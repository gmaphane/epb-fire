import proj4 from 'proj4';
import { CONFIG } from '../config';
import { haversineM } from './geo';

/**
 * Parse a coordinate typed by a person (e.g. read out over a radio).
 * Accepts:
 *   decimal degrees   6.8287, -0.8093  |  6.8287 N 0.8093 W  |  N6.8287 W0.8093
 *   deg-min-sec       6°48'46.8"N 0°48'03.8"W  |  6 48 46.8 N, 0 48 3.8 W
 *   deg-decimal-min   6°48.780'N 0°48.063'W   |  6 48.78 N 0 48.063 W
 *   PSP sheet style   6°4846.8N, 000°4803.8W  (deg°MMSS.s)
 *   UTM               30N 742110 755363  |  742110 E 755363 N  |  742110, 755363  (zone 30N by default)
 * When no hemisphere or sign is given, the site default (N, W) is applied and reported as assumed.
 */
export interface ParsedCoord {
  lat: number;
  lon: number;
  format: 'decimal' | 'dms' | 'ddm' | 'utm';
  assumedHemisphere: boolean;
  zone?: number;
}
export type ParseResult = ({ ok: true } & ParsedCoord) | { ok: false; error: string };

const SITE_DEFAULT: Record<'lat' | 'lon', 'N' | 'S' | 'E' | 'W'> = { lat: 'N', lon: 'W' };

function normalise(t: string): string {
  return t
    .toUpperCase()
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″“”]|''/g, '"')
    .replace(/º|˚|DEG/g, '°')
    .replace(/\s+/g, ' ')
    .trim();
}

const NUM = /-?\d+(?:\.\d+)?/g;

function tryUtm(t: string): ParseResult | null {
  // Two big numbers → UTM easting/northing. Optional zone "30N"/"ZONE 30"/"UTM 31".
  const zoneM = t.match(/(?:ZONE|UTM)?\s*\b(2[89]|3[01])\s*([NP])?\b(?=\s+\d{5,})/);
  let rest = t;
  let zone = 30;
  if (zoneM) {
    zone = Number(zoneM[1]);
    rest = t.replace(zoneM[0], ' ');
  }
  rest = rest.replace(/\b(UTM|ZONE|WGS ?84)\b/g, ' ');
  const nums = rest.match(NUM)?.map(Number) ?? [];
  if (nums.length !== 2 || nums.some((n) => Math.abs(n) < 1000)) return null;
  // allow "755363 N 742110 E" (northing first)
  let [e, n] = nums;
  const eIdx = rest.search(/\d\s*(M\s*)?E\b/);
  const nIdx = rest.search(/\d\s*(M\s*)?N\b/);
  if (eIdx >= 0 && nIdx >= 0 && nIdx < eIdx) [n, e] = nums;
  else if (eIdx < 0 && nIdx < 0 && e > 1_000_000 && n < 1_000_000) [e, n] = [n, e];
  if (e < 100_000 || e > 900_000) return { ok: false, error: `Easting ${e} looks wrong (should be 6 digits, about 100 000–900 000)` };
  if (n < 0 || n > 9_400_000) return { ok: false, error: `Northing ${n} looks wrong` };
  const [lon, lat] = proj4(`+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`, 'EPSG:4326', [e, n]);
  return { ok: true, lat, lon, format: 'utm', assumedHemisphere: false, zone };
}

interface Axis { value: number; hemi: string | null; fmt: 'decimal' | 'dms' | 'ddm' }

function parseAxis(part: string): Axis | { error: string } {
  let p = part.trim();
  let hemi: string | null = null;
  const lead = p.match(/^([NSEW])\s*/);
  const trail = p.match(/\s*([NSEW])$/);
  if (lead) { hemi = lead[1]; p = p.slice(lead[0].length); }
  else if (trail) { hemi = trail[1]; p = p.slice(0, p.length - trail[0].length); }
  if (/[A-Z]/.test(p)) return { error: `Can't read "${part.trim()}"` };
  let neg = false;
  p = p.trim();
  if (p.startsWith('-')) { neg = true; p = p.slice(1); }
  // PSP sheet compact form: 6°4846.8  (deg ° MMSS.s)
  const compact = p.match(/^(\d{1,3})\s*°\s*(\d{2})(\d{2}(?:\.\d+)?)\s*"?$/);
  let nums: number[];
  if (compact) nums = [Number(compact[1]), Number(compact[2]), Number(compact[3])];
  else nums = (p.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!nums.length || nums.length > 3) return { error: `Can't read "${part.trim()}"` };
  const [d, m = 0, s = 0] = nums;
  if (m >= 60 || s >= 60) return { error: `Minutes and seconds must be under 60 ("${part.trim()}")` };
  if (nums.length > 1 && !Number.isInteger(d)) return { error: `Degrees should be a whole number when minutes are given ("${part.trim()}")` };
  if (nums.length > 2 && !Number.isInteger(m)) return { error: `Minutes should be whole when seconds are given ("${part.trim()}")` };
  const value = (d + m / 60 + s / 3600) * (neg ? -1 : 1);
  return { value, hemi, fmt: nums.length === 3 ? 'dms' : nums.length === 2 ? 'ddm' : 'decimal' };
}

function split(t: string): [string, string] | null {
  if (/[,;/]/.test(t)) {
    const [a, ...b] = t.split(/[,;/]/);
    return [a, b.join(' ')];
  }
  // split after a trailing hemisphere letter: "6 48 46.8 N 0 48 3.8 W"
  const m = t.match(/^(.*?\d[^NSEW]*?[NS])\s+(.*)$/) ?? t.match(/^(.*?\d[^NSEW]*?[EW])\s+(.*\d.*)$/);
  if (m && /\d/.test(m[2])) return [m[1], m[2]];
  // leading letters: "N6.82 W0.80"
  const l = t.match(/^([NS].*?)\s+([EW].*)$/) ?? t.match(/^([EW].*?)\s+([NS].*)$/);
  if (l) return [l[1], l[2]];
  // pure numbers: split the list in half
  const tokens = t.split(' ');
  if (tokens.length % 2 === 0 && tokens.every((x) => /^-?\d+(\.\d+)?[°'"]?$/.test(x))) {
    const h = tokens.length / 2;
    return [tokens.slice(0, h).join(' '), tokens.slice(h).join(' ')];
  }
  return null;
}

export function parseCoordinates(input: string): ParseResult {
  const t = normalise(input);
  if (!t) return { ok: false, error: 'Enter a coordinate' };
  const utm = tryUtm(t);
  if (utm) return utm;
  const parts = split(t);
  if (!parts) return { ok: false, error: 'Enter latitude and longitude, e.g. 6.8287 N, 0.8093 W — or UTM 742110 755363' };
  const a = parseAxis(parts[0]);
  const b = parseAxis(parts[1]);
  if ('error' in a) return { ok: false, error: a.error };
  if ('error' in b) return { ok: false, error: b.error };
  let lat = a, lon = b;
  if ((a.hemi === 'E' || a.hemi === 'W') && (b.hemi === 'N' || b.hemi === 'S' || !b.hemi)) [lat, lon] = [b, a];
  if (lat.hemi === 'E' || lat.hemi === 'W') return { ok: false, error: 'Both values look like longitudes (E/W)' };
  if (lon.hemi === 'N' || lon.hemi === 'S') return { ok: false, error: 'Both values look like latitudes (N/S)' };
  let assumed = false;
  const sign = (ax: Axis, axis: 'lat' | 'lon') => {
    if (ax.hemi) return Math.abs(ax.value) * (ax.hemi === 'S' || ax.hemi === 'W' ? -1 : 1);
    if (ax.value < 0) return ax.value;
    assumed = true;
    return ax.value * (SITE_DEFAULT[axis] === 'S' || SITE_DEFAULT[axis] === 'W' ? -1 : 1);
  };
  const la = sign(lat, 'lat');
  const lo = sign(lon, 'lon');
  if (Math.abs(la) > 90) return { ok: false, error: 'Latitude must be between −90 and 90' };
  if (Math.abs(lo) > 180) return { ok: false, error: 'Longitude must be between −180 and 180' };
  const fmt = lat.fmt === 'dms' || lon.fmt === 'dms' ? 'dms' : lat.fmt === 'ddm' || lon.fmt === 'ddm' ? 'ddm' : 'decimal';
  return { ok: true, lat: la, lon: lo, format: fmt, assumedHemisphere: assumed };
}

/** Distance from the site centre, to catch misheard digits. */
export function siteDistanceKm(lat: number, lon: number): number {
  return haversineM(lat, lon, CONFIG.center.lat, CONFIG.center.lon) / 1000;
}

/** Group digits for reading aloud: 742110 → "742 110". */
export const radioDigits = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
