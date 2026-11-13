-- Fuel dryness: send Copernicus valid shapes. Converting to UTM and rounding to 0.1 m made some shapes (A048, two
-- edge zones) self-intersect, which the Statistical API rejects (COMMON_BAD_PAYLOAD, input->bounds->geometry).
-- Now: convert, repair (ST_MakeValid), keep polygons only, and write 2 decimals (1 cm).
-- Run in the Supabase SQL Editor. Safe to run twice.
set search_path = public, extensions;

create or replace function public.dryness_zones() returns table (id text, zone_kind text, compartment text, block text, area_m2 float8, geojson jsonb)
language sql stable security definer set search_path = public, extensions as $$
  with z as (
    select 'compartment|' || c.code as id, 'compartment' as zone_kind, c.code as compartment, c.block, st_transform(c.geom, 32630) as g
    from public.compartments c where c.geom is not null
    union all
    select 'edge_zone|' || (m.props->>'compartment'), 'edge_zone', m.props->>'compartment', c.block, st_transform(m.geom, 32630)
    from public.map_layers m left join public.compartments c on c.code = m.props->>'compartment'
    where m.layer = 'edge_zone' and m.geom is not null
  ), v as (
    select id, zone_kind, compartment, block, st_multi(st_collectionextract(st_makevalid(st_snaptogrid(g, 0.01)), 3)) as g from z
  )
  select id, zone_kind, compartment, block, st_area(g), st_asgeojson(g, 2)::jsonb
  from v where not st_isempty(g) $$;
revoke execute on function public.dryness_zones() from public, anon, authenticated;
grant execute on function public.dryness_zones() to service_role;
