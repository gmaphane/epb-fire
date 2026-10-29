import { getState } from './store';
import { toUtm30 } from './geo';
import { STATUS_LABEL } from './flow';
import { buildXlsx, type Cell } from './xlsx';

/** Local date-time for spreadsheets: "2026-10-26 14:03" (Ghana = UTC). */
const dt = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : '');
const r1 = (n: number | null | undefined, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Workbook of every fire on this phone: incidents, timeline, call-outs, perimeters. */
export function incidentsWorkbook(): Blob {
  const s = getState();
  const byId = new Map(s.incidents.map((i) => [i.id, i]));
  const code = (id: string) => { const i = byId.get(id); return i ? i.code ?? i.label : id.slice(0, 8); };
  const crew = (id: string | null) => s.crews.find((c) => c.id === id)?.name ?? '';
  const incidents = [...s.incidents].filter((i) => !i.deleted_at).sort((a, b) => (a.reported_at < b.reported_at ? 1 : -1));

  const inc: Cell[][] = incidents.map((i) => {
    const u = toUtm30(i.lat, i.lon);
    const events = s.events.filter((e) => e.incident_id === i.id);
    const closedAt = events.filter((e) => e.kind === 'status' && (e.payload as any)?.to === 'out').map((e) => e.client_ts).sort().pop() ?? null;
    const per = s.perimeters.filter((p) => p.incident_id === i.id && p.state === 'closed').sort((a, b) => ((a.closed_at ?? '') < (b.closed_at ?? '') ? 1 : -1))[0];
    const crews = s.assignments.filter((a) => a.incident_id === i.id).length;
    return [
      i.code ?? i.label, STATUS_LABEL[i.status], dt(i.reported_at), i.reported_by_name, i.source, i.block ?? '', i.compartment ?? '',
      r1(i.lat, 6), r1(i.lon, 6), Math.round(u.e), Math.round(u.n), i.accuracy_m != null ? Math.round(i.accuracy_m) : null,
      i.location_source, i.observer_name ?? '', i.relayed_via ?? '', i.category ?? null, i.size_class, r1(i.area_ha ?? per?.area_ha ?? null, 2),
      per ? r1(per.length_km, 2) : null, crews, i.cause ?? '', i.dismiss_reason ?? '', dt(i.out_at ?? closedAt), dt(i.report_submitted_at), i.notes ?? '',
    ];
  });
  const timeline: Cell[][] = [...s.events].sort((a, b) => (a.client_ts < b.client_ts ? -1 : 1)).map((e) => [
    code(e.incident_id), dt(e.client_ts), e.kind, e.by_name,
    Object.entries(e.payload ?? {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('; '),
    e.lat != null ? r1(e.lat, 6) : null, e.lon != null ? r1(e.lon, 6) : null,
  ]);
  const callouts: Cell[][] = [...s.assignments].sort((a, b) => (a.dispatched_at < b.dispatched_at ? -1 : 1)).map((a) => [
    code(a.incident_id), crew(a.crew_id), a.state, dt(a.dispatched_at), dt(a.acked_at), dt(a.en_route_at), dt(a.on_scene_at),
    a.en_route_at && a.dispatched_at ? r1((Date.parse(a.on_scene_at ?? a.en_route_at) - Date.parse(a.dispatched_at)) / 60000, 0) : null,
    a.need_support ? 'yes' : '', a.instruction ?? '',
  ]);
  const perims: Cell[][] = s.perimeters.map((p) => [code(p.incident_id), p.state, dt(p.started_at), dt(p.closed_at), r1(p.area_ha, 2), r1(p.length_km, 2), r1(p.walk_seconds / 60, 0), p.vertices.length]);

  return buildXlsx([
    { name: 'Incidents', header: ['Code', 'Status', 'Reported (UTC)', 'Reported by', 'Source', 'Block', 'Compartment', 'Latitude', 'Longitude', 'UTM 30N E', 'UTM 30N N', 'GPS accuracy m', 'Location from', 'Observer', 'Relayed via', 'SOP category', 'Size (old)', 'Area ha', 'Perimeter km', 'Call-outs', 'Cause', 'False alarm reason', 'Out at (UTC)', 'Report submitted (UTC)', 'Notes'], rows: inc },
    { name: 'Timeline', header: ['Incident', 'Time (UTC)', 'Event', 'By', 'Details', 'Latitude', 'Longitude'], rows: timeline },
    { name: 'Call-outs', header: ['Incident', 'Crew', 'State', 'Dispatched (UTC)', 'Acknowledged', 'En route', 'On scene', 'Minutes to move/arrive', 'Needed support', 'Instruction'], rows: callouts },
    { name: 'Perimeters', header: ['Incident', 'State', 'Started (UTC)', 'Closed (UTC)', 'Area ha', 'Length km', 'Walk minutes', 'Points'], rows: perims },
  ]);
}

export function downloadBlob(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
