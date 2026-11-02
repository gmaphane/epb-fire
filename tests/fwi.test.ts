import { describe, expect, it } from 'vitest';
import { bui, dc, dmc, ffmc, fwi, isi, levelOfFwi, series } from '../supabase/functions/_shared/fwi';
import { rate } from '../supabase/functions/_shared/danger';

// Reference: Van Wagner & Pickett (1985) / cffdrs test data, first two days (lat 46 N, April day lengths).
describe('Canadian FWI system', () => {
  it('matches the published reference values', () => {
    const f1 = ffmc(17, 42, 25, 0, 85), p1 = dmc(17, 42, 0, 6, 12.8), d1 = dc(17, 0, 15, 0.9);
    const i1 = isi(25, f1), u1 = bui(p1, d1);
    expect(f1).toBeCloseTo(87.69, 1); expect(p1).toBeCloseTo(8.55, 1); expect(d1).toBeCloseTo(19.01, 1);
    expect(i1).toBeCloseTo(10.85, 1); expect(u1).toBeCloseTo(8.49, 1); expect(fwi(i1, u1)).toBeCloseTo(10.10, 1);
    const f2 = ffmc(20, 21, 25, 2.4, f1), p2 = dmc(20, 21, 2.4, p1, 12.8), d2 = dc(20, 2.4, d1, 0.9);
    const i2 = isi(25, f2), u2 = bui(p2, d2);
    expect(f2).toBeCloseTo(86.2, 1); expect(p2).toBeCloseTo(10.4, 1); expect(d2).toBeCloseTo(23.6, 1);
    expect(i2).toBeCloseTo(8.8, 1); expect(u2).toBeCloseTo(10.4, 1); expect(fwi(i2, u2)).toBeCloseTo(9.3, 1);
  });

  it('dries out over rainless days and drops after heavy rain', () => {
    const dry = series(Array.from({ length: 20 }, () => ({ t: 33, h: 30, w: 15, rain: 0 })));
    expect(dry[19].fwi).toBeGreaterThan(dry[0].fwi);
    const wet = series([...Array.from({ length: 20 }, () => ({ t: 33, h: 30, w: 15, rain: 0 })), { t: 26, h: 90, w: 5, rain: 40 }]);
    expect(wet[20].fwi).toBeLessThan(wet[19].fwi);
    expect(levelOfFwi(5)).toBe(0); expect(levelOfFwi(15)).toBe(1); expect(levelOfFwi(30)).toBe(2); expect(levelOfFwi(45)).toBe(3); expect(levelOfFwi(60)).toBe(4);
  });

  it('rates a block from hourly weather', () => {
    const time: string[] = [], T: number[] = [], H: number[] = [], W: number[] = [], D: number[] = [], P: number[] = [];
    const start = Date.UTC(2026, 8, 3);
    for (let h = 0; h < 61 * 24; h++) {
      const d = new Date(start + h * 3600e3), hr = d.getUTCHours(), day = Math.floor(h / 24), s = Math.sin(((hr - 9) / 24) * 2 * Math.PI);
      time.push(d.toISOString().slice(0, 16)); T.push(24 + 8 * s); H.push(85 - 40 * s); W.push(8 + 6 * s); D.push(45);
      P.push(day < 45 && hr === 16 && day % 3 === 0 ? 12 : 0);
    }
    const today = time[time.length - 1].slice(0, 10);
    const r = rate({ time, temperature_2m: T, relative_humidity_2m: H, wind_speed_10m: W, wind_direction_10m: D, precipitation: P }, today)!;
    expect(r.since).toBe(17);
    expect(r.peak.hour).toBe('15:00');
    expect(r.x.fwi).toBeGreaterThan(5);
    expect(rate({ time, temperature_2m: T, relative_humidity_2m: H, wind_speed_10m: W, wind_direction_10m: D, precipitation: P }, '2027-01-01')).toBeNull();
  });
});
