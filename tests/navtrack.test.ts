import { describe, expect, it } from 'vitest';
import { angleDiff, HeadingFilter, NAV, NavTracker, progressOn } from '../src/core/navtrack';
import { route, type Route } from '../src/core/route';
import { destination } from '../src/core/geo';
import type { GpsFix, MapLayer, Road } from '../src/core/types';

// a 3 km straight road running east from A, fire 200 m north of its far end
const A = { lat: 6.82, lon: -0.9 };
const B = destination(A.lat, A.lon, 90, 3000);
const FIRE = destination(B.lat, B.lon, 0, 200);
const road: Road = { id: 'r', name: 'Main', passable: true, geojson: { type: 'LineString', coordinates: [[A.lon, A.lat], [B.lon, B.lat]] } };
const roads = [road];
const layers: MapLayer[] = [];
const plan = (from: { lat: number; lon: number }) => route(roads, layers, from, FIRE, 'drive');
const fix = (p: { lat: number; lon: number }, extra: Partial<GpsFix> = {}): GpsFix => ({ lat: p.lat, lon: p.lon, acc: 8, alt: null, speed: 8, heading: 90, ts: Date.now(), ...extra });
const along = (m: number, sideM = 0) => { const p = destination(A.lat, A.lon, 90, m); return sideM ? destination(p.lat, p.lon, 0, sideM) : p; };

describe('route timing per vertex', () => {
  it('cumulative distance/time end at the route totals', () => {
    const r = plan(along(0, 30));
    expect(r.viaTracks).toBe(true);
    expect(r.cumM.length).toBe(r.coords.length);
    expect(r.cumM[r.cumM.length - 1]).toBeCloseTo(r.distM, 3);
    expect(r.cumMin[r.cumMin.length - 1]).toBeCloseTo(r.etaMin, 6);
  });
});

describe('progress along the route', () => {
  it('halfway along the road leaves half the road plus the walk to the fire', () => {
    const r = plan(A);
    const p = progressOn(r, ...Object.values(along(1500)) as [number, number]);
    expect(p.offRouteM).toBeLessThan(1);
    expect(p.remainingM).toBeGreaterThan(1500 + 190);
    expect(p.remainingM).toBeLessThan(1500 + 210);
  });
});

describe('steady travel time', () => {
  it('GPS jitter and changing speed do not move the time up and down', () => {
    const t = new NavTracker();
    const shown: number[] = [];
    for (let m = 0; m <= 2400; m += 40) {
      const wobble = ((m / 40) % 2 ? 1 : -1) * 12; // ±12 m sideways jitter
      const speed = (m / 40) % 3 === 0 ? 1.5 : 11; // bumpy track: crawling, then 40 km/h
      shown.push(t.update(fix(along(m, wobble), { speed }), 'k', plan).etaMin);
    }
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeLessThanOrEqual(shown[i - 1] + 1e-9); // never goes up
    expect(t.update(fix(along(2400)), 'k', plan).rerouted).toBe(1); // planned once, never re-planned
  });

  it('re-plans only when clearly off the route for two fixes in a row', () => {
    const t = new NavTracker();
    t.update(fix(along(500)), 'k', plan);
    const off = along(800, NAV.OFF_ROUTE_M + 100);
    expect(t.update(fix(off), 'k', plan).rerouted).toBe(1); // one stray fix: ignored
    expect(t.update(fix(along(820)), 'k', plan).rerouted).toBe(1);
    t.update(fix(off), 'k', plan);
    expect(t.update(fix(off), 'k', plan).rerouted).toBe(2); // two in a row: re-planned
  });

  it('a poor fix never re-plans; a new target or mode does', () => {
    const t = new NavTracker();
    t.update(fix(along(500)), 'k', plan);
    const far = along(900, 400);
    t.update(fix(far, { acc: 150 }), 'k', plan);
    expect(t.update(fix(far, { acc: 150 }), 'k', plan).rerouted).toBe(1);
    expect(t.update(fix(along(900)), 'k2', plan).rerouted).toBe(2);
  });

  it('no fix: no time', () => {
    expect(Number.isNaN(new NavTracker().update(null, 'k', plan).etaMin)).toBe(true);
  });

  it('a route that doubles back does not jump to the far leg', () => {
    // out 2 km east and back 2 km west along a parallel track 20 m north
    const out = along(2000), back = destination(out.lat, out.lon, 0, 20), end = along(0, 20);
    const r: Route = { coords: [[A.lat, A.lon], [out.lat, out.lon], [back.lat, back.lon], [end.lat, end.lon]], distM: 4020, onTrackM: 4020, offRoadM: 0, etaMin: 20, viaTracks: true, cumM: [0, 2000, 2020, 4020], cumMin: [0, 10, 10.1, 20] };
    const p = progressOn(r, ...Object.values(along(500, 12)) as [number, number], 450);
    expect(p.seg).toBe(0); // still on the way out, although the return leg is nearer
    expect(p.remainingM).toBeCloseTo(3520, -1);
  });
});

describe('heading', () => {
  it('angle differences wrap', () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
    expect(angleDiff(0, 180)).toBe(-180);
  });
  it('GPS course when moving, compass when still', () => {
    const h = new HeadingFilter();
    expect(h.update(fix(A, { speed: 0, heading: null }), 100)).toBe(100); // still: compass
    const k = new HeadingFilter();
    expect(k.update(fix(A, { speed: 10, heading: 350 }), 120)).toBe(350); // moving: GPS course wins over compass
    expect(k.update(fix(A, { speed: 10, heading: 10 }), 120)).toBe(10);
    expect(k.update(fix(A, { speed: 0.5, heading: 10 }), 120)).toBe(120); // stopped: back to the compass
  });
  it('a steady reading is followed all the way (no stalling part-way)', () => {
    const h = new HeadingFilter();
    h.update(null, 60);
    expect(h.update(null, 200)).toBe(200);
    expect(h.update(null, 200)).toBe(200);
  });
  it('small wobbles are ignored', () => {
    const h = new HeadingFilter();
    h.update(null, 90);
    expect(h.update(null, 92)).toBe(90);
    expect(h.update(null, 91)).toBe(90);
  });
});
