-- Align fire records with SOP 4.1 (Fire Detection & Response):
--  * fire category 1–5 (SOP size/behaviour classes), alongside the old size_class
--  * when the fire was declared Out (starts the Fire Watch Patrol and report clock)
--  * when the Incident Report was submitted (coordinators/admins only)
-- Status value 'controlled' is kept in the database; the app now labels it "Mop-up".

alter table public.incidents
  add column if not exists category smallint check (category between 1 and 5),
  add column if not exists out_at timestamptz,
  add column if not exists report_submitted_at timestamptz;

create or replace function public.incident_before_update()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
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
    new.report_submitted_at := old.report_submitted_at;
  end if;
  if new.status is distinct from old.status then
    if new.status in ('dismissed','controlled','out') and not private.is_coord() then
      raise exception 'Only a coordinator may set status %', new.status using errcode = '42501';
    end if;
    if old.status in ('dismissed','controlled','out') and not private.is_coord() then
      raise exception 'Only a coordinator may reopen an incident' using errcode = '42501';
    end if;
  end if;
  -- Out time: set when the fire is declared Out, cleared if it is reopened
  if new.status = 'out' then
    new.out_at := coalesce(case when old.status = 'out' then old.out_at end, new.out_at, now());
  else
    new.out_at := null;
  end if;
  return new;
end $function$;
