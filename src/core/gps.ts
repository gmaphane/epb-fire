import { CONFIG } from '../config';
import type { GpsFix } from './types';

export type GpsStatus = 'idle' | 'acquiring' | 'ok' | 'denied' | 'unavailable';
export interface GpsState {
  status: GpsStatus;
  fix: GpsFix | null; // latest
  best: GpsFix | null; // most accurate within the recent window
  samples: number;
  now: number; // ticks every second so "fix age" re-renders
}

/**
 * High-accuracy GNSS watcher (docs/05 §6). Started at launch so a fix is already warm
 * when a report is opened. Works with no network (GNSS only).
 */
class Gps {
  state: GpsState = { status: 'idle', fix: null, best: null, samples: 0, now: Date.now() };
  private id: number | null = null;
  private buf: GpsFix[] = [];
  private tickId: ReturnType<typeof setInterval> | null = null;
  private subs = new Set<(s: GpsState) => void>();
  private users = 0;

  subscribe(fn: (s: GpsState) => void) {
    this.subs.add(fn);
    fn(this.state);
    return () => this.subs.delete(fn);
  }
  private set(p: Partial<GpsState>) {
    this.state = { ...this.state, ...p };
    this.subs.forEach((s) => s(this.state));
  }

  start() {
    this.users++;
    if (this.id !== null) return;
    if (!('geolocation' in navigator)) return this.set({ status: 'unavailable' });
    this.set({ status: this.state.fix ? this.state.status : 'acquiring' });
    this.id = navigator.geolocation.watchPosition(
      (p) => this.onFix(p),
      (e) => {
        if (e.code === 1) this.set({ status: 'denied' });
        else if (e.code === 2) this.set({ status: 'unavailable' });
        // code 3 (timeout): keep waiting, the watch continues
        else if (!this.state.fix) this.set({ status: 'acquiring' });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    this.tickId = setInterval(() => this.set({ now: Date.now() }), 1000);
    // some phones stall the first watch: nudge with a one-off read if nothing arrives, and on return to the app
    const nudge = () => { try { navigator.geolocation.getCurrentPosition((p) => this.onFix(p), () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20_000 }); } catch { /* ignore */ } };
    setTimeout(() => { if (!this.state.fix && this.id !== null) nudge(); }, 4000);
    try { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.id !== null) nudge(); }); } catch { /* no document */ }
  }

  stop() {
    this.users = Math.max(0, this.users - 1);
    // the app keeps GPS warm for its whole life; stop() only matters in tests
    if (this.users === 0 && this.id !== null) {
      navigator.geolocation.clearWatch(this.id);
      this.id = null;
      if (this.tickId) clearInterval(this.tickId);
    }
  }

  private onFix(p: GeolocationPosition) {
    const fix: GpsFix = {
      lat: p.coords.latitude,
      lon: p.coords.longitude,
      acc: p.coords.accuracy,
      alt: p.coords.altitude,
      speed: p.coords.speed,
      heading: p.coords.heading,
      ts: p.timestamp || Date.now(),
    };
    this.inject(fix);
  }

  /** Also used by tests. */
  inject(fix: GpsFix) {
    const cutoff = Date.now() - CONFIG.gps.bestWindowMs;
    this.buf = [...this.buf.filter((f) => f.ts >= cutoff), fix];
    const best = this.buf.reduce((b, f) => (f.acc < b.acc ? f : b), this.buf[0]);
    this.set({ status: 'ok', fix, best, samples: this.state.samples + 1, now: Date.now() });
  }

  /** Position to stamp on a record: best fix of the last 10 s, else latest, else null. */
  forRecord(): { fix: GpsFix | null; stale: boolean } {
    const { best, fix } = this.state;
    const use = best && Date.now() - best.ts <= CONFIG.gps.bestWindowMs ? best : fix;
    if (!use) return { fix: null, stale: true };
    return { fix: use, stale: Date.now() - use.ts > CONFIG.gps.staleMs };
  }
}

export const gps = new Gps();

export type Quality = 'good' | 'fair' | 'poor' | 'none';
export function quality(f: GpsFix | null, now = Date.now()): Quality {
  if (!f) return 'none';
  if (now - f.ts > CONFIG.gps.staleMs) return 'poor';
  if (f.acc <= CONFIG.gps.goodAccuracyM) return 'good';
  if (f.acc <= CONFIG.gps.fairAccuracyM) return 'fair';
  return 'poor';
}

/** Keep the screen on during perimeter walks / navigation. */
let lock: WakeLockSentinel | null = null;
export async function keepAwake(on: boolean): Promise<boolean> {
  try {
    if (on) {
      lock = (await (navigator as any).wakeLock?.request('screen')) ?? null;
      return !!lock;
    }
    await lock?.release();
    lock = null;
  } catch {
    /* unsupported or denied */
  }
  return false;
}
