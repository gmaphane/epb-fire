import { describe, expect, it } from 'vitest';
import { rosAt, spreadParams, threats, spreadEllipse } from '../src/core/spread';
import type { Compartment } from '../src/core/types';

const sq = (id: string, lon0: number, lat0: number, d = 0.005): Compartment => ({
  id, code: id, block: 'Block C', risk_class: 'high', risk_score: null, treatment_status: '',
  geojson: { type: 'Polygon', coordinates: [[[lon0, lat0], [lon0 + d, lat0], [lon0 + d, lat0 + d], [lon0, lat0 + d], [lon0, lat0]]] },
});
const fire = { lat: 6.8, lon: -0.9 };
// one compartment ~1 km east, one ~1 km west, one containing the fire
const east = sq('C_EAST', -0.891, 6.7975);
const west = sq('C_WEST', -0.914, 6.7975);
const home = sq('C_HOME', -0.9025, 6.7975);

describe('spread', () => {
  it('spreads fastest downwind', () => {
    const p = spreadParams({ kmh: 20, from: 270 }); // westerly wind → blows to the east
    expect(rosAt(90, p)).toBeGreaterThan(rosAt(270, p) * 5);
    expect(Math.round(rosAt(90, p))).toBe(Math.round(p.head));
  });
  it('ranks the downwind compartment first and flags the burning one', () => {
    const t = threats(fire, [west, east, home], { kmh: 20, from: 270 });
    expect(t[0].code).toBe('C_HOME');
    expect(t[0].level).toBe('burning');
    expect(t[1].code).toBe('C_EAST');
    expect(t[1].downwind).toBe(true);
    const w = t.find((x) => x.code === 'C_WEST')!;
    expect(w.etaMin!).toBeGreaterThan(t[1].etaMin! * 5);
  });
  it('stronger wind arrives sooner; young bamboo is flagged', () => {
    const calm = threats(fire, [east], { kmh: 5, from: 270 })[0].etaMin!;
    const windy = threats(fire, [east], { kmh: 25, from: 270 })[0].etaMin!;
    expect(windy).toBeLessThan(calm / 3);
    const young = { ...east, props: { yop_youngest: 2025, planted_ha: 90 } };
    const old = { ...west, props: { yop_youngest: 2021 } };
    const t = threats(fire, [young, old, home], { kmh: 10, from: 270 }, 6, 2026);
    expect(t.find((x) => x.code === 'C_EAST')!.young).toBe(true);
    expect(t.find((x) => x.code === 'C_WEST')!.young).toBe(false);
    expect(t.find((x) => x.code === 'C_HOME')!.yop).toBe(null);
  });
  it('ellipse reaches further downwind', () => {
    const e = spreadEllipse(fire, { kmh: 20, from: 270 }, 60);
    const maxLon = Math.max(...e.map((p) => p[1])), minLon = Math.min(...e.map((p) => p[1]));
    expect(maxLon - fire.lon).toBeGreaterThan((fire.lon - minLon) * 5);
  });
});
