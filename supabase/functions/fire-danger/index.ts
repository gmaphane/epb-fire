// Fire danger rating per block (A, B, C), every morning at 05:45 and again at 11:45 (Ghana = UTC).
//
// Rating = Canadian Fire Weather Index (FWI) for each block's own location: the fuel moisture codes are run over the
// last 60 days of noon weather and rain, so the rating reflects how dry the fuel has become, not only today's weather.
// Classes follow the European Forest Fire Information System (provisional: tune against the estate's fire history).
// The afternoon-peak Fosberg index is kept alongside as a check on wind and humidity at the hottest hour.
// One row per block (id YYYY-MM-DD|A) plus an estate row (id YYYY-MM-DD) carrying the worst block, for older app versions.
// Morning run: push to everyone. Midday run ({"run":"midday"}): push only if a block's level went up.
import { caller, compass8, json, sb, sendPush, users } from '../_shared/alerts.ts';
import { LEVELS, levelOfFwi } from '../_shared/fwi.ts';
import { type Hourly, rate } from '../_shared/danger.ts';

// block centroids (from public.compartments, Nov 2026)
const BLOCKS = [
  { key: 'A', name: 'Block A', lat: 6.8512, lon: -1.0185 },
  { key: 'B', name: 'Block B', lat: 6.8019, lon: -0.8884 },
  { key: 'C', name: 'Block C', lat: 6.8267, lon: -0.8168 },
];
const LABEL: Record<string, string> = { low: 'LOW', moderate: 'MODERATE', high: 'HIGH', very_high: 'VERY HIGH', extreme: 'EXTREME' };
const ACTION: Record<string, string> = {
  low: 'Normal patrols.',
  moderate: 'Standby crews at posts; watch for smoke.',
  high: 'All standby posts manned; no burning; water bowsers full.',
  very_high: 'Full standby; extra patrols in young bamboo; no burning anywhere.',
  extreme: 'Maximum readiness: all crews on standby, vehicles fuelled, community warned.',
};
const DAYS = 60;

const r1 = (v: number) => Math.round(v * 10) / 10;

Deno.serve(async (req) => {
  const who = await caller(req);
  if (!who || (who.kind === 'user' && who.role !== 'admin')) return json({ error: 'unauthorised' }, 401);
  const body = await req.json().catch(() => ({}));
  const midday = body.run === 'midday';

  const key = Deno.env.get('OPEN_METEO_KEY');
  const q = `latitude=${BLOCKS.map((b) => b.lat).join(',')}&longitude=${BLOCKS.map((b) => b.lon).join(',')}` +
    `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation&past_days=${DAYS}&forecast_days=1&wind_speed_unit=kmh&timezone=UTC`;
  const url = key ? `https://customer-api.open-meteo.com/v1/forecast?${q}&apikey=${key}` : `https://api.open-meteo.com/v1/forecast?${q}`;
  const res = await fetch(url);
  if (!res.ok) return json({ error: `weather HTTP ${res.status}` }, 502);
  const w = await res.json();
  const list = Array.isArray(w) ? w : [w];

  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const rows: Record<string, unknown>[] = [];
  const out: { b: (typeof BLOCKS)[number]; lv: number; r: NonNullable<ReturnType<typeof rate>> }[] = [];
  for (let k = 0; k < BLOCKS.length; k++) {
    const b = BLOCKS[k], r = list[k]?.hourly ? rate(list[k].hourly as Hourly, today) : null;
    if (!r) continue;
    const lv = levelOfFwi(r.x.fwi);
    out.push({ b, lv, r });
    rows.push({
      id: `${today}|${b.key}`, day: today, block: b.name, level: LEVELS[lv],
      fwi: r1(r.x.fwi), ffmc: r1(r.x.ffmc), dmc: r1(r.x.dmc), dc: r1(r.x.dc), isi: r1(r.x.isi), bui: r1(r.x.bui),
      ffwi: r1(Math.max(0, r.peak.f)), temp_max_c: r1(r.tMax), rh_min_pct: Math.round(r.rhMin), wind_max_kmh: Math.round(r.wsMax),
      wind_from_deg: Math.round(r.peak.wd), days_since_rain: r.since, rain_24h_mm: r1(r.yest),
      basis: `FWI ${r.x.fwi.toFixed(0)} (FFMC ${r.x.ffmc.toFixed(0)}, DMC ${r.x.dmc.toFixed(0)}, DC ${r.x.dc.toFixed(0)}) from ${DAYS} days of noon weather at the block; ` +
        `afternoon Fosberg ${Math.max(0, r.peak.f).toFixed(0)} at ${r.peak.hour || '-'}${midday ? '; midday update' : ''}`,
      client_updated_at: now,
    });
  }
  if (!out.length) return json({ error: 'no weather for today' }, 502);

  // estate row = the worst block (older app versions read only this one)
  const worst = out.reduce((a, c) => (c.lv > a.lv || (c.lv === a.lv && c.r.x.fwi > a.r.x.fwi) ? c : a));
  const est = rows.find((r) => r.block === worst.b.name)!;
  rows.push({ ...est, id: today, block: null, basis: `Worst block: ${worst.b.name}. ${est.basis}` });

  // midday: compare with this morning before overwriting
  let before: Record<string, string> = {};
  if (midday) {
    const { data } = await sb.from('fire_danger').select('id, level').in('id', out.map((o) => `${today}|${o.b.key}`));
    before = Object.fromEntries((data ?? []).map((d) => [d.id as string, d.level as string]));
  }
  const { error } = await sb.from('fire_danger').upsert(rows);
  if (error) return json({ error: error.message }, 500);

  const risen = out.filter((o) => {
    const was = before[`${today}|${o.b.key}`];
    return midday && was != null && (LEVELS as readonly string[]).indexOf(was) < o.lv;
  });
  let push = null;
  if (body.notify !== false && (!midday || risen.length)) {
    const same = out.every((o) => o.lv === worst.lv);
    const title = midday
      ? `Fire danger raised: ${risen.map((o) => `${o.b.name} ${LABEL[LEVELS[o.lv]]}`).join(', ')}`
      : same ? `Fire danger today: ${LABEL[LEVELS[worst.lv]]} (all blocks)` : `Fire danger today: ${LABEL[LEVELS[worst.lv]]} in ${worst.b.name}`;
    const per = out.map((o) => `${o.b.key} ${LABEL[LEVELS[o.lv]]} (FWI ${o.r.x.fwi.toFixed(0)})`).join(' · ');
    const p = worst.r.peak;
    push = await sendPush(await users({ all: true }), {
      title,
      body: `${per}. ${worst.b.name} afternoon ${Math.round(p.t)}°C, humidity ${Math.round(p.rh)}%, wind ${compass8(p.wd)} ${Math.round(p.ws)} km/h` +
        `${worst.r.since >= 3 ? `, no rain for ${worst.r.fullHistory ? `${worst.r.since}+` : worst.r.since} days` : ''}. ${ACTION[LEVELS[worst.lv]]}`,
      url: '/#/map', tag: `danger-${today}`, urgent: worst.lv >= 3, kind: 'danger',
    });
  }
  return json({ day: today, run: midday ? 'midday' : 'morning', blocks: rows.filter((r) => r.block), risen: risen.map((o) => o.b.name), push });
});
