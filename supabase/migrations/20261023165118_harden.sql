-- Hardening after Supabase advisor review.
-- 1) Role helpers move to a schema the API doesn't expose (no /rpc access); RLS policies keep working
--    because they reference the functions by identity, not by name.
create schema if not exists private;
grant usage on schema private to authenticated;
do $$ begin
  -- projects created before this migration: move the helpers out of the API schema
  if to_regprocedure('public.my_role()') is not null and to_regprocedure('private.my_role()') is null then
    alter function public.my_role() set schema private;
    alter function public.my_crew() set schema private;
    alter function public.is_coord() set schema private;
    alter function public.is_resp() set schema private;
  end if;
end $$;
revoke execute on function private.my_role(), private.my_crew(), private.is_coord(), private.is_resp() from public, anon;
grant execute on function private.my_role(), private.my_crew(), private.is_coord(), private.is_resp() to authenticated;

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

-- 2) Evaluate auth.uid() once per query, not per row.
alter policy profiles_read on public.profiles using (id = (select auth.uid()) or private.is_coord());
alter policy incidents_insert on public.incidents with check (reported_by = (select auth.uid()) or private.is_resp());
alter policy incidents_update on public.incidents using (private.is_resp() or reported_by = (select auth.uid())) with check (private.is_resp() or reported_by = (select auth.uid()));
alter policy events_insert on public.incident_events with check ("by" = (select auth.uid()));
alter policy assign_read on public.assignments using (private.is_coord() or private.my_role() = 'manager' or crew_id = private.my_crew() or user_id = (select auth.uid()));
alter policy assign_insert on public.assignments with check (private.is_coord() or crew_id = private.my_crew() or user_id = (select auth.uid()));
alter policy assign_update on public.assignments using (private.is_coord() or crew_id = private.my_crew() or user_id = (select auth.uid())) with check (private.is_coord() or crew_id = private.my_crew() or user_id = (select auth.uid()));
alter policy per_write on public.perimeters using (private.is_coord() or ("by" = (select auth.uid()) and private.is_resp())) with check (private.is_coord() or ("by" = (select auth.uid()) and private.is_resp()));
alter policy photos_write on public.photos using ("by" = (select auth.uid()) or private.is_coord()) with check ("by" = (select auth.uid()) or private.is_coord());
alter policy haz_insert on public.hazards with check ("by" = (select auth.uid()) or private.is_coord());
alter policy haz_update on public.hazards using ("by" = (select auth.uid()) or private.is_coord()) with check ("by" = (select auth.uid()) or private.is_coord());

-- 3) Indexes on foreign keys.
create index if not exists assignments_incident on public.assignments(incident_id);
create index if not exists assignments_crew on public.assignments(crew_id);
create index if not exists detections_promoted on public.detections(promoted_incident_id);
create index if not exists perimeters_incident on public.perimeters(incident_id);
create index if not exists photos_incident on public.photos(incident_id);
create index if not exists profiles_crew on public.profiles(crew_id);
