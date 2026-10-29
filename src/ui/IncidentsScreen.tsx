import { useState } from 'preact/hooks';
import { BadgeCheck, ChevronRight, CloudOff, Flame, Footprints, Navigation, Satellite, UserPlus } from 'lucide-preact';
import { useStore } from '../core/store';
import { StatusChip, cx } from './kit';
import { AppBar } from './kit';
import { go, useGps, useNow } from './hooks';
import { ago } from '../core/time';
import { bearingDeg, cardinal, fmtDistance, fmtHa, haversineM } from '../core/geo';
import { afterOut, can, isOpen } from '../core/flow';
import type { Assignment, Incident } from '../core/types';
import type { SyncState } from '../core/sync';

const SOURCE: Record<Incident['source'], string> = { tower: 'Lookout tower', camera: 'Camera', satellite: 'Satellite', patrol: 'Patrol', community: 'Community', other: 'Other' };

function SyncLine({ s }: { s: SyncState | null }) {
  const offline = s?.simulateOffline || s?.reachable === false;
  if (!offline && !s?.pending) return null;
  return (
    <button onClick={() => go('sync')} data-testid="offline-banner" class="press mx-4 mb-1 inline-flex items-center gap-2 text-[13px] text-muted">
      <CloudOff size={15} />{offline ? `Offline · ${s?.pending ?? 0} saved on this phone` : `Sending ${s!.pending}…`}
    </button>
  );
}

export function IncidentsScreen() {
  const s = useStore((x) => x);
  const g = useGps();
  const now = useNow(30_000);
  const [f, setF] = useState<'all' | 'active' | 'closed'>('all');
  const all = s.incidents.filter((i) => !i.deleted_at);
  const list = all
    .filter((i) => (f === 'all' ? true : f === 'active' ? isOpen(i.status) : !isOpen(i.status)))
    .sort((a, b) => Number(isOpen(b.status)) - Number(isOpen(a.status)) || (a.reported_at < b.reported_at ? 1 : -1));
  const nActive = all.filter((i) => isOpen(i.status)).length;
  const dets = s.detections.filter((d) => !d.promoted_incident_id).sort((a, b) => (a.acq_time < b.acq_time ? 1 : -1));
  const role = s.me?.role;
  const here = g.fix;

  return (
    <div class="h-full flex flex-col bg-surface screen-in">
      <AppBar title="Fires" sub={nActive ? `${nActive} active` : 'None active'} />
      <main class="flex-1 overflow-y-auto pb-28">
        <SyncLine s={s.sync} />
        <div class="px-4 pt-1 pb-3">
          <div class="inline-flex p-1 bg-sc rounded-pill">
            {([['all', 'All'], ['active', 'Active'], ['closed', 'Closed']] as const).map(([k, l]) => (
              <button key={k} data-testid={'filter-' + k} onClick={() => setF(k)} class={cx('press px-4 h-9 rounded-pill text-[14px] font-medium', f === k ? 'bg-card text-ink shadow-l1' : 'text-muted')}>{l}</button>
            ))}
          </div>
        </div>

        <div class="px-4 flex flex-col gap-3">
          {list.length === 0 && (
            <div class="text-center py-14 fade-in">
              <div class="w-14 h-14 rounded-full bg-moss text-on-moss mx-auto flex items-center justify-center mb-3"><BadgeCheck size={26} /></div>
              <div class="font-display text-[22px]">No fires here</div>
              <div class="text-[14px] text-muted mt-1">Report one if you see smoke.</div>
            </div>
          )}
          {list.map((i) => <IncidentCard key={i.id} i={i} here={here} now={now} canDispatch={can(role, 'dispatch')} canPerimeter={can(role, 'perimeter')} assigns={s.assignments.filter((a) => a.incident_id === i.id)} />)}
        </div>

        {f !== 'closed' && dets.length > 0 && can(role, 'respond') && (
          <section class="mt-7 px-4">
            <h2 class="font-display text-[20px] mb-3 flex items-center gap-2">Satellite hotspots <span class="text-[14px] font-sans text-muted">{dets.length}</span></h2>
            <div class="bg-card rounded-card border border-line divide-y divide-line overflow-hidden">
              {dets.map((d) => (
                <button key={d.id} data-testid="detection-card" class="press w-full px-4 py-3 flex items-center gap-3 text-left active:bg-surface-low" onClick={() => go('report?det=' + d.id)}>
                  <span class="w-10 h-10 rounded-full bg-sat-bg text-sat flex items-center justify-center shrink-0"><Satellite size={18} /></span>
                  <span class="flex-1 min-w-0">
                    <span class="block text-[15px] font-medium truncate">{d.compartment ?? 'Near the estate'} · {d.confidence} confidence</span>
                    <span class="block text-[13px] text-muted truncate">{ago(d.acq_time, now)}{here ? ` · ${fmtDistance(haversineM(here.lat, here.lon, d.lat, d.lon))} ${cardinal(bearingDeg(here.lat, here.lon, d.lat, d.lon))}` : ''}</span>
                  </span>
                  <span class="text-[13px] font-semibold text-ink shrink-0">Verify</span>
                  <ChevronRight size={18} class="text-faint shrink-0" />
                </button>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function IncidentCard({ i, here, now, canDispatch, canPerimeter, assigns }: { i: Incident; here: { lat: number; lon: number } | null; now: number; canDispatch: boolean; canPerimeter: boolean; assigns: Assignment[] }) {
  const open = isOpen(i.status);
  const onScene = assigns.filter((a) => a.state === 'on_scene').length;
  const stop = (e: Event) => e.stopPropagation();
  const dist = here ? haversineM(here.lat, here.lon, i.lat, i.lon) : null;
  const sub = open
    ? (i.location_source === 'manual' ? `${i.observer_name ?? 'Field'} via ${i.relayed_via ?? 'radio'}` : `${SOURCE[i.source]} · ${i.reported_by_name}`)
    : i.status === 'dismissed' ? `False alarm${i.dismiss_reason ? ` · ${i.dismiss_reason}` : ''}` : `${i.cause ?? 'Cause not recorded'}${i.area_ha != null ? ` · ${fmtHa(i.area_ha)} ha` : ''}`;
  return (
    <article data-testid="incident-card" onClick={() => go('incident/' + i.id)} class={cx('press bg-card rounded-card border border-line p-4 flex flex-col gap-3', !open && 'opacity-90')}>
      <div class="flex items-start gap-3">
        <span class={cx('w-11 h-11 rounded-full flex items-center justify-center shrink-0', open ? 'bg-fire-bg text-fire' : i.status === 'dismissed' ? 'bg-sc text-faint' : 'bg-moss text-on-moss')}>
          {open ? <Flame size={20} fill="currentColor" class={i.status !== 'reported' ? 'animate-pulse' : ''} /> : <BadgeCheck size={20} />}
        </span>
        <div class="flex-1 min-w-0">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-[17px] font-semibold truncate">{i.compartment ?? i.block ?? 'Unmapped area'}</h2>
            <span class="text-[13px] text-muted shrink-0 num">{ago(i.reported_at, now)}</span>
          </div>
          <div class="text-[13px] text-muted truncate">{i.code ?? i.label} · {sub}</div>
          <div class="flex items-center gap-2 mt-2 flex-wrap">
            <StatusChip s={i.status} short />
            {i.category && <span class="text-[12px] font-semibold px-2 py-0.5 rounded-pill bg-sc text-ink" data-testid="cat-chip">Cat {i.category}</span>}
            {i.status === 'out' && i.out_at && <FollowUp i={i} now={now} />}
            {open && assigns.length > 0 && <span class="text-[12px] text-muted">{onScene}/{assigns.length} crews on scene</span>}
            {i._sync && i._sync !== 'synced' && <span data-testid="row-pending" class="text-[12px] font-medium text-amber">On this phone</span>}
          </div>
        </div>
      </div>
      {open && (
        <div class="flex items-center gap-2" onClick={stop}>
          <button class="press flex-1 inline-flex items-center justify-center gap-2 h-11 rounded-pill bg-brand text-on-brand text-[15px] font-semibold" onClick={() => go('navigate/incident/' + i.id)}><Navigation size={17} />Navigate{dist != null ? <span class="font-normal opacity-75 num">· {fmtDistance(dist)}</span> : null}</button>
          {canDispatch && <button data-testid="card-dispatch" aria-label="Dispatch crews" class="press w-11 h-11 rounded-full border border-line flex items-center justify-center text-ink" onClick={() => go('dispatch/' + i.id)}><UserPlus size={18} /></button>}
        </div>
      )}
      {!open && i.status !== 'dismissed' && canPerimeter && i.area_ha == null && (
        <div onClick={stop}><button class="press w-full inline-flex items-center justify-center gap-2 h-11 rounded-pill border border-line text-[15px] font-semibold" onClick={() => go('perimeter/' + i.id)}><Footprints size={17} />Map the burnt area</button></div>
      )}
    </article>
  );
}

/** After Out (SOP 4.1): patrol still running, or the incident report not yet submitted. */
function FollowUp({ i, now }: { i: Incident; now: number }) {
  const a = afterOut(i.out_at!, i.category ?? null);
  const hm = (t: number) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (a.patrolUntil != null && a.patrolUntil > now) return <span class="text-[12px] font-semibold px-2 py-0.5 rounded-pill bg-amber-bg text-amber" data-testid="followup">Patrol until {hm(a.patrolUntil)}</span>;
  if (!i.report_submitted_at) return <span class={cx('text-[12px] font-semibold px-2 py-0.5 rounded-pill', a.submitDue < now ? 'bg-fire-bg text-on-fire-bg' : 'bg-sc text-muted')} data-testid="followup">{a.submitDue < now ? 'Report overdue' : `Report due ${hm(a.submitDue)}`}</span>;
  return null;
}
