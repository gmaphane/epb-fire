export type Role = 'reporter' | 'responder' | 'coordinator' | 'manager' | 'admin';

export type IncidentStatus =
  | 'reported'
  | 'confirmed'
  | 'responding'
  | 'on_scene'
  | 'contained'
  | 'controlled'
  | 'out'
  | 'dismissed';

export type SyncState = 'pending' | 'synced' | 'error';

/** Local-only bookkeeping, stripped before sending to the server. */
export interface Local {
  _sync?: SyncState;
}

export interface Me {
  id: string;
  name: string;
  role: Role;
  crew_id: string | null;
}

export interface Incident extends Local {
  id: string;
  code: string | null; // server-assigned, e.g. F-2026-0001
  label: string; // device-provisional label, e.g. "F-4K2A"
  status: IncidentStatus;
  source: 'tower' | 'camera' | 'satellite' | 'patrol' | 'community' | 'other';
  size_class: 'unknown' | 'small' | 'medium' | 'large';
  /** SOP 4.1 fire category 1–5 (null = not assessed yet). */
  category?: 1 | 2 | 3 | 4 | 5 | null;
  /** When the fire was declared Out: starts the Fire Watch Patrol and the report deadlines. */
  out_at?: string | null;
  /** When the Incident Report was submitted to the GM and VP of Forestry. */
  report_submitted_at?: string | null;
  notes: string;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  location_estimated: boolean;
  block: string | null;
  compartment: string | null;
  reported_by: string;
  reported_by_name: string;
  reported_at: string;
  client_updated_at: string;
  updated_at?: string;
  cause: string | null;
  area_ha: number | null;
  dismiss_reason: string | null;
  detection_id: string | null;
  deleted_at: string | null;
  /** gps = device fix, map = pin dropped, manual = typed (e.g. read out over radio), satellite = hotspot */
  location_source: 'gps' | 'map' | 'manual' | 'satellite';
  observer_name: string | null;
  relayed_via: 'radio' | 'phone' | null;
  observed_at: string | null;
}

export type EventKind =
  | 'reported'
  | 'status'
  | 'note'
  | 'dispatch'
  | 'ack'
  | 'en_route'
  | 'on_scene'
  | 'need_support'
  | 'photo'
  | 'perimeter'
  | 'hazard';

export interface IncidentEvent extends Local {
  id: string;
  incident_id: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  by: string;
  by_name: string;
  client_ts: string;
  received_at?: string;
  updated_at?: string;
}

export type AssignmentState = 'dispatched' | 'acknowledged' | 'en_route' | 'on_scene' | 'released';

export interface Assignment extends Local {
  id: string;
  incident_id: string;
  crew_id: string | null;
  user_id: string | null;
  state: AssignmentState;
  instruction: string;
  need_support: boolean;
  dispatched_by: string;
  dispatched_at: string;
  acked_at: string | null;
  acked_by: string | null;
  en_route_at: string | null;
  on_scene_at: string | null;
  client_updated_at: string;
  updated_at?: string;
}

export interface Vertex {
  lat: number;
  lon: number;
  acc: number | null;
  ts: string;
  manual?: boolean;
}

export interface Perimeter extends Local {
  id: string;
  incident_id: string;
  state: 'recording' | 'paused' | 'closed';
  vertices: Vertex[];
  rejected_fixes: number;
  area_ha: number | null;
  length_km: number | null;
  walk_seconds: number;
  started_at: string;
  closed_at: string | null;
  by: string;
  client_updated_at: string;
  updated_at?: string;
}

export interface PhotoRow extends Local {
  id: string;
  incident_id: string;
  storage_path: string;
  lat: number | null;
  lon: number | null;
  accuracy_m: number | null;
  heading: number | null;
  taken_at: string;
  by: string;
  uploaded: boolean;
  client_updated_at: string;
  updated_at?: string;
}

export interface Hazard extends Local {
  id: string;
  kind: 'road_blocked' | 'tree_down' | 'bridge' | 'other';
  note: string;
  lat: number;
  lon: number;
  by: string;
  created_at: string;
  resolved_at: string | null;
  client_updated_at: string;
  updated_at?: string;
}

export interface Detection {
  id: string;
  source: string; // e.g. VIIRS_SNPP
  acq_time: string;
  confidence: string;
  frp: number | null;
  lat: number;
  lon: number;
  promoted_incident_id: string | null;
  compartment?: string | null; // nearest compartment (server-computed)
  distance_m?: number | null; // 0 = inside
  notified_at?: string | null;
  client_updated_at: string;
  updated_at?: string;
}

export type AssetKind = 'water' | 'camera' | 'tower' | 'camp' | 'assembly' | 'standby_post' | 'parking' | 'community';
export interface Asset {
  id: string;
  kind: AssetKind;
  name: string;
  lat: number;
  lon: number;
  props: Record<string, unknown>;
  updated_at?: string;
}

export interface Compartment {
  id: string;
  code: string;
  block: string;
  geojson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  risk_class: 'low' | 'moderate' | 'high' | 'very_high' | 'extreme';
  risk_score: number | null;
  treatment_status: string;
  props?: Record<string, unknown>;
  updated_at?: string;
}

export interface Road {
  id: string;
  name: string;
  geojson: GeoJSON.LineString;
  passable: boolean;
  props?: Record<string, unknown>;
  updated_at?: string;
}

/** Reference overlays: firebreaks, high-risk zones, camera views, patrol routes, burnt-area history, waterways. */
export type MapLayerKind = 'firebreak' | 'high_risk_zone' | 'camera_coverage' | 'standby_route' | 'burnt_area' | 'waterway';
export interface MapLayer {
  id: string;
  layer: MapLayerKind;
  name: string;
  geojson: GeoJSON.Geometry;
  props: Record<string, unknown>;
  updated_at?: string;
}

export interface Crew {
  id: string;
  name: string;
  block: string;
  shift: 'day' | 'night' | 'support';
  updated_at?: string;
}

export interface Readiness {
  id: string; // singleton "site"
  level: 'green' | 'amber' | 'red';
  note: string;
  set_by: string;
  client_updated_at: string;
  updated_at?: string;
}

/** Live location shared by a crew member (one row per user, id = user id). */
export type CrewPosStatus = 'standby' | 'en_route' | 'on_scene' | 'off';
export interface CrewPosition extends Local {
  id: string;
  user_id: string;
  name: string;
  crew_id: string | null;
  status: CrewPosStatus;
  incident_id: string | null;
  lat: number;
  lon: number;
  acc: number | null;
  heading: number | null;
  speed: number | null;
  fix_at: string;
  client_updated_at: string;
  updated_at?: string;
}

/** Daily fire danger rating (server-computed every morning). id = YYYY-MM-DD. */
export type DangerLevel = 'low' | 'moderate' | 'high' | 'very_high' | 'extreme';
export interface FireDanger {
  id: string;
  day: string;
  level: DangerLevel;
  ffwi: number | null;
  temp_max_c: number | null;
  rh_min_pct: number | null;
  wind_max_kmh: number | null;
  wind_from_deg: number | null;
  days_since_rain: number | null;
  rain_24h_mm: number | null;
  basis: string;
  client_updated_at: string;
  updated_at?: string;
}

/** Tables replicated between device and server. */
export const TABLES = [
  'incidents',
  'incident_events',
  'assignments',
  'perimeters',
  'photos',
  'hazards',
  'detections',
  'assets',
  'compartments',
  'roads',
  'crews',
  'readiness',
  'map_layers',
  'crew_positions',
  'fire_danger',
] as const;
export type TableName = (typeof TABLES)[number];

/** Tables the device writes (the rest are reference data pulled only). */
export const WRITABLE: TableName[] = [
  'incidents',
  'incident_events',
  'assignments',
  'perimeters',
  'photos',
  'hazards',
  'detections',
  'readiness',
  'crew_positions',
];
/** Insert-only tables: replays must never overwrite. */
export const APPEND_ONLY: TableName[] = ['incident_events'];

export interface GpsFix {
  lat: number;
  lon: number;
  acc: number;
  alt: number | null;
  speed: number | null;
  heading: number | null;
  ts: number; // device ms
}
