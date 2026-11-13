-- Stage 4: compartment risk rating (13 Nov 2026).
-- The rating itself is worked out on each phone from data it already has (src/core/compartmentRisk.ts), so it works
-- offline and changes the moment a satellite detection arrives. The server adds:
--   * feed_status: when each data feed last ran and last succeeded. The phone needs it to tell "no fire detected"
--     from "the detection feed is down" (the latter is unknown, never low). Written by the firms-hotspots and
--     fuel-dryness functions; synced to phones.
--   * risk_config.params.risk: weights, bands and thresholds (defaults below; change here, phones follow on sync).
--   * risk_config is synced to phones too (touch trigger so changes reach them).
-- Run in the Supabase SQL Editor. Safe to run twice.
set search_path = public, extensions;

create table if not exists public.feed_status (
  id text primary key,                 -- 'firms' | 'dryness'
  last_attempt timestamptz,
  last_ok timestamptz,
  detail text not null default '',
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists feed_status_updated on public.feed_status(updated_at);
drop trigger if exists c_feed_status_touch on public.feed_status;
create trigger c_feed_status_touch before insert or update on public.feed_status for each row execute function public.touch_updated_at();
alter table public.feed_status enable row level security;
drop policy if exists feed_status_read on public.feed_status;
create policy feed_status_read on public.feed_status for select to authenticated using (true);

-- start from what is known now
insert into public.feed_status (id, last_attempt, last_ok, detail)
values ('firms', null, null, 'waiting for the next satellite check'),
       ('dryness', (select max(started_at) from public.dryness_runs),
                   (select max(finished_at) from public.dryness_runs where status in ('ok', 'partial')), '')
on conflict (id) do nothing;

-- risk_config: phones sync it, so its updated_at must move on every change
drop trigger if exists c_risk_config_touch on public.risk_config;
create trigger c_risk_config_touch before insert or update on public.risk_config for each row execute function public.touch_updated_at();
create index if not exists risk_config_updated on public.risk_config(updated_at);

update public.risk_config set params = params || jsonb_build_object('risk', '{
  "weights": { "dryness_in": 0.25, "dryness_out": 0.20, "barriers": 0.15, "detections": 0.20, "weather": 0.20 },
  "bands": [0.75, 1.5, 2.25],
  "barrier_open_pct": [10, 30, 60],
  "uncertain_weight": 0.5,
  "detections": { "km1_m": 1000, "km1_h": 24, "km2_m": 2000, "km2_h": 72, "km5_m": 5000, "km5_h": 168 },
  "stale": { "dryness_days": 16, "barriers_days": 180, "firms_hours": 3 },
  "min_known_weight": 0.5,
  "_notes": "drivers scored 0-3; rating = weighted mean of known drivers: < bands[0] Low, < bands[1] Moderate, < bands[2] High, else Extreme. A detection within km1_m in km1_h hours forces at least High. Unknown if dryness inside is unknown or less than min_known_weight of the applicable weight is known. Barrier open share = gap% + uncertain_weight x unverified%."
}'::jsonb)
where id = 'site' and not (params ? 'risk');
