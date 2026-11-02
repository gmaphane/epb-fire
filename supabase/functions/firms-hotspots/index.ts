// Satellite hotspots (NASA FIRMS, VIIRS + MODIS near-real-time) over the estate, checked every 10 min.
// Alerts (push to everyone):
//   - urgent: a new hotspot inside a compartment or within 2 km of one;
//   - watch (not urgent): 2–5 km away, only on days the nearest block's fire danger is HIGH or above;
//   - each alert names the compartment, block, that block's fire danger today, and says when the same spot (within
//     1 km) was already seen in the last 24 h, i.e. a fire that persists across satellite passes.
// Needs the free FIRMS MAP_KEY: edge-function secret FIRMS_MAP_KEY, or private.app_keys 'firms_map_key'.
import { appKey, caller, dd, json, sb, sendPush, users } from '../_shared/alerts.ts';

// estate extent + ~5 km (west, south, east, north)
const AREA = '-1.10,6.70,-0.71,6.95';
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];
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

Deno.serve(async (req) => {
  const who = await caller(req);
  if (!who || (who.kind === 'user' && who.role !== 'admin')) return json({ error: 'unauthorised' }, 401);
  const MAP_KEY = Deno.env.get('FIRMS_MAP_KEY') || (await appKey('firms_map_key'));
  if (!MAP_KEY) return json({ skipped: 'FIRMS map key not set' });

  const fresh: { id: string; lat: number; lon: number; source: string; acq_time: string; confidence: string }[] = [];
  const errors: string[] = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${src}/${AREA}/1`);
      const text = await res.text();
      if (!res.ok) { errors.push(`${src}: HTTP ${res.status}`); continue; }
      if (/invalid|error/i.test(text.slice(0, 100)) && !text.startsWith('latitude')) { errors.push(`${src}: ${text.slice(0, 120)}`); continue; }
      const rows = parseCsv(text);
      if (!rows.length) continue;
      const recs = await Promise.all(rows.map(async (r) => {
        const t = r.acq_time.padStart(4, '0');
        const acq = new Date(`${r.acq_date}T${t.slice(0, 2)}:${t.slice(2)}:00Z`).toISOString();
        const lat = Number(r.latitude), lon = Number(r.longitude);
        return { id: await uuidFrom(`${src}|${lat}|${lon}|${acq}`), source: src, acq_time: acq, confidence: conf(src, r.confidence), frp: r.frp ? Number(r.frp) : null, lat, lon, promoted_incident_id: null, client_updated_at: acq };
      }));
      // insert only; never overwrite a hotspot someone already promoted to a fire
      const { data, error } = await sb.from('detections').upsert(recs, { onConflict: 'id', ignoreDuplicates: true }).select('id, lat, lon, source, acq_time, confidence');
      if (error) { errors.push(`${src}: ${error.message}`); continue; }
      fresh.push(...(data ?? []));
    } catch (e) {
      errors.push(`${src}: ${(e as Error).message}`);
    }
  }

  // locate new hotspots: nearest compartment, its block, and that block's fire danger today
  const today = new Date().toISOString().slice(0, 10);
  const { data: dz } = await sb.from('fire_danger').select('block, level').eq('day', today).not('block', 'is', null);
  const danger = Object.fromEntries((dz ?? []).map((r) => [r.block as string, r.level as string]));
  const blockOf = new Map<string, string | null>();
  type Hit = { code: string; block: string | null; dist: number; d: (typeof fresh)[number]; urgent: boolean; seen: number; first: string | null };
  const hits: Hit[] = [];
  const since = new Date(Date.now() - 24 * 3600e3).toISOString();
  const { data: recent } = await sb.from('detections').select('id, lat, lon, acq_time').gte('acq_time', since);
  const freshIds = new Set(fresh.map((f) => f.id));
  const older = (recent ?? []).filter((r) => !freshIds.has(r.id as string));
  for (const d of fresh) {
    const { data } = await sb.rpc('nearest_compartment', { p_lat: d.lat, p_lon: d.lon });
    const n = (data as { code: string; distance_m: number }[] | null)?.[0];
    let block: string | null = null;
    if (n) {
      if (!blockOf.has(n.code)) {
        const { data: c } = await sb.from('compartments').select('block').eq('code', n.code).limit(1);
        blockOf.set(n.code, (c?.[0]?.block as string) ?? null);
      }
      block = blockOf.get(n.code) ?? null;
    }
    await sb.from('detections').update({ compartment: n?.code ?? null, distance_m: n ? Math.round(n.distance_m) : null, block }).eq('id', d.id);
    if (!n || n.distance_m > WATCH_WITHIN_M) continue;
    const urgent = n.distance_m <= ALERT_WITHIN_M;
    const lv = block ? danger[block] : undefined;
    if (!urgent && !(lv === 'high' || lv === 'very_high' || lv === 'extreme')) continue;
    const same = older.filter((o) => metres(d, o as { lat: number; lon: number }) <= REPEAT_M);
    const first = same.length ? same.map((o) => o.acq_time as string).sort()[0] : null;
    hits.push({ code: n.code, block, dist: n.distance_m, d, urgent, seen: same.length, first });
  }

  let push = null;
  if (hits.length) {
    hits.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.dist - b.dist);
    const f = hits[0];
    const urgent = hits.some((h) => h.urgent);
    const where = f.dist < 1 ? `inside ${f.code}` : `${f.dist < 1000 ? `${Math.round(f.dist / 10) * 10} m` : `${(f.dist / 1000).toFixed(1)} km`} from ${f.code}`;
    const lv = f.block ? danger[f.block] : undefined;
    const hhmm = f.d.acq_time.slice(11, 16);
    const repeat = f.seen ? ` Seen again: ${f.seen + 1} detections here since ${f.first!.slice(11, 16)} UTC ${f.first!.slice(0, 10) === today ? 'today' : 'yesterday'}.` : '';
    const comps = [...new Set(hits.map((h) => h.code))];
    push = await sendPush(await users({ all: true }), {
      title: urgent
        ? (hits.length > 1 ? `${hits.length} satellite hotspots near the estate` : `Satellite hotspot ${where}`) + (f.seen ? ' (repeat)' : '')
        : `Watch: hotspot ${where}`,
      body: `${f.block ?? 'Estate'}${lv ? ` · fire danger ${LABEL[lv]}` : ''} · ${f.d.source.replace('_NRT', '')} pass ${hhmm} UTC · ${f.d.confidence} confidence · ${dd(f.d.lat, f.d.lon)}.` +
        `${repeat}${hits.length > 1 ? ` Also near ${comps.slice(0, 4).join(', ')}.` : ''} Unverified: check before calling crews.`,
      url: '/#/map', tag: `hotspot-${f.code}`, urgent, kind: 'hotspot',
    });
    await sb.from('detections').update({ notified_at: new Date().toISOString() }).in('id', hits.map((h) => h.d.id));
  }
  return json({ new: fresh.length, alerted: hits.length, urgent: hits.filter((h) => h.urgent).length, push, errors });
});
