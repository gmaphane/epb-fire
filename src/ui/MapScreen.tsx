import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BellRing, ChevronDown, Copy, Download, ClipboardList, Flame, Layers, LocateFixed, MapPin, MoreHorizontal, Navigation, Radio, Ruler, Satellite, Search, ShieldCheck, Trash2, Users, X } from 'lucide-preact';
import L from 'leaflet';
import { getState, setState, toast, useStore } from '../core/store';
import { gps } from '../core/gps';
import { CONFIG } from '../config';
import { MapController, RISK, type RouteLine } from './mapview';
import { Button, Choice, CoordReadout, NorthDial, RailButton, SatChip, Sheet, StatusChip, SyncChip, cx } from './kit';
import { fmtDistance, haversineM, toUtm30 } from '../core/geo';
import { deleteIncident, moveIncident, resolveHazard } from '../core/actions';
import { ago } from '../core/time';
import { go, useGpsFix } from './hooks';
import { isOpen } from '../core/flow';
import { metaSet } from '../core/db';
import { fmtEta, route, type Mode, type Route } from '../core/route';
import { isStale, setPresence, stopResponding } from '../core/presence';
import type { Incident } from '../core/types';
import { compass8, useWeather, wxAge, type Weather } from '../core/weather';
import { spreadEllipse, threats, type Threat } from '../core/spread';
import { SpreadPanel, WindArrow } from './SpreadPanel';
import { enablePush, pushState, type PushState } from '../core/push';
import { promptInstall, useInstall } from '../core/install';
import type { FireDanger } from '../core/types';

/** The few layers people actually switch. Hazards are always shown; everything else stays in the data. */
const LAYERS: { k: string; label: string; swatch: string }[] = [
  { k: 'compartments', label: 'Compartments', swatch: 'risk' },
  { k: 'roads', label: 'Roads & tracks', swatch: 'line:#F8FAFC' },
  { k: 'firebreak', label: 'Firebreaks', swatch: 'dash:#F8FAFC' },
  { k: 'water', label: 'Water points', swatch: 'dot:#2563EB' },
  { k: 'camp', label: 'Camps', swatch: 'dot:#334155' },
  { k: 'standby_post', label: 'Standby posts', swatch: 'dot:#133C34' },
  { k: 'crews', label: 'Crews (live)', swatch: 'ring:#2563EB' },
  { k: 'detections', label: 'Satellite hotspots', swatch: 'diamond:#C026D3' },
];

function Swatch({ s }: { s: string }) {
  if (s === 'risk')
    return <span class="flex gap-[2px]">{Object.values(RISK).map((r) => <span key={r.c} class="w-1.5 h-4 rounded-[2px]" style={{ background: r.c, boxShadow: 'inset 0 0 0 1px rgba(20,33,29,.35)' }} />)}</span>;
  const [kind, c] = s.split(':');
  if (kind === 'line') return <span class="w-5 h-[4px] rounded-full" style={{ background: c, boxShadow: '0 0 0 1.5px #133C34' }} />;
  if (kind === 'dash') return <span class="w-5 h-[3px]" style={{ backgroundImage: `repeating-linear-gradient(90deg, ${c} 0 4px, transparent 4px 7px)`, boxShadow: '0 0 0 1.5px #133C34' }} />;
  if (kind === 'diamond') return <span class="w-3 h-3 rotate-45 rounded-[2px]" style={{ background: c }} />;
  if (kind === 'ring') return <span class="w-3.5 h-3.5 rounded-full border-[3px] bg-white" style={{ borderColor: c }} />;
  return <span class="w-3.5 h-3.5 rounded-full" style={{ background: c }} />;
}

export function MapScreen() {
  const el = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);
  const s = useStore((x) => ({
    incidents: x.incidents, assets: x.assets, compartments: x.compartments, roads: x.roads, detections: x.detections, hazards: x.hazards,
    perimeters: x.perimeters, mapLayers: x.mapLayers, layers: x.layers, crewPositions: x.crewPositions, crews: x.crews, me: x.me,
    presence: x.presence, readiness: x.readiness, fireDanger: x.fireDanger, basemap: x.basemap, mapFocus: x.mapFocus,
  }));
  const g = useGpsFix();
  const [sel, setSel] = useState<string | null>(null);
  const [selDet, setSelDet] = useState<string | null>(null);
  const [selHaz, setSelHaz] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'closed' | 'list'>('closed');
  const [panel, setPanel] = useState(false);
  const [presenceMenu, setPresenceMenu] = useState(false);
  const [mode, setMode] = useState<Mode>('drive');
  const [measure, setMeasure] = useState<[number, number][] | null>(null);
  const [moving, setMoving] = useState<string | null>(null); // incident whose pin is being moved
  const [moveTo, setMoveTo] = useState<[number, number] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const followed = useRef(false);

  const closeAll = () => { setSel(null); setSelDet(null); setSelHaz(null); setSheet('closed'); setPresenceMenu(false); };

  useEffect(() => {
    const c = new MapController(el.current!);
    ctl.current = c;
    (window as any).__map = c.map; // test/debug hook
    return () => { c.destroy(); ctl.current = null; };
  }, []);
  useEffect(() => { ctl.current?.setBasemap(s.basemap); }, [s.basemap]);
  // stable handlers so the map doesn't redraw fire markers just because this screen re-rendered
  const handlers = useMemo(() => ({
    onIncident: (id: string) => { setSel(id); setSelDet(null); setPanel(false); setPresenceMenu(false); },
    onDetection: (id: string) => { setSelDet(id); setSel(null); setSelHaz(null); setPanel(false); setPresenceMenu(false); },
    onHazard: (id: string) => { setSelHaz(id); setSel(null); setSelDet(null); setPanel(false); setPresenceMenu(false); },
  }), []);
  useEffect(() => {
    // the controller only rebuilds the layer groups whose data changed
    ctl.current?.render(s, { selectedId: sel, ...handlers });
  }, [s.incidents, s.assets, s.compartments, s.roads, s.detections, s.hazards, s.perimeters, s.mapLayers, s.layers, s.crewPositions, s.crews, s.me, sel]);
  useEffect(() => {
    ctl.current?.setMe(g.fix);
    if (g.fix && !followed.current && !s.mapFocus) {
      followed.current = true;
      ctl.current?.map.setView([g.fix.lat, g.fix.lon], Math.max(ctl.current.map.getZoom(), 15));
    }
  }, [g.fix]);
  useEffect(() => {
    const f = s.mapFocus;
    if (f && Date.now() - f.t < 5000) { followed.current = true; ctl.current?.map.setView([f.lat, f.lon], f.zoom); }
  }, [s.mapFocus]);

  // tap on empty map closes sheets/panels; while measuring, taps add points instead
  useEffect(() => {
    const c = ctl.current!;
    const grp = c.extra();
    grp.clearLayers();
    c.setPick(!!moving || measure !== null); // placing points: taps inside compartments count too
    if (moving) {
      // move-pin mode: the next tap chooses the new position (confirmed in the banner)
      c.onClick((lat, lon) => { c.map.closePopup(); setMoveTo([lat, lon]); });
      if (moveTo) L.circleMarker(moveTo, { radius: 10, color: '#fff', weight: 3, fillColor: '#E2483D', fillOpacity: 1 }).addTo(grp);
      return;
    }
    if (measure === null) { c.onClick(() => { closeAll(); setPanel(false); }); return; }
    c.onClick((lat, lon) => { c.map.closePopup(); setMeasure((m) => [...(m ?? []), [lat, lon]]); });
    if (measure.length) {
      L.polyline(measure, { color: '#133C34', weight: 3, dashArray: '6 4' }).addTo(grp);
      measure.forEach((p) => L.circleMarker(p, { radius: 4, color: '#fff', weight: 2, fillColor: '#133C34', fillOpacity: 1 }).addTo(grp));
    }
  }, [measure, moving, moveTo]);
  const measureM = measure ? measure.reduce((t, p, i) => (i ? t + haversineM(measure[i - 1][0], measure[i - 1][1], p[0], p[1]) : 0), 0) : 0;

  const here = g.fix;
  const active = s.incidents.filter((i) => isOpen(i.status) && !i.deleted_at);
  const inc = s.incidents.find((i) => i.id === sel);
  const det = s.detections.find((d) => d.id === selDet);
  const haz = s.hazards.find((h) => h.id === selHaz && !h.resolved_at);

  // routes: me → every open fire (rounded fix so GPS jitter doesn't recompute)
  const fixKey = here ? `${here.lat.toFixed(4)},${here.lon.toFixed(4)}` : '';
  const activeKey = active.map((i) => i.id + i.lat + i.lon).join();
  const routes = useMemo(() => {
    const m = new Map<string, Route>();
    if (!here) return m;
    for (const i of active) m.set(i.id, route(s.roads, s.mapLayers, here, i, mode));
    return m;
  }, [fixKey, activeKey, s.roads, s.mapLayers, mode]);
  const ranked = [...active].sort((a, b) => (routes.get(a.id)?.etaMin ?? 1e9) - (routes.get(b.id)?.etaMin ?? 1e9));
  const target: Incident | undefined = inc && isOpen(inc.status) ? inc : ranked[0];

  // crews heading to a fire, each with its own route (thin, dashed)
  const live = s.crewPositions.filter((p) => p.status !== 'off' && p.id !== s.me?.id && !isStale(p));
  const liveKey = live.map((p) => p.id + p.lat.toFixed(4) + p.lon.toFixed(4) + p.status + p.incident_id).join();
  const crewRoutes = useMemo(() => {
    const out: RouteLine[] = [];
    for (const p of live) {
      if (p.status !== 'en_route' || !p.incident_id) continue;
      const i = active.find((x) => x.id === p.incident_id);
      if (i) out.push({ coords: route(s.roads, s.mapLayers, p, i, 'drive').coords });
    }
    return out;
  }, [liveKey, activeKey, s.roads, s.mapLayers]);

  useEffect(() => {
    // my own route is drawn only for the fire I opened or the one I'm responding to, never just "the nearest fire"
    const respondingTo = s.presence && (s.presence.status === 'en_route' || s.presence.status === 'on_scene') ? s.presence.incident_id : null;
    const showFor = inc && isOpen(inc.status) && !inc.deleted_at ? inc.id : respondingTo && active.some((i) => i.id === respondingTo) ? respondingTo : null;
    const r = showFor ? routes.get(showFor) : undefined;
    ctl.current?.setRoutes([...(s.layers.crews ? crewRoutes : []), ...(r ? [{ coords: r.coords, primary: true }] : [])]);
  }, [routes, inc?.id, inc?.status, s.presence?.status, s.presence?.incident_id, activeKey, crewRoutes, s.layers.crews]);

  // weather at the focused fire (else where I am, else the estate) and the spread threat it implies
  const wxAt = target ?? here ?? CONFIG.center;
  const wx = useWeather(wxAt.lat, wxAt.lon);
  const wind = wx ? { kmh: wx.windKmh, from: wx.windFrom } : null;
  const threatList = useMemo(() => (target ? threats(target, s.compartments, wind) : []), [target?.id, target?.lat, target?.lon, s.compartments, wx?.fetched]);
  useEffect(() => {
    if (!target) { ctl.current?.setSpread(null); return; }
    ctl.current?.setSpread({ fire: target, ellipse: wind && wind.kmh >= 3 ? spreadEllipse(target, wind, 60) : null, windFrom: wind && wind.kmh >= 3 ? wind.from : null, threats: threatList });
  }, [threatList, s.compartments, s.layers.compartments]);

  const crewsFor = (id: string) => live.filter((p) => p.incident_id === id);
  const standbyN = live.filter((p) => p.status === 'standby').length;
  const pr = s.presence;
  const sharing = !!pr && pr.status !== 'off';
  const toggleLayer = (k: string) => {
    const layers = { ...getState().layers, [k]: !getState().layers[k] };
    setState({ layers });
    void metaSet('layers', layers);
  };
  const top = (px: number) => ({ top: `calc(env(safe-area-inset-top, 0px) + ${px}px)` });

  return (
    <div class="h-full flex flex-col">
      <div class="relative flex-1 min-h-0 overflow-hidden">
        <div ref={el} class="absolute inset-0" data-testid="map" />

        {/* Top: one search field (CalmRoutes style) */}
        <div class="absolute left-3 right-3 z-[1000] flex items-center gap-2" style={top(10)}>
          <div class="flex-1 min-w-0 h-[52px] bg-card rounded-pill shadow-capsule flex items-center pl-1.5 pr-2 gap-2">
            <button aria-label="Status and info" data-testid="appbar-info" onClick={() => setState({ overlay: 'info' })} class="press w-10 h-10 rounded-full bg-brand flex items-center justify-center shrink-0"><Flame size={18} class="text-[#F0675C]" fill="#F0675C" /></button>
            <button aria-label="Search" data-testid="appbar-search" onClick={() => setState({ overlay: 'search' })} class="flex-1 min-w-0 flex flex-col items-start text-left leading-tight">
              <span class="text-[15px] font-semibold truncate max-w-full">{CONFIG.appName}</span>
              <span class="text-[12px] text-muted num truncate max-w-full" data-testid="capsule-coords">
                {here ? <>{Math.abs(here.lat).toFixed(4)}° {here.lat >= 0 ? 'N' : 'S'}, {Math.abs(here.lon).toFixed(4)}° {here.lon >= 0 ? 'E' : 'W'} · ±{Math.round(here.acc)} m</> : g.status === 'denied' ? 'GPS blocked' : 'Finding GPS…'}
              </span>
            </button>
            <LiveSyncChip />
            <Search size={19} class="text-muted shrink-0 pointer-events-none" />
          </div>
        </div>
        {/* Conditions and the odd nudge, one quiet row */}
        <div class="absolute left-3 right-[64px] z-[1000] flex flex-col items-start gap-2 pointer-events-none" style={top(72)}>
          <Conditions rows={s.fireDanger} wx={wx} />
          <AlertsNudge />
          <InstallNudge />
          {s.readiness && s.readiness.level !== 'green' && (
            <span data-testid="readiness-banner" class={cx('px-3 py-1.5 rounded-pill text-[12px] font-semibold shadow-capsule', s.readiness.level === 'red' ? 'bg-fire text-on-fire' : 'bg-amber-bg text-amber')}>Readiness {s.readiness.level.toUpperCase()}{s.readiness.note ? ` · ${s.readiness.note}` : ''}</span>
          )}
          {moving && (
            <span class="pointer-events-auto bg-brand text-on-brand rounded-pill shadow-capsule pl-4 pr-1.5 py-1.5 flex items-center gap-2 text-[14px] sheet-enter" data-testid="move-banner">
              <MapPin size={16} />{moveTo ? 'Move the fire here?' : 'Tap where the fire is'}
              {moveTo && <button data-testid="move-confirm" class="press px-3.5 h-9 rounded-pill bg-fire text-on-fire font-semibold" onClick={() => void moveIncident(moving, moveTo[0], moveTo[1]).then(() => { toast('Location corrected'); setMoving(null); setMoveTo(null); }).catch((e) => toast((e as Error).message, 'err'))}>Move</button>}
              <button class="press px-3 h-9 rounded-pill bg-white/15 font-semibold" onClick={() => { setMoving(null); setMoveTo(null); }}>Cancel</button>
            </span>
          )}
          {measure !== null && (
            <span class="pointer-events-auto bg-card rounded-pill shadow-capsule pl-4 pr-1.5 py-1.5 flex items-center gap-2 sheet-enter">
              <Ruler size={15} class="text-muted" /><span class="font-semibold num text-[15px]" data-testid="measure-out">{fmtDistance(measureM)}</span>
              <button aria-label="Clear" class="press w-8 h-8 flex items-center justify-center rounded-full bg-sc" onClick={() => setMeasure([])}><X size={15} /></button>
            </span>
          )}
        </div>

        {/* Right tool rail; the red Report button sits at its foot (App.tsx) */}
        <div class="absolute right-3 z-[1000] flex flex-col gap-2.5" style={top(72)}>
          <RailButton label="Map layers" testid="rail-layers" active={panel} onClick={() => { setPanel((p) => !p); closeAll(); }}><Layers size={20} /></RailButton>
          <RailButton label="My location" testid="rail-locate" tone="text-cobalt" onClick={() => { const f = gps.state.fix; if (f) ctl.current?.map.setView([f.lat, f.lon], Math.max(ctl.current.map.getZoom(), 16)); else toast('Waiting for GPS', 'warn'); }}><LocateFixed size={20} /></RailButton>
          <RailButton label="Reset north / site view" testid="rail-north" onClick={() => { const c = CONFIG.center; ctl.current?.map.setView([c.lat, c.lon], 14); }}><NorthDial /></RailButton>
          <RailButton label="Measure distance" testid="rail-measure" active={measure !== null} onClick={() => setMeasure((m) => (m === null ? [] : null))}><Ruler size={19} /></RailButton>
        </div>

        {deleting && <DeleteSheet id={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); setSel(null); }} />}
        {panel && (
          <div class="absolute right-[64px] z-[1001] w-[256px] bg-card rounded-[24px] shadow-l3 p-3 pop-in origin-top-right" style={top(72)} data-testid="layers-panel">
            <div class="flex gap-1 p-1 bg-sc rounded-pill mb-2">
              {(['satellite', 'street'] as const).map((b) => (
                <button key={b} onClick={() => { setState({ basemap: b }); void metaSet('basemap', b); }} class={cx('press flex-1 h-9 rounded-pill text-[14px] font-medium', s.basemap === b ? 'bg-card text-ink shadow-l1' : 'text-muted')}>{b === 'satellite' ? 'Satellite' : 'Street'}</button>
              ))}
            </div>
            <div>
              {LAYERS.map((l) => (
                <button key={l.k} role="switch" aria-checked={!!s.layers[l.k]} data-testid={'layer-' + l.k} onClick={() => toggleLayer(l.k)} class="w-full flex items-center gap-3 px-2 min-h-[44px] text-left">
                  <span class="w-6 flex items-center justify-center"><Swatch s={l.swatch} /></span>
                  <span class="flex-1 text-[15px]">{l.label}</span>
                  <span class="switch" aria-checked={!!s.layers[l.k]} />
                </button>
              ))}
            </div>
            {s.layers.compartments && (
              <div class="px-2 pt-2 mt-1 border-t border-line flex items-center justify-between gap-1 text-[11px] text-muted">
                {Object.values(RISK).map((r) => <span key={r.label} class="flex items-center gap-1"><span class="w-2 h-2 rounded-full" style={{ background: r.c }} />{r.label.replace('Very high', 'V.high').replace('Moderate', 'Mod.')}</span>)}
              </div>
            )}
          </div>
        )}

        {/* Bottom sheet: one line by default, a card when something is chosen */}
        <div class="absolute inset-x-0 bottom-0 z-[1150]" data-testid="map-sheet">
          {inc ? (
            <IncidentCard inc={inc} r={routes.get(inc.id)} role={s.me?.role} onClose={() => setSel(null)} sharingFor={sharing && pr!.incident_id === inc.id ? pr!.status : null} wx={target?.id === inc.id ? wx : null} threats={target?.id === inc.id ? threatList : []} onMove={() => { setMoving(inc.id); setMoveTo(null); setSel(null); }} onDelete={() => setDeleting(inc.id)} />
          ) : haz ? (
            <Sheet testid="hazard-sheet" class="px-5 pb-5 space-y-4" onDown={() => setSelHaz(null)}>
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="font-display text-[22px] leading-tight">{HAZARD_LABEL[haz.kind] ?? 'Hazard'}</h2>
                  <p class="text-[14px] text-muted mt-1">{haz.note ? `${haz.note} · ` : ''}{ago(haz.created_at)}{here ? ` · ${fmtDistance(haversineM(here.lat, here.lon, haz.lat, haz.lon))} away` : ''}</p>
                </div>
                <button aria-label="Close" class="press w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-muted shrink-0" onClick={() => setSelHaz(null)}><X size={20} /></button>
              </div>
              {(haz.by === s.me?.id || s.me?.role === 'coordinator' || s.me?.role === 'admin')
                ? <Button kind="secondary" size="lg" full testid="hazard-remove" icon={<Trash2 size={18} />} onClick={() => void resolveHazard(haz).then(() => { toast('Hazard removed'); setSelHaz(null); }).catch((e) => toast((e as Error).message, 'err'))}>Remove hazard</Button>
                : <p class="text-[13px] text-muted">Only the person who added it or a coordinator can remove it.</p>}
            </Sheet>
          ) : det ? (
            <Sheet class="px-5 pb-5 space-y-4" onDown={() => setSelDet(null)}>
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <h2 class="font-display text-[22px] leading-tight">Satellite hotspot</h2>
                  <p class="text-[14px] text-muted mt-1">{det.compartment ? (det.distance_m != null && det.distance_m < 1 ? `Inside ${det.compartment}` : `${fmtDistance(det.distance_m ?? 0)} from ${det.compartment}`) : 'Outside the estate'} · {ago(det.acq_time)}{here ? ` · ${fmtDistance(haversineM(here.lat, here.lon, det.lat, det.lon))} away` : ''}</p>
                </div>
                <button aria-label="Close" class="press w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-muted shrink-0" onClick={() => setSelDet(null)}><X size={20} /></button>
              </div>
              <div class="flex items-center gap-2"><SatChip text={`${det.confidence} confidence`} /><span class="text-[13px] text-muted">±375 m</span></div>
              <Button kind="danger" size="lg" full icon={<Satellite size={18} />} onClick={() => go('report?det=' + det.id)}>Report as fire</Button>
            </Sheet>
          ) : sheet === 'list' && active.length ? (
            <Sheet testid="incident-list" class="pb-4" onDown={() => setSheet('closed')} onHandle={() => setSheet('closed')}>
              <button class="w-full flex items-center justify-between px-5 pt-1 pb-3" onClick={() => setSheet('closed')}>
                <span class="font-display text-[22px]" data-testid="active-count">{active.length} active fire{active.length > 1 ? 's' : ''}</span>
                <ChevronDown size={22} class="text-muted" />
              </button>
              <div class="max-h-[40vh] overflow-y-auto px-2">
                {ranked.map((i) => {
                  const r = routes.get(i.id);
                  const n = crewsFor(i.id).length;
                  return (
                    <button key={i.id} class="press w-full flex items-center gap-3 px-3 py-3 rounded-2xl text-left active:bg-surface-low" onClick={() => { setSel(i.id); setSheet('closed'); ctl.current?.map.panTo([i.lat, i.lon]); }}>
                      <span class="w-10 h-10 rounded-full flex items-center justify-center shrink-0 bg-fire-bg text-fire"><Flame size={18} fill="currentColor" /></span>
                      <span class="flex-1 min-w-0">
                        <span class="block text-[16px] font-semibold truncate">{i.compartment ?? i.block ?? 'Unmapped area'}</span>
                        <span class="block text-[13px] text-muted truncate">{i.status === 'reported' ? 'Unverified' : 'Active'} · {ago(i.reported_at)}{n ? ` · ${n} crew` : ''}</span>
                      </span>
                      {r && <span class="text-right shrink-0"><span class="block text-[16px] font-semibold num">{fmtEta(r.etaMin)}</span><span class="block text-[12px] text-muted num">{fmtDistance(r.distM)}</span></span>}
                    </button>
                  );
                })}
              </div>
              <div class="px-5 pt-2"><Button kind="tonal" full onClick={() => go('incidents')}>See all fires</Button></div>
            </Sheet>
          ) : (
            <Sheet testid="peek" class="px-4 pb-3" swipeAll
              onUp={() => { if (active.length) { setSheet('list'); setPresenceMenu(false); } else setPresenceMenu(true); }}
              onDown={() => setPresenceMenu(false)}
              onHandle={() => { if (active.length) { setSheet('list'); setPresenceMenu(false); } else setPresenceMenu((v) => !v); }}>
              {presenceMenu && (
                <div class="px-1 pb-3 space-y-3 fade-in" data-testid="presence-menu">
                  <div class="text-[14px] text-muted">{sharing
                    ? `Sharing your location${pr!.status === 'standby' ? ' as standby' : ''} since ${new Date(pr!.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                    : 'Let the control room see you while on standby.'}</div>
                  {sharing
                    ? <Button kind="secondary" full testid="checkout" onClick={() => { void (pr!.status === 'standby' ? setPresence('off') : stopResponding()); setPresenceMenu(false); toast(pr!.status === 'standby' ? 'Checked out' : 'Stopped responding'); }}>{pr!.status === 'standby' ? 'Check out' : 'Stop responding'}</Button>
                    : <Button kind="primary" full testid="checkin" icon={<Radio size={17} />} onClick={() => { void setPresence('standby'); setPresenceMenu(false); toast(here ? 'Checked in · sharing your location' : 'Checked in · shared once GPS has a fix'); }}>Check in for standby</Button>}
                </div>
              )}
              <div class="flex items-center gap-3">
                {active.length ? (
                  <button data-testid="active-pill" onClick={() => { setSheet('list'); setPresenceMenu(false); }} class="press flex-1 min-w-0 flex items-center gap-3 text-left">
                    <span class="w-11 h-11 rounded-full bg-fire text-on-fire flex items-center justify-center shrink-0 pulse"><Flame size={20} fill="currentColor" /></span>
                    <span class="min-w-0">
                      <span class="block text-[16px] font-semibold truncate" data-testid="active-count">{active.length} active</span>
                      {target && routes.get(target.id) && <span class="block text-[13px] text-muted num truncate">Nearest {fmtEta(routes.get(target.id)!.etaMin)} · {target.compartment ?? target.block ?? 'unmapped'}</span>}
                    </span>
                  </button>
                ) : (
                  <span class="flex-1 min-w-0 flex items-center gap-3">
                    <span class="w-11 h-11 rounded-full bg-moss text-on-moss flex items-center justify-center shrink-0"><ShieldCheck size={20} /></span>
                    <span class="min-w-0"><span class="block text-[16px] font-semibold" data-testid="active-count">No active incidents</span><span class="block text-[13px] text-muted">All quiet on the estate</span></span>
                  </span>
                )}
                <button data-testid="presence-pill" onClick={() => (pr && (pr.status === 'en_route' || pr.status === 'on_scene') && pr.incident_id ? go('navigate/incident/' + pr.incident_id) : setPresenceMenu((v) => !v))} class={cx('press h-11 px-4 rounded-pill flex items-center gap-2 text-[14px] font-semibold whitespace-nowrap shrink-0', sharing ? 'bg-cobalt text-white' : 'bg-sc text-ink')}>
                  {sharing
                    ? <><span class="w-2 h-2 rounded-full bg-white animate-pulse" />{pr!.status === 'standby' ? 'Standby' : pr!.status === 'en_route' ? 'En route' : 'On scene'}</>
                    : <><Radio size={16} />Check in</>}
                  {standbyN > 0 && <span class={cx('font-medium flex items-center gap-0.5', sharing ? 'text-white/75' : 'text-muted')}><Users size={14} />{standbyN}</span>}
                </button>
              </div>
            </Sheet>
          )}
        </div>
      </div>
    </div>
  );
}

function IncidentCard({ inc, r, onClose, sharingFor, wx, threats: th, role, onMove, onDelete }: { inc: Incident; r?: Route; onClose: () => void; sharingFor: string | null; wx: Weather | null; threats: Threat[]; role?: string; onMove: () => void; onDelete: () => void }) {
  const open = isOpen(inc.status);
  const [menu, setMenu] = useState(false);
  const inside = !inc.compartment ? th.find((t) => t.level === 'burning') : null;
  const near = !inc.compartment && !inside ? th.find((t) => t.level !== 'burning') : null;
  const title = inc.compartment ?? inside?.code ?? (near && near.distM < 2000 ? `Near ${near.code}` : inc.block ?? 'Unmapped area');
  const canMove = role === 'responder' || role === 'coordinator' || role === 'admin';
  const canDelete = role === 'coordinator' || role === 'admin';
  return (
    <Sheet testid="incident-sheet" class="px-5 pb-5 max-h-[66vh] overflow-y-auto" onDown={onClose}>
      <div class="flex items-start gap-2">
        <div class="flex-1 min-w-0">
          <h2 class="font-display text-[24px] leading-tight truncate">{title}</h2>
          <div class="flex items-center gap-2 mt-1.5"><StatusChip s={inc.status} short /><span class="text-[13px] text-muted truncate">{inc.code ?? inc.label} · {ago(inc.reported_at)}</span></div>
        </div>
        {(canMove || canDelete) && (
          <div class="relative shrink-0">
            <button aria-label="More actions" data-testid="incident-menu" class="press w-10 h-10 rounded-full flex items-center justify-center text-muted" onClick={() => setMenu((v) => !v)}><MoreHorizontal size={20} /></button>
            {menu && (
              <div class="absolute right-0 top-11 z-10 w-52 bg-card rounded-2xl shadow-l3 border border-line overflow-hidden text-[15px] pop-in origin-top-right">
                {canMove && <button data-testid="move-pin" class="w-full text-left px-4 py-3 flex items-center gap-3 active:bg-surface-low" onClick={() => { setMenu(false); onMove(); }}><MapPin size={18} class="text-muted" />Move pin</button>}
                {canDelete && <button data-testid="delete-incident" class="w-full text-left px-4 py-3 flex items-center gap-3 text-fire-dark active:bg-surface-low border-t border-line" onClick={() => { setMenu(false); onDelete(); }}><Trash2 size={18} />Delete report</button>}
              </div>
            )}
          </div>
        )}
        <button aria-label="Close" class="press w-10 h-10 -mr-2 rounded-full flex items-center justify-center text-muted shrink-0" onClick={onClose}><X size={20} /></button>
      </div>

      {r && (
        <div class="flex items-end gap-6 mt-4">
          <div><div class="text-[30px] font-semibold num leading-none tracking-[-.02em]">{fmtEta(r.etaMin)}</div><div class="text-[13px] text-muted mt-1">to reach</div></div>
          <div><div class="text-[20px] font-semibold num leading-none">{fmtDistance(r.distM)}</div><div class="text-[13px] text-muted mt-1">{r.viaTracks ? 'by track' : 'straight line'}</div></div>
        </div>
      )}

      <div class="mt-4"><CoordLine lat={inc.lat} lon={inc.lon} /></div>

      <div class="flex items-center gap-2 mt-4">
        {open && (sharingFor
          ? <Button kind="primary" size="lg" class="flex-1" icon={<Navigation size={18} />} testid="navigate" onClick={() => go('navigate/incident/' + inc.id)}>Navigate</Button>
          : <Button kind="primary" size="lg" class="flex-1" icon={<Navigation size={18} />} testid="respond" onClick={() => void setPresence('en_route', inc.id).then(() => { toast('Responding · control can see you'); go('navigate/incident/' + inc.id); })}>Respond</Button>)}
        <button aria-label="Fire details" class={cx('press h-[54px] rounded-pill border border-line text-ink flex items-center justify-center shrink-0 gap-2 text-[15px] font-semibold', open ? 'w-[54px]' : 'flex-1')} onClick={() => go('incident/' + inc.id)}><ClipboardList size={19} />{!open && 'Details'}</button>
      </div>
      {open && sharingFor && <div class="text-[13px] text-cobalt mt-2 flex items-center justify-between">You're responding · location shared <button class="font-semibold text-muted" onClick={() => void stopResponding().then(() => toast('Stopped responding'))}>Stop</button></div>}

      {open && <div class="mt-4"><SpreadPanel wx={wx} th={th} /></div>}
    </Sheet>
  );
}

/** Fire position in one tap-to-copy line (decimal degrees), UTM underneath for radio read-out. */
function CoordLine({ lat, lon }: { lat: number; lon: number }) {
  const u = toUtm30(lat, lon);
  const g3 = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (
    <button data-testid="card-coords" aria-label="Copy coordinates" class="press w-full text-left rounded-2xl bg-surface-low px-4 py-3 flex items-center gap-3"
      onClick={() => { void navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)} | UTM 30N ${g3(u.e)} E ${g3(u.n)} N`); toast('Coordinates copied'); }}>
      <span class="flex-1 min-w-0">
        <span class="block text-[17px] font-semibold num whitespace-nowrap tracking-[-.01em]">{Math.abs(lat).toFixed(5)}° {lat >= 0 ? 'N' : 'S'}  {Math.abs(lon).toFixed(5)}° {lon >= 0 ? 'E' : 'W'}</span>
        <span class="block text-[13px] text-muted num whitespace-nowrap">UTM 30N {g3(u.e)} E {g3(u.n)} N</span>
      </span>
      <Copy size={17} class="text-muted shrink-0" />
    </button>
  );
}


const HAZARD_LABEL: Record<string, string> = { road_blocked: 'Road blocked', tree_down: 'Tree down', bridge: 'Bridge unsafe', other: 'Hazard' };

export const DANGER_LABEL: Record<string, string> = { low: 'Low', moderate: 'Moderate', high: 'High', very_high: 'Very high', extreme: 'Extreme' };
export const DANGER_STYLE: Record<string, string> = {
  low: 'bg-moss text-on-moss', moderate: 'bg-amber-bg text-amber', high: 'bg-[#E9822F] text-white', very_high: 'bg-fire text-on-fire', extreme: 'bg-[#8E2219] text-white',
};
const DANGER_ACTION: Record<string, string> = {
  low: 'Normal patrols.',
  moderate: 'Standby crews at posts; watch for smoke.',
  high: 'All standby posts manned; no burning; water bowsers full.',
  very_high: 'Full standby; extra patrols in young bamboo; no burning anywhere.',
  extreme: 'Maximum readiness: all crews on standby, vehicles fuelled, community warned.',
};


/** One-tap prompt to turn on push alerts on this phone (hidden once on, in demo, or unsupported). */
function AlertsNudge() {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void pushState().then(setSt).catch(() => setSt('unsupported')); }, []);
  if (st !== 'off' && st !== 'blocked') return null;
  return (
    <button data-testid="alerts-nudge" disabled={busy} class="press pointer-events-auto h-9 px-3.5 rounded-pill text-[13px] font-medium bg-card text-ink shadow-capsule flex items-center gap-2 fade-in"
      onClick={async () => {
        if (st === 'blocked') { toast('Notifications are blocked: allow them for this site in the browser settings.', 'warn'); return; }
        setBusy(true);
        try { const r = await enablePush(); setSt(r); toast(r === 'on' ? 'Fire alerts are on for this phone.' : 'Alerts not turned on.', r === 'on' ? 'ok' : 'warn'); }
        catch (e) { toast((e as Error).message, 'err'); }
        setBusy(false);
      }}>
      <BellRing size={15} class="text-fire" />{st === 'blocked' ? 'Alerts blocked' : 'Turn on fire alerts'}
    </button>
  );
}

/** Sync pill with its own store subscription, so sync ticks don't re-render the whole map screen. */
function LiveSyncChip() {
  const sync = useStore((x) => x.sync);
  return <SyncChip s={sync} onClick={() => go('sync')} />;
}

/** Suggest installing the app (full screen, no browser bar). Hidden once installed or dismissed. */
function InstallNudge() {
  const mode = useInstall();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('epb-install-dismissed') === '1'; } catch { return false; } });
  if (!mode || hidden) return null;
  const dismiss = () => { setHidden(true); try { localStorage.setItem('epb-install-dismissed', '1'); } catch { /* ignore */ } };
  return (
    <span class="pointer-events-auto flex items-center h-9 rounded-pill bg-card text-ink shadow-capsule text-[13px] font-medium fade-in" data-testid="install-nudge">
      <button class="press pl-3.5 pr-1.5 h-full flex items-center gap-2" onClick={async () => {
        if (mode === 'prompt') { if (await promptInstall()) toast('Installed. Open EmberWatch from your home screen.'); }
        else toast('On iPhone: tap Share, then "Add to Home Screen".', 'warn');
      }}><Download size={15} class="text-muted" />Install app</button>
      <button aria-label="Dismiss" class="pr-3 pl-1 h-full text-muted" onClick={dismiss}><X size={15} /></button>
    </span>
  );
}

/** One chip for conditions: today's fire danger + current wind and temperature. Tap for details. */
function Conditions({ rows, wx }: { rows: FireDanger[]; wx: Weather | null }) {
  const [open, setOpen] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const d = rows.find((r) => r.id === today) ?? rows.find((r) => r.id === yest);
  if (!d && !wx) return null;
  const age = wx ? wxAge(wx) : 0;
  return (
    <div class="pointer-events-auto flex flex-col items-start gap-1.5">
      <button data-testid="conditions" onClick={() => setOpen((v) => !v)} class="press h-9 rounded-pill shadow-capsule flex items-stretch overflow-hidden text-[13px] font-semibold num bg-card">
        {d && <span data-testid="danger-pill" class={cx('pl-2.5 pr-3 flex items-center gap-1.5', DANGER_STYLE[d.level])}><Flame size={13} fill="currentColor" />{DANGER_LABEL[d.level].toUpperCase()}</span>}
        {wx && <span data-testid="wx-chip" class="px-3 flex items-center gap-1.5"><WindArrow from={wx.windFrom} size={15} />{compass8(wx.windFrom)} {Math.round(wx.windKmh)} km/h<span class="text-muted font-medium">· {Math.round(wx.tempC)}°</span>{age > 60 && <span class="text-amber font-medium">· old</span>}</span>}
      </button>
      {open && (
        <div class="bg-card rounded-[22px] shadow-l3 p-4 w-[284px] text-[13px] space-y-2 pop-in origin-top-left" data-testid="danger-detail">
          {d && <div class="font-display text-[19px] leading-snug">{DANGER_LABEL[d.level]} fire danger{d.id !== today ? ' (yesterday)' : ''}</div>}
          {d && <div class="text-[14px]">{DANGER_ACTION[d.level]}</div>}
          {wx && <div class="text-muted num">Now: wind {compass8(wx.windFrom)} {Math.round(wx.windKmh)} km/h{wx.gustKmh != null ? `, gusts ${Math.round(wx.gustKmh)}` : ''} · {Math.round(wx.tempC)}°C · humidity <span class={wx.rh < 30 ? 'text-fire-dark font-semibold' : ''}>{Math.round(wx.rh)}%</span>{age > 60 ? ` · reading ${age >= 120 ? `${Math.round(age / 60)} h` : `${age} min`} old` : ''}</div>}
          {d && <div class="text-muted num">Today max {d.temp_max_c != null ? Math.round(d.temp_max_c) : '—'}°C, min humidity {d.rh_min_pct ?? '—'}%, wind up to {d.wind_max_kmh ?? '—'} km/h{d.days_since_rain != null ? ` · ${d.days_since_rain === 0 ? 'rain yesterday' : `no rain for ${d.days_since_rain >= 14 ? '14+' : d.days_since_rain} days`}` : ''}</div>}

        </div>
      )}
    </div>
  );
}

/** Confirm deleting a fire report, with a reason (kept in the fire's timeline). */
export function DeleteSheet({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const REASONS = ['Duplicate report', 'Wrong location', 'Not a fire', 'Test'];
  return (
    <div class="absolute inset-0 z-[1500] bg-black/30 flex items-end fade-in" onClick={onClose}>
      <div class="w-full bg-card rounded-t-sheet px-5 pt-2 pb-6 pb-safe space-y-4 sheet-enter" onClick={(e) => e.stopPropagation()} data-testid="delete-sheet">
        <div class="w-9 h-1 bg-schh rounded-full mx-auto" />
        <div>
          <h2 class="font-display text-[22px]">Delete this report?</h2>
          <p class="text-[14px] text-muted mt-1">It's removed from maps and lists. Kept for audit with your reason.</p>
        </div>
        <div class="flex flex-wrap gap-2">{REASONS.map((r) => <Choice key={r} selected={reason === r} onClick={() => setReason(r)}>{r}</Choice>)}</div>
        <input class="w-full h-12 rounded-2xl border border-line bg-surface-low px-4 text-[15px] outline-none focus:border-brand" placeholder="Or type a reason" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
        <div class="grid grid-cols-2 gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="danger" testid="delete-confirm" disabled={busy || !reason.trim()} icon={<Trash2 size={17} />} onClick={() => { setBusy(true); void deleteIncident(id, reason).then(() => { toast('Fire report deleted'); onDone(); }).catch((e) => { toast((e as Error).message, 'err'); setBusy(false); }); }}>Delete</Button>
        </div>
      </div>
    </div>
  );
}
