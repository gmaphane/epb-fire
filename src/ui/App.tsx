import { useEffect, useState } from 'preact/hooks';
import { BellRing, Flame, List, Map as MapIcon, Settings, Users, Search, X, Droplets, MapPin, Square } from 'lucide-preact';
import { assignmentAction } from '../core/actions';
import { startAlarm, stopAlarm } from '../core/alarm';
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
      <div class="mt-2 rounded-2xl bg-fire text-on-fire shadow-sheet p-4 space-y-3">
        <div class="flex items-center gap-2 font-bold text-[18px]"><BellRing class="animate-pulse" /> Fire call-out — {crews.find((c) => c.id === a.crew_id)?.name ?? 'You'}</div>
        <div class="text-[14px] font-semibold opacity-95">{inc?.code ?? inc?.label} · {inc?.compartment ?? inc?.block ?? 'see map'} · {ago(a.dispatched_at)}{a.instruction ? ` — ${a.instruction}` : ''}</div>
        <div class="flex gap-2">
          <button data-testid="alarm-ack" class="flex-1 min-h-[52px] rounded-xl bg-white text-[#B91C1C] font-bold text-[16px]" onClick={() => void assignmentAction(a, 'ack')}>Acknowledge</button>
          <button class="min-h-[52px] px-4 rounded-xl bg-white/15 font-semibold" onClick={() => go('incident/' + a.incident_id)}>View</button>
        </div>
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
      <div class="h-14 px-3 flex items-center gap-2 blur-bar border-b border-line">
        <Search size={20} class="text-muted ml-1" />
        <input autoFocus data-testid="search-input" class="flex-1 h-11 bg-transparent outline-none text-[16px]" placeholder="Incidents, compartments, water points…" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button aria-label="Close" class="w-11 h-11 rounded-full flex items-center justify-center" onClick={close}><X size={22} /></button>
      </div>
      <div class="flex-1 overflow-y-auto p-4 space-y-2">
        {n && !hits.length && <div class="text-center text-muted font-semibold py-8">No matches on this phone</div>}
        {hits.map((h) => (
          <button key={h.k} class="w-full bg-card rounded-xl shadow-sm p-3 flex items-center gap-3 text-left" onClick={() => { close(); h.go(); }}>
            <span class="w-9 h-9 rounded-lg bg-sc flex items-center justify-center shrink-0">{h.icon}</span>
            <span class="min-w-0 flex-1"><span class="block font-semibold truncate">{h.title}</span>{h.sub}</span>
          </button>
        ))}
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
      <div class="w-full bg-card rounded-t-[28px] shadow-sheet p-4 pb-8 pb-safe space-y-3 sheet-enter" onClick={(e) => e.stopPropagation()}>
        <div class="w-10 h-1 bg-schh rounded-full mx-auto" />
        <div class="flex items-center justify-between"><h2 class="text-[16px] font-semibold">Status</h2><div class="flex gap-2 items-center"><GpsChip g={g} compact /><SyncChip s={s.sync} onClick={() => { close(); go('sync'); }} /></div></div>
        {g.fix ? (() => { const u = toUtm30(g.fix!.lat, g.fix!.lon); return (
          <div class="rounded-xl bg-cobalt-bg p-3 space-y-1" data-testid="readout">
            <div class="text-[10px] font-bold uppercase tracking-[.06em] text-on-moss">My position — read out over the radio</div>
            <div class="text-[22px] font-bold num leading-7">{fmtDms(g.fix.lat, 'lat')}  {fmtDms(g.fix.lon, 'lon')}</div>
            <div class="text-[16px] font-semibold num">{g.fix.lat.toFixed(5)} N, {Math.abs(g.fix.lon).toFixed(5)} {g.fix.lon < 0 ? 'W' : 'E'}</div>
            <div class="text-[16px] font-semibold num">UTM 30N  {radioDigits(u.e)} E  {radioDigits(u.n)} N</div>
            <div class="text-[12px] text-muted font-semibold">Accuracy ±{Math.round(g.fix.acc)} m · works with no signal</div>
          </div>
        ); })() : <div class="rounded-xl bg-sch p-3 text-[13px] font-semibold">Waiting for a GPS fix…</div>}
        <div class="bg-surface-low rounded-xl divide-y divide-line">
          {rows.map(([k, v]) => <div key={k} class="flex justify-between gap-3 px-3 py-2.5 text-[13px]"><span class="text-muted font-semibold">{k}</span><span class="font-semibold num text-right">{v}</span></div>)}
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
      <div class="flex-1 min-h-0 relative">{screen}</div>
      {showFab && (onMap ? (
        // On the map it joins the Stitch tool rail as a red dial so it never covers callouts
        <button data-testid="report-fab" aria-label="Report fire" onClick={() => go('report')}
          class="absolute right-[9px] z-[1100] w-[50px] flex flex-col items-center gap-1 active:scale-95 transition-transform"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px + 4 * 54px + 4px)' }}>
          <span class="w-[50px] h-[50px] rounded-full bg-[#EF4444] text-white shadow-sheet flex items-center justify-center ring-4 ring-[#EF4444]/25"><Flame size={24} fill="currentColor" /></span>
          <span class="px-1.5 py-0.5 rounded-pill bg-[#0F172A] text-white text-[9px] font-semibold uppercase tracking-wide shadow-sm">Report</span>
        </button>
      ) : (
        <button data-testid="report-fab" aria-label="Report fire" onClick={() => go('report')}
          class="absolute right-4 z-[1100] h-14 pl-4 pr-5 rounded-pill bg-fire text-on-fire shadow-sheet flex items-center gap-2 font-bold text-[15px] active:scale-95 transition-transform"
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)' }}>
          <Flame size={22} /> Report fire
        </button>
      ))}
      {!full && (
        <nav class="shrink-0 blur-bar border-t border-line pb-safe z-[1200]" aria-label="Main">
          <div class="flex items-center justify-around h-16 px-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              const badge = t.id === 'sync' && sync && (sync.pending > 0 || sync.errors > 0);
              return (
                <a key={t.id} href={'#/' + t.id} data-testid={'tab-' + t.id} aria-current={active ? 'page' : undefined}
                  class={cx('relative flex flex-col items-center justify-center gap-0.5 min-w-[56px] min-h-[44px] text-[11px]', active ? 'text-ink font-semibold' : 'text-faint font-medium')}>
                  <Icon size={22} strokeWidth={active ? 2.4 : 2} />
                  {t.label}
                  {badge && <span class={cx('absolute top-0.5 right-3 w-2 h-2 rounded-full', sync!.errors ? 'bg-fire' : 'bg-amber')} />}
                </a>
              );
            })}
          </div>
        </nav>
      )}
      {overlay === 'search' && <SearchOverlay />}
      {overlay === 'info' && <InfoOverlay />}
      {toast && (
        <div data-testid="toast" role="status" class={cx('fixed left-1/2 -translate-x-1/2 z-[3000] max-w-[92vw] rounded-pill px-4 py-2.5 text-[13px] font-semibold shadow-xl sheet-enter text-center', toast.kind === 'err' ? 'bg-fire text-on-fire' : toast.kind === 'warn' ? 'bg-amber-bg text-amber' : 'bg-inverse text-surface')} style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 150px)' }}>
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
