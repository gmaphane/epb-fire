-- Satellite fire detections: alert within 1 km (13 Nov 2026).
--  * nearest_compartments(): nearest compartment, its block and the distance (m) for many points in one call, so the
--    FIRMS function stores each detection complete (phones receive it over Realtime the moment it is inserted, and a
--    row without its distance used to be skipped by the in-app alert).
--    Distance is geodesic (WGS84 spheroid) to the compartment outline, 0 = inside. The 5 nearest by bounding-box
--    order are re-ranked by true distance.
--  * call_alert_fn(): wait up to 60 s for the function (10 s cut off some FIRMS runs). pg_net is asynchronous, so this
--    never delays saving a fire report.
set search_path = public, extensions;

create or replace function public.nearest_compartments(p jsonb)
returns table (i int, code text, block text, distance_m double precision)
language sql stable set search_path = public, extensions as $$
  select (e->>'i')::int, n.code, n.block, n.d
  from jsonb_array_elements(p) e
  cross join lateral (select st_setsrid(st_makepoint((e->>'lon')::float8, (e->>'lat')::float8), 4326) as pt) q
  cross join lateral (
    select c.code, c.block, st_distance(c.geom::geography, q.pt::geography) as d
    from (select code, block, geom from public.compartments order by geom <-> q.pt limit 5) c
    order by 3 limit 1
  ) n $$;
revoke execute on function public.nearest_compartments(jsonb) from public, anon;
grant execute on function public.nearest_compartments(jsonb) to authenticated, service_role;

create or replace function public.call_alert_fn(fn text, body jsonb) returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform net.http_post(
    url := 'https://qmgialosxnlvyvzpvgiv.supabase.co/functions/v1/' || fn,
    body := body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-epb-hook', public.app_key_get('hook_secret')),
    timeout_milliseconds := 60000);
exception when others then
  raise warning 'alert call % failed: %', fn, sqlerrm;  -- an alert problem must never block saving a fire report
end $$;
revoke execute on function public.call_alert_fn(text, jsonb) from public, anon, authenticated;
