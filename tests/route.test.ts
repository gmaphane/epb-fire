import { describe, expect, it } from 'vitest';
import { route } from '../src/core/route';
import type { MapLayer, Road } from '../src/core/types';

// an L-shaped track: west→east along lat 6.80, then north along lon -0.80
const roads: Road[] = [
  { id: 'r1', name: 'E-W', passable: true, geojson: { type: 'LineString', coordinates: [[-0.83, 6.8], [-0.815, 6.8], [-0.8, 6.8]] } },
  { id: 'r2', name: 'N-S', passable: true, geojson: { type: 'LineString', coordinates: [[-0.8001, 6.8001], [-0.8, 6.82]] } }, // end not exactly joined (~15 m)
  { id: 'r3', name: 'closed shortcut', passable: false, geojson: { type: 'LineString', coordinates: [[-0.83, 6.8], [-0.8, 6.82]] } },
];
const layers: MapLayer[] = [];

describe('route', () => {
  it('follows tracks when driving is faster than walking straight', () => {
    const r = route(roads, layers, { lat: 6.8002, lon: -0.8295 }, { lat: 6.8198, lon: -0.8002 }, 'drive');
    expect(r.viaTracks).toBe(true);
    // ~3.3 km E + ~2.2 km N on tracks, not the impassable diagonal
    expect(r.onTrackM).toBeGreaterThan(5000);
    expect(r.etaMin).toBeLessThan(20);
    expect(r.coords[0]).toEqual([6.8002, -0.8295]);
  });
  it('on foot also follows the tracks (crews stay on the network)', () => {
    const r = route(roads, layers, { lat: 6.8002, lon: -0.8295 }, { lat: 6.8198, lon: -0.8002 }, 'walk');
    expect(r.viaTracks).toBe(true);
    expect(r.onTrackM).toBeGreaterThan(5000);
    expect(r.coords.length).toBeGreaterThan(3);
  });
  it('short trips use the network too', () => {
    const r = route(roads, layers, { lat: 6.8003, lon: -0.825 }, { lat: 6.8003, lon: -0.818 }, 'drive');
    expect(r.viaTracks).toBe(true);
    expect(r.offRoadM).toBeLessThan(80);
  });
  it('snaps both ends onto one connected track system', () => {
    const island: Road[] = [...roads, { id: 'r4', name: 'island', passable: true, geojson: { type: 'LineString', coordinates: [[-0.79, 6.83], [-0.789, 6.831]] } }];
    const r = route(island, layers, { lat: 6.8002, lon: -0.8295 }, { lat: 6.8295, lon: -0.7905 }, 'drive');
    expect(r.viaTracks).toBe(true);
    expect(r.onTrackM).toBeGreaterThan(5000);
  });
  it('falls back with no network data', () => {
    const r = route([], [], { lat: 6.8, lon: -0.8 }, { lat: 6.81, lon: -0.8 });
    expect(r.viaTracks).toBe(false);
    expect(Math.round(r.distM)).toBeGreaterThan(1000);
  });
});
