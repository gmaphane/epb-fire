-- Tests for the barrier-between logic (supabase/migrations/20261113170000_estate_edge_barriers.sql).
-- Pure: made-up geometry in UTM 30N metres, reads no tables except one real-distance check, changes nothing.
-- Run in the SQL editor (or any SQL client). Success: a single row "all barrier tests passed". Failure: an error naming the test.
do $$
declare
  cpt geometry := st_geomfromtext('POLYGON((0 0,1000 0,1000 1000,0 1000,0 0))', 32630);   -- a 1 km square compartment
  src geometry := st_setsrid(st_makepoint(500, -500), 32630);                              -- detection 500 m south of it
  rays geometry[];
  s jsonb;
  road_long public.barrier_t := (gen_random_uuid(), 'road', 'Long road', st_geomfromtext('LINESTRING(-1000 -250,2000 -250)', 32630), 8, false)::public.barrier_t;
  road_short public.barrier_t := (gen_random_uuid(), 'road', 'Short road', st_geomfromtext('LINESTRING(400 -250,600 -250)', 32630), 8, false)::public.barrier_t;
  fb_ok public.barrier_t := (gen_random_uuid(), 'firebreak', 'Checked firebreak', st_geomfromtext('LINESTRING(-1000 -250,2000 -250)', 32630), 12, true)::public.barrier_t;
  fb_narrow public.barrier_t := (gen_random_uuid(), 'firebreak', 'Narrow firebreak', st_geomfromtext('LINESTRING(-1000 -250,2000 -250)', 32630), 8, true)::public.barrier_t;
  edge_break public.barrier_t := (gen_random_uuid(), 'firebreak', 'Break on the edge', st_geomfromtext('LINESTRING(-100 0,1100 0)', 32630), 10, false)::public.barrier_t;
  farm_wide public.barrier_t := (gen_random_uuid(), 'plantain_farm', 'Wide farm', st_geomfromtext('POLYGON((-1000 -300,2000 -300,2000 -280,-1000 -280,-1000 -300))', 32630), null, true)::public.barrier_t;
  farm_thin public.barrier_t := (gen_random_uuid(), 'plantain_farm', 'Thin farm', st_geomfromtext('POLYGON((-1000 -300,2000 -300,2000 -295,-1000 -295,-1000 -300))', 32630), null, true)::public.barrier_t;
  p geometry;
  d_geo float8; d_utm float8;
begin
  -- fan of check lines: nearest point + every 100 m up to 300 m either side = 7 lines, all ending on the compartment edge
  rays := public.approach_rays(src, cpt, 300, 100);
  assert array_length(rays, 1) = 7, format('fan: expected 7 lines, got %s', array_length(rays, 1));
  foreach p in array rays loop
    assert st_distance(st_endpoint(p), st_boundary(cpt)) < 0.01, 'fan: a line does not end on the compartment edge';
  end loop;
  assert abs(least(st_length(rays[1]), st_length(rays[4]), st_length(rays[7])) - 500) < 0.01, 'fan: nearest line should be 500 m';

  -- around a corner the fan wraps round the closed outline
  rays := public.approach_rays(st_setsrid(st_makepoint(-300, -300), 32630), cpt, 300, 100);
  assert array_length(rays, 1) = 7, 'corner: expected 7 lines';
  foreach p in array rays loop
    assert st_distance(st_endpoint(p), st_boundary(cpt)) < 0.01, 'corner: a line does not end on the edge';
  end loop;

  -- inside the compartment: no lines, status inside
  rays := public.approach_rays(st_setsrid(st_makepoint(500, 500), 32630), cpt, 300, 100);
  assert coalesce(array_length(rays, 1), 0) = 0, 'inside: expected no lines';
  assert public.approach_summary(rays, '{}', 10)->>'status' = 'inside', 'inside: status';

  rays := public.approach_rays(src, cpt, 300, 100);
  -- nothing mapped in between: gap on every line
  s := public.approach_summary(rays, '{}', 10);
  assert s->>'status' = 'gap' and (s->>'gap_rays')::int = 7, format('no barriers: %s', s);

  -- an unverified road across the whole approach: uncertain (never assumed to work)
  s := public.approach_summary(rays, array[road_long], 10);
  assert s->>'status' = 'uncertain' and (s->>'uncertain_rays')::int = 7, format('unverified road: %s', s);
  assert s->'barriers'->0->>'name' = 'Long road' and (s->'barriers'->0->>'rays')::int = 7, format('unverified road listed: %s', s);

  -- a short road covers only part of the approach: the open lines make it a gap
  s := public.approach_summary(rays, array[road_short], 10);
  assert s->>'status' = 'gap' and (s->>'gap_rays')::int > 0 and (s->>'uncertain_rays')::int > 0, format('short road: %s', s);

  -- a checked, wide-enough, continuous firebreak across the approach: protected
  s := public.approach_summary(rays, array[fb_ok], 10);
  assert s->>'status' = 'protected' and (s->>'protected_rays')::int = 7, format('checked firebreak: %s', s);

  -- checked but narrower than the minimum: not protected
  s := public.approach_summary(rays, array[fb_narrow], 10);
  assert s->>'status' = 'uncertain', format('narrow firebreak: %s', s);

  -- protected wins over uncertain on the same line; the list shows both
  s := public.approach_summary(rays, array[road_long, fb_ok], 10);
  assert s->>'status' = 'protected' and jsonb_array_length(s->'barriers') = 2, format('road + firebreak: %s', s);

  -- a break running along the compartment edge itself counts as in between
  s := public.approach_summary(rays, array[edge_break], 10);
  assert s->>'status' = 'uncertain', format('break on the edge: %s', s);

  -- areas (plantain): the width actually crossed decides; 20 m crossed ≥ 10 m minimum, 5 m is not
  s := public.approach_summary(rays, array[farm_wide], 10);
  assert s->>'status' = 'protected', format('wide farm: %s', s);
  assert (s->'barriers'->0->>'width_m')::numeric between 19 and 21, format('wide farm crossing width: %s', s);
  s := public.approach_summary(rays, array[farm_thin], 10);
  assert s->>'status' = 'uncertain', format('thin farm: %s', s);

  -- a barrier beside, not across, the approach is ignored
  s := public.approach_summary(rays, array[(gen_random_uuid(), 'road', 'Beside', st_geomfromtext('LINESTRING(1500 -1000,1500 2000)', 32630), 8, true)::public.barrier_t], 10);
  assert s->>'status' = 'gap' and jsonb_array_length(s->'barriers') = 0, format('beside: %s', s);

  -- single line: classify_ray directly
  assert (select status from public.classify_ray(rays[4], array[road_long], 10)) = 'uncertain', 'classify_ray uncertain';
  assert (select status from public.classify_ray(rays[4], array[fb_ok], 10)) = 'protected', 'classify_ray protected';
  assert (select status from public.classify_ray(rays[4], '{}', 10)) = 'gap', 'classify_ray gap';

  -- distances: geodesic (used for the 1 km alert) and UTM 30N agree to within 0.1% on the estate
  select st_distance(c.geom::geography, st_setsrid(st_makepoint(-0.85, 6.80), 4326)::geography),
         st_distance(st_transform(c.geom, 32630), st_transform(st_setsrid(st_makepoint(-0.85, 6.80), 4326), 32630))
    into d_geo, d_utm from public.compartments c order by c.geom <-> st_setsrid(st_makepoint(-0.85, 6.80), 4326) limit 1;
  assert d_geo > 0 and abs(d_geo - d_utm) / d_geo < 0.001, format('geodesic %s m vs UTM %s m', d_geo, d_utm);

  raise notice 'all barrier tests passed';
end $$;
select 'all barrier tests passed' as result;
