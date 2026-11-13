-- Supabase blocks DELETE without a WHERE clause for requests through the API (pg_safeupdate), so rebuilding from the
-- loader (npm run load:barriers) stopped at "delete from estate_edge_samples". Same function, with an explicit WHERE.
set search_path = public, extensions;

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
  delete from public.estate_edge_samples where true;
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
