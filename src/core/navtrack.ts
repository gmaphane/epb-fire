import type { Route } from './route';
import type { GpsFix } from './types';

/**
 * Steady navigation: the route is planned once and the phone then measures progress ALONG it, like a car sat-nav.
 *
 * What used to make the travel time jump:
 *  - the route was re-planned every ~11 m of GPS movement, and GPS jitter near junctions or parallel tracks snapped
 *    the start onto a different track, so the route (and its time) flipped back and forth;
 *  - while moving, the time was remaining distance ÷ the GPS speed at that instant, which swings between ~5 and
 *    40 km/h on estate tracks (and applied vehicle speed to the final walk on foot);
 *  - stopping for a moment (speed < 0.8 m/s) switched to a different formula.
 *
 * Now:
 *  - time left = the planned time of the part of the route still ahead (each track at its planned speed, walking parts
 *    at walking speed), so it only goes down as you progress;
 *  - re-plan only when clearly off the route (further than OFF_ROUTE_M and the GPS accuracy, for 2 fixes in a row),
 *    or the target/mode changes; fixes worse than MAX_ACC_M never re-plan;
 *  - the displayed minutes are smoothed and change by whole minutes only when the estimate has moved by HYST_MIN.
 */
export const NAV = { OFF_ROUTE_M: 50, OFF_FIXES: 2, MAX_ACC_M: 60, HYST_MIN: 0.6, BACKTRACK_M: 80, AHEAD_M: 400 };

const R = 6371008.8, RAD = Math.PI / 180;

export interface Progress { offRouteM: number; alongM: number; remainingM: number; remainingMin: number; seg: number }

/** Project the position onto the route; prefer the part at or ahead of `fromM` (avoids jumping back where a route doubles back). */
export function progressOn(r: Route, lat: number, lon: number, fromM = 0): Progress {
  const kx = R * RAD * Math.cos(lat * RAD), ky = R * RAD;
  const c = r.coords;
  let best = { score: Infinity, d: Infinity, i: 0, t: 0 };
  for (let i = 0; i < c.length - 1; i++) {
    const ax = (c[i][1] - lon) * kx, ay = (c[i][0] - lat) * ky;
    const bx = (c[i + 1][1] - lon) * kx, by = (c[i + 1][0] - lat) * ky;
    const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
    const d = Math.hypot(ax + t * vx, ay + t * vy);
    const along = r.cumM[i] + t * (r.cumM[i + 1] - r.cumM[i]);
    // stay near where we were: not far back, and not jumping far ahead onto a later leg that happens to be close
    // (a real jump, e.g. after a long GPS gap, shows as off-route and re-plans)
    const score = d + (along < fromM - NAV.BACKTRACK_M || along > fromM + NAV.AHEAD_M ? 1000 : 0);
    if (score < best.score) best = { score, d, i, t };
  }
  const { i, t } = best;
  const alongM = r.cumM[i] + t * (r.cumM[i + 1] - r.cumM[i]);
  const doneMin = r.cumMin[i] + t * (r.cumMin[i + 1] - r.cumMin[i]);
  const totalM = r.cumM[r.cumM.length - 1], totalMin = r.cumMin[r.cumMin.length - 1];
  return { offRouteM: best.d, alongM, remainingM: Math.max(0, totalM - alongM), remainingMin: Math.max(0, totalMin - doneMin), seg: i };
}

export interface NavState { route: Route | null; progress: Progress | null; etaMin: number; distM: number; rerouted: number }

type Planner = (from: { lat: number; lon: number }) => Route;

export class NavTracker {
  private key = '';
  private route: Route | null = null;
  private off = 0;
  private along = 0;
  private shown = NaN;
  private raw = NaN;
  private n = 0;

  /** `key` identifies target + mode; a new key re-plans. */
  update(fix: GpsFix | null, key: string, plan: Planner): NavState {
    if (!fix) return this.state(null);
    const goodFix = fix.acc <= NAV.MAX_ACC_M;
    if (key !== this.key || !this.route) {
      // first plan uses whatever fix there is (better than nothing); it is re-planned once a good fix shows we're off it
      this.key = key;
      this.replan(fix, plan);
    }
    let p = progressOn(this.route!, fix.lat, fix.lon, this.along);
    if (p.offRouteM > Math.max(NAV.OFF_ROUTE_M, fix.acc)) {
      this.off++;
      if (this.off >= NAV.OFF_FIXES && goodFix) {
        this.replan(fix, plan);
        p = progressOn(this.route!, fix.lat, fix.lon, 0);
      }
    } else this.off = 0;
    this.along = p.alongM;
    this.smooth(p.remainingMin);
    return this.state(p);
  }

  private replan(fix: GpsFix, plan: Planner) {
    this.route = plan(fix);
    this.off = 0;
    this.along = 0;
    this.raw = NaN; // a new route resets the smoothing
    this.n++;
  }

  /** Light smoothing, then only move the shown value when it is HYST_MIN away (no 7-8-7-8 flicker). */
  private smooth(min: number) {
    this.raw = Number.isFinite(this.raw) ? this.raw + 0.35 * (min - this.raw) : min;
    if (!Number.isFinite(this.shown) || Math.abs(this.raw - this.shown) >= NAV.HYST_MIN || this.raw < 1) this.shown = this.raw;
  }

  private state(p: Progress | null): NavState {
    return { route: this.route, progress: p, etaMin: this.shown, distM: p ? p.remainingM : this.route?.distM ?? NaN, rerouted: this.n };
  }
}

// ---------- heading ----------

/** Shortest signed difference b − a in degrees (−180..180). */
export const angleDiff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/**
 * Which way the user is facing/travelling:
 *  - moving (GPS speed ≥ MOVE_MS and good fix): GPS course over ground, which is what matters in a vehicle;
 *  - otherwise the phone's compass (already smoothed per reading in useCompass);
 *  - small wobbles (< DEADBAND°) are ignored so the map doesn't shiver; the map's CSS transition turns it smoothly.
 * No smoothing here: this only runs when the inputs change, so smoothing would stall part-way if the reading held still.
 */
export const HEADING = { MOVE_MS: 1.5, DEADBAND: 4 };
export class HeadingFilter {
  private shown: number | null = null;
  update(fix: GpsFix | null, compass: number | null): number | null {
    const moving = !!fix && fix.speed != null && fix.speed >= HEADING.MOVE_MS && fix.heading != null && Number.isFinite(fix.heading) && fix.acc <= NAV.MAX_ACC_M;
    const src = moving ? fix!.heading! : compass;
    if (src == null || !Number.isFinite(src)) return this.shown;
    const h = ((src % 360) + 360) % 360;
    if (this.shown == null || Math.abs(angleDiff(this.shown, h)) >= HEADING.DEADBAND) this.shown = h;
    return this.shown;
  }
}
