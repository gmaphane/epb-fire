import proj4 from 'proj4';
import area from '@turf/area';
import length from '@turf/length';
import { lineString, polygon } from '@turf/helpers';
import type { Vertex } from './types';

const R = 6371008.8; // mean Earth radius (m)
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing 0–360° from point 1 to point 2. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x =
    Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(lat: number, lon: number, bearing: number, distM: number): { lat: number; lon: number } {
  const d = distM / R;
  const b = rad(bearing);
  const φ1 = rad(lat);
  const λ1 = rad(lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 };
}

const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const cardinal = (b: number) => CARD[Math.round((((b % 360) + 360) % 360) / 22.5) % 16];

export function fmtDistance(m: number): string {
  if (!isFinite(m)) return '—';
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

export function fmtHa(ha: number | null | undefined): string {
  if (ha == null || !isFinite(ha)) return '—';
  return ha < 10 ? ha.toFixed(2) : ha.toFixed(1);
}

export function fmtDms(value: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  const a = Math.abs(value);
  const d = Math.floor(a);
  const mFull = (a - d) * 60;
  const m = Math.floor(mFull);
  const s = (mFull - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(1).padStart(4, '0')}"${hemi}`;
}

export const fmtDd = (lat: number, lon: number) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

proj4.defs('EPSG:32630', '+proj=utm +zone=30 +datum=WGS84 +units=m +no_defs +type=crs');
export function toUtm30(lat: number, lon: number): { e: number; n: number } {
  const [e, n] = proj4('EPSG:4326', 'EPSG:32630', [lon, lat]);
  return { e, n };
}
export const fmtUtm = (lat: number, lon: number) => {
  const { e, n } = toUtm30(lat, lon);
  return `30N ${Math.round(e)} E ${Math.round(n)} N`;
};

// ---------- polygons ----------

function ringContains(ring: number[][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(lat: number, lon: number, g: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((p) => ringContains(p[0], lon, lat) && !p.slice(1).some((h) => ringContains(h, lon, lat)));
}

/** Geodesic area (ha) and perimeter (km) of the closed polygon through the vertices. */
export function polygonStats(vs: Pick<Vertex, 'lat' | 'lon'>[]): { areaHa: number; lengthKm: number } | null {
  if (vs.length < 3) return null;
  const ring = vs.map((v) => [v.lon, v.lat]);
  ring.push(ring[0]);
  const poly = polygon([ring]);
  return { areaHa: area(poly) / 10_000, lengthKm: length(lineString(ring), { units: 'kilometers' }) };
}

export function pathLengthM(vs: Pick<Vertex, 'lat' | 'lon'>[]): number {
  let t = 0;
  for (let i = 1; i < vs.length; i++) t += haversineM(vs[i - 1].lat, vs[i - 1].lon, vs[i].lat, vs[i].lon);
  return t;
}

export function vertsToGeoJson(vs: Vertex[]): GeoJSON.Polygon | null {
  if (vs.length < 3) return null;
  const ring = vs.map((v) => [v.lon, v.lat]);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

// ---------- tiles ----------
export function lonLatToTile(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2) * n);
  return { x, y };
}

export function tileRange(bbox: [number, number, number, number], z: number) {
  const [s, w, n, e] = bbox;
  const a = lonLatToTile(n, w, z);
  const b = lonLatToTile(s, e, z);
  return { x0: a.x, x1: b.x, y0: a.y, y1: b.y };
}

export function countTiles(bbox: [number, number, number, number], zmin: number, zmax: number): number {
  let c = 0;
  for (let z = zmin; z <= zmax; z++) {
    const r = tileRange(bbox, z);
    c += (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  }
  return c;
}

export const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

export function shortLabel(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += a[Math.floor(Math.random() * a.length)];
  return `F-${s}`;
}
