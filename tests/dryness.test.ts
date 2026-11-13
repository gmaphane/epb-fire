import { describe, expect, it } from 'vitest';
import { cadenceOf, chooseWindow, drynessClass, drynessStale, readStats, usablePct } from '../supabase/functions/_shared/dryness';

describe('fuel dryness classes (NDMI)', () => {
  it('thresholds: wettest first, boundaries inclusive', () => {
    expect(drynessClass(0.35)).toBe('low');
    expect(drynessClass(0.2)).toBe('low');
    expect(drynessClass(0.19)).toBe('moderate');
    expect(drynessClass(0.1)).toBe('moderate');
    expect(drynessClass(0.05)).toBe('high');
    expect(drynessClass(0)).toBe('high');
    expect(drynessClass(-0.05)).toBe('extreme'); // 2023/24 bad season level
    expect(drynessClass(-0.9)).toBe('extreme');
  });
  it('missing data is unknown, never low', () => {
    expect(drynessClass(null)).toBe('unknown');
    expect(drynessClass(undefined)).toBe('unknown');
    expect(drynessClass(NaN)).toBe('unknown');
  });
});

describe('cloud fallback: 7 → 14 → 30 days, else unknown', () => {
  const s = (p50: number | null, valid = 100) => ({ p25: p50, p50, p75: p50, valid });
  it('uses the weekly result when enough is clear', () => {
    const r = chooseWindow([{ days: 7, stats: s(0.05), usable: 80 }], 30);
    expect(r.cadence).toBe('weekly');
    expect(r.attempt?.days).toBe(7);
  });
  it('falls back to two weeks when the week was cloudy', () => {
    const r = chooseWindow([{ days: 7, stats: s(0.05, 5), usable: 10 }, { days: 14, stats: s(0.06), usable: 65 }], 30);
    expect(r.cadence).toBe('fortnightly');
    expect(r.attempt?.days).toBe(14);
  });
  it('then a month, marked monthly (older imagery)', () => {
    const r = chooseWindow([{ days: 7, stats: null, usable: 0 }, { days: 14, stats: s(0.1, 2), usable: 4 }, { days: 30, stats: s(0.12), usable: 45 }], 30);
    expect(r.cadence).toBe('monthly');
  });
  it('still too cloudy: unknown (cadence none), keeps the best try for the record', () => {
    const r = chooseWindow([{ days: 7, stats: null, usable: 0 }, { days: 14, stats: s(0.1, 2), usable: 4 }, { days: 30, stats: s(0.12, 10), usable: 20 }], 30);
    expect(r.cadence).toBe('none');
    expect(r.cls_ok).toBe(false);
    expect(r.attempt?.days).toBe(30);
  });
  it('cadence names', () => {
    expect([cadenceOf(7), cadenceOf(14), cadenceOf(30)]).toEqual(['weekly', 'fortnightly', 'monthly']);
  });
});

describe('usable pixels and response reading', () => {
  it('usable share is against the zone, not the bounding box', () => {
    // B104 probe (13 Nov 2026): 264 bbox pixels, 71 outside the zone came back as no-data, zone ≈ 193 px at 20 m
    expect(usablePct(264 - 71, 193 * 400, 20)).toBeCloseTo(100, 0);
    expect(usablePct(50, 200 * 400, 20)).toBe(25);
    expect(usablePct(500, 200 * 400, 20)).toBe(100); // capped
    expect(usablePct(10, 0, 20)).toBe(0);
  });
  it('reads the Statistical API shape', () => {
    const resp = { data: [{ interval: {}, outputs: { ndmi: { bands: { B0: { stats: { sampleCount: 264, noDataCount: 71, percentiles: { '25.0': 0.017, '50.0': 0.046, '75.0': 0.085 } } } } } } }] };
    expect(readStats(resp)).toEqual({ p25: 0.017, p50: 0.046, p75: 0.085, valid: 193 });
    expect(readStats({ data: [] })).toBeNull();
    // all no-data: percentiles are meaningless → null
    expect(readStats({ data: [{ outputs: { ndmi: { bands: { B0: { stats: { sampleCount: 100, noDataCount: 100, percentiles: { '50.0': 'NaN' } } } } } } }] })?.p50).toBeNull();
  });
  it('stale after 16 days', () => {
    const now = Date.parse('2026-11-30T00:00:00Z');
    expect(drynessStale('2026-11-20T00:00:00Z', 16, now)).toBe(false);
    expect(drynessStale('2026-11-10T00:00:00Z', 16, now)).toBe(true);
    expect(drynessStale(null, 16, now)).toBe(true);
  });
});
