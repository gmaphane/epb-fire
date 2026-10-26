// Satellite hotspots (NASA FIRMS, VIIRS + MODIS near-real-time) over the estate, every 30 min.
// New hotspots inside or within 2 km of a compartment raise a push alert to coordinators.
// Needs the free FIRMS MAP_KEY as the edge-function secret FIRMS_MAP_KEY.
import { caller, COORDINATORS, dd, json, sb, sendPush, users } from '../_shared/alerts.ts';

// estate extent + ~5 km (west, south, east, north)
const AREA = '-1.10,6.70,-0.71,6.95';
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT'];
const ALERT_WITHIN_M = 2000;

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
  const MAP_KEY = Deno.env.get('FIRMS_MAP_KEY');
  if (!MAP_KEY) return json({ skipped: 'FIRMS_MAP_KEY secret not set' });

  const fresh: { id: string; lat: number; lon: number; source: string; acq_time: string; confidence: string }[] = [];
  const errors: string[] = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${src}/${AREA}/1`);
      const text = await res.text();
      if (!res.ok) { errors.push(`${src}: HTTP ${res.status}`); continue; }
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

  // locate new hotspots and alert on the ones near the estate
  const near: { code: string; dist: number; d: (typeof fresh)[number] }[] = [];
  for (const d of fresh) {
    const { data } = await sb.rpc('nearest_compartment', { p_lat: d.lat, p_lon: d.lon });
    const n = (data as { code: string; distance_m: number }[] | null)?.[0];
    await sb.from('detections').update({ compartment: n?.code ?? null, distance_m: n ? Math.round(n.distance_m) : null }).eq('id', d.id);
    if (n && n.distance_m <= ALERT_WITHIN_M) near.push({ code: n.code, dist: n.distance_m, d });
  }
  let push = null;
  if (near.length) {
    near.sort((a, b) => a.dist - b.dist);
    const f = near[0];
    const where = f.dist < 1 ? `inside ${f.code}` : `${Math.round(f.dist / 10) * 10} m from ${f.code}`;
    const hhmm = f.d.acq_time.slice(11, 16);
    push = await sendPush(await users({ roles: COORDINATORS }), {
      title: near.length > 1 ? `${near.length} satellite hotspots near the estate` : `Satellite hotspot ${where}`,
      body: `${near.length > 1 ? `Closest ${where} · ` : ''}${f.d.source.replace('_NRT', '')} pass ${hhmm} UTC · ${f.d.confidence} confidence · ${dd(f.d.lat, f.d.lon)}. Unverified: check before calling crews.`,
      url: '/#/map', tag: 'hotspots', urgent: true, kind: 'hotspot',
    });
    await sb.from('detections').update({ notified_at: new Date().toISOString() }).in('id', near.map((n) => n.d.id));
  }
  return json({ new: fresh.length, near: near.length, push, errors });
});
