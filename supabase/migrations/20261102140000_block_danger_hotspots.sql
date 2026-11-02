-- Fire danger per block (Canadian FWI) and faster satellite hotspot checks (2 Nov 2026).
--  * fire_danger: one row per block per day (id YYYY-MM-DD|A) with the FWI system codes; the estate row
--    (id YYYY-MM-DD, block null) keeps the worst block for older app versions
--  * detections: the block of the nearest compartment
--  * schedules: hotspots every 10 min; fire danger at 05:45 and an update at 11:45 (pushes only if a block rises)

alter table public.fire_danger
  add column if not exists block text,
  add column if not exists fwi numeric,
  add column if not exists ffmc numeric,
  add column if not exists dmc numeric,
  add column if not exists dc numeric,
  add column if not exists isi numeric,
  add column if not exists bui numeric;
create index if not exists fire_danger_day on public.fire_danger(day);

alter table public.detections add column if not exists block text;

select cron.unschedule(jobid) from cron.job where jobname in ('epb-firms-hotspots', 'epb-fire-danger', 'epb-fire-danger-midday');
select cron.schedule('epb-firms-hotspots', '*/10 * * * *', $$ select public.call_alert_fn('firms-hotspots', '{}'::jsonb) $$);
select cron.schedule('epb-fire-danger', '45 5 * * *', $$ select public.call_alert_fn('fire-danger', '{}'::jsonb) $$);           -- 05:45 Ghana time (UTC)
select cron.schedule('epb-fire-danger-midday', '45 11 * * *', $$ select public.call_alert_fn('fire-danger', '{"run":"midday"}'::jsonb) $$);  -- 11:45
