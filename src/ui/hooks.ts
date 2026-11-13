import { useEffect, useState } from 'preact/hooks';
import { gps, type GpsState } from '../core/gps';
import { angleDiff } from '../core/navtrack';

export function useGps(): GpsState {
  const [s, set] = useState(gps.state);
  useEffect(() => gps.subscribe(set), []);
  return s;
}
/** GPS without the 1-second clock tick: re-renders only when the fix or status changes (for maps and lists). */
export function useGpsFix(): GpsState {
  const [s, set] = useState(gps.state);
  useEffect(() => {
    let last = gps.state;
    return gps.subscribe((n) => { if (n.fix !== last.fix || n.status !== last.status) { last = n; set(n); } });
  }, []);
  return s;
}
export function useNow(ms = 1000): number {
  const [n, set] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => set(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return n;
}

export interface Route { name: string; parts: string[]; q: URLSearchParams }
export function parseHash(h = location.hash): Route {
  const [path, qs] = h.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'map', parts: parts.slice(1), q: new URLSearchParams(qs ?? '') };
}
export function useRoute(): Route {
  const [r, set] = useState(parseHash());
  useEffect(() => {
    const f = () => set(parseHash());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return r;
}
export const go = (path: string) => { location.hash = '#/' + path.replace(/^\//, ''); };
export const back = () => { if (history.length > 1) history.back(); else go('map'); };

/**
 * Device compass: degrees clockwise from true-ish (magnetic) north that the TOP of the screen points to, or null.
 *  - Android Chrome: 'deviceorientationabsolute' (alpha is relative to north);
 *  - iPhone Safari: 'deviceorientation' with webkitCompassHeading, after the user allows motion access (needs a tap:
 *    call `request()` from a button);
 *  - landscape: the screen angle is added so "up on screen" stays correct.
 * Readings are throttled to ~10 per second.
 */
export function useCompass(): { heading: number | null; needsPermission: boolean; request: () => Promise<void> } {
  const [h, set] = useState<number | null>(null);
  const DOE = typeof window !== 'undefined' ? (window as any).DeviceOrientationEvent : undefined;
  // iPhones (and some newer browsers) have requestPermission; listen anyway, since many phones send readings without
  // asking. Only if nothing arrives is a tap (request()) needed: iOS allows asking only from a tap.
  const canAsk = !!DOE && typeof DOE.requestPermission === 'function';
  const [granted, setGranted] = useState(0); // bumped after a successful request, to re-attach the listener
  useEffect(() => {
    let last = 0;
    let sm: number | null = null; // smoothed on every reading, so it settles even when the phone is held still
    const screenAngle = () => (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number;
    const f = (e: DeviceOrientationEvent) => {
      const now = Date.now();
      if (now - last < 100) return;
      const wk = (e as any).webkitCompassHeading as number | undefined;
      let deg: number | null = null;
      if (typeof wk === 'number' && Number.isFinite(wk)) deg = wk; // iOS: already compass heading
      else if (e.alpha != null && ((e as any).absolute === true || e.type === 'deviceorientationabsolute')) deg = 360 - e.alpha;
      if (deg == null) return;
      last = now;
      const raw = (((deg + screenAngle()) % 360) + 360) % 360;
      sm = sm == null ? raw : (sm + 0.35 * angleDiff(sm, raw) + 360) % 360;
      set(Math.round(sm * 10) / 10);
    };
    const ev = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    addEventListener(ev, f as any);
    return () => removeEventListener(ev, f as any);
  }, [granted]);
  const request = async () => {
    if (!canAsk || h != null) return;
    try { if ((await DOE.requestPermission()) === 'granted') setGranted((n) => n + 1); } catch { /* denied or not from a tap */ }
  };
  return { heading: h, needsPermission: canAsk && h == null, request };
}
