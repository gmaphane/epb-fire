-- Compartment fire risk, stages 0 and 2 (13 Nov 2026): estate edge, edge compartments, 2 km edge zones,
-- potential fire barriers, and gaps along the estate edge. Detections near the estate get a "barriers in between" check.
--
-- All distances and buffers are in UTM zone 30N (EPSG:32630); stored map layers are WGS84 GeoJSON for the phones.
-- Every threshold is in public.risk_config (one row, id 'site'); re-run public.refresh_fire_risk_layers() after
-- changing settings, compartments, roads, firebreaks, waterways or plantain farms, or after verifying a barrier.
--
-- Principles:
--  * A mapped feature is only a POTENTIAL barrier. It counts as effective only when checked in the field (recently),
--    measured at least min_effective_width_m wide, continuous and in good/fair condition. Everything else is
--    "uncertain", with the reasons listed. Nothing in today's data is verified, so nothing is "protected" yet.
--  * The estate outline is the compartments merged (hairline gaps closed); enclosed non-compartment land of
--    enclave_min_ha or more counts as outside (it can be a fire source), smaller pockets are filled in.
set search_path = public, extensions;

-- ---------------------------------------------------------------- settings
create table if not exists public.risk_config (
  id text primary key default 'site',
  params jsonb not null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.risk_config enable row level security;
drop policy if exists risk_config_read on public.risk_config;
create policy risk_config_read on public.risk_config for select to authenticated using (true);
drop policy if exists risk_config_admin on public.risk_config;
create policy risk_config_admin on public.risk_config for all to authenticated using (private.my_role() = 'admin') with check (private.my_role() = 'admin');
insert into public.risk_config (id, params) values ('site', '{
  "close_gaps_m": 25,
  "enclave_min_ha": 10,
  "edge_tolerance_m": 50,
  "edge_min_length_m": 100,
  "buffer_m": 2000,
  "sample_step_m": 100,
  "barrier_default_width_m": { "firebreak": 10, "road_primary": 8, "road_secondary": 6, "road_other": 5, "track": 4, "waterway": 5 },
  "min_effective_width_m": 10,
  "verified_max_age_days": 365,
  "fan_half_width_m": 300,
  "fan_step_m": 100,
  "detection_check_within_m": 2000,
  "_notes": {
    "close_gaps_m": "hairline gaps between compartments closed when drawing the estate outline (as in the War Room pipeline)",
    "enclave_min_ha": "enclosed non-compartment land this large or larger counts as outside the estate (possible fire source)",
    "edge_tolerance_m": "a compartment owns the estate edge within this distance",
    "edge_min_length_m": "edge compartment = owns at least this much of the estate edge",
    "buffer_m": "outer zone width used for edge zones and for the outward check lines",
    "sample_step_m": "spacing of check points along the estate edge",
    "barrier_default_width_m": "ASSUMED widths where no width is recorded (none of the current layers has one)",
    "min_effective_width_m": "a barrier narrower than this is never counted as effective",
    "verified_max_age_days": "a field check older than this no longer counts",
    "fan_half_width_m": "detection check: lines to the compartment edge up to this far either side of the nearest point",
    "fan_step_m": "detection check: spacing of those lines",
    "detection_check_within_m": "detections this close to a compartment get the barrier check"
  }
}'::jsonb) on conflict (id) do nothing;

create or replace function public.risk_num(k text, dflt numeric) returns numeric language sql stable set search_path = public as $$
  select coalesce((select (params->>k)::numeric from public.risk_config where id = 'site'), dflt) $$;

-- only an admin (or the server itself: SQL editor, service role, scheduler) may rebuild the layers
create or replace function private.require_admin() returns void language plpgsql stable set search_path = public as $$
begin
  if auth.uid() is not null and private.my_role() is distinct from 'admin' then
    raise exception 'Only an admin can rebuild fire-risk layers' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------- compartments: edge facts (kept out of props so
-- reloading layers doesn't wipe them; refresh again after reloading)
alter table public.compartments
  add column if not exists edge boolean not null default false,
  add column if not exists edge_length_m numeric,
  add column if not exists edge_protected_pct numeric,
  add column if not exists edge_uncertain_pct numeric,
  add column if not exists edge_gap_pct numeric,
  add column if not exists edge_checked_at timestamptz;

-- detections: what lies between a detection and its compartment (computed before insert by the FIRMS function)
alter table public.detections add column if not exists barriers jsonb;

-- ---------------------------------------------------------------- potential barriers
create table if not exists public.fire_barriers (
  id uuid primary key,                       -- = the source row's id
  kind text not null check (kind in ('firebreak', 'road', 'track', 'waterway', 'plantain_farm')),
  name text not null default '',
  source_table text not null,
  geom geometry(Geometry, 32630) not null,
  width_m numeric,                            -- lines; areas use the width actually crossed
  width_basis text not null default 'assumed_default' check (width_basis in ('assumed_default', 'attribute', 'field', 'imagery', 'area')),
  continuity text not null default 'unknown' check (continuity in ('continuous', 'broken', 'unknown')),
  condition text not null default 'unknown' check (condition in ('good', 'fair', 'poor', 'unknown')),
  verified_on date,
  verified_by text,
  note text not null default '',
  effective boolean not null default false,
  why_uncertain text[] not null default '{}',
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists fire_barriers_geom on public.fire_barriers using gist (geom);
alter table public.fire_barriers enable row level security;
drop policy if exists fire_barriers_read on public.fire_barriers;
create policy fire_barriers_read on public.fire_barriers for select to authenticated using (true);
drop policy if exists fire_barriers_admin on public.fire_barriers;
create policy fire_barriers_admin on public.fire_barriers for update to authenticated using (private.my_role() = 'admin') with check (private.my_role() = 'admin');

do $$ begin
  create type public.barrier_t as (id uuid, kind text, name text, geom geometry, width_m numeric, effective boolean);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- core logic (pure: no table reads; see supabase/tests)
-- One check line ("ray") against a set of barriers:
--   protected = crosses an effective barrier (areas: crossed at least min_w wide);
--   uncertain = crosses only barriers that are not (yet) effective;
--   gap       = crosses no mapped barrier at all.
create or replace function public.classify_ray(ray geometry, bs public.barrier_t[], min_w numeric)
returns table (status text, crossed jsonb) language sql immutable set search_path = public, extensions as $$
  with x as (
    select b.id, b.kind, b.name, b.effective,
      case when geometrytype(b.geom) in ('POLYGON', 'MULTIPOLYGON') then st_length(st_intersection(b.geom, ray))::numeric else b.width_m end as w
    from unnest(bs) b
    where st_intersects(b.geom, ray)
  ), y as (select *, effective and coalesce(w, 0) >= min_w as eff from x)
  select case when bool_or(eff) then 'protected' when count(*) > 0 then 'uncertain' else 'gap' end,
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'name', name, 'width_m', round(w), 'effective', eff) order by kind, name), '[]'::jsonb)
  from y $$;

-- Lines from a source point to the facing edge of a compartment: to the nearest point on its outline and to points
-- every step_m along the outline up to half_m either side. Empty when the source is inside the compartment.
create or replace function public.approach_rays(src geometry, target geometry, half_m numeric, step_m numeric)
returns geometry[] language plpgsql immutable set search_path = public, extensions as $$
declare ring geometry; q geometry; len float8; f float8; fk float8; n int; out geometry[] := '{}';
begin
  if st_intersects(src, target) then return out; end if;
  select d.geom into ring from st_dump(st_boundary(target)) d order by st_distance(d.geom, src) limit 1;
  q := st_closestpoint(ring, src);
  len := st_length(ring);
  f := st_linelocatepoint(ring, q);
  n := floor(half_m / step_m);
  for k in -n..n loop
    if abs(k * step_m) > len / 2 then continue; end if;
    fk := f + k * step_m / len;
    fk := fk - floor(fk); -- outlines are closed rings: wrap round
    out := out || st_makeline(src, st_lineinterpolatepoint(ring, fk));
  end loop;
  return out;
end $$;

-- Summary for a source point and a compartment, from the rays above. Overall: gap if any line is open (fire can
-- reach the edge without crossing anything mapped), else uncertain if any line crosses only uncertain barriers,
-- else protected.
create or replace function public.approach_summary(rays geometry[], bs public.barrier_t[], min_w numeric)
returns jsonb language sql immutable set search_path = public, extensions as $$
  with r as (select c.status, c.crossed from unnest(rays) ray cross join lateral public.classify_ray(ray, bs, min_w) c),
  b as (select e->>'id' id, e->>'kind' kind, e->>'name' name, max((e->>'width_m')::numeric) width_m, bool_or((e->>'effective')::boolean) effective, count(*) n
        from r, jsonb_array_elements(r.crossed) e group by 1, 2, 3)
  select case when coalesce(array_length(rays, 1), 0) = 0 then jsonb_build_object('status', 'inside')
    else jsonb_build_object(
      'status', case when (select count(*) from r where status = 'gap') > 0 then 'gap' when (select count(*) from r where status = 'uncertain') > 0 then 'uncertain' else 'protected' end,
      'rays', (select count(*) from r),
      'gap_rays', (select count(*) from r where status = 'gap'),
      'uncertain_rays', (select count(*) from r where status = 'uncertain'),
      'protected_rays', (select count(*) from r where status = 'protected'),
      'barriers', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'name', name, 'width_m', width_m, 'effective', effective, 'rays', n) order by effective desc, n desc) from b), '[]'::jsonb))
  end $$;

-- ---------------------------------------------------------------- barrier list from the existing layers
create or replace function public.refresh_fire_barriers() returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare w jsonb; minw numeric := public.risk_num('min_effective_width_m', 10); maxage int := public.risk_num('verified_max_age_days', 365); r jsonb;
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
  -- source removed → barrier removed
  delete from public.fire_barriers b
  where not exists (select 1 from public.roads ro where ro.id = b.id)
    and not exists (select 1 from public.map_layers m where m.id = b.id and m.layer in ('firebreak', 'waterway', 'plantain_farm'));
  -- effective only when nothing argues against it; the reasons are kept and shown
  update public.fire_barriers b set why_uncertain = x.why, effective = cardinality(x.why) = 0
  from (
    select id, array_remove(array[
      case when verified_on is null then 'not checked in the field'
           when verified_on < current_date - maxage then format('last checked %s (over %s days ago)', verified_on, maxage) end,
      case when width_basis = 'assumed_default' then format('width assumed %s m, not measured', width_m) end,
      case when width_m is not null and width_m < minw then format('narrower than %s m', minw) end,
      case when continuity = 'broken' then 'broken: has gaps along it'
           when continuity = 'unknown' and verified_on is not null then 'continuity not recorded' end,
      case when condition = 'poor' then coalesce(nullif(note, ''), 'poor condition')
           when condition = 'unknown' and verified_on is not null then 'condition not recorded' end
    ], null) as why
    from public.fire_barriers
  ) x where x.id = b.id;
  select jsonb_build_object('barriers', count(*), 'effective', count(*) filter (where effective),
    'by_kind', (select jsonb_object_agg(kind, n) from (select kind, count(*) n from public.fire_barriers group by kind) k))
  into r from public.fire_barriers;
  return r;
end $$;

-- ---------------------------------------------------------------- estate outline, edge compartments, edge zones
create table if not exists public.estate_edge_samples (
  id bigint generated always as identity primary key,
  ring int not null,
  seq int not null,
  compartment text,                                  -- nearest compartment within edge_tolerance_m (null: none)
  geom geometry(Point, 32630) not null,              -- check point on the estate edge
  section geometry(LineString, 32630) not null,      -- the stretch of edge it stands for
  ray geometry(LineString, 32630),                   -- outward check line through the outer zone
  status text,                                       -- protected | uncertain | gap
  crossed jsonb,
  checked_at timestamptz
);
create index if not exists estate_edge_samples_ray on public.estate_edge_samples using gist (ray);
alter table public.estate_edge_samples enable row level security;
drop policy if exists estate_edge_samples_read on public.estate_edge_samples;
create policy estate_edge_samples_read on public.estate_edge_samples for select to authenticated using (private.my_role() in ('coordinator', 'manager', 'admin'));

create or replace function public.estate_outline_utm() returns geometry language sql stable set search_path = public, extensions as $$
  select st_transform(geom, 32630) from public.map_layers where layer = 'estate_boundary' limit 1 $$;

create or replace function public.refresh_estate_edge() returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  close_m numeric := public.risk_num('close_gaps_m', 25);
  encl numeric := public.risk_num('enclave_min_ha', 10) * 1e4;
  tol numeric := public.risk_num('edge_tolerance_m', 50);
  minlen numeric := public.risk_num('edge_min_length_m', 100);
  buf numeric := public.risk_num('buffer_m', 2000);
  step numeric := public.risk_num('sample_step_m', 100);
  est geometry; zone geometry; rg record; len float8; n int; f0 float8; f1 float8; p geometry; t1 geometry; t2 geometry;
  dx float8; dy float8; nx float8; ny float8; ray geometry; nring int := 0; cid text;
begin
  perform private.require_admin();
  -- 1) outline: merge, close hairline gaps, fill pockets smaller than enclave_min_ha
  select st_buffer(st_union(st_buffer(st_transform(geom, 32630), close_m)), -close_m) into est from public.compartments where geom is not null;
  select st_multi(st_collect(st_makepolygon(st_exteriorring(d.geom),
           coalesce(array(select st_interiorringn(d.geom, k) from generate_series(1, st_numinteriorrings(d.geom)) k
                          where st_area(st_makepolygon(st_interiorringn(d.geom, k))) >= encl), '{}'::geometry[]))))
    into est from st_dump(est) d;
  zone := st_difference(st_buffer(est, buf), est);
  insert into public.map_layers (id, layer, name, geojson, props)
  values (md5('estate_boundary')::uuid, 'estate_boundary', 'Estate edge (outline of the compartments)',
          st_asgeojson(st_transform(est, 4326), 7)::jsonb,
          jsonb_build_object('area_ha', round((st_area(est) / 1e4)::numeric), 'perimeter_km', round((st_perimeter(est) / 1000)::numeric, 1),
            'parts', st_numgeometries(est), 'basis', format('compartments merged, gaps under %s m closed, enclosed land under %s ha filled in', close_m * 2, encl / 1e4)))
  on conflict (id) do update set geojson = excluded.geojson, props = excluded.props, name = excluded.name;

  -- 2) check points every sample_step_m along every ring of the outline (outer edges and enclave rims)
  delete from public.estate_edge_samples;
  for rg in select (st_dumprings(d.geom)).geom as g from st_dump(est) d loop
    nring := nring + 1;
    len := st_perimeter(rg.g);
    n := greatest(1, floor(len / step));
    for k in 0..n - 1 loop
      f0 := k::float8 / n; f1 := (k + 1)::float8 / n;
      p := st_lineinterpolatepoint(st_exteriorring(rg.g), (f0 + f1) / 2);
      -- outward direction: perpendicular to the edge, on the side that is outside the estate
      t1 := st_lineinterpolatepoint(st_exteriorring(rg.g), greatest(0, (f0 + f1) / 2 - 5 / len));
      t2 := st_lineinterpolatepoint(st_exteriorring(rg.g), least(1, (f0 + f1) / 2 + 5 / len));
      dx := st_x(t2) - st_x(t1); dy := st_y(t2) - st_y(t1);
      nx := dy / greatest(sqrt(dx * dx + dy * dy), 1e-9); ny := -dx / greatest(sqrt(dx * dx + dy * dy), 1e-9);
      if st_intersects(est, st_translate(p, nx * 3, ny * 3)) then nx := -nx; ny := -ny; end if;
      -- check line: outward through the outer zone, stopping where it meets estate land again
      ray := st_makeline(p, st_translate(p, nx * buf, ny * buf));
      select g into ray from (select (st_dump(st_intersection(ray, st_buffer(zone, 0.5)))).geom g) x
        where geometrytype(g) = 'LINESTRING' order by st_distance(g, p) limit 1;
      select c.code into cid from public.compartments c
        where st_dwithin(st_transform(c.geom, 32630), p, tol) order by st_distance(st_transform(c.geom, 32630), p) limit 1;
      insert into public.estate_edge_samples (ring, seq, compartment, geom, section, ray)
      values (nring, k, cid, p, st_linesubstring(st_exteriorring(rg.g), f0, f1), ray);
    end loop;
  end loop;

  -- 3) edge compartments
  update public.compartments c set edge = coalesce(s.len, 0) >= minlen, edge_length_m = round(coalesce(s.len, 0)::numeric)
  from (select c2.code, sum(st_length(e.section)) len from public.compartments c2
        left join public.estate_edge_samples e on e.compartment = c2.code group by c2.code) s
  where s.code = c.code;

  -- 4) edge zones: the outer zone split by the nearest edge check point's compartment
  with pts as (select compartment, geom from public.estate_edge_samples where compartment is not null),
  cells as (select (st_dump(st_voronoipolygons(st_collect(geom), 0, st_buffer(est, buf + 200)))).geom cell from pts),
  owned as (select p.compartment, st_union(c.cell) g from cells c join pts p on st_intersects(c.cell, p.geom) group by p.compartment),
  z as (select o.compartment, st_multi(st_collectionextract(st_intersection(o.g, zone), 3)) g from owned o)
  insert into public.map_layers (id, layer, name, geojson, props)
  select md5('edge_zone|' || compartment)::uuid, 'edge_zone', format('%s · outer %s km zone', compartment, buf / 1000),
         st_asgeojson(st_transform(st_simplifypreservetopology(g, 2), 4326), 7)::jsonb,
         jsonb_build_object('compartment', compartment, 'area_ha', round((st_area(g) / 1e4)::numeric), 'buffer_m', buf)
  from z where not st_isempty(g)
  on conflict (id) do update set geojson = excluded.geojson, props = excluded.props, name = excluded.name;
  delete from public.map_layers m where m.layer = 'edge_zone'
    and not exists (select 1 from public.compartments c where c.edge and md5('edge_zone|' || c.code)::uuid = m.id);

  return jsonb_build_object('outline_ha', round((st_area(est) / 1e4)::numeric), 'parts', st_numgeometries(est), 'rings', nring,
    'check_points', (select count(*) from public.estate_edge_samples),
    'edge_compartments', (select count(*) from public.compartments where edge),
    'edge_zones', (select count(*) from public.map_layers where layer = 'edge_zone'));
end $$;

-- ---------------------------------------------------------------- gaps along the edge
create or replace function public.refresh_edge_barriers() returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare minw numeric := public.risk_num('min_effective_width_m', 10);
begin
  perform private.require_admin();
  update public.estate_edge_samples s set status = c.status, crossed = c.crossed, checked_at = now()
  from public.estate_edge_samples s2
  cross join lateral public.classify_ray(s2.ray,
    array(select row(b.id, b.kind, b.name, b.geom, b.width_m, b.effective)::public.barrier_t from public.fire_barriers b where b.geom && s2.ray), minw) c
  where s.id = s2.id and s2.ray is not null;
  update public.estate_edge_samples set status = null, crossed = null, checked_at = now() where ray is null;

  update public.compartments c set
    edge_protected_pct = case when c.edge then x.p end, edge_uncertain_pct = case when c.edge then x.u end,
    edge_gap_pct = case when c.edge then x.g end, edge_checked_at = now()
  from (select compartment,
          round(100 * sum(st_length(section)) filter (where status = 'protected') / nullif(sum(st_length(section)) filter (where status is not null), 0)) p,
          round(100 * sum(st_length(section)) filter (where status = 'uncertain') / nullif(sum(st_length(section)) filter (where status is not null), 0)) u,
          round(100 * sum(st_length(section)) filter (where status = 'gap') / nullif(sum(st_length(section)) filter (where status is not null), 0)) g
        from public.estate_edge_samples where compartment is not null group by compartment) x
  where x.compartment = c.code;

  -- map: stretches of edge with no mapped barrier (gap) or only uncertain ones, per compartment
  with s as (select compartment, status, st_linemerge(st_union(section)) g, sum(st_length(section)) len
             from public.estate_edge_samples where compartment is not null and status in ('gap', 'uncertain') group by 1, 2)
  insert into public.map_layers (id, layer, name, geojson, props)
  select md5('edge_gap|' || compartment || '|' || status)::uuid, 'edge_gap',
         format('%s · %s', compartment, case status when 'gap' then 'no mapped barrier' else 'only unverified barriers' end),
         st_asgeojson(st_transform(g, 4326), 7)::jsonb,
         jsonb_build_object('compartment', compartment, 'status', status, 'length_m', round(len::numeric))
  from s
  on conflict (id) do update set geojson = excluded.geojson, props = excluded.props, name = excluded.name;
  delete from public.map_layers m where m.layer = 'edge_gap' and not exists (
    select 1 from public.estate_edge_samples e where e.compartment is not null and e.status in ('gap', 'uncertain')
      and md5('edge_gap|' || e.compartment || '|' || e.status)::uuid = m.id);

  return (select jsonb_build_object('checked', count(*) filter (where status is not null),
    'protected', count(*) filter (where status = 'protected'), 'uncertain', count(*) filter (where status = 'uncertain'),
    'gap', count(*) filter (where status = 'gap'), 'no_line', count(*) filter (where status is null))
    from public.estate_edge_samples where compartment is not null);
end $$;

create or replace function public.refresh_fire_risk_layers() returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform private.require_admin();
  return jsonb_build_object('barriers', public.refresh_fire_barriers(), 'edge', public.refresh_estate_edge(), 'gaps', public.refresh_edge_barriers());
end $$;

-- ---------------------------------------------------------------- detections: what lies in between
-- p: [{i, lat, lon, code}] → per item the approach summary from the detection to that compartment's facing edge,
-- with each barrier's reasons for being uncertain.
create or replace function public.barriers_between(p jsonb) returns table (i int, summary jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
declare e jsonb; src geometry; tgt geometry; rays geometry[]; s jsonb; bs public.barrier_t[];
  half numeric := public.risk_num('fan_half_width_m', 300); step numeric := public.risk_num('fan_step_m', 100); minw numeric := public.risk_num('min_effective_width_m', 10);
begin
  for e in select * from jsonb_array_elements(p) loop
    i := (e->>'i')::int;
    src := st_transform(st_setsrid(st_makepoint((e->>'lon')::float8, (e->>'lat')::float8), 4326), 32630);
    select st_transform(geom, 32630) into tgt from public.compartments where code = e->>'code';
    if tgt is null then summary := null; return next; continue; end if;
    rays := public.approach_rays(src, tgt, half, step);
    bs := array(select row(b.id, b.kind, b.name, b.geom, b.width_m, b.effective)::public.barrier_t from public.fire_barriers b
                where b.geom && st_envelope(st_collect(coalesce(rays, '{}'::geometry[]))));
    s := public.approach_summary(rays, bs, minw);
    -- add each barrier's reasons
    if s ? 'barriers' then
      s := jsonb_set(s, '{barriers}', coalesce((select jsonb_agg(x.v || jsonb_build_object('why', to_jsonb(fb.why_uncertain), 'width_basis', fb.width_basis))
                                               from jsonb_array_elements(s->'barriers') x(v) left join public.fire_barriers fb on fb.id = (x.v->>'id')::uuid), '[]'::jsonb));
    end if;
    summary := s || jsonb_build_object('compartment', e->>'code', 'checked_at', now());
    return next;
  end loop;
end $$;

revoke execute on function public.refresh_fire_barriers(), public.refresh_estate_edge(), public.refresh_edge_barriers(), public.refresh_fire_risk_layers(), public.barriers_between(jsonb) from public, anon;
grant execute on function public.refresh_fire_barriers(), public.refresh_estate_edge(), public.refresh_edge_barriers(), public.refresh_fire_risk_layers(), public.barriers_between(jsonb) to authenticated, service_role;
