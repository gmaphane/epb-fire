-- Alerts: phone push notifications, satellite hotspot feed (NASA FIRMS) and the daily fire danger rating.
-- Server-side keys are generated inside the database / edge functions and never leave the server.

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------- server-only settings
create schema if not exists private;
create table if not exists private.app_keys (k text primary key, v text not null, created_at timestamptz not null default now());
revoke all on private.app_keys from public, anon, authenticated;
-- shared secret the database uses to call the alert functions (random, generated here)
insert into private.app_keys (k, v) values ('hook_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')) on conflict (k) do nothing;

-- edge functions (service role) read/write keys through these; no other role can
create or replace function public.app_key_get(p_k text) returns text language sql stable security definer set search_path = private as $$
  select v from private.app_keys where k = p_k $$;
create or replace function public.app_key_put(p_k text, p_v text) returns void language sql security definer set search_path = private as $$
  insert into private.app_keys (k, v) values (p_k, p_v) on conflict (k) do nothing $$;
revoke execute on function public.app_key_get(text), public.app_key_put(text, text) from public, anon, authenticated;
grant execute on function public.app_key_get(text), public.app_key_put(text, text) to service_role;

-- public settings phones may read (the VAPID public key)
create table if not exists public.app_config (k text primary key, v text not null, updated_at timestamptz not null default now());
alter table public.app_config enable row level security;
drop policy if exists app_config_read on public.app_config;
create policy app_config_read on public.app_config for select to authenticated using (true);

-- ---------------------------------------------------------------- push subscriptions (one per phone/browser)
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  user_id uuid not null default auth.uid(),
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- daily fire danger
create table if not exists public.fire_danger (
  id text primary key,                 -- the day, YYYY-MM-DD (Ghana = UTC)
  day date not null,
  level text not null check (level in ('low','moderate','high','very_high','extreme')),
  ffwi numeric,                        -- Fosberg Fire Weather Index at the afternoon peak
  temp_max_c numeric,
  rh_min_pct numeric,
  wind_max_kmh numeric,
  wind_from_deg numeric,
  days_since_rain integer,
  rain_24h_mm numeric,
  basis text not null default '',
  client_updated_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists fire_danger_updated on public.fire_danger(updated_at);
drop trigger if exists c_fire_danger_touch on public.fire_danger;
create trigger c_fire_danger_touch before insert or update on public.fire_danger for each row execute function public.touch_updated_at();
alter table public.fire_danger enable row level security;
drop policy if exists fire_danger_read on public.fire_danger;
create policy fire_danger_read on public.fire_danger for select to authenticated using (true);

-- satellite hotspots: remember which ones already raised an alert
alter table public.detections add column if not exists notified_at timestamptz;
alter table public.detections add column if not exists compartment text;
alter table public.detections add column if not exists distance_m numeric;

-- nearest compartment to a point (0 m = inside), for hotspot alerts
create or replace function public.nearest_compartment(p_lat double precision, p_lon double precision)
returns table (code text, distance_m double precision) language sql stable set search_path = public, extensions as $$
  select c.code, st_distance(c.geom::geography, st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography)
  from public.compartments c
  order by c.geom <-> st_setsrid(st_makepoint(p_lon, p_lat), 4326)
  limit 1 $$;

do $$ begin
  begin execute 'alter publication supabase_realtime add table public.fire_danger'; exception when duplicate_object then null; end;
end $$;

-- ---------------------------------------------------------------- database → alert function
create or replace function public.call_alert_fn(fn text, body jsonb) returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'https://qmgialosxnlvyvzpvgiv.supabase.co/functions/v1/' || fn,
    body := body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-epb-hook', public.app_key_get('hook_secret')),
    timeout_milliseconds := 10000);
exception when others then
  raise warning 'alert call % failed: %', fn, sqlerrm;  -- an alert problem must never block saving a fire report
end $$;
revoke execute on function public.call_alert_fn(text, jsonb) from public, anon, authenticated;

-- new call-out → push to the dispatched crew / person
create or replace function public.on_assignment_alert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.state = 'dispatched' and (tg_op = 'INSERT' or old.state is distinct from 'dispatched') then
    perform public.call_alert_fn('notify', jsonb_build_object('event', 'dispatch', 'id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists z_assignment_alert on public.assignments;
create trigger z_assignment_alert after insert or update of state on public.assignments for each row execute function public.on_assignment_alert();

-- new fire report → push to coordinators, managers, admins
create or replace function public.on_incident_alert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.call_alert_fn('notify', jsonb_build_object('event', 'incident', 'id', new.id));
  return new;
end $$;
drop trigger if exists z_incident_alert on public.incidents;
create trigger z_incident_alert after insert on public.incidents for each row execute function public.on_incident_alert();

-- ---------------------------------------------------------------- schedules
select cron.unschedule(jobid) from cron.job where jobname in ('epb-firms-hotspots', 'epb-fire-danger');
select cron.schedule('epb-firms-hotspots', '*/30 * * * *', $$ select public.call_alert_fn('firms-hotspots', '{}'::jsonb) $$);
select cron.schedule('epb-fire-danger', '45 5 * * *', $$ select public.call_alert_fn('fire-danger', '{}'::jsonb) $$);  -- 05:45 Ghana time (UTC)
