import { describe, expect, it } from 'vitest';
import { bearingDeg, countTiles, destination, fmtDms, fmtUtm, haversineM, pointInPolygon, polygonStats, toUtm30 } from '../src/core/geo';

describe('geodesy', () => {
  it('haversine ≈ 111.2 km per degree of latitude', () => {
    expect(haversineM(0, 0, 1, 0)).toBeGreaterThan(111_000);
    expect(haversineM(0, 0, 1, 0)).toBeLessThan(111_400);
  });
  it('bearing', () => {
    expect(bearingDeg(6.8, -0.8, 6.9, -0.8)).toBeCloseTo(0, 3);
    expect(bearingDeg(6.8, -0.8, 6.8, -0.7)).toBeCloseTo(90, 1);
    expect(bearingDeg(6.8, -0.8, 6.7, -0.8)).toBeCloseTo(180, 3);
  });
  it('destination inverts distance/bearing', () => {
    const p = destination(6.83, -0.81, 42, 1500);
    expect(haversineM(6.83, -0.81, p.lat, p.lon)).toBeCloseTo(1500, 0);
    expect(bearingDeg(6.83, -0.81, p.lat, p.lon)).toBeCloseTo(42, 2);
  });
  it('T8 calc: a 100 m × 100 m square is 1.00 ha within 0.5%', () => {
    const a = { lat: 6.83, lon: -0.81 };
    const b = destination(a.lat, a.lon, 90, 100);
    const c = destination(b.lat, b.lon, 180, 100);
    const d = destination(a.lat, a.lon, 180, 100);
    const s = polygonStats([a, b, c, d])!;
    expect(Math.abs(s.areaHa - 1) / 1).toBeLessThan(0.005);
    expect(s.lengthKm).toBeCloseTo(0.4, 2);
  });
  it('point in polygon with holes', () => {
    const poly: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
    expect(pointInPolygon(1, 1, poly)).toBe(true);
    expect(pointInPolygon(5, 5, poly)).toBe(false);
    expect(pointInPolygon(11, 5, poly)).toBe(false);
  });
  it('UTM 30N: central meridian −3° has easting 500 000', () => {
    expect(toUtm30(6.8, -3).e).toBeCloseTo(500000, 0);
    expect(fmtUtm(6.83, -0.81)).toMatch(/^30N \d{6} E \d{6,7} N$/);
  });
  it('DMS', () => {
    expect(fmtDms(6.8130, 'lat')).toBe(`6°48'46.8"N`);
    expect(fmtDms(-0.8010, 'lon')).toBe(`0°48'03.6"W`);
  });
  it('tile count for the default pack is within the guard', () => {
    expect(countTiles([6.78, -0.87, 6.88, -0.76], 12, 16)).toBeLessThan(4000);
  });
});
