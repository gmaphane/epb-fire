// Daily fire danger rating for the estate, every morning at 05:45 (Ghana = UTC), pushed to everyone.
//
// Rating = Fosberg Fire Weather Index (temperature, humidity, wind) at today's afternoon peak (10:00–17:00),
// then one level up after 7+ days without rain (≥2 mm), one level down after ≥5 mm in the last 24 h.
// Provisional thresholds: tune against the estate's fire history.
import { caller, compass8, json, sb, sendPush, users } from '../_shared/alerts.ts';

const LAT = 6.8243, LON = -0.9059; // estate centre
const LEVELS = ['low', 'moderate', 'high', 'very_high', 'extreme'] as const;
const LABEL: Record<string, string> = { low: 'LOW', moderate: 'MODERATE', high: 'HIGH', very_high: 'VERY HIGH', extreme: 'EXTREME' };
const ACTION: Record<string, string> = {
  low: 'Normal patrols.',
  moderate: 'Standby crews at posts; watch for smoke.',
  high: 'All standby posts manned; no burning; water bowsers full.',
  very_high: 'Full standby; extra patrols in young bamboo; no burning anywhere.',
  extreme: 'Maximum readiness: all crews on standby, vehicles fuelled, community warned.',
};

/** Fosberg FFWI from °C, %RH, km/h (0–100). */
export function ffwi(tC: number, rh: number, windKmh: number) {
  const T = tC * 9 / 5 + 32, H = Math.max(0, Math.min(100, rh)), U = windKmh * 0.621371;
  const m = H < 10 ? 0.03229 + 0.281073 * H - 0.000578 * H * T
    : H <= 50 ? 2.22749 + 0.160107 * H - 0.01478 * T
    : 21.0606 + 0.005565 * H * H - 0.00035 * H * T - 0.483199 * H;
  const x = m / 30;
  const eta = 1 - 2 * x + 1.5 * x * x - 0.5 * x * x * x;
  return Math.max(0, Math.min(100, (eta * Math.sqrt(1 + U * U)) / 0.3002));
}
const levelOf = (f: number) => (f < 10 ? 0 : f < 20 ? 1 : f < 30 ? 2 : f < 40 ? 3 : 4);

Deno.serve(async (req) => {
  const who = await caller(req);
  if (!who || (who.kind === 'user' && who.role !== 'admin')) return json({ error: 'unauthorised' }, 401);
  const body = await req.json().catch(() => ({}));

  const key = Deno.env.get('OPEN_METEO_KEY');
  const q = `latitude=${LAT}&longitude=${LON}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m&daily=precipitation_sum&past_days=14&forecast_days=1&wind_speed_unit=kmh&timezone=UTC`;
  const url = key ? `https://customer-api.open-meteo.com/v1/forecast?${q}&apikey=${key}` : `https://api.open-meteo.com/v1/forecast?${q}`;
  const res = await fetch(url);
  if (!res.ok) return json({ error: `weather HTTP ${res.status}` }, 502);
  const w = await res.json();

  const today = new Date().toISOString().slice(0, 10);
  const H = w.hourly;
  let peak = { f: -1, t: 0, rh: 0, ws: 0, wd: 0, hour: '' };
  let tMax = -99, rhMin = 101, wsMax = 0;
  H.time.forEach((t: string, i: number) => {
    if (!t.startsWith(today)) return;
    const hr = Number(t.slice(11, 13));
    tMax = Math.max(tMax, H.temperature_2m[i]); rhMin = Math.min(rhMin, H.relative_humidity_2m[i]); wsMax = Math.max(wsMax, H.wind_speed_10m[i]);
    if (hr < 10 || hr > 17) return;
    const f = ffwi(H.temperature_2m[i], H.relative_humidity_2m[i], H.wind_speed_10m[i]);
    if (f > peak.f) peak = { f, t: H.temperature_2m[i], rh: H.relative_humidity_2m[i], ws: H.wind_speed_10m[i], wd: H.wind_direction_10m[i], hour: t.slice(11, 16) };
  });
  if (peak.f < 0) return json({ error: 'no forecast hours for today' }, 502);

  // rain: days since the last day with ≥2 mm (yesterday backwards), and yesterday's total
  const D = w.daily;
  const past = D.time.map((t: string, i: number) => ({ t, p: D.precipitation_sum[i] ?? 0 })).filter((d: { t: string }) => d.t < today);
  let since = 0;
  for (let i = past.length - 1; i >= 0 && past[i].p < 2; i--) since++;
  const rain24 = past.length ? past[past.length - 1].p : 0;

  let lv = levelOf(peak.f);
  const notes = [`Fosberg index ${peak.f.toFixed(0)} at ${peak.hour}`];
  if (since >= 7) { lv = Math.min(4, lv + 1); notes.push(`+1: no rain for ${since >= past.length ? `${past.length}+` : since} days`); }
  if (rain24 >= 5) { lv = Math.max(0, lv - 1); notes.push(`−1: ${rain24.toFixed(0)} mm rain in last 24 h`); }
  const level = LEVELS[lv];

  const row = {
    id: today, day: today, level, ffwi: Math.round(peak.f * 10) / 10,
    temp_max_c: Math.round(tMax * 10) / 10, rh_min_pct: Math.round(rhMin), wind_max_kmh: Math.round(wsMax),
    wind_from_deg: Math.round(peak.wd), days_since_rain: since, rain_24h_mm: Math.round(rain24 * 10) / 10,
    basis: notes.join('; '), client_updated_at: new Date().toISOString(),
  };
  const { error } = await sb.from('fire_danger').upsert(row);
  if (error) return json({ error: error.message }, 500);

  let push = null;
  if (body.notify !== false) {
    push = await sendPush(await users({ all: true }), {
      title: `Fire danger today: ${LABEL[level]}`,
      body: `Afternoon ${Math.round(peak.t)}°C, humidity ${Math.round(peak.rh)}%, wind ${compass8(peak.wd)} ${Math.round(peak.ws)} km/h${since >= 3 ? `, no rain for ${since} days` : ''}. ${ACTION[level]}`,
      url: '/#/map', tag: `danger-${today}`, urgent: lv >= 3, kind: 'danger',
    });
  }
  return json({ ...row, push });
});
