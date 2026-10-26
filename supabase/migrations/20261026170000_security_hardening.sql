-- Security hardening after review (2026-10-26).

-- C2: a client clock (or a forged value) far in the future must not freeze a row against later edits (lww_guard).
create or replace function public.clamp_client_ts() returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_updated_at is not null and new.client_updated_at > now() + interval '2 minutes' then
    new.client_updated_at := now();
  end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['incidents','assignments','perimeters','photos','hazards','detections','readiness','crew_positions'] loop
    execute format('drop trigger if exists a0_%1$s_clamp on public.%1$s', t);
    execute format('create trigger a0_%1$s_clamp before insert or update on public.%1$s for each row execute function public.clamp_client_ts()', t);
  end loop;
end $$;

-- H3: the server assigns the fire code, the reporter identity and (for reporters) the starting status.
-- Note: PostgREST upserts run BEFORE INSERT triggers even when the row exists (it then becomes an update),
-- so existing rows are left to the update trigger.
create or replace function public.incident_before_insert() returns trigger language plpgsql set search_path = public as $$
declare v_code text;
begin
  select code into v_code from public.incidents where id = new.id;
  if found then
    new.code := coalesce(v_code, new.code);
    return new;
  end if;
  new.code := 'F-' || to_char(now(), 'YYYY') || '-' || lpad(nextval('public.incident_seq')::text, 4, '0');
  if auth.uid() is not null then
    new.reported_by := auth.uid();
    new.reported_by_name := coalesce((select full_name from public.profiles where id = auth.uid()), new.reported_by_name);
    if not private.is_resp() then new.status := 'reported'; new.deleted_at := null; end if;
  end if;
  return new;
end $$;

-- M1: only coordinators may hide (delete) an incident or change who reported it / its code.
-- Other roles' attempts are quietly ignored (raising would jam the phone's outbox on a harmless stale copy).
create or replace function public.incident_before_update() returns trigger language plpgsql set search_path = public as $$
begin
  if new.code is null then new.code := old.code; end if;
  if private.my_role() = 'reporter' then
    return null;
  end if;
  if auth.uid() is not null and not private.is_coord() then
    new.deleted_at := old.deleted_at;
    new.reported_by := old.reported_by;
    new.reported_by_name := old.reported_by_name;
    new.code := old.code;
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

-- H1: only coordinators dispatch; crews may only move their own call-out through its states.
alter policy assign_insert on public.assignments with check (private.is_coord());
create or replace function public.assignment_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and not private.is_coord() then
    -- crews can acknowledge / go en route / on scene / ask for support / release; the rest stays as dispatched
    new.incident_id := old.incident_id; new.crew_id := old.crew_id; new.user_id := old.user_id;
    new.instruction := old.instruction; new.dispatched_by := old.dispatched_by; new.dispatched_at := old.dispatched_at;
    if new.state = 'dispatched' and old.state is distinct from 'dispatched' then new.state := old.state; end if;
  end if;
  return new;
end $$;
drop trigger if exists b_assignments_guard on public.assignments;
create trigger b_assignments_guard before update on public.assignments for each row execute function public.assignment_guard();

-- H2: photos: everyone signed in may view; you may add/replace only your own; only coordinators delete. Images only, 10 MB.
drop policy if exists photos_obj_rw on storage.objects;
drop policy if exists photos_obj_read on storage.objects;
drop policy if exists photos_obj_ins on storage.objects;
drop policy if exists photos_obj_upd on storage.objects;
drop policy if exists photos_obj_del on storage.objects;
create policy photos_obj_read on storage.objects for select to authenticated using (bucket_id = 'incident-photos');
create policy photos_obj_ins on storage.objects for insert to authenticated with check (bucket_id = 'incident-photos' and owner_id = (select auth.uid())::text);
create policy photos_obj_upd on storage.objects for update to authenticated using (bucket_id = 'incident-photos' and owner_id = (select auth.uid())::text) with check (bucket_id = 'incident-photos' and owner_id = (select auth.uid())::text);
create policy photos_obj_del on storage.objects for delete to authenticated using (bucket_id = 'incident-photos' and private.is_coord());
update storage.buckets set file_size_limit = 10485760, allowed_mime_types = '{image/jpeg,image/png,image/webp}' where id = 'incident-photos';

-- M3: names and crew on the live map come from the profile, not the phone.
create or replace function public.crew_position_identity() returns trigger language plpgsql security definer set search_path = public as $$
declare p record;
begin
  select full_name, crew_id into p from public.profiles where id = new.user_id;
  if found then new.name := coalesce(p.full_name, new.name); new.crew_id := p.crew_id; end if;
  return new;
end $$;
drop trigger if exists b_crew_positions_identity on public.crew_positions;
create trigger b_crew_positions_identity before insert or update on public.crew_positions for each row execute function public.crew_position_identity();

-- M4: at most one "new fire" push per reporter per minute.
create or replace function public.on_incident_alert() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.incidents i where i.reported_by = new.reported_by and i.id <> new.id and i.reported_at > now() - interval '60 seconds') then
    perform public.call_alert_fn('notify', jsonb_build_object('event', 'incident', 'id', new.id));
  end if;
  return new;
end $$;

-- L1: trigger functions are not API endpoints.
revoke execute on function public.on_assignment_alert(), public.on_incident_alert(), public.assignment_guard(),
  public.crew_position_identity(), public.clamp_client_ts() from public, anon, authenticated;

-- L2: push endpoints must be a real browser push service.
alter table public.push_subscriptions drop constraint if exists push_endpoint_host;
alter table public.push_subscriptions add constraint push_endpoint_host check (
  endpoint ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/');
