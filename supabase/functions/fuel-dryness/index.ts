// Fuel dryness per compartment and per 2 km edge zone, weekly (Monday 04:30 UTC, pg_cron) or on demand (admin).
// Sentinel-2 L2A via the Copernicus Data Space Ecosystem (Sentinel Hub Statistical + Catalog APIs).
//
// For every zone: median NDMI of clear pixels over 7 days; if under min_usable_pct of the zone was clear, 14 days,
// then 30 days; still not enough → "unknown" (never "low"). Each zone records its window, cadence, clear share
// and the Sentinel-2 passes in that window. A zone whose request fails keeps its previous result (it will show as
// stale) and the run is marked "partial" with the errors.
// Runs in the background (EdgeRuntime.waitUntil) and answers at once with the run id: the work takes ~1 min.
//
// Credentials: edge secrets CDSE_CLIENT_ID / CDSE_CLIENT_SECRET, or private.app_keys 'cdse_client_id' / 'cdse_client_secret'.
import { appKey, caller, json, sb } from '../_shared/alerts.ts';
import { chooseWindow, DEFAULT_DRYNESS, drynessClass, evalscript, readStats, usablePct, type Attempt, type DrynessParams } from '../_shared/dryness.ts';

const SH = 'https://sh.dataspace.copernicus.eu';
const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const ESTATE_BBOX = [-1.07, 6.73, -0.74, 6.92]; // estate + 2 km, WGS84 (for the list of passes)
const UTM = 'http://www.opengis.net/def/crs/EPSG/0/32630';
const CONCURRENCY = 6;

type Zone = { id: string; zone_kind: string; compartment: string; block: string | null; area_m2: number; geojson: unknown };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const iso = (d: Date) => d.toISOString().slice(0, 19) + 'Z';

async function token(): Promise<string> {
  const id = Deno.env.get('CDSE_CLIENT_ID') || (await appKey('cdse_client_id'));
  const secret = Deno.env.get('CDSE_CLIENT_SECRET') || (await appKey('cdse_client_secret'));
  if (!id || !secret) throw new Error('Copernicus credentials not set (CDSE_CLIENT_ID / CDSE_CLIENT_SECRET)');
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Copernicus sign-in failed: HTTP ${r.status}`);
  return j.access_token as string;
}

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if ((e as { permanent?: boolean }).permanent) break; // a bad request won't get better by retrying
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw last;
}

async function passes(tok: string, from: Date, to: Date) {
  const r = await fetch(`${SH}/api/v1/catalog/1.0.0/search`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: ['sentinel-2-l2a'], bbox: ESTATE_BBOX, datetime: `${iso(from)}/${iso(to)}`, limit: 100,
      fields: { include: ['properties.datetime', 'properties.eo:cloud_cover'], exclude: ['assets', 'links', 'geometry', 'bbox'] } }) });
  if (!r.ok) throw new Error(`catalog HTTP ${r.status}`);
  const j = await r.json();
  const seen = new Map<string, number>();
  for (const f of j.features ?? []) {
    const d = String(f.properties.datetime).slice(0, 10), c = Math.round(Number(f.properties['eo:cloud_cover'] ?? NaN));
    seen.set(d, Math.min(seen.get(d) ?? 101, Number.isFinite(c) ? c : 101)); // several tiles per day: keep the clearest
  }
  return [...seen].sort((a, b) => b[0].localeCompare(a[0])).map(([date, cloud]) => ({ date, cloud_pct: cloud > 100 ? null : cloud }));
}

async function zoneStats(tok: string, z: Zone, from: Date, to: Date, days: number, P: DrynessParams) {
  const r = await fetch(`${SH}/api/v1/statistics`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { bounds: { geometry: z.geojson, properties: { crs: UTM } }, data: [{ type: 'sentinel-2-l2a', dataFilter: { maxCloudCoverage: 100 } }] },
      aggregation: { timeRange: { from: iso(from), to: iso(to) }, aggregationInterval: { of: `P${days}D` }, evalscript: evalscript(P.clear_scene_classes), resx: P.resolution_m, resy: P.resolution_m },
      calculations: { ndmi: { statistics: { default: { percentiles: { k: [25, 50, 75] } } } } },
    }) });
  if (r.status === 429 || r.status >= 500) throw new Error(`statistics HTTP ${r.status}`);
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`statistics HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`), { permanent: true });
  return readStats(j);
}

async function run(runId: string, trigger: string) {
  const errors: string[] = [];
  const { data: cfg } = await sb.from('risk_config').select('params').eq('id', 'site').maybeSingle();
  const P: DrynessParams = { ...DEFAULT_DRYNESS, ...((cfg?.params as Record<string, unknown> | undefined)?.dryness as Partial<DrynessParams> ?? {}) };
  try {
    const tok = await token();
    const { data: zs, error: ze } = await sb.rpc('dryness_zones');
    if (ze) throw new Error(`zones: ${ze.message}`);
    const zones = (zs ?? []) as Zone[];
    const to = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'); // up to today 00:00 UTC
    const windows = [...P.windows_days].sort((a, b) => a - b);
    const passList = new Map<number, { date: string; cloud_pct: number | null }[]>();
    for (const d of windows) passList.set(d, await retry(() => passes(tok, new Date(+to - d * 864e5), to)).catch((e) => { errors.push(`passes ${d}d: ${(e as Error).message}`); return []; }));

    const rows: Record<string, unknown>[] = [];
    const by: Record<string, number> = {};
    let next = 0;
    const work = async () => {
      while (next < zones.length) {
        const z = zones[next++];
        try {
          const attempts: Attempt[] = [];
          for (const d of windows) {
            const from = new Date(+to - d * 864e5);
            const st = await retry(() => zoneStats(tok, z, from, to, d, P));
            attempts.push({ days: d, stats: st, usable: st ? usablePct(st.valid, z.area_m2, P.resolution_m) : 0 });
            if (st && st.p50 != null && attempts[attempts.length - 1].usable >= P.min_usable_pct) break;
          }
          const pick = chooseWindow(attempts, P.min_usable_pct);
          const a = pick.attempt;
          const cls = pick.cls_ok ? drynessClass(a?.stats?.p50, P.classes) : 'unknown';
          by[pick.cadence] = (by[pick.cadence] ?? 0) + 1;
          const r3 = (v: number | null | undefined) => (v == null ? null : Math.round(v * 1000) / 1000);
          rows.push({
            id: z.id, zone_kind: z.zone_kind, compartment: z.compartment, block: z.block, run_id: runId, sensor: 'sentinel-2-l2a',
            ndmi_p25: r3(a?.stats?.p25), ndmi_p50: r3(a?.stats?.p50), ndmi_p75: r3(a?.stats?.p75),
            usable_pct: a ? Math.round(a.usable) : 0, pixels: Math.round(z.area_m2 / (P.resolution_m * P.resolution_m)),
            class: cls,
            class_basis: pick.cls_ok
              ? `median NDMI ${a?.stats?.p50?.toFixed(3)} of clear pixels (${Math.round(a!.usable)}% of the zone clear) over ${a!.days} days`
              : `too cloudy: only ${Math.round(a?.usable ?? 0)}% of the zone clear in ${a?.days ?? '-'} days (need ${P.min_usable_pct}%)`,
            window_from: a ? isoDay(new Date(+to - a.days * 864e5)) : null, window_to: isoDay(new Date(+to - 864e5)),
            cadence: pick.cadence, images: a ? passList.get(a.days) ?? [] : [],
            computed_at: new Date().toISOString(), client_updated_at: new Date().toISOString(),
          });
        } catch (e) {
          errors.push(`${z.id}: ${(e as Error).message}`); // keep the previous result for this zone
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, work));
    for (let i = 0; i < rows.length; i += 100) {
      const { error } = await sb.from('fuel_dryness').upsert(rows.slice(i, i + 100), { onConflict: 'id' });
      if (error) errors.push(`save: ${error.message}`);
    }
    await sb.from('dryness_runs').update({
      finished_at: new Date().toISOString(), status: errors.length ? (rows.length ? 'partial' : 'failed') : 'ok', trigger,
      zones: rows.length, unknown: rows.filter((r) => r.class === 'unknown').length, by_cadence: by,
      images: Object.fromEntries([...passList].map(([d, l]) => [`${d}d`, l])), errors, params: P,
    }).eq('id', runId);
    if (errors.length) console.error(JSON.stringify({ dryness_errors: errors.slice(0, 20) }));
  } catch (e) {
    errors.push((e as Error).message);
    console.error(JSON.stringify({ dryness_failed: errors }));
    await sb.from('dryness_runs').update({ finished_at: new Date().toISOString(), status: 'failed', trigger, errors, params: P }).eq('id', runId);
  }
}

Deno.serve(async (req) => {
  const who = await caller(req);
  if (!who || (who.kind === 'user' && who.role !== 'admin')) return json({ error: 'unauthorised' }, 401);
  const trigger = who.kind === 'hook' ? 'schedule' : 'manual';
  const { data: r, error } = await sb.from('dryness_runs').insert({ trigger }).select('id').single();
  if (error || !r) return json({ error: `could not start: ${error?.message}` }, 500);
  const job = run(r.id as string, trigger);
  if (typeof EdgeRuntime !== 'undefined') { EdgeRuntime.waitUntil(job); return json({ started: true, run_id: r.id }, 202); }
  await job;
  return json({ done: true, run_id: r.id });
});
