import { useEffect, useRef, useState } from 'preact/hooks';
import { Camera, Copy, MapPinned, Navigation, Route as RouteIcon, Send, UserPlus } from 'lucide-preact';
import { addNote, addPhoto, assignmentAction, photoBlob, setStatus } from '../core/actions';
import { getState, toast, useStore } from '../core/store';
import { ago, hhmm } from '../core/time';
import { fmtDd, fmtDms, fmtHa, fmtUtm } from '../core/geo';
import { ACTIVE, allowedNext, CAUSES, can, STATUS_LABEL } from '../core/flow';
import { Banner, Button, Card, CoordReadout, Metric, RowSyncDot, Screen, StatusChip } from './kit';
import { back, go, useNow } from './hooks';
import { CONFIG } from '../config';
import type { Assignment, IncidentStatus } from '../core/types';

function Thumb({ id, uploaded }: { id: string; uploaded: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    void photoBlob(id).then((b) => { if (b && live) { u = URL.createObjectURL(b); setUrl(u); } });
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return url ? <img src={url} class="w-24 h-24 rounded-xl object-cover" alt="Incident" /> : <div class="w-24 h-24 rounded-xl bg-surface-mid text-[11px] text-muted flex items-center justify-center text-center p-2">{uploaded ? 'On server' : 'Photo'}</div>;
}

export function IncidentScreen({ id }: { id: string }) {
  const s = useStore((x) => x);
  const now = useNow(15_000);
  const inc = s.incidents.find((i) => i.id === id);
  const [note, setNote] = useState('');
  const [pick, setPick] = useState<IncidentStatus | null>(null);
  const [cause, setCause] = useState('');
  const [reason, setReason] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const role = s.me?.role;

  if (!inc) return <Screen title="Incident" back={back}><Banner tone="warn">This incident is not on this phone yet.</Banner></Screen>;
  const events = s.events.filter((e) => e.incident_id === id).sort((a, b) => (a.client_ts < b.client_ts ? 1 : -1));
  const assigns = s.assignments.filter((a) => a.incident_id === id);
  const photos = s.photos.filter((p) => p.incident_id === id);
  const per = s.perimeters.filter((p) => p.incident_id === id).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
  const next = allowedNext(inc.status, role ?? 'reporter');
  const mine = (a: Assignment) => !!s.me && (a.user_id === s.me.id || (a.crew_id && a.crew_id === s.me.crew_id));
  const crewName = (cid: string | null) => s.crews.find((c) => c.id === cid)?.name ?? 'Crew';

  const apply = async (to: IncidentStatus) => {
    try {
      if (to === 'out' && !cause && !inc.cause) return setPick('out');
      if (to === 'dismissed' && !reason.trim()) return setPick('dismissed');
      await setStatus(id, to, { ...(to === 'out' ? { cause: cause || inc.cause } : {}), ...(to === 'dismissed' ? { dismiss_reason: reason } : {}) });
      setPick(null);
      toast(`Status: ${STATUS_LABEL[to]} — saved on this phone`);
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  return (
    <Screen title={`${inc.code ?? inc.label}`} sub={inc.compartment ?? inc.block ?? 'Unmapped area'} back={back} right={<StatusChip s={inc.status} />}>
      <Card>
        <div class="flex items-center justify-between"><div class="text-[12px] font-bold uppercase text-muted tracking-wide">Location</div><RowSyncDot s={inc._sync} /></div>
        <div class="mt-2"><CoordReadout lat={inc.lat} lon={inc.lon} testid="inc-coords" /></div>
        <div class="text-[13px] text-muted num">{fmtDms(inc.lat, 'lat')} {fmtDms(inc.lon, 'lon')}</div>
                <div class="mt-2 text-[13px]">
          {inc.location_source === 'manual'
            ? <b class="text-amber" data-testid="relay-info">Typed in from {inc.relayed_via === 'phone' ? 'a phone call' : 'a radio relay'}{inc.observer_name ? ` — seen by ${inc.observer_name}` : ''}{inc.observed_at ? ` at ${hhmm(inc.observed_at)}` : ''}</b>
            : inc.location_estimated ? <b class="text-amber">Estimated location</b> : <>GPS accuracy ±{inc.accuracy_m != null ? Math.round(inc.accuracy_m) : '?'} m</>}
          {inc.location_source === 'manual' && inc.accuracy_m != null && <> · ±{Math.round(inc.accuracy_m)} m</>} · {inc.block ?? 'outside mapped blocks'}
        </div>
        <div class="mt-3 grid grid-cols-2 gap-2">
          <Button icon={<Copy size={16} />} onClick={() => { void navigator.clipboard?.writeText(fmtDd(inc.lat, inc.lon)); toast('Coordinates copied'); }}>Copy</Button>
          <Button icon={<MapPinned size={16} />} onClick={() => go('map')}>Map</Button>
        </div>
      </Card>

      <div class="grid grid-cols-3 gap-2">
        <Metric label="Reported" value={ago(inc.reported_at, now)} />
        <Metric label="Size" value={inc.size_class} />
        <Metric label="Area" value={fmtHa(inc.area_ha)} unit="ha" />
      </div>
      {inc.notes && <Card><div class="text-[12px] font-bold uppercase text-muted">Notes at report</div><div class="mt-1">{inc.notes}</div><div class="text-xs text-muted mt-1">{inc.observer_name ? `seen by ${inc.observer_name} · entered by ${inc.reported_by_name}` : `by ${inc.reported_by_name}`} · {inc.source}</div></Card>}

      <div class="grid grid-cols-2 gap-2">
        <Button kind="primary" icon={<Navigation size={18} />} onClick={() => go('navigate/incident/' + id)}>Navigate</Button>
        {can(role, 'dispatch') && ACTIVE.includes(inc.status) ? <Button testid="dispatch-btn" icon={<UserPlus size={18} />} onClick={() => go('dispatch/' + id)}>Dispatch crews</Button> : <span />}
        {can(role, 'perimeter') && <Button icon={<RouteIcon size={18} />} onClick={() => go('perimeter/' + id)}>{per && per.state !== 'closed' ? 'Resume perimeter' : 'Walk perimeter'}</Button>}
        <Button icon={<Camera size={18} />} onClick={() => file.current?.click()}>Add photo</Button>
        <input ref={file} type="file" accept="image/*" capture="environment" class="hidden" onChange={async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { await addPhoto(id, f); toast('Photo saved on this phone'); } }} />
      </div>

      {next.length > 0 && (
        <Card>
          <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Update status</div>
          <div class="flex flex-wrap gap-2">
            {next.map((st) => (
              <button key={st} data-testid={'status-' + st} onClick={() => (st === 'out' || st === 'dismissed' ? setPick(st) : void apply(st))} class="px-4 min-h-[44px] rounded-pill bg-sc font-semibold text-[13px]">{STATUS_LABEL[st]}</button>
            ))}
          </div>
          {pick === 'out' && (
            <div class="mt-3 space-y-2">
              <label class="text-[13px] font-semibold">Cause (required to close)</label>
              <select data-testid="cause" class="w-full min-h-[48px] rounded-lg border border-outline-v bg-card px-3" value={cause} onChange={(e) => setCause((e.target as HTMLSelectElement).value)}>
                <option value="">Select cause…</option>{CAUSES.map((c) => <option key={c}>{c}</option>)}
              </select>
              <Button kind="primary" full disabled={!cause} onClick={() => void apply('out')} testid="confirm-out">Close incident — Out</Button>
            </div>
          )}
          {pick === 'dismissed' && (
            <div class="mt-3 space-y-2">
              <label class="text-[13px] font-semibold">Reason for false alarm</label>
              <input data-testid="reason" class="w-full min-h-[48px] rounded-lg border border-outline-v bg-card px-3" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="e.g. cooking smoke, checked by tower" />
              <Button kind="danger" full disabled={!reason.trim()} onClick={() => void apply('dismissed')} testid="confirm-dismiss">Dismiss as false alarm</Button>
            </div>
          )}
        </Card>
      )}

      {assigns.length > 0 && (
        <Card>
          <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Crews</div>
          <div class="space-y-3">
            {assigns.map((a) => {
              const late = a.state === 'dispatched' && now - new Date(a.dispatched_at).getTime() > CONFIG.ackEscalationMs;
              return (
                <div key={a.id} data-testid="assignment" class="rounded-xl bg-surface-low p-3">
                  <div class="flex items-center justify-between gap-2">
                    <div class="font-bold">{crewName(a.crew_id)}</div>
                    <span class={'text-xs font-bold ' + (late ? 'text-fire' : 'text-muted')} data-testid="assign-state">{late ? 'NOT ACKNOWLEDGED' : a.state.replace('_', ' ')}{a.need_support ? ' · NEEDS SUPPORT' : ''}</span>
                  </div>
                  <div class="text-xs text-muted">Called {ago(a.dispatched_at, now)}{a.acked_at ? ` · acknowledged ${hhmm(a.acked_at)}` : ''}{a.on_scene_at ? ` · on scene ${hhmm(a.on_scene_at)}` : ''}</div>
                  {a.instruction && <div class="text-[13px] mt-1">“{a.instruction}”</div>}
                  {mine(a) && a.state !== 'released' && can(role, 'respond') && (
                    <div class="grid grid-cols-2 gap-2 mt-2">
                      {a.state === 'dispatched' && <Button kind="primary" class="col-span-2" testid="ack" onClick={() => void assignmentAction(a, 'ack')}>Acknowledge</Button>}
                      {a.state !== 'en_route' && a.state !== 'on_scene' && <Button testid="enroute" onClick={() => void assignmentAction(a, 'en_route')}>En route</Button>}
                      {a.state !== 'on_scene' && <Button testid="onscene" onClick={() => void assignmentAction(a, 'on_scene')}>On scene</Button>}
                      {!a.need_support && <Button kind="danger" class="col-span-2" onClick={() => void assignmentAction(a, 'need_support')}>Need support</Button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {per && <Card><div class="text-[12px] font-bold uppercase text-muted tracking-wide">Perimeter</div><div class="mt-1 font-bold num">{fmtHa(per.area_ha)} ha · {per.length_km?.toFixed(2) ?? '—'} km · {per.vertices.length} points {per.state !== 'closed' && <span class="text-amber">(in progress)</span>}</div></Card>}
      {photos.length > 0 && <Card><div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Photos</div><div class="flex gap-2 overflow-x-auto">{photos.map((p) => <Thumb key={p.id} id={p.id} uploaded={p.uploaded} />)}</div></Card>}

      <Card>
        <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Timeline</div>
        <div class="flex gap-2 mb-3">
          <input data-testid="note-input" class="flex-1 min-h-[48px] rounded-lg border border-outline-v bg-card px-3" placeholder="Add a note…" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <Button icon={<Send size={16} />} testid="note-send" onClick={async () => { await addNote(id, note); setNote(''); }}>Add</Button>
        </div>
        <ol class="space-y-2.5" data-testid="timeline">
          {events.map((e) => (
            <li key={e.id} class="text-[13px] flex gap-2">
              <span class="num text-muted w-11 shrink-0">{hhmm(e.client_ts)}</span>
              <span class="flex-1"><b>{label(e)}</b> <span class="text-muted">— {e.by_name}{e.accuracy_m != null ? ` · ±${Math.round(e.accuracy_m)} m` : ''}</span></span>
            </li>
          ))}
        </ol>
      </Card>
      <div class="h-24" />
    </Screen>
  );
}

function label(e: { kind: string; payload: Record<string, any> }): string {
  const p = e.payload;
  switch (e.kind) {
    case 'reported': return `Reported (${p.source ?? 'unknown'}, size ${p.size_class ?? 'unknown'})${p.location_source === 'manual' ? ` — relayed by ${p.relayed_via ?? 'radio'}${p.observer_name ? ` from ${p.observer_name}` : ''}` : ''}`;
    case 'status': return p.to ? `Status → ${STATUS_LABEL[p.to as IncidentStatus] ?? p.to}${p.cause ? ` (cause: ${p.cause})` : ''}${p.dismiss_reason ? ` (${p.dismiss_reason})` : ''}` : 'Crew released';
    case 'note': return String(p.text ?? '');
    case 'dispatch': return `Dispatched ${p.crew ?? 'crew'}${p.instruction ? ` — ${p.instruction}` : ''}`;
    case 'ack': return `${p.crew ?? 'Crew'} acknowledged`;
    case 'en_route': return `${p.crew ?? 'Crew'} en route`;
    case 'on_scene': return `${p.crew ?? 'Crew'} on scene`;
    case 'need_support': return `${p.crew ?? 'Crew'} NEEDS SUPPORT`;
    case 'photo': return 'Photo added';
    case 'perimeter': return `Perimeter closed: ${p.area_ha != null ? Number(p.area_ha).toFixed(2) : '—'} ha, ${p.vertices} points`;
    default: return e.kind;
  }
}
