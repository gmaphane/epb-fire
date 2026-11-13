// Satellite fire detections (NASA FIRMS active fires, VIIRS + MODIS near-real-time) over the estate, checked every 10 min.
// (The function keeps its old name "firms-hotspots" so the schedule keeps working; in EmberWatch "hotspot" means an area
// with a history of fires, so everything users see says "satellite fire detection".)
//
// Each detection is stored complete: nearest compartment, its block and the distance to the compartment edge (0 = inside)
// are worked out BEFORE the row is inserted. Phones receive new rows over Realtime the moment they are inserted, and the
// in-app alert needs the distance.
//
// Push alerts (to everyone):
//   - urgent: within 1 km of a compartment (or inside one);
//   - normal: 1–2 km;
//   - watch (normal): 2–5 km, only on days the nearest block's fire danger is HIGH or above;
//   - each alert names the compartment, block, that block's fire danger today, what lies between the detection and
//     the compartment (mapped barriers, and whether any is verified), and says when the same spot (within 1 km) was
//     already seen in the last 24 h, i.e. a fire that persists across satellite passes.
// Fetches 2 days each run, so a failed or timed-out run (or an outage up to ~2 days) is caught up by the next one;
// detection ids are derived from source + position + time, so re-fetching never duplicates.
// Needs the free FIRMS MAP_KEY: edge-function secret FIRMS_MAP_KEY, or private.app_keys 'firms_map_key'.
import { appKey, caller, dd, json, sb, sendPush, users } from '../_shared/alerts.ts';
import { barrierSentence, type BarrierSummary } from '../_shared/barriers.ts';

// estate extent + ~5 km (west, south, east, north)
const AREA = '-1.10,6.70,-0.71,6.95';
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];
const DAYS = 2;
const URGENT_WITHIN_M = 1000;
const ALERT_WITHIN_M = 2000;
const WATCH_WITHIN_M = 5000;
const REPEAT_M = 1000;
const LABEL: Record<string, string> = { low: 'LOW', moderate: 'MODERATE', high: 'HIGH', very_high: 'VERY HIGH', extreme: 'EXTREME' };

const metres = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
  const r = Math.PI / 180, x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r), y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
};

async function uuidFrom(s: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function parseCsv(t: string): Record<string, string>[] {
  const lines = t.trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[0].includes('latitude')) return [];
  const h = lines[0].split(',');
  return lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((v, i) => [h[i], v])));
}

const conf = (src: string, c: string) => {
  if (src.startsWith('MODIS')) { const n = Number(c); return n >= 80 ? 'high' : n >= 30 ? 'nominal' : 'low'; }
  return ({ l: 'low', n: 'nominal', h: 'high' } as Record<string, string>)[c?.toLowerCase()] ?? c;
};
const satName = (s: string) => s.replace(/_NRT$/, '').replace(/_/g, ' ').replace(/NOAA(\d+)/, 'NOAA-$1').replace('SNPP', 'S-NPP');
const where = (code: string, m: number) => (m < 1 ? `inside ${code}` : `${m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`} from ${code}`);

type Rec = { id: string; source: string; acq_time: string; confidence: string; frp: number | null; lat: number; lon: number; promoted_incident_id: null; client_updated_at: string; compartment?: string | null; block?: string | null; distance_m?: number | null; barriers?: BarrierSummary | null };

Deno.serve(async (req) => {
  const who = await caller(req);
  if (!who || (who.kind === 'user' && who.role !== 'admin')) return json({ error: 'unauthorised' }, 401);
  const MAP_KEY = Deno.env.get('FIRMS_MAP_KEY') || (await appKey('firms_map_key'));
  if (!MAP_KEY) return json({ skipped: 'FIRMS map key not set' });

  // 1) fetch every source
  const errors: string[] = [];
  const all = new Map<string, Rec>();
  await Promise.all(SOURCES.map(async (src) => {
    try {
      const res = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${src}/${AREA}/${DAYS}`, { signal: AbortSignal.timeout(20_000) });
      const text = await res.text();
      if (!res.ok) { errors.push(`${src}: HTTP ${res.status}`); return; }
      if (/invalid|error/i.test(text.slice(0, 100)) && !text.startsWith('latitude')) { errors.push(`${src}: ${text.slice(0, 120)}`); return; }
      for (const r of parseCsv(text)) {
        const t = r.acq_time.padStart(4, '0');
        const acq = new Date(`${r.acq_date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`).toISOString();
        const lat = Number(r.latitude), lon = Number(r.longitude);
        const id = await uuidFrom(`${src}|${lat}|${lon}|${acq}`);
        all.set(id, { id, source: src, acq_time: acq, confidence: conf(src, r.confidence), frp: r.frp ? Number(r.frp) : null, lat, lon, promoted_incident_id: null, client_updated_at: acq });
      }
    } catch (e) {
      errors.push(`${src}: ${(e as Error).message}`);
    }
  }));

  // 2) only the ones we don't have yet; locate them (nearest compartment, block, distance) before inserting
  let fresh: Rec[] = [];
  const ids = [...all.keys()];
  if (ids.length) {
    const have = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from('detections').select('id').in('id', ids.slice(i, i + 200));
      if (error) { errors.push(`lookup: ${error.message}`); return json({ error: 'lookup failed', errors }, 500); }
      for (const r of data ?? []) have.add(r.id as string);
    }
    const todo = ids.filter((id) => !have.has(id)).map((id) => all.get(id)!);
    if (todo.length) {
      const { data: near, error: ne } = await sb.rpc('nearest_compartments', { p: todo.map((d, i) => ({ i, lat: d.lat, lon: d.lon })) });
      if (ne) errors.push(`locate: ${ne.message}`); // still insert: an unlocated detection is better than a lost one
      for (const n of (near ?? []) as { i: number; code: string; block: string; distance_m: number }[]) {
        Object.assign(todo[n.i], { compartment: n.code, block: n.block, distance_m: Math.round(n.distance_m) });
      }
      // what lies between each nearby detection and its compartment (public.barriers_between). Skipped while the
      // barrier list is empty (not built yet), so an unbuilt list is never reported as "no barrier".
      const { data: cfg } = await sb.from('risk_config').select('params').eq('id', 'site').maybeSingle();
      const within = Number((cfg?.params as Record<string, unknown> | undefined)?.detection_check_within_m ?? 2000);
      const { count: nb } = await sb.from('fire_barriers').select('id', { count: 'exact', head: true });
      const check = todo.map((d, i) => ({ i, lat: d.lat, lon: d.lon, code: d.compartment, dist: d.distance_m }))
        .filter((x) => x.code && x.dist != null && x.dist > 0 && x.dist <= within);
      if (check.length && nb) {
        const { data: bb, error: be } = await sb.rpc('barriers_between', { p: check.map(({ i, lat, lon, code }) => ({ i, lat, lon, code })) });
        if (be) errors.push(`barriers: ${be.message}`); // the detection is still stored and alerted, just without this line
        for (const b of (bb ?? []) as { i: number; summary: BarrierSummary | null }[]) todo[b.i].barriers = b.summary;
      }
      // insert only; never overwrite a detection someone already promoted to a fire
      const { data, error } = await sb.from('detections').upsert(todo, { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (error) errors.push(`insert: ${error.message}`);
      const inserted = new Set((data ?? []).map((r) => r.id as string));
      fresh = todo.filter((d) => inserted.has(d.id));
    }
  }
  if (errors.length) console.error(JSON.stringify({ firms_errors: errors }));
  // feed health for the app: "no detections" only means something if the check actually worked
  const sourceFailures = errors.filter((e) => SOURCES.some((s) => e.startsWith(s))).length;
  const ok = sourceFailures < SOURCES.length && !errors.some((e) => e.startsWith('lookup') || e.startsWith('insert'));
  const nowIso = new Date().toISOString();
  await sb.from('feed_status').upsert({ id: 'firms', last_attempt: nowIso, ...(ok ? { last_ok: nowIso } : {}),
    detail: errors.length ? errors.join('; ').slice(0, 300) : `${all.size} detections in the last ${DAYS} days, ${fresh.length} new` }, { onConflict: 'id' });

  // 3) alerts: the block's fire danger today, and repeats of the same fire in the last 24 h
  const today = new Date().toISOString().slice(0, 10);
  const { data: dz } = await sb.from('fire_danger').select('block, level').eq('day', today).not('block', 'is', null);
  const danger = Object.fromEntries((dz ?? []).map((r) => [r.block as string, r.level as string]));
  type Hit = { code: string; block: string | null; dist: number; d: Rec; urgent: boolean; seen: number; first: string | null };
  const hits: Hit[] = [];
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const { data: recent } = await sb.from('detections').select('id, lat, lon, acq_time').gte('acq_time', since);
  const freshIds = new Set(fresh.map((f) => f.id));
  const older = (recent ?? []).filter((r) => !freshIds.has(r.id as string));
  for (const d of fresh) {
    if (d.compartment == null || d.distance_m == null || d.distance_m > WATCH_WITHIN_M) continue;
    const urgent = d.distance_m <= URGENT_WITHIN_M;
    const lv = d.block ? danger[d.block] : undefined;
    if (d.distance_m > ALERT_WITHIN_M && !(lv === 'high' || lv === 'very_high' || lv === 'extreme')) continue;
    const same = older.filter((o) => metres(d, o as { lat: number; lon: number }) <= REPEAT_M);
    const first = same.length ? same.map((o) => o.acq_time as string).sort()[0] : null;
    hits.push({ code: d.compartment, block: d.block ?? null, dist: d.distance_m, d, urgent, seen: same.length, first });
  }

  let push = null;
  if (hits.length) {
    hits.sort((a, b) => a.dist - b.dist);
    const f = hits[0];
    const urgent = f.urgent;
    const lv = f.block ? danger[f.block] : undefined;
    const hhmm = f.d.acq_time.slice(11, 16);
    const repeat = f.seen ? ` Seen again: ${f.seen + 1} detections here since ${f.first!.slice(11, 16)} UTC ${f.first!.slice(0, 10) === today ? 'today' : 'yesterday'}.` : '';
    const comps = [...new Set(hits.map((h) => h.code))];
    const within1 = hits.filter((h) => h.urgent).length;
    push = await sendPush(await users({ all: true }), {
      title: f.dist > ALERT_WITHIN_M
        ? `Watch: satellite fire ${where(f.code, f.dist)}`
        : `Satellite fire detection ${where(f.code, f.dist)}` + (within1 > 1 ? ` (+${within1 - 1} more within 1 km)` : '') + (f.seen ? ' (repeat)' : ''),
      body: `${f.block ?? 'Estate'}${lv ? ` · fire danger ${LABEL[lv]}` : ''} · ${satName(f.d.source)} pass ${hhmm} UTC (GMT) · ${f.d.confidence} confidence · ${dd(f.d.lat, f.d.lon)}.` +
        `${f.d.barriers ? ` ${barrierSentence(f.d.barriers, f.code)}` : ''}${repeat}${hits.length > 1 ? ` Also near ${comps.slice(0, 4).join(', ')}.` : ''} Unverified: check before calling crews.`,
      url: `/#/map?det=${f.d.id}`, tag: `satfire-${f.code}`, urgent, kind: 'hotspot',
    });
    await sb.from('detections').update({ notified_at: new Date().toISOString() }).in('id', hits.map((h) => h.d.id));
  }
  return json({ fetched: all.size, new: fresh.length, alerted: hits.length, urgent: hits.filter((h) => h.urgent).length, push, errors });
});
