-- Real estate layers: overlay layers (firebreaks, risk zones, camera coverage, standby routes, burnt history...),
-- more asset kinds (standby posts, vehicle parking, communities), attribute bags, and a server-side fire history table.
set search_path = public, extensions;

-- 1) Generic overlay layers, synced to phones as reference data
create table if not exists public.map_layers (
  id uuid primary key,
  layer text not null,          -- firebreak | high_risk_zone | camera_coverage | standby_route | burnt_area | waterway | comms_tower
  name text not null default '',
  geojson jsonb not null,
  props jsonb not null default '{}',
  geom geometry(Geometry,4326),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists map_layers_updated on public.map_layers(updated_at);
create index if not exists map_layers_layer on public.map_layers(layer);
create index if not exists map_layers_geom on public.map_layers using gist(geom);
drop trigger if exists map_layers_geom on public.map_layers;
create trigger map_layers_geom before insert or update on public.map_layers for each row execute function public.geojson_to_geom();
drop trigger if exists c_map_layers_touch on public.map_layers;
create trigger c_map_layers_touch before insert or update on public.map_layers for each row execute function public.touch_updated_at();
alter table public.map_layers enable row level security;
drop policy if exists map_layers_read on public.map_layers;
create policy map_layers_read on public.map_layers for select to authenticated using (true);
drop policy if exists map_layers_admin_ins on public.map_layers;
create policy map_layers_admin_ins on public.map_layers for insert to authenticated with check (private.my_role() = 'admin');
drop policy if exists map_layers_admin_upd on public.map_layers;
create policy map_layers_admin_upd on public.map_layers for update to authenticated using (private.my_role() = 'admin') with check (private.my_role() = 'admin');
drop policy if exists map_layers_admin_del on public.map_layers;
create policy map_layers_admin_del on public.map_layers for delete to authenticated using (private.my_role() = 'admin');

-- 2) More asset kinds + attribute bags
alter table public.assets drop constraint if exists assets_kind_check;
alter table public.assets add constraint assets_kind_check
  check (kind in ('water','camera','tower','camp','assembly','standby_post','parking','community'));
alter table public.compartments add column if not exists props jsonb not null default '{}';
alter table public.roads add column if not exists props jsonb not null default '{}';

-- 3) Fire history (FIRMS detections, alert logs): analysis only, not synced to phones
create table if not exists public.fire_history (
  id uuid primary key,
  source text not null,          -- firms_modis | alert_log
  observed_on date,
  observed_time text,
  lat double precision not null,
  lon double precision not null,
  props jsonb not null default '{}',
  geom geometry(Point,4326) generated always as (st_setsrid(st_makepoint(lon, lat), 4326)) stored,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists fire_history_geom on public.fire_history using gist(geom);
create index if not exists fire_history_date on public.fire_history(observed_on);
alter table public.fire_history enable row level security;
drop policy if exists fire_history_read on public.fire_history;
create policy fire_history_read on public.fire_history for select to authenticated using (private.my_role() in ('coordinator','manager','admin'));
drop policy if exists fire_history_admin_ins on public.fire_history;
create policy fire_history_admin_ins on public.fire_history for insert to authenticated with check (private.my_role() = 'admin');
drop policy if exists fire_history_admin_upd on public.fire_history;
create policy fire_history_admin_upd on public.fire_history for update to authenticated using (private.my_role() = 'admin') with check (private.my_role() = 'admin');
drop policy if exists fire_history_admin_del on public.fire_history;
create policy fire_history_admin_del on public.fire_history for delete to authenticated using (private.my_role() = 'admin');
