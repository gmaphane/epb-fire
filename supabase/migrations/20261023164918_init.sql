-- EPB Fire Response — schema, sync semantics and Row-Level Security (MVP)
-- Run in the Supabase SQL editor or with `supabase db push`.
-- Columns mirror src/core/types.ts exactly: the client upserts rows as-is.

create extension if not exists postgis with schema extensions;
set search_path = public, extensions;

-- ---------------------------------------------------------------- helpers
create or replace function public.touch_updated_at() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := clock_timestamp();   -- server clock = pull cursor
  return new;
end $$;

-- Last-writer-wins: ignore a write whose client timestamp is older than what we hold.
create or replace function public.lww_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_updated_at is not null and old.client_updated_at is not null
     and new.client_updated_at < old.client_updated_at then
    return null;  -- silently keep the newer row (idempotent replays)
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- identity
create table if not exists public.crews (
  id uuid primary key,
  name text not null,
  block text not null,
  shift text not null check (shift in ('day','night','support')),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'reporter' check (role in ('reporter','responder','coordinator','manager','admin')),
  crew_id uuid references public.crews(id),
  created_at timestamptz not null default now()
);

create schema if not exists private;  -- not exposed by the API, so these helpers can't be called via /rpc
grant usage on schema private to authenticated;
create or replace function private.my_role() returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;
create or replace function private.my_crew() returns uuid language sql stable security definer set search_path = public as $$
  select crew_id from public.profiles where id = auth.uid()
$$;
create or replace function private.is_coord() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(role in ('coordinator','admin'), false) from public.profiles where id = auth.uid()
$$;
create or replace function private.is_resp() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(role in ('responder','coordinator','admin'), false) from public.profiles where id = auth.uid()
$$;

-- Role helpers are for RLS only: not callable by anonymous clients.
revoke execute on function private.my_role(), private.my_crew(), private.is_coord(), private.is_resp() from public, anon;
grant execute on function private.my_role(), private.my_crew(), private.is_coord(), private.is_resp() to authenticated;

-- ---------------------------------------------------------------- reference data
create table if not exists public.compartments (
  id uuid primary key,
  code text not null unique,
  block text not null,
  geojson jsonb not null,
  risk_class text not null default 'moderate' check (risk_class in ('low','moderate','high','very_high','extreme')),
  risk_score numeric,
  treatment_status text not null default '',
  geom geometry(Geometry,4326),
  updated_at timestamptz not null default clock_timestamp()
);
create or replace function public.geojson_to_geom() returns trigger language plpgsql set search_path = public, extensions as $$
begin
  new.geom := st_setsrid(st_geomfromgeojson(new.geojson::text), 4326);
  return new;
end $$;
drop trigger if exists compartments_geom on public.compartments;
create trigger compartments_geom before insert or update on public.compartments for each row execute function public.geojson_to_geom();

create table if not exists public.roads (
  id uuid primary key,
  name text not null,
  geojson jsonb not null,
  passable boolean not null default true,
  geom geometry(Geometry,4326),
  updated_at timestamptz not null default clock_timestamp()
);
drop trigger if exists roads_geom on public.roads;
create trigger roads_geom before insert or update on public.roads for each row execute function public.geojson_to_geom();

create table if not exists public.assets (
  id uuid primary key,
  kind text not null check (kind in ('water','camera','tower','camp','assembly')),
  name text not null,
  lat double precision not null,
  lon double precision not null,
  props jsonb not null default '{}',
  geom geometry(Point,4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,
  updated_at timestamptz not null default clock_timestamp()
);

-- ---------------------------------------------------------------- incidents
create sequence if not exists public.incident_seq;

create table if not exists public.incidents (
  id uuid primary key,
  code text unique,
  label text not null,
  status text not null check (status in ('reported','confirmed','responding','on_scene','contained','controlled','out','dismissed')),
  source text not null check (source in ('tower','camera','satellite','patrol','community','other')),
  size_class text not null default 'unknown' check (size_class in ('unknown','small','medium','large')),
  notes text not null default '',
  lat double precision not null,
  lon double precision not null,
  accuracy_m double precision,
  location_estimated boolean not null default false,
  block text,
  compartment text,
  reported_by uuid not null,
  reported_by_name text not null default '',
  reported_at timestamptz not null,
  client_updated_at timestamptz not null,
  cause text,
  area_ha numeric,
  dismiss_reason text,
  detection_id uuid,
  deleted_at timestamptz,
  geom geometry(Point,4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists incidents_updated on public.incidents(updated_at);
create index if not exists incidents_geom on public.incidents using gist(geom);

create or replace function public.incident_before_insert() returns trigger language plpgsql set search_path = public as $$
begin
  if new.code is null then
    new.code := 'F-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.incident_seq')::text, 4, '0');
  end if;
  return new;
end $$;
drop trigger if exists incidents_code on public.incidents;
create trigger incidents_code before insert on public.incidents for each row execute function public.incident_before_insert();

-- Role guard + keep server-assigned code when a replay carries code = null.
create or replace function public.incident_before_update() returns trigger language plpgsql set search_path = public as $$
begin
  if new.code is null then new.code := old.code; end if;
  if private.my_role() = 'reporter' then
    return null;  -- reporters can create but not change (replays of their own report are ignored)
  end if;
  if new.status is distinct from old.status then
    if new.status in ('dismissed','controlled','out') and not private.is_coord() then
      raise exception 'Only a coordinator may set status %', new.status using errcode = '42501';
    end if;
    if old.status in ('dismissed','controlled','out') and not private.is_coord() then
      raise exception 'Only a coordinator may reopen an incident' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
-- trigger order (alphabetical): a_lww → b_guard → c_touch
drop trigger if exists a_incidents_lww on public.incidents;
create trigger a_incidents_lww before update on public.incidents for each row execute function public.lww_guard();
drop trigger if exists b_incidents_guard on public.incidents;
create trigger b_incidents_guard before update on public.incidents for each row execute function public.incident_before_update();
drop trigger if exists c_incidents_touch on public.incidents;
create trigger c_incidents_touch before insert or update on public.incidents for each row execute function public.touch_updated_at();

create table if not exists public.incident_events (
  id uuid primary key,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}',
  lat double precision,
  lon double precision,
  accuracy_m double precision,
  "by" uuid not null,
  by_name text not null default '',
  client_ts timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists events_incident on public.incident_events(incident_id, client_ts);
create index if not exists events_updated on public.incident_events(updated_at);
drop trigger if exists events_touch on public.incident_events;
create trigger events_touch before insert or update on public.incident_events for each row execute function public.touch_updated_at();

create table if not exists public.assignments (
  id uuid primary key,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  crew_id uuid references public.crews(id),
  user_id uuid,
  state text not null check (state in ('dispatched','acknowledged','en_route','on_scene','released')),
  instruction text not null default '',
  need_support boolean not null default false,
  dispatched_by uuid not null,
  dispatched_at timestamptz not null,
  acked_at timestamptz,
  acked_by uuid,
  en_route_at timestamptz,
  on_scene_at timestamptz,
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists assignments_updated on public.assignments(updated_at);

create table if not exists public.perimeters (
  id uuid primary key,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  state text not null check (state in ('recording','paused','closed')),
  vertices jsonb not null default '[]',
  rejected_fixes integer not null default 0,
  area_ha numeric,
  length_km numeric,
  walk_seconds integer not null default 0,
  started_at timestamptz not null,
  closed_at timestamptz,
  "by" uuid not null,
  client_updated_at timestamptz not null,
  geom geometry(Polygon,4326),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists perimeters_updated on public.perimeters(updated_at);
create or replace function public.perimeter_geom() returns trigger language plpgsql set search_path = public, extensions as $$
declare pts geometry[]; n int;
begin
  n := jsonb_array_length(new.vertices);
  if new.state = 'closed' and n >= 3 then
    select array_agg(st_makepoint((v->>'lon')::float8, (v->>'lat')::float8) order by ord) into pts
      from jsonb_array_elements(new.vertices) with ordinality as t(v, ord);
    pts := pts || pts[1];
    new.geom := st_setsrid(st_makepolygon(st_makeline(pts)), 4326);
  else
    new.geom := null;
  end if;
  return new;
end $$;
drop trigger if exists perimeters_geom on public.perimeters;
create trigger perimeters_geom before insert or update on public.perimeters for each row execute function public.perimeter_geom();

create table if not exists public.photos (
  id uuid primary key,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  storage_path text not null,
  lat double precision,
  lon double precision,
  accuracy_m double precision,
  heading double precision,
  taken_at timestamptz not null,
  "by" uuid not null,
  uploaded boolean not null default false,
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists photos_updated on public.photos(updated_at);

create table if not exists public.hazards (
  id uuid primary key,
  kind text not null check (kind in ('road_blocked','tree_down','bridge','other')),
  note text not null default '',
  lat double precision not null,
  lon double precision not null,
  "by" uuid not null,
  created_at timestamptz not null,
  resolved_at timestamptz,
  client_updated_at timestamptz not null,
  geom geometry(Point,4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists hazards_updated on public.hazards(updated_at);

create table if not exists public.detections (
  id uuid primary key,
  source text not null,
  acq_time timestamptz not null,
  confidence text not null default '',
  frp double precision,
  lat double precision not null,
  lon double precision not null,
  promoted_incident_id uuid references public.incidents(id),
  client_updated_at timestamptz not null default now(),
  geom geometry(Point,4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists detections_updated on public.detections(updated_at);

create table if not exists public.readiness (
  id text primary key,
  level text not null check (level in ('green','amber','red')),
  note text not null default '',
  set_by uuid not null,
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);

-- LWW + updated_at on every client-writable table (incidents handled above)
do $$
declare t text;
begin
  foreach t in array array['assignments','perimeters','photos','hazards','detections','readiness'] loop
    execute format('drop trigger if exists a_%1$s_lww on public.%1$s', t);
    execute format('create trigger a_%1$s_lww before update on public.%1$s for each row execute function public.lww_guard()', t);
    execute format('drop trigger if exists c_%1$s_touch on public.%1$s', t);
    execute format('create trigger c_%1$s_touch before insert or update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
  foreach t in array array['crews','compartments','roads','assets'] loop
    execute format('drop trigger if exists c_%1$s_touch on public.%1$s', t);
    execute format('create trigger c_%1$s_touch before insert or update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;
create index if not exists crews_updated on public.crews(updated_at);
create index if not exists compartments_updated on public.compartments(updated_at);
create index if not exists roads_updated on public.roads(updated_at);
create index if not exists assets_updated on public.assets(updated_at);

-- ---------------------------------------------------------------- Row-Level Security
do $$
declare t text;
begin
  foreach t in array array['profiles','crews','compartments','roads','assets','incidents','incident_events','assignments','perimeters','photos','hazards','detections','readiness'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- profiles
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (id = (select auth.uid()) or private.is_coord());
drop policy if exists profiles_admin on public.profiles;
create policy profiles_admin on public.profiles for all to authenticated using (private.my_role() = 'admin') with check (private.my_role() = 'admin');

-- reference data: everyone reads, admin writes
do $$
declare t text;
begin
  foreach t in array array['crews','compartments','roads','assets'] loop
    execute format('drop policy if exists %1$s_read on public.%1$s', t);
    execute format('create policy %1$s_read on public.%1$s for select to authenticated using (true)', t);
    execute format('drop policy if exists %1$s_admin on public.%1$s', t);
    execute format('create policy %1$s_admin on public.%1$s for all to authenticated using (private.my_role() = ''admin'') with check (private.my_role() = ''admin'')', t);
  end loop;
end $$;

-- incidents: everyone reads; anyone creates their own; responders+ update; reporter may "update" own row only so replays are harmless
drop policy if exists incidents_read on public.incidents;
create policy incidents_read on public.incidents for select to authenticated using (true);
drop policy if exists incidents_insert on public.incidents;
-- NB: the app writes with upsert (INSERT ... ON CONFLICT DO UPDATE); Postgres checks the INSERT policy first,
-- so anyone allowed to update a row must also pass the insert check.
create policy incidents_insert on public.incidents for insert to authenticated with check (reported_by = (select auth.uid()) or private.is_resp());
drop policy if exists incidents_update on public.incidents;
create policy incidents_update on public.incidents for update to authenticated
  using (private.is_resp() or reported_by = (select auth.uid()))
  with check (private.is_resp() or reported_by = (select auth.uid()));

-- events: append-only
drop policy if exists events_read on public.incident_events;
create policy events_read on public.incident_events for select to authenticated using (true);
drop policy if exists events_insert on public.incident_events;
create policy events_insert on public.incident_events for insert to authenticated with check ("by" = (select auth.uid()));

-- assignments: coordinators all; responders see/update their crew's
drop policy if exists assign_read on public.assignments;
create policy assign_read on public.assignments for select to authenticated
  using (private.is_coord() or private.my_role() = 'manager' or crew_id = private.my_crew() or user_id = (select auth.uid()));
drop policy if exists assign_insert on public.assignments;
create policy assign_insert on public.assignments for insert to authenticated with check (private.is_coord() or crew_id = private.my_crew() or user_id = (select auth.uid()));
drop policy if exists assign_update on public.assignments;
create policy assign_update on public.assignments for update to authenticated
  using (private.is_coord() or crew_id = private.my_crew() or user_id = (select auth.uid()))
  with check (private.is_coord() or crew_id = private.my_crew() or user_id = (select auth.uid()));

-- perimeters
drop policy if exists per_read on public.perimeters;
create policy per_read on public.perimeters for select to authenticated using (true);
drop policy if exists per_write on public.perimeters;
create policy per_write on public.perimeters for all to authenticated
  using (private.is_coord() or ("by" = (select auth.uid()) and private.is_resp()))
  with check (private.is_coord() or ("by" = (select auth.uid()) and private.is_resp()));

-- photos
drop policy if exists photos_read on public.photos;
create policy photos_read on public.photos for select to authenticated using (true);
drop policy if exists photos_write on public.photos;
create policy photos_write on public.photos for all to authenticated using ("by" = (select auth.uid()) or private.is_coord()) with check ("by" = (select auth.uid()) or private.is_coord());

-- hazards
drop policy if exists haz_read on public.hazards;
create policy haz_read on public.hazards for select to authenticated using (true);
drop policy if exists haz_insert on public.hazards;
create policy haz_insert on public.hazards for insert to authenticated with check ("by" = (select auth.uid()) or private.is_coord());
drop policy if exists haz_update on public.hazards;
create policy haz_update on public.hazards for update to authenticated using ("by" = (select auth.uid()) or private.is_coord()) with check ("by" = (select auth.uid()) or private.is_coord());

-- detections: read all; coordinators/responders promote; ingestion uses the service role
drop policy if exists det_read on public.detections;
create policy det_read on public.detections for select to authenticated using (true);
drop policy if exists det_update on public.detections;
create policy det_update on public.detections for update to authenticated using (private.is_resp()) with check (private.is_resp());
drop policy if exists det_insert on public.detections;
create policy det_insert on public.detections for insert to authenticated with check (private.is_resp());

-- readiness
drop policy if exists ready_read on public.readiness;
create policy ready_read on public.readiness for select to authenticated using (true);
drop policy if exists ready_write on public.readiness;
create policy ready_write on public.readiness for all to authenticated using (private.is_coord()) with check (private.is_coord());

-- ---------------------------------------------------------------- Storage (photos)
insert into storage.buckets (id, name, public) values ('incident-photos', 'incident-photos', false) on conflict (id) do nothing;
drop policy if exists photos_obj_rw on storage.objects;
create policy photos_obj_rw on storage.objects for all to authenticated
  using (bucket_id = 'incident-photos') with check (bucket_id = 'incident-photos');

-- ---------------------------------------------------------------- Realtime
do $$
declare t text;
begin
  foreach t in array array['incidents','incident_events','assignments','perimeters','hazards','detections','readiness'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------- new-user profile
create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)), 'reporter')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();
revoke execute on function public.handle_new_user() from public, anon, authenticated;
