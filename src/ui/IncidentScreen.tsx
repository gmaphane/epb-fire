import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Camera, Navigation, Route as RouteIcon, Send, UserPlus } from 'lucide-preact';
import { addNote, addPhoto, assignmentAction, photoBlob, setStatus } from '../core/actions';
import { getState, toast, useStore } from '../core/store';
import { ago, hhmm } from '../core/time';
import { fmtDms, fmtHa, fmtUtm } from '../core/geo';
import { ACTIVE, allowedNext, CAUSES, can, isOpen, STATUS_LABEL } from '../core/flow';
import { DeleteSheet } from './MapScreen';
import { Banner, Button, Choice, CoordReadout, Metric, RowSyncDot, Screen, StatusChip, cx } from './kit';
import { back, go, useNow } from './hooks';
import { CONFIG } from '../config';
import type { Assignment, IncidentStatus } from '../core/types';
import { useWeather } from '../core/weather';
import { threats } from '../core/spread';
import { SpreadPanel } from './SpreadPanel';

function Thumb({ id, uploaded }: { id: string; uploaded: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    void photoBlob(id).then((b) => { if (b && live) { u = URL.createObjectURL(b); setUrl(u); } });
    return () => { live = false; if (u) URL.revokeObjectURL(u); };
  }, [id]);
  return url ? <img src={url} class="w-28 h-28 rounded-2xl object-cover" alt="Incident" /> : <div class="w-28 h-28 rounded-2xl bg-surface-mid text-[11px] text-muted flex items-center justify-center text-center p-2">{uploaded ? 'On server' : 'Photo'}</div>;
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
  const [del, setDel] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // wind at the fire and the compartments it could reach (same as the map card)
  const wx = useWeather(inc?.lat, inc?.lon);
  const th = useMemo(() => (inc ? threats(inc, s.compartments, wx ? { kmh: wx.windKmh, from: wx.windFrom } : null) : []), [inc?.lat, inc?.lon, s.compartments, wx?.fetched]);

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
      toast(`Status: ${STATUS_LABEL[to]}`);
    } catch (e) { toast((e as Error).message, 'err'); }
  };

  const H = ({ children }: { children: any }) => <h2 class="font-display text-[20px] mb-3">{children}</h2>;
  const shown = showAll ? events : events.slice(0, 5);
  return (
    <Screen title={inc.compartment ?? inc.block ?? 'Unmapped area'} sub={`${inc.code ?? inc.label} · ${ago(inc.reported_at, now)}`} back={back} right={<StatusChip s={inc.status} short />}>
      <section class="space-y-2">
        <CoordReadout lat={inc.lat} lon={inc.lon} testid="inc-coords" />
        <div class="px-1 text-[13px] text-muted flex items-center gap-2 flex-wrap">
          {inc.location_source === 'manual'
            ? <span class="text-amber font-medium" data-testid="relay-info">Typed in from {inc.relayed_via === 'phone' ? 'a phone call' : 'a radio relay'}{inc.observer_name ? ` — seen by ${inc.observer_name}` : ''}{inc.observed_at ? ` at ${hhmm(inc.observed_at)}` : ''}</span>
            : inc.location_estimated ? <span class="text-amber font-medium">Estimated location</span> : <span>GPS ±{inc.accuracy_m != null ? Math.round(inc.accuracy_m) : '?'} m</span>}
          <span>·</span><span class="num">{fmtDms(inc.lat, 'lat')} {fmtDms(inc.lon, 'lon')}</span>
          <RowSyncDot s={inc._sync} />
        </div>
      </section>

      <div class="grid grid-cols-3 gap-3 px-1">
        <Metric label="Reported" value={ago(inc.reported_at, now)} />
        <Metric label="Size" value={inc.size_class === 'unknown' ? 'Not sure' : inc.size_class} />
        <Metric label="Burnt" value={fmtHa(inc.area_ha)} unit="ha" />
      </div>

      <div class="space-y-2">
        <Button kind="primary" size="lg" full icon={<Navigation size={18} />} onClick={() => go('navigate/incident/' + id)}>Navigate</Button>
        <div class="flex gap-2">
          {can(role, 'dispatch') && ACTIVE.includes(inc.status) && <Button kind="secondary" class="flex-1 !px-3" testid="dispatch-btn" icon={<UserPlus size={17} />} onClick={() => go('dispatch/' + id)}>Dispatch</Button>}
          {can(role, 'perimeter') && <Button kind="secondary" class="flex-1 !px-3" icon={<RouteIcon size={17} />} onClick={() => go('perimeter/' + id)}>{per && per.state !== 'closed' ? 'Resume edge' : 'Walk edge'}</Button>}
          <Button kind="secondary" class="!px-4" icon={<Camera size={17} />} onClick={() => file.current?.click()}><span class="sr-only">Add photo</span></Button>
          <input ref={file} type="file" accept="image/*" capture="environment" class="hidden" onChange={async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { await addPhoto(id, f); toast('Photo saved'); } }} />
        </div>
      </div>

      {isOpen(inc.status) && !inc.deleted_at && <div class="px-1"><SpreadPanel wx={wx} th={th} /></div>}

      {inc.notes && (
        <section class="px-1">
          <p class="text-[16px] leading-relaxed">“{inc.notes}”</p>
          <p class="text-[13px] text-muted mt-1">{inc.observer_name ? `${inc.observer_name} · entered by ${inc.reported_by_name}` : inc.reported_by_name} · {inc.source}</p>
        </section>
      )}

      {next.length > 0 && (
        <section>
          <H>Update status</H>
          <div class="flex flex-wrap gap-2">
            {next.map((st) => (
              <Choice key={st} testid={'status-' + st} selected={pick === st} onClick={() => (st === 'out' || st === 'dismissed' ? setPick(st) : void apply(st))}>{STATUS_LABEL[st]}</Choice>
            ))}
          </div>
          {pick === 'out' && (
            <div class="mt-3 space-y-2 fade-in">
              <select data-testid="cause" aria-label="Cause" class="w-full min-h-[52px] rounded-2xl border border-line bg-card px-4 text-[16px]" value={cause} onChange={(e) => setCause((e.target as HTMLSelectElement).value)}>
                <option value="">Cause of the fire…</option>{CAUSES.map((c) => <option key={c}>{c}</option>)}
              </select>
              <Button kind="primary" full disabled={!cause} onClick={() => void apply('out')} testid="confirm-out">Close as out</Button>
            </div>
          )}
          {pick === 'dismissed' && (
            <div class="mt-3 space-y-2 fade-in">
              <input data-testid="reason" aria-label="Reason for false alarm" class="w-full min-h-[52px] rounded-2xl border border-line bg-card px-4 text-[16px]" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} placeholder="Why is it a false alarm?" />
              <Button kind="danger" full disabled={!reason.trim()} onClick={() => void apply('dismissed')} testid="confirm-dismiss">Mark as false alarm</Button>
            </div>
          )}
        </section>
      )}

      {assigns.length > 0 && (
        <section>
          <H>Crews</H>
          <div class="space-y-2">
            {assigns.map((a) => {
              const late = a.state === 'dispatched' && now - new Date(a.dispatched_at).getTime() > CONFIG.ackEscalationMs;
              return (
                <div key={a.id} data-testid="assignment" class="rounded-card border border-line bg-card p-4">
                  <div class="flex items-center justify-between gap-2">
                    <div class="text-[16px] font-semibold">{crewName(a.crew_id)}</div>
                    <span class={cx('text-[12px] font-semibold px-2.5 py-1 rounded-pill', late || a.need_support ? 'bg-fire-bg text-on-fire-bg' : 'bg-sc text-muted')} data-testid="assign-state">{late ? 'not acknowledged' : a.state.replace('_', ' ')}{a.need_support ? ' · needs support' : ''}</span>
                  </div>
                  <div class="text-[13px] text-muted mt-0.5">Called {ago(a.dispatched_at, now)}{a.acked_at ? ` · acknowledged ${hhmm(a.acked_at)}` : ''}{a.on_scene_at ? ` · on scene ${hhmm(a.on_scene_at)}` : ''}</div>
                  {a.instruction && <div class="text-[14px] mt-1.5">“{a.instruction}”</div>}
                  {mine(a) && a.state !== 'released' && can(role, 'respond') && (
                    <div class="grid grid-cols-2 gap-2 mt-3">
                      {a.state === 'dispatched' && <Button kind="primary" class="col-span-2" testid="ack" onClick={() => void assignmentAction(a, 'ack')}>Acknowledge</Button>}
                      {a.state !== 'en_route' && a.state !== 'on_scene' && <Button testid="enroute" onClick={() => void assignmentAction(a, 'en_route')}>En route</Button>}
                      {a.state !== 'on_scene' && <Button testid="onscene" onClick={() => void assignmentAction(a, 'on_scene')}>On scene</Button>}
                      {!a.need_support && <Button kind="outline" class="col-span-2 !text-fire-dark" onClick={() => void assignmentAction(a, 'need_support')}>Need support</Button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {per && (
        <section class="px-1">
          <H>Burnt area</H>
          <div class="text-[16px] num"><b>{fmtHa(per.area_ha)} ha</b> · {per.length_km?.toFixed(2) ?? '—'} km edge · {per.vertices.length} points {per.state !== 'closed' && <span class="text-amber">· in progress</span>}</div>
        </section>
      )}
      {photos.length > 0 && <section><H>Photos</H><div class="flex gap-2 overflow-x-auto">{photos.map((p) => <Thumb key={p.id} id={p.id} uploaded={p.uploaded} />)}</div></section>}

      <section>
        <H>Timeline</H>
        <div class="relative mb-4">
          <input data-testid="note-input" class="w-full min-h-[52px] rounded-pill border border-line bg-card pl-5 pr-14 text-[16px] outline-none focus:border-brand" placeholder="Add a note" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <button aria-label="Add note" data-testid="note-send" class="press absolute right-1.5 top-1.5 w-10 h-10 rounded-full bg-brand text-on-brand flex items-center justify-center disabled:opacity-30" disabled={!note.trim()} onClick={async () => { await addNote(id, note); setNote(''); }}><Send size={16} /></button>
        </div>
        <ol class="relative pl-5 space-y-3.5 before:absolute before:left-[5px] before:top-1.5 before:bottom-1.5 before:w-px before:bg-line" data-testid="timeline">
          {shown.map((e, i) => (
            <li key={e.id} class="relative text-[14px]">
              <span class={cx('absolute -left-5 top-1.5 w-[11px] h-[11px] rounded-full border-2 border-surface', i === 0 ? 'bg-brand' : 'bg-schh')} />
              <div>{label(e)}</div>
              <div class="text-[12px] text-muted num">{hhmm(e.client_ts)} · {e.by_name}{e.accuracy_m != null ? ` · ±${Math.round(e.accuracy_m)} m` : ''}</div>
            </li>
          ))}
        </ol>
        {events.length > 5 && <button class="press mt-3 text-[14px] font-semibold text-muted" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show less' : `Show all ${events.length}`}</button>}
      </section>
      {(role === 'coordinator' || role === 'admin') && (
        <button data-testid="delete-incident" class="w-full py-3 text-[14px] font-medium text-fire-dark" onClick={() => setDel(true)}>Delete this report</button>
      )}
      {del && <div class="fixed inset-0 z-[2600]"><DeleteSheet id={id} onClose={() => setDel(false)} onDone={() => { setDel(false); go('incidents'); }} /></div>}
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
