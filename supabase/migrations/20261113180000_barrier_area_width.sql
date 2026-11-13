-- Area barriers (plantain farms): a check line crossing at an angle measures more than the strip is wide, so a strip
-- narrower than min_effective_width_m could pass. The crossing width is now capped at the area's real thickness
-- (diameter of the largest circle that fits inside it), and summaries report the narrowest crossing, not the widest.
set search_path = public, extensions;

create or replace function public.classify_ray(ray geometry, bs public.barrier_t[], min_w numeric)
returns table (status text, crossed jsonb) language sql immutable set search_path = public, extensions as $$
  with x as (
    select b.id, b.kind, b.name, b.effective,
      case when geometrytype(b.geom) in ('POLYGON', 'MULTIPOLYGON')
           then least(st_length(st_intersection(b.geom, ray)), 2 * (st_maximuminscribedcircle(b.geom)).radius)::numeric
           else b.width_m end as w
    from unnest(bs) b
    where st_intersects(b.geom, ray)
  ), y as (select *, effective and coalesce(w, 0) >= min_w as eff from x)
  select case when bool_or(eff) then 'protected' when count(*) > 0 then 'uncertain' else 'gap' end,
         coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'name', name, 'width_m', round(w), 'effective', eff) order by kind, name), '[]'::jsonb)
  from y $$;

create or replace function public.approach_summary(rays geometry[], bs public.barrier_t[], min_w numeric)
returns jsonb language sql immutable set search_path = public, extensions as $$
  with r as (select c.status, c.crossed from unnest(rays) ray cross join lateral public.classify_ray(ray, bs, min_w) c),
  b as (select e->>'id' id, e->>'kind' kind, e->>'name' name, min((e->>'width_m')::numeric) width_m, bool_or((e->>'effective')::boolean) effective, count(*) n
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
