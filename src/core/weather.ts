import { useEffect, useState } from 'preact/hooks';
import { CONFIG, IS_DEMO } from '../config';
import { metaGet, metaSet } from './db';

/**
 * Current weather at a point (Open-Meteo, no key needed for evaluation).
 * Cached on the phone so the last reading still shows offline, with its age.
 * Wind direction is where the wind blows FROM (meteorological), degrees from north.
 */
export interface Weather {
  tempC: number;
  rh: number; // %
  windKmh: number;
  gustKmh: number | null;
  windFrom: number; // deg
  at: string; // observation time (ISO)
  fetched: number; // device ms
  lat: number;
  lon: number;
}

const REFRESH_MS = 15 * 60_000;
const GRID = 0.05; // ≈ 5.5 km: one reading covers a fire and its surroundings
const keyOf = (lat: number, lon: number) => `wx:${(Math.round(lat / GRID) * GRID).toFixed(2)},${(Math.round(lon / GRID) * GRID).toFixed(2)}`;
const mem = new Map<string, Weather>();
const inflight = new Map<string, Promise<Weather | null>>();
const subs = new Set<() => void>();

/** Demo builds use a fixed dry-season reading so nothing calls the internet. */
const demo = (lat: number, lon: number): Weather => ({ tempC: 33, rh: 32, windKmh: 16, gustKmh: 28, windFrom: 45, at: new Date().toISOString(), fetched: Date.now(), lat, lon });

async function fetchWx(lat: number, lon: number): Promise<Weather | null> {
  if (IS_DEMO) return demo(lat, lon);
  const q = `latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=UTC`;
  const url = CONFIG.weather.apiKey ? `${CONFIG.weather.paidUrl}?${q}&apikey=${encodeURIComponent(CONFIG.weather.apiKey)}` : `${CONFIG.weather.url}?${q}`;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    const c = j.current;
    if (!c || c.wind_speed_10m == null) return null;
    return {
      tempC: c.temperature_2m, rh: c.relative_humidity_2m, windKmh: c.wind_speed_10m, gustKmh: c.wind_gusts_10m ?? null,
      windFrom: c.wind_direction_10m, at: new Date(c.time + 'Z').toISOString(), fetched: Date.now(), lat, lon,
    };
  } catch {
    return null; // offline: keep the cached reading
  }
}

export async function getWeather(lat: number, lon: number, force = false): Promise<Weather | null> {
  const k = keyOf(lat, lon);
  let cur = mem.get(k) ?? (await metaGet<Weather>(k)) ?? null;
  if (cur) mem.set(k, cur);
  if (!force && cur && Date.now() - cur.fetched < REFRESH_MS) return cur;
  if (!inflight.has(k))
    inflight.set(k, fetchWx(lat, lon).then(async (w) => {
      inflight.delete(k);
      if (w) { mem.set(k, w); await metaSet(k, w); subs.forEach((f) => f()); }
      return w;
    }));
  const w = await inflight.get(k)!;
  return w ?? cur;
}

/** Weather for a point, refreshed every 15 min while shown. Null until the first reading. */
export function useWeather(lat: number | null | undefined, lon: number | null | undefined): Weather | null {
  const [w, setW] = useState<Weather | null>(null);
  useEffect(() => {
    if (lat == null || lon == null) { setW(null); return; }
    let live = true;
    const load = () => void getWeather(lat, lon).then((x) => live && setW(x));
    load();
    const t = setInterval(load, REFRESH_MS);
    const sub = () => { const x = mem.get(keyOf(lat, lon)); if (x && live) setW(x); };
    subs.add(sub);
    return () => { live = false; clearInterval(t); subs.delete(sub); };
  }, [lat == null ? null : keyOf(lat, lon ?? 0)]);
  return w;
}

const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass8 = (deg: number) => CARD[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
export const wxAge = (w: Weather) => Math.round((Date.now() - w.fetched) / 60_000);
