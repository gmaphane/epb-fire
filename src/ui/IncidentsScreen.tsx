import { useState } from 'preact/hooks';
import { BadgeCheck, ChevronRight, Compass, Eye, Footprints, Map as MapIcon, MapPin, Navigation, Satellite, SlidersHorizontal, UserPlus, Waypoints, CloudCheck, CloudOff } from 'lucide-preact';
import { useStore } from '../core/store';
import { Card, StatusChip, statusBar, cx } from './kit';
import { AppBar } from './kit';
import { go, useGps, useNow } from './hooks';
import { ago } from '../core/time';
import { bearingDeg, cardinal, fmtDistance, fmtDms, fmtHa, haversineM } from '../core/geo';
import { can, isOpen } from '../core/flow';
import type { Assignment, Incident } from '../core/types';
import type { SyncState } from '../core/sync';

const SOURCE: Record<Incident['source'], string> = { tower: 'Lookout tower', camera: 'Camera', satellite: 'Satellite', patrol: 'Patrol', community: 'Community', other: 'Other' };

function SyncPill({ s }: { s: SyncState | null }) {
  const offline = s?.simulateOffline || s?.reachable === false;
  const text = offline ? `Offline • ${s?.pending ?? 0} saved on this phone` : s?.pending ? `Offline storage active • Sending ${s.pending}…` : 'Offline storage active • Auto-syncing to Supabase';
  return (
    <div class="flex justify-center pt-3 pb-1 px-4">
      <button onClick={() => go('sync')} data-testid="offline-banner" class="inline-flex items-center gap-1 px-3 py-1 rounded-pill bg-sch shadow-sm max-w-full">
        <span class={cx('w-2 h-2 rounded-full shrink-0 animate-pulse', offline ? 'bg-outline' : s?.pending ? 'bg-amber' : 'bg-ok')} />
        <span class="text-[10px] font-semibold tracking-[.02em] text-muted truncate">{text}</span>
        {offline ? <CloudOff size={14} class="text-muted ml-0.5 shrink-0" /> : <CloudCheck size={14} class="text-muted ml-0.5 shrink-0" />}
      </button>
    </div>
  );
}

export function IncidentsScreen() {
  const s = useStore((x) => x);
  const g = useGps();
  const now = useNow(30_000);
  const [f, setF] = useState<'all' | 'active' | 'closed'>('all');
  const [sortNew, setSortNew] = useState(false);
  const all = s.incidents.filter((i) => !i.deleted_at);
  const list = all
    .filter((i) => (f === 'all' ? true : f === 'active' ? isOpen(i.status) : !isOpen(i.status)))
    .sort((a, b) => (sortNew ? 0 : Number(isOpen(b.status)) - Number(isOpen(a.status))) || (a.reported_at < b.reported_at ? 1 : -1));
  const nActive = all.filter((i) => isOpen(i.status)).length;
  const dets = s.detections.filter((d) => !d.promoted_incident_id).sort((a, b) => (a.acq_time < b.acq_time ? 1 : -1));
  const role = s.me?.role;
  const here = g.fix;

  return (
    <div class="h-full flex flex-col bg-surface">
      <AppBar title="Fires" />
      <main class="flex-1 overflow-y-auto pb-24">
        <SyncPill s={s.sync} />
        <div class="px-4 py-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 overflow-x-auto">
            {([['all', `All (${all.length})`], ['active', `Active (${nActive})`], ['closed', `Closed (${all.length - nActive})`]] as const).map(([k, l]) => (
              <button key={k} data-testid={'filter-' + k} onClick={() => setF(k)} class={cx('px-3.5 py-1.5 rounded-pill text-[12px] font-semibold shadow-sm shrink-0 transition-colors', f === k ? 'bg-brand text-on-brand' : 'bg-card text-muted')}>{l}</button>
            ))}
          </div>
          <button aria-label={sortNew ? 'Sort: newest first' : 'Sort: active first'} onClick={() => setSortNew((v) => !v)} class={cx('w-9 h-9 rounded-full shadow-sm flex items-center justify-center shrink-0', sortNew ? 'bg-brand text-on-brand' : 'bg-card text-muted')}><SlidersHorizontal size={18} /></button>
        </div>

        <div class="px-4 flex flex-col gap-3 mt-1">
          {list.length === 0 && (
            <div class="bg-card rounded-xl shadow-md p-6 text-center text-muted font-semibold">No incidents here. Use <b class="text-fire">Report fire</b> if you see smoke.</div>
          )}
          {list.map((i) => <IncidentCard key={i.id} i={i} here={here} now={now} canDispatch={can(role, 'dispatch')} canPerimeter={can(role, 'perimeter')} assigns={s.assignments.filter((a) => a.incident_id === i.id)} />)}

          {f !== 'closed' && dets.length > 0 && can(role, 'respond') && dets.map((d) => (
            <Card key={d.id} bar="bg-sat" testid="detection-card" pad="pl-5 pr-4 py-4">
              <div class="flex flex-col gap-1.5">
                <div class="flex items-start justify-between gap-2">
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill bg-sc text-ink text-[11px] font-semibold"><Satellite size={13} class="text-sat" />Hotspot · {d.source.replace(/_/g, ' ')}</span>
                  <span class="text-[11px] text-muted font-semibold">{ago(d.acq_time, now)}</span>
                </div>
                <h2 class="text-[20px] font-semibold leading-7 tracking-tight">Satellite detection</h2>
                <p class="text-[14px] text-muted">{d.confidence.replace(/^./, (c) => c.toUpperCase())} confidence{d.frp != null ? ` · FRP ${d.frp} MW` : ''}. Not yet checked on the ground.</p>
              </div>
              {here && (
                <div class="flex items-center gap-3 py-2 text-muted text-[12px] flex-wrap">
                  <span class="flex items-center gap-1"><Compass size={15} class="text-brand-deep" /><b class="text-ink text-[12px]">{fmtDistance(haversineM(here.lat, here.lon, d.lat, d.lon))} {cardinal(bearingDeg(here.lat, here.lon, d.lat, d.lon))}</b> from you</span>
                  <span class="text-outline-v">•</span>
                  <span>Bearing {Math.round(bearingDeg(here.lat, here.lon, d.lat, d.lon))}°</span>
                </div>
              )}
              <div class="flex items-center gap-2 pt-1">
                <button class="flex-1 inline-flex items-center justify-center gap-1.5 h-11 rounded-lg bg-sc text-brand-deep text-[14px] font-bold" onClick={() => go('report?det=' + d.id)}><MapIcon size={18} />Verify &amp; report</button>
              </div>
            </Card>
          ))}
        </div>

        <div class="flex flex-col items-center justify-center gap-1 pt-6 pb-4 text-center">
          <div class="w-8 h-8 rounded-full bg-sc flex items-center justify-center text-outline"><Satellite size={18} /></div>
          <span class="text-[11px] font-semibold text-muted">{all.length ? `All ${all.length} incident${all.length > 1 ? 's' : ''} on this phone` : 'Nothing reported yet'}</span>
          <span class="text-[11px] text-outline">{s.sync?.lastOkAt ? `Last synced ${ago(new Date(s.sync.lastOkAt).toISOString(), now)}` : 'Not synced yet'}</span>
        </div>
      </main>
    </div>
  );
}

function IncidentCard({ i, here, now, canDispatch, canPerimeter, assigns }: { i: Incident; here: { lat: number; lon: number } | null; now: number; canDispatch: boolean; canPerimeter: boolean; assigns: Assignment[] }) {
  const open = isOpen(i.status);
  const unverified = i.status === 'reported';
  const priority = open && !unverified;
  const onScene = assigns.filter((a) => a.state === 'on_scene').length;
  const stop = (e: Event) => e.stopPropagation();
  return (
    <article data-testid="incident-card" onClick={() => go('incident/' + i.id)} class="relative bg-card rounded-xl shadow-md p-4 flex flex-col gap-3 active:scale-[.99] transition-transform">
      <div class={cx('absolute top-0 left-0 bottom-0 w-1.5 rounded-l-xl', statusBar(i.status))} />
      <div class="flex flex-col gap-1.5 pl-1">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-center gap-1.5 flex-wrap">
            <StatusChip s={i.status} />
            {priority && <span class="text-[11px] font-semibold text-fire">Priority 1</span>}
            {i._sync && i._sync !== 'synced' && <span data-testid="row-pending" class="text-[11px] font-semibold text-amber">• On this phone</span>}
          </div>
          <span class="text-[11px] text-muted font-semibold shrink-0">{ago(i.reported_at, now)}</span>
        </div>
        <h2 class="text-[20px] font-semibold leading-7 tracking-tight">{i.compartment ?? i.block ?? 'Unmapped area'} fire #{i.code ?? i.label}</h2>
        {unverified && i.notes ? <p class="text-[14px] text-muted">{i.notes}</p> : null}
        <div class="flex items-center gap-1 text-muted text-[12px]">
          {open ? <Eye size={16} class="text-outline shrink-0" /> : <BadgeCheck size={16} class="text-ok shrink-0" />}
          <span class="truncate">{open ? (i.location_source === 'manual' ? `${i.observer_name ?? 'Field'} via ${i.relayed_via ?? 'radio'} • entered by ${i.reported_by_name}` : `${i.reported_by_name} • ${SOURCE[i.source]}`) : i.status === 'dismissed' ? `False alarm${i.dismiss_reason ? ` — ${i.dismiss_reason}` : ''}` : `${i.cause ?? 'Cause not recorded'}${i.area_ha != null ? ` • ${fmtHa(i.area_ha)} ha burnt` : ''}`}</span>
        </div>
      </div>

      {unverified && here ? (
        <div class="flex items-center gap-3 py-1 text-muted text-[12px] flex-wrap pl-1">
          <span class="flex items-center gap-1"><Compass size={16} class="text-brand-deep" /><b class="text-ink text-[12px]">{fmtDistance(haversineM(here.lat, here.lon, i.lat, i.lon))} {cardinal(bearingDeg(here.lat, here.lon, i.lat, i.lon))}</b> from you</span>
          <span class="text-outline-v">•</span>
          <span>Bearing {Math.round(bearingDeg(here.lat, here.lon, i.lat, i.lon))}°</span>
        </div>
      ) : open ? (
        <div class="bg-surface-low rounded-lg p-2 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2 min-w-0">
            <div class="w-8 h-8 rounded-lg bg-sc flex items-center justify-center shrink-0"><MapPin size={18} class="text-brand-deep" /></div>
            <div class="flex flex-col min-w-0">
              <span class="text-[10px] font-semibold uppercase tracking-[.06em] text-muted">Coordinates {here ? `• ${fmtDistance(haversineM(here.lat, here.lon, i.lat, i.lon))} away` : ''}</span>
              <span class="text-[12px] font-semibold truncate num">{fmtDms(i.lat, 'lat')} {fmtDms(i.lon, 'lon')}</span>
            </div>
          </div>
          <span class="text-[11px] px-2 py-1 rounded bg-sch font-bold shrink-0 num">{assigns.length ? `${onScene}/${assigns.length} crews` : i.accuracy_m != null ? `±${Math.round(i.accuracy_m)} m` : 'est.'}</span>
        </div>
      ) : i.status !== 'dismissed' && canPerimeter ? (
        <div class="bg-surface-low rounded-xl p-3 flex items-center justify-between gap-2" onClick={(e) => { stop(e); go('perimeter/' + i.id); }}>
          <div class="flex items-center gap-2 min-w-0">
            <div class="w-9 h-9 rounded-full bg-sc flex items-center justify-center text-brand-deep shrink-0"><Waypoints size={20} /></div>
            <div class="flex flex-col min-w-0">
              <span class="text-[12px] font-semibold truncate">Perimeter GPS survey</span>
              <span class="text-[12px] text-muted truncate">{i.area_ha != null ? `${fmtHa(i.area_ha)} ha mapped` : 'Ready for post-fire walk logging'}</span>
            </div>
          </div>
          <ChevronRight size={20} class="text-outline shrink-0" />
        </div>
      ) : null}

      {open && (
        <div class="flex items-center gap-2 pt-1" onClick={stop}>
          {unverified ? (
            <>
              <button class="flex-1 inline-flex items-center justify-center gap-1.5 h-11 px-3 rounded-lg bg-sc text-brand-deep text-[14px] font-bold" onClick={() => go('incident/' + i.id)}><MapIcon size={18} />Verify</button>
              <button class="inline-flex items-center justify-center gap-1.5 h-11 px-3 rounded-lg bg-brand text-on-brand text-[14px] font-bold shadow-sm" onClick={() => go('navigate/incident/' + i.id)}><Navigation size={18} />Navigate</button>
              {canDispatch && <button data-testid="card-dispatch" class="inline-flex items-center justify-center h-11 px-3 rounded-lg bg-surface-low text-muted text-[12px] font-semibold" onClick={() => go('dispatch/' + i.id)}><UserPlus size={18} /></button>}
            </>
          ) : (
            <>
              <button class="flex-1 inline-flex items-center justify-center gap-1.5 h-11 px-3 rounded-lg bg-brand text-on-brand text-[14px] font-bold shadow-sm" onClick={() => go('navigate/incident/' + i.id)}><Navigation size={18} />Navigate to Fire</button>
              {canDispatch
                ? <button data-testid="card-dispatch" class="inline-flex items-center justify-center gap-1.5 h-11 px-3 rounded-lg bg-sc text-ink text-[14px] font-semibold" onClick={() => go('dispatch/' + i.id)}><UserPlus size={18} class="text-muted" />Notify Team</button>
                : <button class="inline-flex items-center justify-center gap-1.5 h-11 px-3 rounded-lg bg-sc text-ink text-[14px] font-semibold" onClick={() => go('incident/' + i.id)}>Details</button>}
            </>
          )}
        </div>
      )}
      {!open && i.status !== 'dismissed' && canPerimeter && i.area_ha == null && (
        <div onClick={stop}><button class="w-full inline-flex items-center justify-center gap-2 h-11 rounded-lg bg-sc text-ink text-[14px] font-bold" onClick={() => go('perimeter/' + i.id)}><Footprints size={18} class="text-brand-deep" />Start Perimeter Survey</button></div>
      )}
    </article>
  );
}
