import { useEffect, useState } from 'preact/hooks';
import { gps, type GpsState } from '../core/gps';

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

/** Device compass (Android Chrome: deviceorientationabsolute). Returns degrees clockwise from north or null. */
export function useCompass(): number | null {
  const [h, set] = useState<number | null>(null);
  useEffect(() => {
    const f = (e: DeviceOrientationEvent) => {
      const wk = (e as any).webkitCompassHeading as number | undefined;
      if (typeof wk === 'number') return set(wk);
      if (e.alpha != null && (e as any).absolute !== false) set((360 - e.alpha) % 360);
    };
    addEventListener('deviceorientationabsolute', f as any);
    return () => removeEventListener('deviceorientationabsolute', f as any);
  }, []);
  return h;
}
