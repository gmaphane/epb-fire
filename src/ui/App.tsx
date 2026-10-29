import { useEffect, useRef, useState } from 'preact/hooks';
import { BellRing, Flame, Satellite, List, Map as MapIcon, Settings, Users, Search, X, Droplets, MapPin, Square } from 'lucide-preact';
import { assignmentAction } from '../core/actions';
import { chime, startAlarm, stopAlarm } from '../core/alarm';
import { isOpen } from '../core/flow';
import { stopResponding } from '../core/presence';
import { getState, setState, useStore } from '../core/store';
import { go, useGps, useRoute } from './hooks';
import { cx, GpsChip, StatusChip, SyncChip } from './kit';
import { MapScreen } from './MapScreen';
import { IncidentsScreen } from './IncidentsScreen';
import { IncidentScreen } from './IncidentScreen';
import { ReportScreen } from './ReportScreen';
import { DispatchScreen } from './DispatchScreen';
import { NavigateScreen } from './NavigateScreen';
import { PerimeterScreen } from './PerimeterScreen';
import { SyncScreen } from './SyncScreen';
import { CrewsScreen } from './CrewsScreen';
import { AdminScreen } from './AdminScreen';
import { SignIn } from './SignIn';
import { Tour, tourSeen } from './Tour';
import { autoPack } from '../core/tiles';
import { ago } from '../core/time';
import { CONFIG, IS_DEMO } from '../config';
import { fmtDd, fmtDms, toUtm30 } from '../core/geo';
import { radioDigits } from '../core/coords';

// Four tabs: where things are, what is burning, who is out, and settings.
// Navigate and Perimeter open from a fire (card, list or details), so they are not tabs.
const TABS = [
  { id: 'map', label: 'Map', icon: MapIcon },
  { id: 'incidents', label: 'Fires', icon: List },
  { id: 'crews', label: 'Crews', icon: Users },
  { id: 'sync', label: 'Settings', icon: Settings },
] as const;

function AlarmBanner() {
  const { me, assignments, incidents, crews } = useStore((s) => ({ me: s.me, assignments: s.assignments, incidents: s.incidents, crews: s.crews }));
  const mine = assignments.filter((a) => a.state === 'dispatched' && me && (a.user_id === me.id || (a.crew_id && a.crew_id === me.crew_id)));
  useEffect(() => {
    if (mine.length) startAlarm();
    else stopAlarm();
    return () => stopAlarm();
  }, [mine.length]);
  if (!mine.length) return null;
  const a = mine[0];
  const inc = incidents.find((i) => i.id === a.incident_id);
  return (
    <div role="alert" data-testid="alarm" class="fixed top-0 inset-x-0 z-[2000] pt-safe px-3 sheet-enter">
      <div class="mt-2 rounded-[24px] bg-fire text-on-fire shadow-l3 p-4 space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center pulse shrink-0"><BellRing size={22} /></span>
          <div class="min-w-0">
            <div class="font-display text-[20px] leading-tight truncate">Fire call-out — {crews.find((c) => c.id === a.crew_id)?.name ?? 'You'}</div>
            <div class="text-[14px] opacity-90 truncate">{inc?.compartment ?? inc?.block ?? 'See map'} · {ago(a.dispatched_at)}{a.instruction ? ` · ${a.instruction}` : ''}</div>
          </div>
        </div>
        <div class="flex gap-2">
          <button data-testid="alarm-ack" class="press flex-1 min-h-[52px] rounded-pill bg-white text-fire-dark font-semibold text-[16px]" onClick={() => void assignmentAction(a, 'ack')}>Acknowledge</button>
          <button class="press min-h-[52px] px-5 rounded-pill bg-white/15 font-semibold" onClick={() => go('incident/' + a.incident_id)}>View</button>
        </div>
      </div>
    </div>
  );
}

/** Clears "En route / On scene" once the fire it was for is closed, dismissed or deleted, so it never sticks. */
function PresenceGuard() {
  const { presence, incidents, booted } = useStore((s) => ({ presence: s.presence, incidents: s.incidents, booted: s.booted }));
  useEffect(() => {
    if (!booted || !presence || (presence.status !== 'en_route' && presence.status !== 'on_scene')) return;
    const i = presence.incident_id ? incidents.find((x) => x.id === presence.incident_id) : null;
    if (!i || i.deleted_at || !isOpen(i.status)) void stopResponding();
  }, [presence?.status, presence?.incident_id, incidents, booted]);
  return null;
}

/** Tells everyone, inside the app, when a fire is reported or a satellite hotspot is seen near the estate.
 *  (Push alerts cover the phone when the app is closed.) Fires already on the phone at start-up are not re-announced. */
function NewFireAlert() {
  const { me, incidents, detections } = useStore((s) => ({ me: s.me, incidents: s.incidents, detections: s.detections }));
  const seen = useRef<Set<string> | null>(null);
  const [alert, setAlert] = useState<{ kind: 'fire' | 'hotspot'; go: string; title: string; sub: string; more: number } | null>(null);
  useEffect(() => {
    const ids = [...incidents.map((i) => 'i' + i.id), ...detections.map((d) => 'd' + d.id)];
    if (!seen.current) { seen.current = new Set(ids); return; }
    const recent = (t: string) => Date.now() - new Date(t).getTime() < 6 * 3600_000;
    const fires = incidents.filter((i) => !seen.current!.has('i' + i.id) && !i.deleted_at && isOpen(i.status) && i.reported_by !== me?.id && recent(i.reported_at));
    const spots = detections.filter((d) => !seen.current!.has('d' + d.id) && !d.promoted_incident_id && d.distance_m != null && d.distance_m <= 2000 && recent(d.acq_time));
    ids.forEach((k) => seen.current!.add(k));
    if (!fires.length && !spots.length) return;
    const a = fires.length
      ? { kind: 'fire' as const, go: 'incident/' + fires[0].id, title: `New fire · ${fires[0].compartment ?? fires[0].block ?? 'unmapped area'}`, sub: `${fires[0].status === 'reported' ? 'Unverified' : 'Confirmed'} · ${fires[0].reported_by_name ?? 'reported'} · ${ago(fires[0].reported_at)}`, more: fires.length - 1 + spots.length }
      : { kind: 'hotspot' as const, go: 'incidents', title: `Satellite hotspot · ${spots[0].compartment ?? 'near the estate'}`, sub: `${spots[0].confidence} confidence · ${ago(spots[0].acq_time)} · unverified`, more: spots.length - 1 };
    setAlert(a);
    chime();
    // the app is open but in the background: show it in the phone's notification shade too
    try {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted')
        void navigator.serviceWorker?.ready.then((r) => r.showNotification(a.title, { body: a.sub, tag: a.go, data: { url: '/#/' + a.go } } as NotificationOptions));
    } catch { /* ignore */ }
  }, [incidents, detections]);
  useEffect(() => { if (!alert) return; const t = setTimeout(() => setAlert(null), 30_000); return () => clearTimeout(t); }, [alert]);
  if (!alert) return null;
  return (
    <div role="alert" data-testid="new-fire-alert" class="fixed top-0 inset-x-0 z-[1990] pt-safe px-3 sheet-enter">
      <div class="mt-2 rounded-[24px] bg-card shadow-l3 border border-line p-3 pr-2 flex items-center gap-3">
        <span class={cx('w-11 h-11 rounded-full flex items-center justify-center shrink-0', alert.kind === 'fire' ? 'bg-fire text-on-fire pulse' : 'bg-sat-bg text-sat')}>{alert.kind === 'fire' ? <Flame size={20} fill="currentColor" /> : <Satellite size={20} />}</span>
        <button class="flex-1 min-w-0 text-left" onClick={() => { setAlert(null); go(alert.go); }}>
          <span class="block text-[16px] font-semibold truncate">{alert.title}</span>
          <span class="block text-[13px] text-muted truncate">{alert.sub}{alert.more > 0 ? ` · +${alert.more} more` : ''}</span>
        </button>
        <button class="press h-10 px-4 rounded-pill bg-brand text-on-brand text-[14px] font-semibold shrink-0" onClick={() => { setAlert(null); go(alert.go); }}>View</button>
        <button aria-label="Dismiss" class="press w-9 h-9 rounded-full flex items-center justify-center text-muted shrink-0" onClick={() => setAlert(null)}><X size={18} /></button>
      </div>
    </div>
  );
}

function SearchOverlay() {
  const s = useStore((x) => ({ incidents: x.incidents, assets: x.assets, compartments: x.compartments }));
  const [q, setQ] = useState('');
  const n = q.trim().toLowerCase();
  const hits = !n ? [] : [
    ...s.incidents.filter((i) => `${i.code ?? ''} ${i.label} ${i.compartment ?? ''} ${i.block ?? ''} ${i.notes}`.toLowerCase().includes(n)).map((i) => ({ k: i.id, icon: <Flame size={16} class="text-fire" />, title: `${i.code ?? i.label} · ${i.compartment ?? i.block ?? 'Unmapped area'}`, sub: <StatusChip s={i.status} short />, go: () => go('incident/' + i.id) })),
    ...s.compartments.filter((c) => `${c.code} ${c.block}`.toLowerCase().includes(n)).map((c) => {
      const ring = (c.geojson.type === 'Polygon' ? c.geojson.coordinates[0] : c.geojson.coordinates[0][0]) as number[][];
      const lat = ring.reduce((a, p) => a + p[1], 0) / ring.length, lon = ring.reduce((a, p) => a + p[0], 0) / ring.length;
      return { k: c.id, icon: <Square size={16} class="text-brand-deep" />, title: c.code, sub: <span class="text-[12px] text-muted">{c.block} · {c.risk_class.replace('_', ' ')} risk</span>, go: () => { setState({ mapFocus: { lat, lon, zoom: 16, t: Date.now() } }); go('map'); } };
    }),
    ...s.assets.filter((a) => a.name.toLowerCase().includes(n) || a.kind.includes(n)).map((a) => ({ k: a.id, icon: a.kind === 'water' ? <Droplets size={16} class="text-cobalt" /> : <MapPin size={16} class="text-brand-deep" />, title: a.name, sub: <span class="text-[12px] text-muted num">{fmtDd(a.lat, a.lon)}</span>, go: () => { setState({ mapFocus: { lat: a.lat, lon: a.lon, zoom: 17, t: Date.now() } }); go('map'); } })),
  ].slice(0, 30);
  const close = () => setState({ overlay: null });
  return (
    <div class="fixed inset-0 z-[2500] bg-surface flex flex-col pt-safe sheet-enter" data-testid="search-overlay">
      <div class="px-4 pt-3 pb-2 flex items-center gap-2">
        <div class="flex-1 h-12 rounded-pill bg-card border border-line shadow-l1 flex items-center gap-2 px-4">
          <Search size={19} class="text-muted" />
          <input autoFocus data-testid="search-input" class="flex-1 h-full bg-transparent outline-none text-[16px]" placeholder="Fire, compartment or water point" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        </div>
        <button aria-label="Close" class="press w-11 h-11 rounded-full flex items-center justify-center text-ink" onClick={close}><X size={22} /></button>
      </div>
      <div class="flex-1 overflow-y-auto px-4 pt-2">
        {n && !hits.length && <div class="text-center text-muted py-10 fade-in">Nothing found</div>}
        {!!hits.length && (
          <div class="bg-card rounded-card border border-line divide-y divide-line overflow-hidden fade-in">
            {hits.map((h) => (
              <button key={h.k} class="press w-full px-4 py-3 flex items-center gap-3 text-left active:bg-surface-low" onClick={() => { close(); h.go(); }}>
                <span class="w-9 h-9 rounded-full bg-sc flex items-center justify-center shrink-0">{h.icon}</span>
                <span class="min-w-0 flex-1"><span class="block text-[15px] font-medium truncate">{h.title}</span>{h.sub}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function InfoOverlay() {
  const s = useStore((x) => x);
  const g = useGps();
  const close = () => setState({ overlay: null });
  const rows: [string, string][] = [
    ['Signed in', `${s.me?.name} (${s.me?.role})`],
    ['Position', g.fix ? fmtDd(g.fix.lat, g.fix.lon) : '—'],
    ['Accuracy', g.fix ? `±${Math.round(g.fix.acc)} m` : '—'],
    ['Datum', 'WGS84 · UTM 30N (EPSG:32630)'],
    ['Waiting to send', String(s.sync?.pending ?? 0)],
    ['Last sync', s.sync?.lastOkAt ? ago(new Date(s.sync.lastOkAt).toISOString()) : 'never'],
    ['Season readiness', (s.readiness?.level ?? 'green').toUpperCase()],
    ['Server', IS_DEMO ? 'Demo (on device)' : 'Supabase'],
    ['Version', CONFIG.version],
  ];
  return (
    <div class="fixed inset-0 z-[2500] bg-black/30 flex items-end" onClick={close} data-testid="info-overlay">
      <div class="w-full bg-card rounded-t-sheet shadow-sheet px-5 pt-2 pb-8 pb-safe space-y-4 sheet-enter max-h-[88vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div class="w-9 h-1 bg-schh rounded-full mx-auto" />
        <div class="flex items-center justify-between"><h2 class="font-display text-[22px]">My position</h2><div class="flex gap-2 items-center"><GpsChip g={g} compact /><SyncChip s={s.sync} onClick={() => { close(); go('sync'); }} /></div></div>
        {g.fix ? (() => { const u = toUtm30(g.fix!.lat, g.fix!.lon); return (
          <button class="press w-full text-left space-y-1" data-testid="readout" onClick={() => { void navigator.clipboard?.writeText(`${g.fix!.lat.toFixed(5)}, ${g.fix!.lon.toFixed(5)}`); }}>
            <div class="text-[26px] font-semibold num tracking-[-.02em] leading-8">{fmtDms(g.fix.lat, 'lat')}  {fmtDms(g.fix.lon, 'lon')}</div>
            <div class="text-[15px] text-muted num">{g.fix.lat.toFixed(5)} N, {Math.abs(g.fix.lon).toFixed(5)} {g.fix.lon < 0 ? 'W' : 'E'}</div>
            <div class="text-[15px] text-muted num">UTM 30N  {radioDigits(u.e)} E  {radioDigits(u.n)} N</div>
          </button>
        ); })() : <div class="text-[15px] text-muted">Waiting for GPS…</div>}
        <div class="rounded-card border border-line divide-y divide-line">
          {rows.map(([k, v]) => <div key={k} class="flex justify-between gap-3 px-4 py-3 text-[14px]"><span class="text-muted">{k}</span><span class="font-medium num text-right">{v}</span></div>)}
        </div>
      </div>
    </div>
  );
}

export function App() {
  const { booted, me, toast, theme, updateReady, sync, overlay } = useStore((s) => ({ booted: s.booted, me: s.me, toast: s.toast, theme: s.theme, updateReady: s.updateReady, sync: s.sync, overlay: s.overlay }));
  const route = useRoute();
  const [night, setNight] = useState(false);

  useEffect(() => {
    const calc = () => {
      const h = new Date().getHours();
      const t = theme === 'auto' ? (h >= 18 || h < 6 ? 'night' : 'day') : theme;
      document.documentElement.dataset.theme = t;
      setNight(t === 'night');
    };
    calc();
    const t = setInterval(calc, 60_000);
    return () => clearInterval(t);
  }, [theme]);
  useEffect(() => { if (getState().overlay) setState({ overlay: null }); }, [route.name, route.parts.join('/')]);

  const [tour, setTour] = useState(false);
  useEffect(() => { if (me && !tourSeen(me.id)) setTour(true); }, [me?.id]);
  useEffect(() => { const f = () => setTour(true); window.addEventListener('ew-tour', f); return () => window.removeEventListener('ew-tour', f); }, []);
  // offline map downloads itself in the background a few seconds after sign-in, and again when back online
  const basemap = useStore((s) => s.basemap);
  useEffect(() => {
    if (!me || IS_DEMO) return;
    const go = () => void autoPack(basemap);
    const t = setTimeout(go, 6000);
    window.addEventListener('online', go);
    return () => { clearTimeout(t); window.removeEventListener('online', go); };
  }, [me?.id, basemap]);
  if (!booted) return <div class="h-full flex items-center justify-center text-muted font-semibold">Loading…</div>;
  if (!me) return <SignIn />;

  const r = route.name;
  const full = ['report', 'dispatch', 'incident'].includes(r);
  const tab = TABS.find((t) => t.id === r)?.id ?? (r === 'incident' || r === 'dispatch' || r === 'navigate' || r === 'perimeter' ? 'incidents' : r === 'admin' ? 'sync' : 'map');

  let screen;
  switch (r) {
    case 'incidents': screen = <IncidentsScreen />; break;
    case 'incident': screen = <IncidentScreen id={route.parts[0]} />; break;
    case 'report': screen = <ReportScreen detection={route.q.get('det')} />; break;
    case 'dispatch': screen = <DispatchScreen id={route.parts[0]} />; break;
    case 'navigate': screen = <NavigateScreen kind={route.parts[0]} id={route.parts[1]} />; break;
    case 'perimeter': screen = <PerimeterScreen incidentId={route.parts[0]} />; break;
    case 'sync': screen = <SyncScreen />; break;
    case 'crews': screen = <CrewsScreen />; break;
    case 'admin': screen = <AdminScreen />; break;
    default: screen = <MapScreen />;
  }
  // Report Fire is always ≤ 1 tap away (FR-REP-01). On the map it sits under the tool rail; elsewhere above the nav.
  const showFab = !['report', 'perimeter', 'dispatch', 'navigate', 'admin'].includes(r);
  const onMap = !['incidents', 'incident', 'crews', 'sync', 'admin', 'navigate', 'perimeter', 'report', 'dispatch'].includes(r);

  return (
    <div class="h-full flex flex-col relative bg-surface" data-night={night}>
      <AlarmBanner />
      <NewFireAlert />
      <PresenceGuard />
      <div class="flex-1 min-h-0 relative">{screen}</div>
      {showFab && (onMap ? (
        // On the map: the red button at the foot of the tool rail, clear of any sheet
        <button data-testid="report-fab" aria-label="Report fire" onClick={() => go('report')}
          class="press absolute right-[9px] z-[1100] w-[50px] h-[50px] rounded-full bg-fire text-on-fire shadow-l3 flex items-center justify-center ring-4 ring-fire/20"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 72px + 4 * 54px + 4px)' }}>
          <Flame size={24} fill="currentColor" />
        </button>
      ) : (
        <button data-testid="report-fab" aria-label="Report fire" onClick={() => go('report')}
          class="press absolute right-4 z-[1100] h-14 pl-5 pr-6 rounded-pill bg-fire text-on-fire shadow-l3 flex items-center gap-2 font-semibold text-[16px] pop-in"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 84px)' }}>
          <Flame size={20} fill="currentColor" /> Report fire
        </button>
      ))}
      {!full && (
        <nav class="shrink-0 bg-card border-t border-line pb-safe z-[1200]" aria-label="Main">
          <div class="flex items-center justify-around h-[68px] px-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              const badge = t.id === 'sync' && sync && (sync.pending > 0 || sync.errors > 0);
              return (
                <a key={t.id} href={'#/' + t.id} data-testid={'tab-' + t.id} aria-current={active ? 'page' : undefined}
                  class={cx('press relative flex flex-col items-center justify-center gap-1 min-w-[64px] min-h-[48px] text-[12px] transition-colors', active ? 'text-ink font-semibold' : 'text-faint font-medium')}>
                  <span class={cx('flex items-center justify-center h-8 w-14 rounded-pill transition-colors', active && 'bg-moss text-on-moss')}><Icon size={21} strokeWidth={active ? 2.2 : 1.8} /></span>
                  {t.label}
                  {badge && <span class={cx('absolute top-0.5 right-3 w-2 h-2 rounded-full', sync!.errors ? 'bg-fire' : 'bg-amber')} />}
                </a>
              );
            })}
          </div>
        </nav>
      )}
      {tour && <Tour onDone={() => setTour(false)} />}
      {overlay === 'search' && <SearchOverlay />}
      {overlay === 'info' && <InfoOverlay />}
      {toast && (
        <div data-testid="toast" role="status" class={cx('fixed left-1/2 -translate-x-1/2 z-[3000] max-w-[88vw] rounded-pill px-5 py-3 text-[14px] font-medium shadow-l3 sheet-enter text-center pointer-events-none', toast.kind === 'err' ? 'bg-fire text-on-fire' : toast.kind === 'warn' ? 'bg-amber-bg text-amber' : 'bg-inverse text-surface')} style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 156px)' }}>
          {toast.text}
        </div>
      )}
      {updateReady && (
        <button class="fixed top-2 left-1/2 -translate-x-1/2 z-[3000] bg-card shadow-l2 rounded-pill px-4 py-2 text-[13px] font-semibold" onClick={() => updateReady()}>
          Update ready — tap to restart when safe
        </button>
      )}
    </div>
  );
}
