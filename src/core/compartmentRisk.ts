import { pointInPolygon } from './geo';
import type { Compartment, Detection, FeedStatus, FireDanger, FuelDryness } from './types';

/**
 * Compartment fire risk rating: Low / Moderate / High / Extreme / Unknown, always shown with its drivers.
 *
 * Each driver is scored 0–3, or unknown (missing or stale data is unknown, never "low"):
 *   dryness_in   fuel dryness inside the compartment (Sentinel-2): low 0, moderate 1, high 2, extreme 3
 *   dryness_out  fuel dryness in the 2 km outside it (edge compartments only)
 *   barriers     estate-edge stretches with no mapped barrier, or only unverified ones (edge compartments only):
 *                open share = gap% + uncertain_weight × uncertain%;  < 10% → 0, < 30% → 1, < 60% → 2, else 3
 *   detections   satellite fire detections: ≤1 km in 24 h → 3, ≤2 km in 72 h → 2, ≤5 km in 7 days → 1, else 0
 *   weather      today's fire danger (Canadian FWI) for the block: low 0, moderate 1, high 2, very high / extreme 3
 * Rating = weighted mean of the known drivers that apply, banded (< 0.75 Low, < 1.5 Moderate, < 2.25 High, else
 * Extreme), with one override: a detection within 1 km in the last 24 h makes it at least High.
 * Unknown when dryness inside is unknown, or when less than half of the applicable weight is known (except that the
 * 1 km override still gives "High (incomplete data)").
 * All numbers are settings (risk_config.params.risk); these are the defaults.
 */
export type Rating = 'low' | 'moderate' | 'high' | 'extreme' | 'unknown';
export type DriverKey = 'dryness_in' | 'dryness_out' | 'barriers' | 'detections' | 'weather';

export interface RiskParams {
  weights: Record<DriverKey, number>;
  bands: [number, number, number];
  barrier_open_pct: [number, number, number];
  uncertain_weight: number;
  detections: { km1_m: number; km1_h: number; km2_m: number; km2_h: number; km5_m: number; km5_h: number };
  stale: { dryness_days: number; barriers_days: number; firms_hours: number };
  min_known_weight: number;
}
export const DEFAULT_RISK: RiskParams = {
  weights: { dryness_in: 0.25, dryness_out: 0.2, barriers: 0.15, detections: 0.2, weather: 0.2 },
  bands: [0.75, 1.5, 2.25],
  barrier_open_pct: [10, 30, 60],
  uncertain_weight: 0.5,
  detections: { km1_m: 1000, km1_h: 24, km2_m: 2000, km2_h: 72, km5_m: 5000, km5_h: 168 },
  stale: { dryness_days: 16, barriers_days: 180, firms_hours: 3 },
  min_known_weight: 0.5,
};

export interface Driver {
  key: DriverKey;
  label: string;
  applies: boolean; // false: not relevant here (e.g. outside dryness for an interior compartment)
  score: 0 | 1 | 2 | 3 | null; // null = unknown
  value: string; // what was found, in words
  updated: string | null; // when the underlying data was last updated
  stale: boolean;
  weight: number;
}
export interface RiskResult { code: string; rating: Rating; score: number | null; drivers: Driver[]; why: string }

const LEVEL: Record<string, 0 | 1 | 2 | 3> = { low: 0, moderate: 1, high: 2, very_high: 3, extreme: 3 };
const LABEL: Record<string, string> = { low: 'Low', moderate: 'Moderate', high: 'High', very_high: 'Very high', extreme: 'Extreme', unknown: 'Unknown' };
const hoursAgo = (iso: string | null | undefined, now: number) => (iso ? (now - Date.parse(iso)) / 3600e3 : Infinity);

/** Distance (m) from a point to a compartment polygon: 0 inside, else to the nearest edge (local metric projection). */
export function distanceToCompartmentM(lat: number, lon: number, g: Compartment['geojson']): number {
  if (pointInPolygon(lat, lon, g)) return 0;
  const R = 6371008.8, rad = Math.PI / 180, kx = R * rad * Math.cos(lat * rad), ky = R * rad;
  let best = Infinity;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const p of polys) for (const ring of p) for (let i = 1; i < ring.length; i++) {
    const ax = (ring[i - 1][0] - lon) * kx, ay = (ring[i - 1][1] - lat) * ky, bx = (ring[i][0] - lon) * kx, by = (ring[i][1] - lat) * ky;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * vx, ay + t * vy));
  }
  return best;
}

export interface RiskInputs {
  compartment: Compartment;
  dryIn: FuelDryness | undefined;
  dryOut: FuelDryness | undefined;
  detections: Detection[]; // recent detections (any compartment); distances are measured here
  danger: FireDanger[]; // fire danger rows (any day/block)
  feeds: FeedStatus[];
  now?: number;
  params?: RiskParams;
}

export function rateCompartment(inp: RiskInputs): RiskResult {
  const P = inp.params ?? DEFAULT_RISK;
  const now = inp.now ?? Date.now();
  const c = inp.compartment;
  const edge = !!c.edge;
  const drivers: Driver[] = [];

  // 1–2) fuel dryness inside / outside
  const dry = (key: DriverKey, label: string, d: FuelDryness | undefined, applies: boolean): Driver => {
    const stale = !d || hoursAgo(d.computed_at, now) > P.stale.dryness_days * 24;
    const known = applies && d && !stale && d.class !== 'unknown';
    return {
      key, label, applies, weight: P.weights[key], updated: d?.computed_at ?? null, stale: applies && stale,
      score: known ? LEVEL[d!.class] : null,
      value: !applies ? 'not an edge compartment' : !d ? 'no satellite reading yet' : d.class === 'unknown' ? 'too cloudy to measure' :
        `${LABEL[d.class]} (NDMI ${d.ndmi_p50?.toFixed(2)})${stale ? ', reading too old' : ''}`,
    };
  };
  drivers.push(dry('dryness_in', 'Fuel dryness inside', inp.dryIn, true));
  drivers.push(dry('dryness_out', 'Fuel dryness 2 km outside', inp.dryOut, edge));

  // 3) barriers along the estate edge
  {
    const stale = !c.edge_checked_at || hoursAgo(c.edge_checked_at, now) > P.stale.barriers_days * 24;
    const has = edge && !stale && c.edge_gap_pct != null;
    const open = has ? (c.edge_gap_pct ?? 0) + P.uncertain_weight * (c.edge_uncertain_pct ?? 0) : null;
    const [a, b, d] = P.barrier_open_pct;
    drivers.push({
      key: 'barriers', label: 'Firebreaks / barriers on the estate edge', applies: edge, weight: P.weights.barriers,
      updated: c.edge_checked_at ?? null, stale: edge && stale,
      score: open == null ? null : open < a ? 0 : open < b ? 1 : open < d ? 2 : 3,
      value: !edge ? 'not an edge compartment' : !has ? 'not analysed' :
        `${c.edge_gap_pct ?? 0}% of edge with no mapped barrier, ${c.edge_uncertain_pct ?? 0}% only unverified, ${c.edge_protected_pct ?? 0}% checked`,
    });
  }

  // 4) satellite fire detections near the compartment
  {
    const feed = inp.feeds.find((f) => f.id === 'firms');
    const stale = hoursAgo(feed?.last_ok, now) > P.stale.firms_hours;
    const D = P.detections;
    let score: 0 | 1 | 2 | 3 = 0, near: { m: number; h: number } | null = null;
    for (const d of inp.detections) {
      if (d.promoted_incident_id) continue; // became a reported fire: handled as an incident
      const h = hoursAgo(d.acq_time, now);
      if (h > D.km5_h || h < -1) continue;
      const m = distanceToCompartmentM(d.lat, d.lon, c.geojson);
      const s = m <= D.km1_m && h <= D.km1_h ? 3 : m <= D.km2_m && h <= D.km2_h ? 2 : m <= D.km5_m ? 1 : 0;
      if (s > score || (s === score && s > 0 && near && m < near.m)) { score = s as 0 | 1 | 2 | 3; near = { m, h }; }
    }
    // a detection close by is real even if the feed is late; "none found" is only trusted when the feed is current
    const known = score > 0 || !stale;
    drivers.push({
      key: 'detections', label: 'Satellite fire detections nearby', applies: true, weight: P.weights.detections,
      updated: feed?.last_ok ?? null, stale,
      score: known ? score : null,
      value: near ? `${near.m < 1 ? 'inside' : `${near.m < 1000 ? `${Math.round(near.m / 10) * 10} m` : `${(near.m / 1000).toFixed(1)} km`} away`}, ${Math.round(near.h)} h ago` :
        stale ? 'detection feed not updating: unknown' : 'none within 5 km in 7 days',
    });
  }

  // 5) today's fire weather for the block
  {
    const today = new Date(now).toISOString().slice(0, 10);
    const row = inp.danger.find((r) => r.day === today && r.block === c.block);
    drivers.push({
      key: 'weather', label: 'Fire weather today (FWI)', applies: true, weight: P.weights.weather,
      updated: row?.updated_at ?? row?.client_updated_at ?? null, stale: !row,
      score: row ? LEVEL[row.level] ?? null : null,
      value: row ? `${LABEL[row.level] ?? row.level}${row.fwi != null ? ` (FWI ${Math.round(row.fwi)})` : ''}` : 'no rating for today',
    });
  }

  // rating
  const applies = drivers.filter((d) => d.applies);
  const known = applies.filter((d) => d.score != null);
  const wAll = applies.reduce((s, d) => s + d.weight, 0);
  const wKnown = known.reduce((s, d) => s + d.weight, 0);
  const score = wKnown > 0 ? known.reduce((s, d) => s + d.weight * (d.score as number), 0) / wKnown : null;
  const det = drivers.find((d) => d.key === 'detections')!;
  const forceHigh = det.score === 3;
  const dryInKnown = drivers[0].score != null;
  const enough = dryInKnown && wAll > 0 && wKnown / wAll >= P.min_known_weight;
  const [b1, b2, b3] = P.bands;
  let rating: Rating = !enough || score == null ? 'unknown' : score < b1 ? 'low' : score < b2 ? 'moderate' : score < b3 ? 'high' : 'extreme';
  let why = enough && score != null
    ? `weighted score ${score.toFixed(2)} from ${known.length} of ${applies.length} drivers`
    : `${dryInKnown ? 'too few drivers known' : 'fuel dryness inside unknown'} (${known.length} of ${applies.length} drivers known)`;
  if (forceHigh && (rating === 'unknown' || rating === 'low' || rating === 'moderate')) {
    why = `${rating === 'unknown' ? 'incomplete data, but ' : ''}satellite fire within ${P.detections.km1_m / 1000} km in the last ${P.detections.km1_h} h: at least High` +
      (rating === 'unknown' ? '' : ` (${why})`);
    rating = 'high';
  }
  return { code: c.code, rating, score: score == null ? null : Math.round(score * 100) / 100, drivers, why };
}

export const RATING_LABEL: Record<Rating, string> = { low: 'Low', moderate: 'Moderate', high: 'High', extreme: 'Extreme', unknown: 'Unknown' };

/** Merge settings from risk_config.params.risk over the defaults. */
export function riskParams(params: Record<string, unknown> | null | undefined): RiskParams {
  const r = (params?.risk ?? {}) as Partial<RiskParams>;
  return {
    ...DEFAULT_RISK, ...r,
    weights: { ...DEFAULT_RISK.weights, ...(r.weights ?? {}) },
    detections: { ...DEFAULT_RISK.detections, ...(r.detections ?? {}) },
    stale: { ...DEFAULT_RISK.stale, ...(r.stale ?? {}) },
  };
}
