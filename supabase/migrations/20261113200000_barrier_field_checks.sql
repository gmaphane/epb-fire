-- Field checks of potential fire barriers (13 Nov 2026).
-- A crew member taps a road, firebreak, stream or plantain farm in the app and records what they found: width,
-- continuity, condition, a note, with their GPS position. The check is saved on the phone first (works with no
-- signal) and synced like every other record. On arrival here a trigger:
--   1. applies it to the barrier (newest check wins, so a late replay of an older check changes nothing),
--   2. re-assesses the barrier (effective only if: checked within verified_max_age_days, measured at least
--      min_effective_width_m, continuous, good/fair condition),
--   3. re-classifies only the estate-edge check lines that pass near that barrier, and redraws the edge gaps and
--      edge shares of the compartments concerned (fast enough to run inside the phone's sync request).
-- Every check is kept (append-only), so there is a history of who checked what and when.
-- Run in the Supabase SQL Editor. Safe to run twice.
set search_path = public, extensions;

-- ---------------------------------------------------------------- the checks
create table if not exists public.barrier_checks (
  id uuid primary key,
  barrier_id uuid not null,                         -- = fire_barriers.id (the road / map layer row id)
  barrier_name text not null default '',
  checked_at timestamptz not null,
  "by" uuid not null default auth.uid(),
  by_name text not null default '',
  width_m numeric check (width_m is null or (width_m > 0 and width_m < 500)),
  continuity text not null check (continuity in ('continuous', 'broken', 'unknown')),
  condition text not null check (condition in ('good', 'fair', 'poor', 'unknown')),
  note text not null default '',
  lat double precision,
  lon double precision,
  accuracy_m double precision,
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists barrier_checks_updated on public.barrier_checks(updated_at);
create index if not exists barrier_checks_barrier on public.barrier_checks(barrier_id, checked_at);
drop trigger if exists c_barrier_checks_touch on public.barrier_checks;
create trigger c_barrier_checks_touch before insert or update on public.barrier_checks for each row execute function public.touch_updated_at();
alter table public.barrier_checks enable row level security;
drop policy if exists barrier_checks_read on public.barrier_checks;
create policy barrier_checks_read on public.barrier_checks for select to authenticated using (true);
drop policy if exists barrier_checks_insert on public.barrier_checks;
create policy barrier_checks_insert on public.barrier_checks for insert to authenticated
  with check ("by" = (select auth.uid()) and private.my_role() in ('responder', 'coordinator', 'manager', 'admin'));
do $$ begin
  begin execute 'alter publication supabase_realtime add table public.barrier_checks'; exception when duplicate_object then null; end;
end $$;

-- the name shown is the checker's profile name, not whatever the phone sent
create or replace function public.barrier_check_who() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then new."by" := auth.uid(); end if;
  new.by_name := coalesce((select full_name from public.profiles where id = new."by"), new.by_name, '');
  return new;
end $$;
drop trigger if exists a_barrier_check_who on public.barrier_checks;
create trigger a_barrier_check_who before insert on public.barrier_checks for each row execute function public.barrier_check_who();

-- ---------------------------------------------------------------- one rule for "why is this barrier uncertain"
create or replace function public.barrier_reasons(b public.fire_barriers) returns text[] language sql stable set search_path = public as $$
  select array_remove(array[
    case when b.verified_on is null then 'not checked in the field'
         when b.verified_on < current_date - public.risk_num('verified_max_age_days', 365)::int
           then format('last checked %s (over %s days ago)', b.verified_on, public.risk_num('verified_max_age_days', 365)) end,
    case when b.width_basis = 'assumed_default' then format('width assumed %s m, not measured', b.width_m) end,
    case when b.width_m is not null and b.width_basis <> 'area' and b.width_m < public.risk_num('min_effective_width_m', 10)
      then format('narrower than %s m', public.risk_num('min_effective_width_m', 10)) end,
    case when b.continuity = 'broken' then 'broken: has gaps along it'
         when b.continuity = 'unknown' and b.verified_on is not null then 'continuity not recorded' end,
    case when b.condition = 'poor' then coalesce(nullif(b.note, ''), 'poor condition')
         when b.condition = 'unknown' and b.verified_on is not null then 'condition not recorded' end
  ], null) $$;

-- ---------------------------------------------------------------- edge results, whole estate or only near one barrier
create or replace function public.reclassify_edge_samples(near geometry default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare minw numeric := public.risk_num('min_effective_width_m', 10);
begin
  update public.estate_edge_samples s set status = c.status, crossed = c.crossed, checked_at = now()
  from public.estate_edge_samples s2
  cross join lateral public.classify_ray(s2.ray,
    array(select row(b.id, b.kind, b.name, b.geom, b.width_m, b.effective)::public.barrier_t from public.fire_barriers b where b.geom && s2.ray), minw) c
  where s.id = s2.id and s2.ray is not null and (near is null or s2.ray && near);
  if near is null then
    update public.estate_edge_samples set status = null, crossed = null, checked_at = now() where ray is null;
  end if;
end $$;

create or replace function public.publish_edge_gaps(cpts text[] default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  -- edge shares per compartment (a share with no check points is 0%, not blank)
  update public.compartments c set
    edge_protected_pct = case when c.edge then coalesce(x.p, 0) end, edge_uncertain_pct = case when c.edge then coalesce(x.u, 0) end,
    edge_gap_pct = case when c.edge then coalesce(x.g, 0) end, edge_checked_at = now()
  from (select compartment,
          round(100 * sum(st_length(section)) filter (where status = 'protected') / nullif(sum(st_length(section)) filter (where status is not null), 0)) p,
          round(100 * sum(st_length(section)) filter (where status = 'uncertain') / nullif(sum(st_length(section)) filter (where status is not null), 0)) u,
          round(100 * sum(st_length(section)) filter (where status = 'gap') / nullif(sum(st_length(section)) filter (where status is not null), 0)) g
        from public.estate_edge_samples where compartment is not null and (cpts is null or compartment = any(cpts)) group by compartment) x
  where x.compartment = c.code;

  -- map: stretches with no mapped barrier (gap) or only unverified ones, per compartment
  with s as (select compartment, status, st_linemerge(st_union(section)) g, sum(st_length(section)) len
             from public.estate_edge_samples
             where compartment is not null and status in ('gap', 'uncertain') and (cpts is null or compartment = any(cpts)) group by 1, 2)
  insert into public.map_layers (id, layer, name, geojson, props)
  select md5('edge_gap|' || compartment || '|' || status)::uuid, 'edge_gap',
         format('%s · %s', compartment, case status when 'gap' then 'no mapped barrier' else 'only unverified barriers' end),
         st_asgeojson(st_transform(g, 4326), 7)::jsonb,
         jsonb_build_object('compartment', compartment, 'status', status, 'length_m', round(len::numeric))
  from s
  on conflict (id) do update set geojson = excluded.geojson, props = excluded.props, name = excluded.name;
  delete from public.map_layers m where m.layer = 'edge_gap' and (cpts is null or m.props->>'compartment' = any(cpts)) and not exists (
    select 1 from public.estate_edge_samples e where e.compartment is not null and e.status in ('gap', 'uncertain')
      and md5('edge_gap|' || e.compartment || '|' || e.status)::uuid = m.id);
end $$;
revoke execute on function public.reclassify_edge_samples(geometry), public.publish_edge_gaps(text[]) from public, anon, authenticated;

-- full rebuild = the same two steps over the whole estate
create or replace function public.refresh_edge_barriers() returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform private.require_admin();
  perform public.reclassify_edge_samples(null);
  perform public.publish_edge_gaps(null);
  return (select jsonb_build_object('checked', count(*) filter (where status is not null),
    'protected', count(*) filter (where status = 'protected'), 'uncertain', count(*) filter (where status = 'uncertain'),
    'gap', count(*) filter (where status = 'gap'), 'no_line', count(*) filter (where status is null))
    from public.estate_edge_samples where compartment is not null);
end $$;

-- barrier list rebuild: same as before, but the reasons come from barrier_reasons() (one rule everywhere)
create or replace function public.refresh_fire_barriers() returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare w jsonb; r jsonb;
begin
  perform private.require_admin();
  select coalesce(params->'barrier_default_width_m', '{}') into w from public.risk_config where id = 'site';
  with src as (
    select ro.id, 'roads' as source_table,
      case when lower(coalesce(ro.props->>'Type', ro.props->>'type', '')) = 'track' then 'track' else 'road' end as kind,
      ro.name, ro.geom,
      case lower(coalesce(ro.props->>'Type', ro.props->>'type', ''))
        when 'primary' then (w->>'road_primary')::numeric when 'secondary' then (w->>'road_secondary')::numeric
        when 'track' then (w->>'track')::numeric else (w->>'road_other')::numeric end as width,
      case when ro.props->>'Status' = 'Needs Opening' or not ro.passable then 'poor' else 'unknown' end as cond,
      case when ro.props->>'Status' = 'Needs Opening' then 'road needs opening (overgrown)' when not ro.passable then 'road marked not passable' else '' end as note
    from public.roads ro where ro.geom is not null
    union all
    select m.id, 'map_layers', m.layer, m.name, m.geom,
      case m.layer when 'firebreak' then (w->>'firebreak')::numeric when 'waterway' then (w->>'waterway')::numeric end,
      'unknown', ''
    from public.map_layers m where m.layer in ('firebreak', 'waterway', 'plantain_farm') and m.geom is not null
  )
  insert into public.fire_barriers as fb (id, kind, name, source_table, geom, width_m, width_basis, condition, note)
  select id, kind, coalesce(name, ''), source_table, st_transform(st_force2d(geom), 32630), width,
         case when kind = 'plantain_farm' then 'area' else 'assumed_default' end, cond, note
  from src
  on conflict (id) do update set kind = excluded.kind, name = excluded.name, geom = excluded.geom, source_table = excluded.source_table,
    width_m = case when fb.width_basis = 'assumed_default' then excluded.width_m else fb.width_m end,
    condition = case when fb.verified_on is null then excluded.condition else fb.condition end,
    note = case when fb.verified_on is null then excluded.note else fb.note end,
    updated_at = clock_timestamp();
  delete from public.fire_barriers b
  where not exists (select 1 from public.roads ro where ro.id = b.id)
    and not exists (select 1 from public.map_layers m where m.id = b.id and m.layer in ('firebreak', 'waterway', 'plantain_farm'));
  update public.fire_barriers b set why_uncertain = public.barrier_reasons(b), effective = cardinality(public.barrier_reasons(b)) = 0 where true;
  select jsonb_build_object('barriers', count(*), 'effective', count(*) filter (where effective),
    'by_kind', (select jsonb_object_agg(kind, n) from (select kind, count(*) n from public.fire_barriers group by kind) k))
  into r from public.fire_barriers;
  return r;
end $$;

-- ---------------------------------------------------------------- apply a check when it arrives
create or replace function public.on_barrier_check() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare g geometry; cpts text[];
begin
  update public.fire_barriers b set
    width_m = coalesce(new.width_m, b.width_m),
    width_basis = case when new.width_m is not null and b.width_basis <> 'area' then 'field' else b.width_basis end,
    continuity = new.continuity, condition = new.condition, note = new.note,
    verified_on = new.checked_at::date, verified_by = nullif(new.by_name, ''), updated_at = clock_timestamp()
  where b.id = new.barrier_id and (b.verified_on is null or b.verified_on <= new.checked_at::date)
  returning b.geom into g;
  if g is null then return new; end if; -- not a mapped barrier, or an older check arriving late: kept as history only
  update public.fire_barriers b set why_uncertain = public.barrier_reasons(b), effective = cardinality(public.barrier_reasons(b)) = 0
  where b.id = new.barrier_id;
  perform public.reclassify_edge_samples(g);
  select array_agg(distinct compartment) into cpts from public.estate_edge_samples where ray && g and compartment is not null;
  if cpts is not null then perform public.publish_edge_gaps(cpts); end if;
  return new;
end $$;
drop trigger if exists z_barrier_check_apply on public.barrier_checks;
create trigger z_barrier_check_apply after insert on public.barrier_checks for each row execute function public.on_barrier_check();

-- fill the blank shares left by the first build (0%, not unknown)
select public.publish_edge_gaps(null);
