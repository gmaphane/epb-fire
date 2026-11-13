-- Stage 1: fuel dryness per compartment and per 2 km edge zone (13 Nov 2026).
-- Computed weekly by the edge function fuel-dryness from Sentinel-2 L2A (Copernicus Data Space, Sentinel Hub
-- Statistical API), index NDMI = (B8A - B11) / (B8A + B11): low NDMI = dry vegetation = fuel that burns readily.
--  * Only clear pixels count (scene classification 4 vegetation, 5 bare soil); clouds, shadows, haze, water excluded.
--  * Per pixel: median NDMI of its clear observations in the window; per zone: 25th/50th/75th percentile.
--  * Window per zone: 7 days; if fewer than min_usable_pct of the zone's pixels were clear, 14 days, then 30 days
--    ("monthly", shown as older imagery). Still not enough: class "unknown", never "low".
--  * Class from the zone's median NDMI with the thresholds in risk_config.dryness (provisional, anchored on the
--    2023/24 bad fire season: Jan-Feb NDMI about -0.05 inside the plantation).
--  * Fuel load: separate columns, left empty (no suitable data yet; never guessed).
-- Run in the Supabase SQL Editor. Safe to run twice.
set search_path = public, extensions;

update public.risk_config set params = params || jsonb_build_object('dryness', '{
  "index": "NDMI (B8A-B11)/(B8A+B11), Sentinel-2 L2A",
  "classes": [ {"class": "low", "min_ndmi": 0.20}, {"class": "moderate", "min_ndmi": 0.10}, {"class": "high", "min_ndmi": 0.00}, {"class": "extreme", "min_ndmi": -1} ],
  "windows_days": [7, 14, 30],
  "min_usable_pct": 30,
  "resolution_m": 20,
  "clear_scene_classes": [4, 5],
  "stale_after_days": 16,
  "_notes": "class = first row whose min_ndmi the zone median reaches; provisional thresholds, tune against fire history"
}'::jsonb)
where id = 'site' and not (params ? 'dryness');

-- ---------------------------------------------------------------- results (synced to phones)
create table if not exists public.fuel_dryness (
  id text primary key,                          -- 'compartment|A016' or 'edge_zone|A016'
  zone_kind text not null check (zone_kind in ('compartment', 'edge_zone')),
  compartment text not null,
  block text,
  run_id uuid,
  sensor text not null default 'sentinel-2-l2a',
  ndmi_p25 numeric, ndmi_p50 numeric, ndmi_p75 numeric,
  usable_pct numeric,                           -- share of the zone's pixels with at least one clear observation
  pixels int,                                   -- pixels in the zone at resolution_m
  class text not null check (class in ('low', 'moderate', 'high', 'extreme', 'unknown')),
  class_basis text not null default '',
  window_from date, window_to date,
  cadence text not null check (cadence in ('weekly', 'fortnightly', 'monthly', 'none')),
  images jsonb not null default '[]',           -- [{date, cloud_pct}] Sentinel-2 passes over the estate in the window
  fuel_load_t_ha numeric,                       -- only where suitable data exist; null = not known (never guessed)
  fuel_load_source text,
  computed_at timestamptz not null default now(),
  client_updated_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists fuel_dryness_updated on public.fuel_dryness(updated_at);
drop trigger if exists c_fuel_dryness_touch on public.fuel_dryness;
create trigger c_fuel_dryness_touch before insert or update on public.fuel_dryness for each row execute function public.touch_updated_at();
alter table public.fuel_dryness enable row level security;
drop policy if exists fuel_dryness_read on public.fuel_dryness;
create policy fuel_dryness_read on public.fuel_dryness for select to authenticated using (true);

-- ---------------------------------------------------------------- run log (when, what imagery, what went wrong)
create table if not exists public.dryness_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  trigger text not null default 'schedule',
  zones int, unknown int,
  by_cadence jsonb, images jsonb, errors jsonb, params jsonb,
  updated_at timestamptz not null default clock_timestamp()
);
drop trigger if exists c_dryness_runs_touch on public.dryness_runs;
create trigger c_dryness_runs_touch before insert or update on public.dryness_runs for each row execute function public.touch_updated_at();
alter table public.dryness_runs enable row level security;
drop policy if exists dryness_runs_read on public.dryness_runs;
create policy dryness_runs_read on public.dryness_runs for select to authenticated using (private.my_role() in ('coordinator', 'manager', 'admin'));

-- ---------------------------------------------------------------- zones for the function, in UTM 30N
create or replace function public.dryness_zones() returns table (id text, zone_kind text, compartment text, block text, area_m2 float8, geojson jsonb)
language sql stable security definer set search_path = public, extensions as $$
  select 'compartment|' || c.code, 'compartment', c.code, c.block, st_area(st_transform(c.geom, 32630)),
         st_asgeojson(st_transform(c.geom, 32630), 1)::jsonb
  from public.compartments c where c.geom is not null
  union all
  select 'edge_zone|' || (m.props->>'compartment'), 'edge_zone', m.props->>'compartment', c.block, st_area(st_transform(m.geom, 32630)),
         st_asgeojson(st_transform(m.geom, 32630), 1)::jsonb
  from public.map_layers m left join public.compartments c on c.code = m.props->>'compartment'
  where m.layer = 'edge_zone' and m.geom is not null $$;
revoke execute on function public.dryness_zones() from public, anon, authenticated;
grant execute on function public.dryness_zones() to service_role;

-- ---------------------------------------------------------------- weekly, Monday 04:30 Ghana time (UTC)
select cron.unschedule(jobid) from cron.job where jobname = 'epb-fuel-dryness';
select cron.schedule('epb-fuel-dryness', '30 4 * * 1', $$ select public.call_alert_fn('fuel-dryness', '{}'::jsonb) $$);
