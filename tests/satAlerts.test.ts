import { describe, expect, it } from 'vitest';
import { markAnnounced, pickSatAlerts, satLevel, satName, satTime, satWhere, SAT_ALERT } from '../src/core/satAlerts';
import type { Detection } from '../src/core/types';

const NOW = Date.parse('2026-11-09T20:00:00Z');
const det = (id: string, distance_m: number | null, hoursAgo = 2, extra: Partial<Detection> = {}): Detection => ({
  id, source: 'VIIRS_NOAA21_NRT', acq_time: new Date(NOW - hoursAgo * 3600_000).toISOString(), confidence: 'nominal', frp: 3,
  lat: 6.8, lon: -0.85, promoted_incident_id: null, compartment: 'B121', distance_m, block: 'Block B', client_updated_at: '', ...extra,
});

describe('satellite fire alert rules', () => {
  it('1 km trigger is inclusive, 2 km is the outer banner', () => {
    expect(satLevel(0)).toBe('urgent');
    expect(satLevel(999)).toBe('urgent');
    expect(satLevel(1000)).toBe('urgent');
    expect(satLevel(1001)).toBe('near');
    expect(satLevel(2000)).toBe('near');
    expect(satLevel(2001)).toBeNull();
  });

  it('no distance yet = not decided, and not marked as announced', () => {
    expect(satLevel(null)).toBeNull();
    expect(satLevel(undefined)).toBeNull();
    const pending = det('a', null);
    const p = pickSatAlerts([pending], {}, NOW);
    expect(p.urgent).toHaveLength(0);
    // the server fills in the distance a moment later: the same row must now alert
    const later = pickSatAlerts([{ ...pending, distance_m: 425 }], markAnnounced({}, [], NOW), NOW);
    expect(later.urgent.map((d) => d.id)).toEqual(['a']);
  });

  it('distance arriving as a numeric string (Postgres numeric) still works', () => {
    expect(pickSatAlerts([det('s', '68' as unknown as number)], {}, NOW).urgent).toHaveLength(1);
  });

  it('alerts detections that arrived while the app was closed, within 24 h of the satellite pass', () => {
    const p = pickSatAlerts([det('old', 300, SAT_ALERT.WINDOW_H + 0.1), det('late', 300, 5.5)], {}, NOW);
    expect(p.urgent.map((d) => d.id)).toEqual(['late']); // 5.5 h FIRMS delay is inside the window
  });

  it('each detection alerts once; promoted ones never', () => {
    const a = det('a', 800), b = det('b', 50), c = det('c', 1500), x = det('x', 10, 1, { promoted_incident_id: 'inc' });
    const first = pickSatAlerts([a, b, c, x], {}, NOW);
    expect(first.urgent.map((d) => d.id)).toEqual(['b', 'a']); // closest first
    expect(first.near.map((d) => d.id)).toEqual(['c']);
    const seen = markAnnounced({}, [...first.urgent, ...first.near], NOW);
    const again = pickSatAlerts([a, b, c, x], seen, NOW);
    expect(again.urgent).toHaveLength(0);
    expect(again.near).toHaveLength(0);
  });

  it('the announced list forgets entries after a few days', () => {
    const old = { stale: new Date(NOW - (SAT_ALERT.KEEP_H + 1) * 3600_000).toISOString(), keep: new Date(NOW - 3600_000).toISOString() };
    expect(Object.keys(markAnnounced(old, [], NOW))).toEqual(['keep']);
  });

  it('wording', () => {
    expect(satWhere({ compartment: 'B104', distance_m: 68 })).toBe('70 m from B104');
    expect(satWhere({ compartment: 'B104', distance_m: 0 })).toBe('inside B104');
    expect(satWhere({ compartment: 'C011', distance_m: 1415 })).toBe('1.4 km from C011');
    expect(satName('VIIRS_NOAA21_NRT')).toBe('VIIRS NOAA-21');
    expect(satName('VIIRS_SNPP_NRT')).toBe('VIIRS S-NPP');
    expect(satName('MODIS_NRT')).toBe('MODIS');
    expect(satTime('2026-11-09T14:03:00Z')).toBe('14:03 UTC (GMT)');
  });
});
