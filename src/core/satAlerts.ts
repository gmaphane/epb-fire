import type { Detection } from './types';

/**
 * Which satellite fire detections (NASA FIRMS) should raise an alert inside the app.
 *
 *  - within URGENT_M of the nearest compartment edge (0 = inside): urgent alert, stays until tapped;
 *  - within NEAR_M: a short banner;
 *  - a detection is only decided once the server has measured its distance (distance_m set): rows can reach the
 *    phone before that, and must not be written off as "seen" while the distance is still missing;
 *  - FIRMS delivers 1.5–5.5 h after the satellite pass, so anything from the last WINDOW_H counts, including
 *    detections that arrived while the app was closed;
 *  - each detection alerts once per phone (the announced list is kept in IndexedDB).
 */
export const SAT_ALERT = { URGENT_M: 1000, NEAR_M: 2000, WINDOW_H: 24, KEEP_H: 72 };

export type SatLevel = 'urgent' | 'near';

export function satLevel(distanceM: number | null | undefined): SatLevel | null {
  if (distanceM == null || !Number.isFinite(Number(distanceM))) return null;
  const d = Number(distanceM);
  if (d <= SAT_ALERT.URGENT_M) return 'urgent';
  if (d <= SAT_ALERT.NEAR_M) return 'near';
  return null;
}

/** Announced detections: id → acquisition time (kept a few days so the list stays small). */
export type Announced = Record<string, string>;

export function pickSatAlerts(dets: Detection[], announced: Announced, now = Date.now()): { urgent: Detection[]; near: Detection[] } {
  const urgent: Detection[] = [], near: Detection[] = [];
  for (const d of dets) {
    if (announced[d.id] || d.promoted_incident_id) continue;
    const t = Date.parse(d.acq_time);
    if (!Number.isFinite(t) || now - t > SAT_ALERT.WINDOW_H * 3600_000) continue;
    const lv = satLevel(d.distance_m);
    if (lv === 'urgent') urgent.push(d);
    else if (lv === 'near') near.push(d);
  }
  const closest = (a: Detection, b: Detection) => Number(a.distance_m) - Number(b.distance_m);
  return { urgent: urgent.sort(closest), near: near.sort(closest) };
}

/** Add ids to the announced list and drop entries older than KEEP_H. */
export function markAnnounced(announced: Announced, dets: Detection[], now = Date.now()): Announced {
  const out: Announced = {};
  for (const [id, t] of Object.entries(announced)) if (now - Date.parse(t) <= SAT_ALERT.KEEP_H * 3600_000) out[id] = t;
  for (const d of dets) out[d.id] = d.acq_time;
  return out;
}

/** Position uncertainty: about half a pixel (VIIRS 375 m, MODIS 1 km). */
export const pixelHalfM = (source: string) => (/MODIS/i.test(source) ? 500 : 190);

/** "VIIRS NOAA-21" from "VIIRS_NOAA21_NRT". */
export const satName = (source: string) =>
  source.replace(/_NRT$/, '').replace(/_/g, ' ').replace(/NOAA(\d+)/, 'NOAA-$1').replace('SNPP', 'S-NPP');

/** "14:03 UTC (GMT)": Ghana keeps GMT all year, so UTC is local time. */
export const satTime = (iso: string) => `${new Date(iso).toISOString().slice(11, 16)} UTC (GMT)`;

/** "425 m from B121" / "Inside B104" / "1.4 km from C011". */
export function satWhere(d: Pick<Detection, 'compartment' | 'distance_m'>): string {
  if (!d.compartment || d.distance_m == null) return 'near the estate';
  const m = Number(d.distance_m);
  if (m < 1) return `inside ${d.compartment}`;
  return `${m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`} from ${d.compartment}`;
}
