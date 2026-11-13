// Fuel dryness per compartment and per 2 km edge zone, weekly (Monday 04:30 UTC, pg_cron) or on demand (admin).
// Sentinel-2 L2A via the Copernicus Data Space Ecosystem (Sentinel Hub Statistical + Catalog APIs).
//
// For every zone: median NDMI of clear pixels over 7 days; if under min_usable_pct of the zone was clear, 14 days,
// then 30 days; still not enough → "unknown" (never "low"). Each zone records its window, cadence, clear share
// and the Sentinel-2 passes in that window. A zone whose request fails keeps its previous result (it will show as
// stale) and the run is marked "partial" with the errors.
// Runs in the background (EdgeRuntime.waitUntil) and answers at once with the run id. Work is done in chunks of
// ~100 s; each chunk saves what it measured and hands the remaining zones to a fresh call of this function, so a
// platform time limit can never lose a whole run. Every Copernicus request times out after 45 s.
//
// Credentials: edge secrets CDSE_CLIENT_ID / CDSE_CLIENT_SECRET, or private.app_keys 'cdse_client_id' / 'cdse_client_secret'.
import { appKey, caller, json, sb } from '../_shared/alerts.ts';
import { chooseWindow, DEFAULT_DRYNESS, drynessClass, evalscript, readStats, usablePct, type Attempt, type DrynessParams } from '../_shared/dryness.ts';

const SH = 'https://sh.dataspace.copernicus.eu';
const TOKEN_URL = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
const ESTATE_BBOX = [-1.07, 6.73, -0.74, 6.92]; // estate + 2 km, WGS84 (for the list of passes)
const UTM = 'http://www.opengis.net/def/crs/EPSG/0/32630';
const CONCURRENCY = 2; // the free Copernicus tier rate-limits bursts (HTTP 429)
const BUDGET_MS = 80_000; // per call; remaining zones continue in a fresh call
const REQ_TIMEOUT_MS = 45_000;

type Zone = { id: string; zone_kind: string; compartment: string; block: string | null; area_m2: number; geojson: unknown };
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const iso = (d: Date) => d.toISOString().slice(0, 19) + 'Z';

async function token(): Promise<string> {
  const id = Deno.env.get('CDSE_CLIENT_ID') || (await appKey('cdse_client_id'));
  const secret = Deno.env.get('CDSE_CLIENT_SECRET') || (await appKey('cdse_client_secret'));
  if (!id || !secret) throw new Error('Copernicus credentials not set (CDSE_CLIENT_ID / CDSE_CLIENT_SECRET)');
  const r = await fetch(TOKEN_URL, { method: 'POST', signal: AbortSignal.timeout(REQ_TIMEOUT_MS), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Copernicus sign-in failed: HTTP ${r.status}`);
  return j.access_token as string;
}

/** Retry transient failures; on "too many requests" wait as long as the server asks (else 5, 10, 20 s). */
async function retry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const err = e as { permanent?: boolean; retryAfterS?: number; status?: number };
      if (err.permanent) break; // a bad request won't get better by retrying
      const waitS = err.retryAfterS ?? (err.status === 429 ? 5 * 2 ** i : 1.5 * (i + 1));
      await new Promise((r) => setTimeout(r, Math.min(20, waitS) * 1000)); // capped: a chunk must stay inside the platform time limit
    }
  }
  throw last;
}

async function passes(tok: string, from: Date, to: Date) {
  const r = await fetch(`${SH}/api/v1/catalog/1.0.0/search`, { method: 'POST', signal: AbortSignal.timeout(REQ_TIMEOUT_MS), headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
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
  const { crs: _crs, ...geometry } = z.geojson as Record<string, unknown>; // PostGIS adds a "crs" member; the CRS goes in properties instead
  const r = await fetch(`${SH}/api/v1/statistics`, { method: 'POST', signal: AbortSignal.timeout(REQ_TIMEOUT_MS), headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { bounds: { geometry, properties: { crs: UTM } }, data: [{ type: 'sentinel-2-l2a', dataFilter: { maxCloudCoverage: 100 } }] },
      aggregation: { timeRange: { from: iso(from), to: iso(to) }, aggregationInterval: { of: `P${days}D` }, evalscript: evalscript(P.clear_scene_classes), resx: P.resolution_m, resy: P.resolution_m },
      calculations: { ndmi: { statistics: { default: { percentiles: { k: [25, 50, 75] } } } } },
    }) });
  if (r.status === 429 || r.status >= 500) {
    const ra = Number(r.headers.get('retry-after'));
    throw Object.assign(new Error(`statistics HTTP ${r.status}`), { status: r.status, retryAfterS: Number.isFinite(ra) && ra > 0 ? ra : undefined });
  }
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`statistics HTTP ${r.status}: ${JSON.stringify(j).slice(0, 160)}`), { permanent: true });
  return readStats(j);
}

async function run(runId: string, trigger: string, offset: number) {
  const t0 = Date.now();
  const errors: string[] = [];
  const { data: cfg } = await sb.from('risk_config').select('params').eq('id', 'site').maybeSingle();
  const P: DrynessParams = { ...DEFAULT_DRYNESS, ...((cfg?.params as Record<string, unknown> | undefined)?.dryness as Partial<DrynessParams> ?? {}) };
  // write to the run log, appending this call's errors to earlier ones
  const note = async (patch: Record<string, unknown>) => {
    if (errors.length) {
      const { data } = await sb.from('dryness_runs').select('errors').eq('id', runId).single();
      patch.errors = [...((data?.errors as string[] | null) ?? []), ...errors].slice(-200);
      errors.length = 0;
    }
    await sb.from('dryness_runs').update(patch).eq('id', runId);
  };
  try {
    const tok = await token();
    const { data: zs, error: ze } = await sb.rpc('dryness_zones');
    if (ze) throw new Error(`zones: ${ze.message}`);
    const zones = ((zs ?? []) as Zone[]).sort((a, b) => a.id.localeCompare(b.id)); // stable order across chunks
    const to = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'); // up to today 00:00 UTC
    const windows = [...P.windows_days].sort((a, b) => a - b);
    const passList = new Map<number, { date: string; cloud_pct: number | null }[]>();
    for (const d of windows) passList.set(d, await retry(() => passes(tok, new Date(+to - d * 864e5), to)).catch((e) => { errors.push(`passes ${d}d: ${(e as Error).message}`); return []; }));
    console.log(JSON.stringify({ dryness: 'chunk start', runId, offset, zones: zones.length }));

    const rows: Record<string, unknown>[] = [];
    let next = offset, saved = 0;
    // save as we go (every 20 zones)
    const flush = async (all = false) => {
      while (rows.length - saved >= (all ? 1 : 20)) {
        const part = rows.slice(saved, saved + 100);
        saved += part.length;
        const { error } = await sb.from('fuel_dryness').upsert(part, { onConflict: 'id' });
        if (error) errors.push(`save: ${error.message}`);
      }
    };
    const work = async () => {
      // take a new zone only while inside this call's time budget; the rest goes to the next call
      while (next < zones.length && Date.now() - t0 < BUDGET_MS) {
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
          await flush();
        } catch (e) {
          errors.push(`${z.id}: ${(e as Error).message}`); // keep the previous result for this zone
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, work));
    await flush(true);
    console.log(JSON.stringify({ dryness: 'chunk done', runId, offset, next, measured: rows.length, seconds: Math.round((Date.now() - t0) / 1000) }));

    if (next < zones.length) {
      // hand the remaining zones to a fresh call (each call has its own time limit)
      await note({ zones: next });
      const hook = await appKey('hook_secret');
      const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/fuel-dryness`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-epb-hook': hook ?? '' },
        body: JSON.stringify({ run_id: runId, offset: next, trigger }), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`could not continue the run at zone ${next}: HTTP ${r.status}`);
      return;
    }
    // last chunk: summary of this run
    const { data: mine } = await sb.from('fuel_dryness').select('class, cadence').eq('run_id', runId);
    const by: Record<string, number> = {};
    for (const m of mine ?? []) by[m.cadence as string] = (by[m.cadence as string] ?? 0) + 1;
    const { data: prev } = await sb.from('dryness_runs').select('errors').eq('id', runId).single();
    const nErr = ((prev?.errors as unknown[] | null) ?? []).length + errors.length;
    const nowIso = new Date().toISOString();
    await sb.from('feed_status').upsert({ id: 'dryness', last_attempt: nowIso, ...((mine ?? []).length ? { last_ok: nowIso } : {}),
      detail: `${(mine ?? []).length} areas measured${nErr ? `, ${nErr} errors` : ''}` }, { onConflict: 'id' });
    await note({
      finished_at: new Date().toISOString(), status: nErr ? ((mine ?? []).length ? 'partial' : 'failed') : 'ok', trigger,
      zones: (mine ?? []).length, unknown: (mine ?? []).filter((m) => m.class === 'unknown').length, by_cadence: by,
      images: Object.fromEntries([...passList].map(([d, l]) => [`${d}d`, l])), params: P,
    });
  } catch (e) {
    errors.push((e as Error).message);
    console.error(JSON.stringify({ dryness_failed: errors }));
    await note({ finished_at: new Date().toISOString(), status: 'failed', trigger, params: P });
  }
}

Deno.serve(async (req) => {
  const who = await caller(req);
  if (!who || (who.kind === 'user' && who.role !== 'admin')) return json({ error: 'unauthorised' }, 401);
  const body = await req.json().catch(() => ({}));
  let runId = typeof body.run_id === 'string' ? body.run_id : null;
  const offset = Number.isInteger(body.offset) && body.offset > 0 ? body.offset : 0;
  const trigger = typeof body.trigger === 'string' ? body.trigger : who.kind === 'hook' ? 'schedule' : 'manual';
  if (!runId) {
    // a run that never finished (stopped by the platform) is marked failed, so it can't look "running" for ever
    await sb.from('dryness_runs').update({ status: 'failed', finished_at: new Date().toISOString(), errors: ['stopped before finishing (platform time limit?)'] })
      .eq('status', 'running').lt('started_at', new Date(Date.now() - 15 * 60e3).toISOString());
    const { data: r, error } = await sb.from('dryness_runs').insert({ trigger }).select('id').single();
    if (error || !r) return json({ error: `could not start: ${error?.message}` }, 500);
    runId = r.id as string;
  }
  const job = run(runId!, trigger, offset);
  if (typeof EdgeRuntime !== 'undefined') { EdgeRuntime.waitUntil(job); return json({ started: true, run_id: runId, offset }, 202); }
  await job;
  return json({ done: true, run_id: runId });
});
