import { describe, expect, it } from 'vitest';
import { DEFAULT_RISK, distanceToCompartmentM, rateCompartment, riskParams, type RiskInputs } from '../src/core/compartmentRisk';
import { destination } from '../src/core/geo';
import type { Compartment, Detection, FeedStatus, FireDanger, FuelDryness } from '../src/core/types';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const H = (h: number) => new Date(NOW - h * 3600e3).toISOString();
// a 1 km × 1 km compartment
const SW = { lat: 6.8, lon: -0.9 };
const NE = destination(destination(SW.lat, SW.lon, 0, 1000).lat, SW.lon, 90, 1000);
const sq: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[SW.lon, SW.lat], [NE.lon, SW.lat], [NE.lon, NE.lat], [SW.lon, NE.lat], [SW.lon, SW.lat]]] };
const cpt = (p: Partial<Compartment> = {}): Compartment => ({
  id: 'c', code: 'C008', block: 'Block C', geojson: sq, risk_class: 'moderate', risk_score: null, treatment_status: '',
  edge: true, edge_length_m: 1000, edge_gap_pct: 0, edge_uncertain_pct: 0, edge_protected_pct: 100, edge_checked_at: H(24), ...p,
});
const dry = (cls: FuelDryness['class'], p: Partial<FuelDryness> = {}): FuelDryness => ({
  id: 'x', zone_kind: 'compartment', compartment: 'C008', block: 'Block C', ndmi_p25: 0, ndmi_p50: 0.05, ndmi_p75: 0.1, usable_pct: 100,
  class: cls, class_basis: '', window_from: '2026-11-06', window_to: '2026-11-12', cadence: 'weekly', images: [],
  fuel_load_t_ha: null, fuel_load_source: null, computed_at: H(6), ...p,
});
const fwi = (level: FireDanger['level'], day = '2026-11-13'): FireDanger => ({
  id: `${day}|C`, day, block: 'Block C', level, fwi: 20, ffwi: null, temp_max_c: null, rh_min_pct: null, wind_max_kmh: null, wind_from_deg: null,
  days_since_rain: null, rain_24h_mm: null, basis: '', client_updated_at: H(6),
});
const feedOk: FeedStatus[] = [{ id: 'firms', last_attempt: H(0.1), last_ok: H(0.1), detail: '' }];
const det = (m: number, hAgo: number, p: Partial<Detection> = {}): Detection => {
  const pt = destination(SW.lat, SW.lon, 180, m); // m metres south of the compartment's south edge
  return { id: `d${m}-${hAgo}`, source: 'VIIRS_NOAA21_NRT', acq_time: H(hAgo), confidence: 'nominal', frp: 3, lat: pt.lat, lon: SW.lon + 0.0001, promoted_incident_id: null, client_updated_at: H(hAgo), ...p };
};
const base = (p: Partial<RiskInputs> = {}): RiskInputs => ({
  compartment: cpt(), dryIn: dry('low'), dryOut: dry('low', { zone_kind: 'edge_zone' }), detections: [], danger: [fwi('low')], feeds: feedOk, now: NOW, ...p,
});
const drv = (r: ReturnType<typeof rateCompartment>, k: string) => r.drivers.find((d) => d.key === k)!;

describe('distance to a compartment (1 km trigger)', () => {
  it('0 inside, metres to the nearest edge outside', () => {
    expect(distanceToCompartmentM(SW.lat + 0.004, SW.lon + 0.004, sq)).toBe(0);
    const p = destination(SW.lat, SW.lon + 0.004, 180, 999);
    expect(distanceToCompartmentM(p.lat, p.lon, sq)).toBeCloseTo(999, 0);
  });
  it('999 m / 1000 m / 1001 m around the 1 km rule (last 24 h)', () => {
    expect(drv(rateCompartment(base({ detections: [det(999, 5)] })), 'detections').score).toBe(3);
    expect(drv(rateCompartment(base({ detections: [det(1000, 5)] })), 'detections').score).toBe(3);
    expect(drv(rateCompartment(base({ detections: [det(1001, 5)] })), 'detections').score).toBe(2);
  });
  it('older or further detections score lower; promoted ones are ignored', () => {
    expect(drv(rateCompartment(base({ detections: [det(500, 30)] })), 'detections').score).toBe(2); // 1 km but 30 h ago
    expect(drv(rateCompartment(base({ detections: [det(3000, 100)] })), 'detections').score).toBe(1);
    expect(drv(rateCompartment(base({ detections: [det(6000, 2)] })), 'detections').score).toBe(0);
    expect(drv(rateCompartment(base({ detections: [det(500, 2, { promoted_incident_id: 'i' })] })), 'detections').score).toBe(0);
  });
});

describe('rating from drivers', () => {
  it('all calm: Low; every driver listed with its value', () => {
    const r = rateCompartment(base());
    expect(r.rating).toBe('low');
    expect(r.score).toBe(0);
    expect(r.drivers.map((d) => d.key)).toEqual(['dryness_in', 'dryness_out', 'barriers', 'detections', 'weather']);
  });
  it('weighted mean, banded', () => {
    // dryness in high(2) .25, out extreme(3) .2, barriers open 100%(3) .15, detections 0 .2, weather high(2) .2 → 1.95 → High
    const r = rateCompartment(base({ dryIn: dry('high'), dryOut: dry('extreme'), danger: [fwi('high')], compartment: cpt({ edge_gap_pct: 100, edge_protected_pct: 0 }) }));
    expect(r.score).toBeCloseTo(1.95, 2);
    expect(r.rating).toBe('high');
  });
  it('barriers: unverified counts half as open', () => {
    const s = (gap: number, unc: number) => drv(rateCompartment(base({ compartment: cpt({ edge_gap_pct: gap, edge_uncertain_pct: unc, edge_protected_pct: 100 - gap - unc }) })), 'barriers').score;
    expect(s(0, 0)).toBe(0);
    expect(s(0, 52)).toBe(1); // today's typical edge: only unverified barriers → 26% open
    expect(s(48, 52)).toBe(3); // 74% open
    expect(s(20, 0)).toBe(1);
  });
  it('interior compartments: outside dryness and barriers do not apply', () => {
    const r = rateCompartment(base({ compartment: cpt({ edge: false }), dryOut: undefined }));
    expect(drv(r, 'dryness_out').applies).toBe(false);
    expect(drv(r, 'barriers').applies).toBe(false);
    expect(r.rating).toBe('low');
  });
  it('a satellite fire within 1 km in 24 h makes it at least High', () => {
    const r = rateCompartment(base({ detections: [det(400, 3)] }));
    expect(r.rating).toBe('high');
    expect(r.why).toMatch(/at least High/);
  });
});

describe('missing or stale data is unknown, not low', () => {
  it('no dryness reading inside: Unknown', () => {
    expect(rateCompartment(base({ dryIn: undefined })).rating).toBe('unknown');
    expect(rateCompartment(base({ dryIn: dry('unknown') })).rating).toBe('unknown');
  });
  it('dryness older than 16 days: unknown driver, Unknown rating', () => {
    const r = rateCompartment(base({ dryIn: dry('low', { computed_at: H(17 * 24) }) }));
    expect(drv(r, 'dryness_in').score).toBeNull();
    expect(drv(r, 'dryness_in').stale).toBe(true);
    expect(r.rating).toBe('unknown');
  });
  it('detection feed not updating: "none nearby" is unknown, but a fire that did arrive still counts', () => {
    const stale: FeedStatus[] = [{ id: 'firms', last_attempt: H(0.1), last_ok: H(5), detail: 'HTTP 503' }];
    expect(drv(rateCompartment(base({ feeds: stale })), 'detections').score).toBeNull();
    expect(drv(rateCompartment(base({ feeds: [] })), 'detections').score).toBeNull();
    expect(drv(rateCompartment(base({ feeds: stale, detections: [det(300, 2)] })), 'detections').score).toBe(3);
  });
  it('no fire weather for today: unknown driver', () => {
    expect(drv(rateCompartment(base({ danger: [fwi('extreme', '2026-11-12')] })), 'weather').score).toBeNull();
  });
  it('fewer than half the weight known: Unknown, unless the 1 km override applies', () => {
    const thin = base({ dryOut: undefined, danger: [], feeds: [], compartment: cpt({ edge_checked_at: null }) });
    expect(rateCompartment(thin).rating).toBe('unknown');
    const withFire = rateCompartment({ ...thin, detections: [det(200, 1)] });
    expect(withFire.rating).toBe('high');
    expect(withFire.why).toMatch(/incomplete data/);
  });
});

describe('settings', () => {
  it('risk_config overrides merge over defaults', () => {
    const p = riskParams({ risk: { weights: { weather: 0.5 }, bands: [1, 2, 2.5] } });
    expect(p.weights.weather).toBe(0.5);
    expect(p.weights.dryness_in).toBe(DEFAULT_RISK.weights.dryness_in);
    expect(p.bands).toEqual([1, 2, 2.5]);
    expect(riskParams(null)).toEqual(DEFAULT_RISK);
  });
});
