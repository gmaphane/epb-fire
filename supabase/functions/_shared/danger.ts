// Weather to fire danger for one location: Canadian FWI over the past days plus the afternoon-peak Fosberg index.
import { series } from './fwi.ts';

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

export type Hourly = { time: string[]; temperature_2m: number[]; relative_humidity_2m: number[]; wind_speed_10m: number[]; wind_direction_10m: number[]; precipitation: number[] };

/** Everything for one block from its hourly weather. */
export function rate(H: Hourly, today: string) {
  const at = new Map(H.time.map((t, i) => [t, i]));
  const days = [...new Set(H.time.map((t) => t.slice(0, 10)))].filter((d) => d <= today).sort();
  const total = new Map<string, number>();
  H.time.forEach((t, i) => total.set(t.slice(0, 10), (total.get(t.slice(0, 10)) ?? 0) + (H.precipitation[i] ?? 0)));
  // noon weather and the noon-to-noon rain the FWI uses
  const noon: { day: string; t: number; h: number; w: number; rain: number }[] = [];
  for (let k = 1; k < days.length; k++) {
    const i = at.get(`${days[k]}T12:00`);
    if (i == null) continue;
    let rain = 0;
    for (let j = i - 23; j <= i; j++) rain += j >= 0 ? (H.precipitation[j] ?? 0) : 0;
    noon.push({ day: days[k], t: H.temperature_2m[i], h: H.relative_humidity_2m[i], w: H.wind_speed_10m[i], rain });
  }
  if (!noon.length || noon[noon.length - 1].day !== today) return null;
  const s = series(noon);
  const x = s[s.length - 1];
  // afternoon peak (10:00–17:00) and today's extremes
  let peak = { f: -1, t: 0, rh: 0, ws: 0, wd: 0, hour: '' }, tMax = -99, rhMin = 101, wsMax = 0;
  H.time.forEach((t, i) => {
    if (!t.startsWith(today)) return;
    tMax = Math.max(tMax, H.temperature_2m[i]); rhMin = Math.min(rhMin, H.relative_humidity_2m[i]); wsMax = Math.max(wsMax, H.wind_speed_10m[i]);
    const hr = Number(t.slice(11, 13));
    if (hr < 10 || hr > 17) return;
    const f = ffwi(H.temperature_2m[i], H.relative_humidity_2m[i], H.wind_speed_10m[i]);
    if (f > peak.f) peak = { f, t: H.temperature_2m[i], rh: H.relative_humidity_2m[i], ws: H.wind_speed_10m[i], wd: H.wind_direction_10m[i], hour: t.slice(11, 16) };
  });
  const past = days.filter((d) => d < today);
  let since = 0;
  for (let k = past.length - 1; k >= 0 && (total.get(past[k]) ?? 0) < 2; k--) since++;
  const yest = past.length ? total.get(past[past.length - 1]) ?? 0 : 0;
  return { x, peak, tMax, rhMin, wsMax, since, yest, fullHistory: since >= past.length };
}

