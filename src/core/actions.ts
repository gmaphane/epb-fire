import { CONFIG } from '../config';
import { getBlob, getRow, metaSet, putBlob, putLocal } from './db';
import { allowedNext } from './flow';
import { haversineM, pointInPolygon, polygonStats, shortLabel, uuid } from './geo';
import { gps, keepAwake } from './gps';
import { getState } from './store';
import { setPresence, stopResponding } from './presence';
import { nowIso } from './time';
import type {
  Assignment, AssignmentState, EventKind, Hazard, Incident, IncidentEvent, IncidentStatus, Perimeter, PhotoRow, Vertex,
} from './types';

const me = () => {
  const m = getState().me;
  if (!m) throw new Error('Not signed in');
  return m;
};

export function locate(lat: number, lon: number): { block: string | null; compartment: string | null } {
  for (const c of getState().compartments) if (pointInPolygon(lat, lon, c.geojson)) return { block: c.block, compartment: c.code };
  return { block: null, compartment: null };
}

async function logEvent(incident_id: string, kind: EventKind, payload: Record<string, unknown> = {}, at?: { lat: number; lon: number; acc: number | null }) {
  const m = me();
  let pos = at;
  if (!pos) {
    const { fix } = gps.forRecord();
    if (fix) pos = { lat: fix.lat, lon: fix.lon, acc: fix.acc };
  }
  const ev: IncidentEvent = {
    id: uuid(), incident_id, kind, payload,
    lat: pos?.lat ?? null, lon: pos?.lon ?? null, accuracy_m: pos?.acc ?? null,
    by: m.id, by_name: m.name, client_ts: nowIso(),
  };
  await putLocal('incident_events', ev);
  return ev;
}

export function nearbyOpenIncidents(lat: number, lon: number, radiusM = CONFIG.duplicateRadiusM): Incident[] {
  return getState().incidents.filter(
    (i) => i.status !== 'out' && i.status !== 'dismissed' && !i.deleted_at && haversineM(lat, lon, i.lat, i.lon) <= radiusM,
  );
}

export interface ReportInput {
  source: Incident['source'];
  size_class: Incident['size_class'];
  notes: string;
  lat: number;
  lon: number;
  accuracy_m: number | null;
  estimated: boolean;
  photo?: Blob | null;
  detection_id?: string | null;
  location_source?: Incident['location_source'];
  observer_name?: string | null;
  relayed_via?: Incident['relayed_via'];
  observed_at?: string | null;
}

/** FR-REP-03: one local transaction per row; no network involved. */
export async function reportFire(inp: ReportInput): Promise<Incident> {
  const m = me();
  const now = nowIso();
  const loc = locate(inp.lat, inp.lon);
  const inc: Incident = {
    id: uuid(), code: null, label: shortLabel(), status: 'reported', source: inp.source, size_class: inp.size_class,
    notes: inp.notes, lat: inp.lat, lon: inp.lon, accuracy_m: inp.accuracy_m, location_estimated: inp.estimated,
    block: loc.block, compartment: loc.compartment, reported_by: m.id, reported_by_name: m.name, reported_at: now,
    client_updated_at: now, cause: null, area_ha: null, dismiss_reason: null, detection_id: inp.detection_id ?? null, deleted_at: null,
    location_source: inp.location_source ?? (inp.detection_id ? 'satellite' : inp.estimated ? 'map' : 'gps'),
    observer_name: inp.observer_name?.trim() || null, relayed_via: inp.relayed_via ?? null, observed_at: inp.observed_at ?? null,
  };
  await putLocal('incidents', inc);
  await logEvent(inc.id, 'reported', { source: inp.source, size_class: inp.size_class, notes: inp.notes, location_source: inc.location_source, observer_name: inc.observer_name, relayed_via: inc.relayed_via, observed_at: inc.observed_at }, { lat: inp.lat, lon: inp.lon, acc: inp.accuracy_m });
  if (inp.detection_id) {
    const d = await getRow<any>('detections', inp.detection_id);
    if (d) await putLocal('detections', { ...d, promoted_incident_id: inc.id, client_updated_at: now });
  }
  if (inp.photo) await addPhoto(inc.id, inp.photo);
  return inc;
}

export async function setStatus(id: string, to: IncidentStatus, extra: Partial<Pick<Incident, 'cause' | 'area_ha' | 'dismiss_reason'>> = {}) {
  const m = me();
  const cur = await getRow<Incident>('incidents', id);
  if (!cur) throw new Error('Incident not found');
  if (!allowedNext(cur.status, m.role).includes(to)) throw new Error(`Not allowed: ${cur.status} → ${to}`);
  if (to === 'out' && !(extra.cause ?? cur.cause)) throw new Error('Cause is required to close an incident');
  if (to === 'dismissed' && !(extra.dismiss_reason ?? '').trim()) throw new Error('A reason is required for a false alarm');
  const now = nowIso();
  await putLocal('incidents', { ...cur, ...extra, status: to, client_updated_at: now });
  await logEvent(id, 'status', { from: cur.status, to, ...extra });
}

/** Remove a fire report entirely (duplicate, test or wrong). Coordinators and admins; kept on the server, hidden everywhere. */
export async function deleteIncident(id: string, reason: string) {
  const m = me();
  if (m.role !== 'coordinator' && m.role !== 'admin') throw new Error('Only a coordinator or admin can delete a fire');
  if (!reason.trim()) throw new Error('Give a reason');
  const cur = await getRow<Incident>('incidents', id);
  if (!cur) throw new Error('Incident not found');
  const now = nowIso();
  await putLocal('incidents', { ...cur, deleted_at: now, client_updated_at: now });
  await logEvent(id, 'note', { text: `Deleted by ${m.name}: ${reason.trim()}` });
}

/** Correct a fire's position (pin was in the wrong place). Responders, coordinators, admins. */
export async function moveIncident(id: string, lat: number, lon: number) {
  const m = me();
  if (m.role === 'reporter' || m.role === 'manager') throw new Error('Ask a coordinator to correct the location');
  const cur = await getRow<Incident>('incidents', id);
  if (!cur) throw new Error('Incident not found');
  const loc = locate(lat, lon);
  const moved = Math.round(haversineM(cur.lat, cur.lon, lat, lon));
  await putLocal('incidents', { ...cur, lat, lon, block: loc.block, compartment: loc.compartment, location_source: 'map', location_estimated: true, accuracy_m: null, client_updated_at: nowIso() });
  await logEvent(id, 'note', { text: `Location corrected by ${m.name} (moved ${moved} m)` }, { lat, lon, acc: null });
}

export async function addNote(id: string, text: string) {
  if (!text.trim()) return;
  await logEvent(id, 'note', { text: text.trim() });
}

export async function dispatchCrews(incidentId: string, crewIds: string[], instruction: string) {
  const m = me();
  const inc = await getRow<Incident>('incidents', incidentId);
  if (!inc) throw new Error('Incident not found');
  const now = nowIso();
  for (const crew_id of crewIds) {
    const existing = getState().assignments.find((a) => a.incident_id === incidentId && a.crew_id === crew_id && a.state !== 'released');
    if (existing) continue;
    const a: Assignment = {
      id: uuid(), incident_id: incidentId, crew_id, user_id: null, state: 'dispatched', instruction, need_support: false,
      dispatched_by: m.id, dispatched_at: now, acked_at: null, acked_by: null, en_route_at: null, on_scene_at: null, client_updated_at: now,
    };
    await putLocal('assignments', a);
    const crew = getState().crews.find((c) => c.id === crew_id);
    await logEvent(incidentId, 'dispatch', { crew: crew?.name ?? crew_id, instruction });
  }
  if (inc.status === 'reported' || inc.status === 'confirmed') await setStatus(incidentId, 'responding').catch(() => {});
}

export async function assignmentAction(a: Assignment, action: 'ack' | 'en_route' | 'on_scene' | 'need_support' | 'released') {
  const m = me();
  const now = nowIso();
  const next: Assignment = { ...a, client_updated_at: now };
  let kind: EventKind;
  switch (action) {
    case 'ack': next.state = 'acknowledged'; next.acked_at = a.acked_at ?? now; next.acked_by = a.acked_by ?? m.id; kind = 'ack'; break;
    case 'en_route': next.state = 'en_route'; next.acked_at = a.acked_at ?? now; next.acked_by = a.acked_by ?? m.id; next.en_route_at = now; kind = 'en_route'; break;
    case 'on_scene': next.state = 'on_scene'; next.on_scene_at = now; next.acked_at = a.acked_at ?? now; next.acked_by = a.acked_by ?? m.id; kind = 'on_scene'; break;
    case 'need_support': next.need_support = true; kind = 'need_support'; break;
    case 'released': next.state = 'released'; kind = 'status'; break;
  }
  await putLocal('assignments', next);
  const crew = getState().crews.find((c) => c.id === a.crew_id);
  await logEvent(a.incident_id, kind, { crew: crew?.name ?? null, by: m.name });
  // live location follows the call-out: en route / on scene share automatically; release returns to standby
  if (action === 'ack' || action === 'en_route') await setPresence('en_route', a.incident_id);
  else if (action === 'on_scene') await setPresence('on_scene', a.incident_id);
  else if (action === 'released') await stopResponding();
}

export async function reportHazard(kind: Hazard['kind'], note: string) {
  const { fix } = gps.forRecord();
  if (!fix) throw new Error('No GPS fix yet');
  const now = nowIso();
  const h: Hazard = { id: uuid(), kind, note, lat: fix.lat, lon: fix.lon, by: me().id, created_at: now, resolved_at: null, client_updated_at: now };
  await putLocal('hazards', h);
}
export async function resolveHazard(h: Hazard) {
  await putLocal('hazards', { ...h, resolved_at: nowIso(), client_updated_at: nowIso() });
}

export async function setReadiness(level: 'green' | 'amber' | 'red', note: string) {
  await putLocal('readiness', { id: 'site', level, note, set_by: me().id, client_updated_at: nowIso() });
}

// ---------- photos ----------
async function compress(file: Blob, maxEdge = 1600, q = 0.75): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
    return out ?? file;
  } catch {
    return file;
  }
}

export async function addPhoto(incidentId: string, file: Blob) {
  const blob = await compress(file);
  const { fix } = gps.forRecord();
  const id = uuid();
  const now = nowIso();
  await putBlob(id, blob);
  const row: PhotoRow = {
    id, incident_id: incidentId, storage_path: `${incidentId}/${id}.jpg`, lat: fix?.lat ?? null, lon: fix?.lon ?? null,
    accuracy_m: fix?.acc ?? null, heading: fix?.heading ?? null, taken_at: now, by: me().id, uploaded: false, client_updated_at: now,
  };
  await putLocal('photos', row);
  await logEvent(incidentId, 'photo', { photo_id: id });
}
export const photoBlob = (id: string) => getBlob(id);

// ---------- perimeter walk ----------
export async function startPerimeter(incidentId: string): Promise<Perimeter> {
  const existing = getState().perimeters.find((p) => p.incident_id === incidentId && p.state !== 'closed');
  if (existing) return existing;
  const now = nowIso();
  const p: Perimeter = {
    id: uuid(), incident_id: incidentId, state: 'recording', vertices: [], rejected_fixes: 0, area_ha: null, length_km: null,
    walk_seconds: 0, started_at: now, closed_at: null, by: me().id, client_updated_at: now,
  };
  await putLocal('perimeters', p);
  return p;
}

function withStats(p: Perimeter): Perimeter {
  const s = polygonStats(p.vertices);
  return { ...p, area_ha: s?.areaHa ?? null, length_km: s?.lengthKm ?? null, client_updated_at: nowIso() };
}

export async function updatePerimeter(id: string, fn: (p: Perimeter) => Perimeter) {
  const cur = await getRow<Perimeter>('perimeters', id);
  if (!cur) return;
  await putLocal('perimeters', withStats(fn(cur)));
}

/** Auto-capture rule (FR-PER-02): moved ≥ 5 m or 5 s, and accuracy ≤ 15 m; otherwise count as rejected. */
export function shouldCapture(prev: Vertex | undefined, fix: { lat: number; lon: number; acc: number }, nowMs: number): 'add' | 'reject' | 'skip' {
  if (fix.acc > CONFIG.gps.perimeterMaxAccuracyM) return 'reject';
  if (!prev) return 'add';
  const dt = (nowMs - new Date(prev.ts).getTime()) / 1000;
  const d = haversineM(prev.lat, prev.lon, fix.lat, fix.lon);
  if (d >= CONFIG.gps.perimeterMinDistanceM && dt >= 1) return 'add';
  if (dt >= CONFIG.gps.perimeterMinSeconds && d >= 1.5) return 'add'; // time-based, ignoring pure GPS jitter
  return 'skip';
}

export async function finishPerimeter(id: string) {
  const cur = await getRow<Perimeter>('perimeters', id);
  if (!cur) return;
  if (cur.vertices.length < 3) throw new Error('Need at least 3 points to close a perimeter');
  const closed = withStats({ ...cur, state: 'closed', closed_at: nowIso() });
  await putLocal('perimeters', closed);
  // keep the incident's area in step with the walked perimeter
  const inc = await getRow<Incident>('incidents', cur.incident_id);
  if (inc && closed.area_ha != null) await putLocal('incidents', { ...inc, area_ha: Math.round(closed.area_ha * 100) / 100, client_updated_at: nowIso() });
  await logEvent(cur.incident_id, 'perimeter', { area_ha: closed.area_ha, length_km: closed.length_km, vertices: closed.vertices.length });
  await keepAwake(false);
}

export async function saveTheme(t: 'auto' | 'day' | 'night') {
  await metaSet('theme', t);
}
