import type { Asset, Compartment, Crew, CrewPosition, Detection, Me, Road } from '../core/types';

/**
 * DEMO DATA ONLY — placeholder geometry around the PSP area (≈ 6.83 N, 0.81 W).
 * Real compartments, roads, water points and cameras must be imported before the pilot.
 */
const ORIGIN = { lat: 6.8135, lon: -0.8255 };
const STEP = 0.0058; // ≈ 640 m

function sq(col: number, row: number, skew = 0): GeoJSON.Polygon {
  const lon0 = ORIGIN.lon + col * STEP;
  const lat0 = ORIGIN.lat + row * STEP;
  const j = (n: number) => skew * (((n * 7919) % 13) / 13 - 0.5) * STEP * 0.25;
  const pts = [
    [lon0 + j(1), lat0 + j(2)],
    [lon0 + STEP + j(3), lat0 + j(4)],
    [lon0 + STEP + j(5), lat0 + STEP + j(6)],
    [lon0 + j(7), lat0 + STEP + j(8)],
  ];
  return { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
}

const risk = ['moderate', 'high', 'very_high', 'low', 'extreme', 'high'] as const;
const treat = ['Slashed + sprayed', 'Slashed', 'Not started', 'Slashed + sprayed', 'Slashing in progress', 'Not started'];

export const DEMO_COMPARTMENTS: Compartment[] = [
  ['A', 0, 0],
  ['A', 0, 1],
  ['B', 1, 0],
  ['B', 1, 1],
  ['C', 2, 0],
  ['C', 2, 1],
].map(([blk, c, r], i) => ({
  id: `00000000-0000-4000-8000-0000000000${10 + i}`,
  code: `DEMO-${blk}${String(i + 1).padStart(2, '0')}`,
  block: `Block ${blk}`,
  geojson: sq(c as number, r as number, i + 1),
  risk_class: risk[i],
  risk_score: [42, 61, 78, 24, 91, 66][i],
  treatment_status: treat[i],
  props: { yop_youngest: [2022, 2024, 2025, 2021, 2025, 2023][i], planted_ha: [88, 95, 102, 110, 76, 99][i] },
}));

const at = (c: number, r: number, fx: number, fy: number) => ({
  lat: ORIGIN.lat + (r + fy) * STEP,
  lon: ORIGIN.lon + (c + fx) * STEP,
});

export const DEMO_ASSETS: Asset[] = [
  { id: '00000000-0000-4000-8000-000000000101', kind: 'water', name: 'Water point 1 (creek)', ...at(0, 0, 0.5, 0.1), props: { capacity: 'Perennial creek' } },
  { id: '00000000-0000-4000-8000-000000000102', kind: 'water', name: 'Water tank 2', ...at(1, 1, 0.3, 0.6), props: { capacity: '10 000 L' } },
  { id: '00000000-0000-4000-8000-000000000103', kind: 'water', name: 'Water tank 3', ...at(2, 0, 0.7, 0.4), props: { capacity: '10 000 L' } },
  { id: '00000000-0000-4000-8000-000000000104', kind: 'camera', name: 'Camera 1', ...at(0, 1, 0.9, 0.9), props: { bearing: 100, radius_m: 4000 } },
  { id: '00000000-0000-4000-8000-000000000105', kind: 'camera', name: 'Camera 2', ...at(2, 1, 0.1, 0.8), props: { bearing: 260, radius_m: 4000 } },
  { id: '00000000-0000-4000-8000-000000000106', kind: 'tower', name: 'Lookout tower', ...at(1, 0, 0.5, 0.5), props: {} },
  { id: '00000000-0000-4000-8000-000000000107', kind: 'camp', name: 'Camp (Blocks B/C)', ...at(1, 0, 0.9, 0.05), props: {} },
  { id: '00000000-0000-4000-8000-000000000108', kind: 'assembly', name: 'Assembly point', ...at(1, 1, 0.05, 0.05), props: {} },
];

const line = (pts: [number, number][]): GeoJSON.LineString => ({
  type: 'LineString',
  coordinates: pts.map(([c, r]) => {
    const p = at(Math.floor(c), Math.floor(r), c % 1, r % 1);
    return [p.lon, p.lat];
  }),
});

export const DEMO_ROADS: Road[] = [
  { id: '00000000-0000-4000-8000-000000000201', name: 'Main access track', passable: true, geojson: line([[-0.2, 0.05], [0.9, 0.12], [1.9, 0.1], [3.2, 0.2]]) },
  { id: '00000000-0000-4000-8000-000000000202', name: 'Block B spur', passable: true, geojson: line([[1.5, 0.1], [1.5, 1], [1.5, 2.2]]) },
  { id: '00000000-0000-4000-8000-000000000203', name: 'Block C spur (washed out)', passable: false, geojson: line([[2.5, 0.1], [2.55, 1], [2.5, 2.2]]) },
];

export const DEMO_CREWS: Crew[] = [
  { id: '00000000-0000-4000-8000-000000000301', name: 'Block A — Day', block: 'Block A', shift: 'day' },
  { id: '00000000-0000-4000-8000-000000000302', name: 'Block A — Night', block: 'Block A', shift: 'night' },
  { id: '00000000-0000-4000-8000-000000000303', name: 'Block B — Day', block: 'Block B', shift: 'day' },
  { id: '00000000-0000-4000-8000-000000000304', name: 'Block B — Night', block: 'Block B', shift: 'night' },
  { id: '00000000-0000-4000-8000-000000000305', name: 'Block C — Day', block: 'Block C', shift: 'day' },
  { id: '00000000-0000-4000-8000-000000000306', name: 'Block C — Night', block: 'Block C', shift: 'night' },
  { id: '00000000-0000-4000-8000-000000000307', name: 'Community support', block: 'All', shift: 'support' },
];

export function demoDetections(now = Date.now()): Detection[] {
  const iso = (m: number) => new Date(now - m * 60_000).toISOString();
  const a = at(2, 0, 0.35, 0.55);
  const b = at(3, 1, 0.5, 0.5);
  return [
    { id: '00000000-0000-4000-8000-000000000401', source: 'VIIRS_SNPP_NRT', acq_time: iso(95), confidence: 'nominal', frp: 6.2, ...a, promoted_incident_id: null, client_updated_at: iso(95) },
    { id: '00000000-0000-4000-8000-000000000402', source: 'MODIS_NRT', acq_time: iso(240), confidence: 'low', frp: 3.1, ...b, promoted_incident_id: null, client_updated_at: iso(240) },
  ];
}

export const DEMO_USERS: (Me & { email: string })[] = [
  { id: '00000000-0000-4000-8000-000000000501', email: 'reporter@demo', name: 'Demo Reporter', role: 'reporter', crew_id: null },
  { id: '00000000-0000-4000-8000-000000000502', email: 'responder@demo', name: 'Demo Responder (Block B Day)', role: 'responder', crew_id: '00000000-0000-4000-8000-000000000303' },
  { id: '00000000-0000-4000-8000-000000000503', email: 'coordinator@demo', name: 'Demo Coordinator', role: 'coordinator', crew_id: null },
  { id: '00000000-0000-4000-8000-000000000504', email: 'manager@demo', name: 'Demo Manager', role: 'manager', crew_id: null },
  { id: '00000000-0000-4000-8000-000000000505', email: 'admin@demo', name: 'Demo Admin', role: 'admin', crew_id: null },
];

/** Demo live crew locations: two standby teams checked in at posts. */
export function demoCrewPositions(now = Date.now()): CrewPosition[] {
  const iso = (m: number) => new Date(now - m * 60_000).toISOString();
  const mk = (n: number, name: string, crew: string, p: { lat: number; lon: number }, mins: number): CrewPosition => ({
    id: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, '0')}`, user_id: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, '0')}`,
    name, crew_id: crew, status: 'standby', incident_id: null, lat: p.lat, lon: p.lon, acc: 8, heading: null, speed: null, fix_at: iso(mins), client_updated_at: iso(mins),
  });
  return [
    mk(1, 'Kofi (Block A day)', '00000000-0000-4000-8000-000000000301', at(0, 1, 0.25, 0.3), 1),
    mk(2, 'Ama (Block C day)', '00000000-0000-4000-8000-000000000305', at(2, 1, 0.6, 0.2), 2),
  ];
}
