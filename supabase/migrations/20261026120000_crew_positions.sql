-- Live crew locations: one row per user (id = auth uid), overwritten on every share.
-- Standby crews check in; crews heading to a fire share en route / on scene.
create table if not exists public.crew_positions (
  id uuid primary key,
  user_id uuid not null,
  name text not null default '',
  crew_id uuid,
  status text not null check (status in ('standby','en_route','on_scene','off')),
  incident_id uuid,
  lat double precision not null,
  lon double precision not null,
  acc double precision,
  heading double precision,
  speed double precision,
  fix_at timestamptz not null,
  client_updated_at timestamptz not null,
  geom geometry(Point,4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,
  updated_at timestamptz not null default clock_timestamp(),
  constraint crew_positions_self check (id = user_id)
);
create index if not exists crew_positions_updated on public.crew_positions(updated_at);

drop trigger if exists a_crew_positions_lww on public.crew_positions;
create trigger a_crew_positions_lww before update on public.crew_positions for each row execute function public.lww_guard();
drop trigger if exists c_crew_positions_touch on public.crew_positions;
create trigger c_crew_positions_touch before insert or update on public.crew_positions for each row execute function public.touch_updated_at();

alter table public.crew_positions enable row level security;
drop policy if exists crewpos_read on public.crew_positions;
create policy crewpos_read on public.crew_positions for select to authenticated using (true);
drop policy if exists crewpos_insert on public.crew_positions;
create policy crewpos_insert on public.crew_positions for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists crewpos_update on public.crew_positions;
create policy crewpos_update on public.crew_positions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

do $$
begin
  execute 'alter publication supabase_realtime add table public.crew_positions';
exception when duplicate_object then null;
end $$;
