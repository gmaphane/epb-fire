import type { Compartment } from './types';
import { pointInPolygon } from './geo';

/**
 * Indicative fire-spread threat to compartments from one fire, given the wind.
 *
 * NOT a fire behaviour model — a transparent ranking aid for the incident commander, based on
 * the wind only (direction and speed), as agreed:
 *  - head-fire rate of spread grows with wind speed;
 *  - spread is elliptical (Anderson 1983 length-to-breadth from wind speed), fastest downwind,
 *    slowest upwind — the fire sits at the rear focus of the ellipse;
 *  - time to reach a compartment = distance to its nearest edge ÷ rate of spread in that direction.
 * Tune ROS_* below once real fire observations are available.
 */

export interface Wind { kmh: number; from: number }
export type ThreatLevel = 'burning' | 'very_high' | 'high' | 'moderate' | 'low';
export interface Threat {
  id: string;
  code: string;
  block: string;
  distM: number; // fire → nearest edge (0 = fire inside)
  bearing: number; // fire → nearest edge, deg
  downwind: boolean; // within ±45° of downwind
  etaMin: number | null; // indicative arrival, minutes
  level: ThreatLevel;
  yop: number | null; // youngest planting year in the compartment (null = no planting record)
  young: boolean; // bamboo planted within YOUNG_MAX_AGE years
  plantedHa: number | null;
}

/** Bamboo this young (years since planting) is treated as young/vulnerable (fire risk config: age 0–3). */
export const YOUNG_MAX_AGE = 3;

const ROS_BASE = 2; // m/min, calm-air grass/understory head fire
const ROS_PER_KMH = 1.2; // m/min added per km/h of 10 m wind

const R = 6371008.8, RAD = Math.PI / 180;
const kx = (lat: number) => R * RAD * Math.cos(lat * RAD);
const KY = R * RAD;


/** Anderson (1983) length-to-breadth ratio from wind speed (mph), capped at 8. */
function lengthToBreadth(kmh: number) {
  const u = kmh * 0.621 * 0.4; // 10 m wind → mid-flame wind (open bamboo/grass, ~0.4)
  return Math.min(8, Math.max(1, 0.936 * Math.exp(0.2566 * u) + 0.461 * Math.exp(-0.1548 * u) - 0.397));
}

/** Head ROS (m/min) and ellipse eccentricity for a wind. */
export function spreadParams(w: Wind) {
  const head = ROS_BASE + ROS_PER_KMH * Math.max(0, w.kmh);
  const lb = lengthToBreadth(w.kmh);
  const e = Math.sqrt(1 - 1 / (lb * lb));
  return { head, e, downwind: (w.from + 180) % 360 };
}
/** Rate of spread (m/min) in direction `bearing` (deg) from the ignition point. */
export function rosAt(bearing: number, p: ReturnType<typeof spreadParams>) {
  const th = ((bearing - p.downwind) * RAD);
  return (p.head * (1 - p.e)) / (1 - p.e * Math.cos(th));
}

/** Nearest point on the polygon boundary to (lat, lon): distance (m) and bearing (deg). */
function nearestEdge(lat: number, lon: number, g: Compartment['geojson']) {
  const sx = kx(lat);
  let best = Infinity, bx = 0, by = 0;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys)
    for (const ring of poly)
      for (let i = 1; i < ring.length; i++) {
        const ax = (ring[i - 1][0] - lon) * sx, ay = (ring[i - 1][1] - lat) * KY;
        const cx = (ring[i][0] - lon) * sx, cy = (ring[i][1] - lat) * KY;
        const vx = cx - ax, vy = cy - ay, L2 = vx * vx + vy * vy;
        const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
        const px = ax + t * vx, py = ay + t * vy, d = Math.hypot(px, py);
        if (d < best) { best = d; bx = px; by = py; }
      }
  return { distM: best, bearing: ((Math.atan2(bx, by) / RAD) + 360) % 360 };
}

const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const levelOf = (eta: number | null): ThreatLevel => (eta == null ? 'low' : eta <= 30 ? 'very_high' : eta <= 60 ? 'high' : eta <= 180 ? 'moderate' : 'low');

/**
 * Threat to every compartment within `maxKm` of the fire, most urgent first.
 * Without wind data, ETA uses calm-air spread (direction-free) and is flagged by `wind === null`.
 */
export function threats(fire: { lat: number; lon: number }, comps: Compartment[], wind: Wind | null, maxKm = 6, year = new Date().getFullYear()): Threat[] {
  const w: Wind = wind ?? { kmh: 0, from: 0 };
  const out: Threat[] = [];
  for (const c of comps) {
    const inside = pointInPolygon(fire.lat, fire.lon, c.geojson);
    const { distM, bearing } = inside ? { distM: 0, bearing: 0 } : nearestEdge(fire.lat, fire.lon, c.geojson);
    if (distM > maxKm * 1000) continue;
    const p = spreadParams(w);
    const ros = rosAt(bearing, p);
    const etaMin = inside ? 0 : distM / ros;
    const off = Math.abs(((bearing - p.downwind + 540) % 360) - 180);
    out.push({
      id: c.id, code: c.code, block: c.block, distM, bearing, downwind: !!wind && w.kmh >= 3 && off <= 45,
      etaMin, level: inside ? 'burning' : levelOf(etaMin),
      yop: num(c.props?.yop_youngest), young: num(c.props?.yop_youngest) != null && year - num(c.props?.yop_youngest)! <= YOUNG_MAX_AGE,
      plantedHa: num(c.props?.planted_ha),
    });
  }
  return out.sort((a, b) => (a.etaMin ?? 1e9) - (b.etaMin ?? 1e9));
}

/** Polygon [lat, lon][] reached after `minutes` (for drawing the likely spread area). */
export function spreadEllipse(fire: { lat: number; lon: number }, wind: Wind, minutes = 60, steps = 48): [number, number][] {
  const p = spreadParams(wind);
  const pts: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const b = (i / steps) * 360;
    const r = rosAt(b, p) * minutes;
    pts.push([fire.lat + (r * Math.cos(b * RAD)) / KY, fire.lon + (r * Math.sin(b * RAD)) / kx(fire.lat)]);
  }
  return pts;
}

export const THREAT_LABEL: Record<ThreatLevel, string> = { burning: 'Burning', very_high: 'Very high', high: 'High', moderate: 'Moderate', low: 'Low' };
