import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { BellRing, ChevronDown, Download, ClipboardList, Flame, Layers, LocateFixed, MapPin, MoreHorizontal, Navigation, Radio, Ruler, Satellite, Search, Trash2, Users, X } from 'lucide-preact';
import L from 'leaflet';
import { getState, setState, toast, useStore } from '../core/store';
import { gps } from '../core/gps';
import { CONFIG } from '../config';
import { MapController, RISK, type RouteLine } from './mapview';
import { Button, CoordReadout, NorthDial, RailButton, SatChip, StatusChip, SyncChip, cx } from './kit';
import { cardinal, fmtDistance, haversineM, toUtm30 } from '../core/geo';
import { deleteIncident, moveIncident } from '../core/actions';
import { ago } from '../core/time';
import { go, useGpsFix } from './hooks';
import { isOpen } from '../core/flow';
import { metaSet } from '../core/db';
import { fmtEta, route, type Mode, type Route } from '../core/route';
import { isStale, setPresence, stopResponding } from '../core/presence';
import type { Incident } from '../core/types';
import { compass8, useWeather, wxAge, type Weather } from '../core/weather';
import { spreadEllipse, threats, THREAT_LABEL, type Threat } from '../core/spread';
import { enablePush, pushState, type PushState } from '../core/push';
import { promptInstall, useInstall } from '../core/install';
import type { FireDanger } from '../core/types';

/** The few layers people actually switch. Hazards are always shown; everything else stays in the data. */
const LAYERS: { k: string; label: string; swatch: string }[] = [
  { k: 'compartments', label: 'Compartments', swatch: 'risk' },
  { k: 'roads', label: 'Roads & tracks', swatch: 'line:#F8FAFC' },
  { k: 'firebreak', label: 'Firebreaks', swatch: 'dash:#F8FAFC' },
  { k: 'water', label: 'Water points', swatch: 'dot:#0284C7' },
  { k: 'camp', label: 'Camps', swatch: 'dot:#334155' },
  { k: 'standby_post', label: 'Standby posts', swatch: 'dot:#0F172A' },
  { k: 'crews', label: 'Crews (live)', swatch: 'ring:#0284C7' },
  { k: 'detections', label: 'Satellite hotspots', swatch: 'diamond:#C026D3' },
];

function Swatch({ s }: { s: string }) {
  if (s === 'risk')
    return <span class="flex gap-[2px]">{Object.values(RISK).map((r) => <span key={r.c} class="w-1.5 h-4 rounded-[2px]" style={{ background: r.c, boxShadow: 'inset 0 0 0 1px rgba(15,23,42,.35)' }} />)}</span>;
  const [kind, c] = s.split(':');
  if (kind === 'line') return <span class="w-5 h-[4px] rounded-full" style={{ background: c, boxShadow: '0 0 0 1.5px #0F172A' }} />;
  if (kind === 'dash') return <span class="w-5 h-[3px]" style={{ backgroundImage: `repeating-linear-gradient(90deg, ${c} 0 4px, transparent 4px 7px)`, boxShadow: '0 0 0 1.5px #0F172A' }} />;
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
  const [sheet, setSheet] = useState<'closed' | 'list'>('closed');
  const [panel, setPanel] = useState(false);
  const [presenceMenu, setPresenceMenu] = useState(false);
  const [mode, setMode] = useState<Mode>('drive');
  const [measure, setMeasure] = useState<[number, number][] | null>(null);
  const [moving, setMoving] = useState<string | null>(null); // incident whose pin is being moved
  const [moveTo, setMoveTo] = useState<[number, number] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const followed = useRef(false);

  const closeAll = () => { setSel(null); setSelDet(null); setSheet('closed'); setPresenceMenu(false); };

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
    onDetection: (id: string) => { setSelDet(id); setSel(null); setPanel(false); setPresenceMenu(false); },
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
    if (moving) {
      // move-pin mode: the next tap chooses the new position (confirmed in the banner)
      c.onClick((lat, lon) => { c.map.closePopup(); setMoveTo([lat, lon]); });
      if (moveTo) L.circleMarker(moveTo, { radius: 10, color: '#fff', weight: 3, fillColor: '#EF4444', fillOpacity: 1 }).addTo(grp);
      return;
    }
    if (measure === null) { c.onClick(() => { closeAll(); setPanel(false); }); return; }
    c.onClick((lat, lon) => { c.map.closePopup(); setMeasure((m) => [...(m ?? []), [lat, lon]]); });
    if (measure.length) {
      L.polyline(measure, { color: '#0F172A', weight: 3, dashArray: '6 4' }).addTo(grp);
      measure.forEach((p) => L.circleMarker(p, { radius: 4, color: '#fff', weight: 2, fillColor: '#0F172A', fillOpacity: 1 }).addTo(grp));
    }
  }, [measure, moving, moveTo]);
  const measureM = measure ? measure.reduce((t, p, i) => (i ? t + haversineM(measure[i - 1][0], measure[i - 1][1], p[0], p[1]) : 0), 0) : 0;

  const here = g.fix;
  const active = s.incidents.filter((i) => isOpen(i.status) && !i.deleted_at);
  const inc = s.incidents.find((i) => i.id === sel);
  const det = s.detections.find((d) => d.id === selDet);

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
    const r = target ? routes.get(target.id) : undefined;
    ctl.current?.setRoutes([...(s.layers.crews ? crewRoutes : []), ...(r ? [{ coords: r.coords, primary: true }] : [])]);
  }, [routes, target?.id, crewRoutes, s.layers.crews]);

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
      <div class="relative flex-1 min-h-0">
        <div ref={el} class="absolute inset-0" data-testid="map" />

        {/* Top capsule: place, position, search, sync */}
        <div class="absolute left-3 right-[68px] z-[1000] flex items-center gap-2 bg-card/90 backdrop-blur-xl pl-2 pr-1.5 py-1.5 rounded-2xl shadow-capsule" style={top(12)}>
          <button aria-label="Status and info" data-testid="appbar-info" onClick={() => setState({ overlay: 'info' })} class="w-8 h-8 rounded-[9px] bg-[#0F172A] flex items-center justify-center shrink-0"><Flame size={17} class="text-[#EF4444]" fill="#EF4444" /></button>
          <div class="flex flex-col min-w-0 flex-1">
            <span class="text-[14px] font-semibold tracking-[-.01em] leading-tight truncate">Bandai Hills</span>
            <span class="text-[11px] text-muted num truncate" data-testid="capsule-coords">
              {here ? <>{Math.abs(here.lat).toFixed(4)}° {here.lat >= 0 ? 'N' : 'S'}, {Math.abs(here.lon).toFixed(4)}° {here.lon >= 0 ? 'E' : 'W'} · ±{Math.round(here.acc)} m</> : g.status === 'denied' ? 'GPS blocked' : 'GPS acquiring…'}
            </span>
          </div>
          <LiveSyncChip />
          <button aria-label="Search" data-testid="appbar-search" onClick={() => setState({ overlay: 'search' })} class="w-8 h-8 rounded-full flex items-center justify-center text-muted"><Search size={18} /></button>
        </div>
        {/* status pills */}
        <div class="absolute left-3 z-[1000] flex flex-col items-start gap-1.5 pointer-events-none" style={top(72)}>
          <Conditions rows={s.fireDanger} wx={wx} />
          <AlertsNudge />
          <InstallNudge />
          {s.readiness && s.readiness.level !== 'green' && (
            <span data-testid="readiness-banner" class={cx('px-2.5 py-1 rounded-pill text-[11px] font-semibold shadow-sm', s.readiness.level === 'red' ? 'bg-fire-bg text-on-fire-bg' : 'bg-amber-bg text-amber')}>Readiness {s.readiness.level.toUpperCase()}{s.readiness.note ? ` · ${s.readiness.note}` : ''}</span>
          )}
          {s.compartments.some((c) => c.code.startsWith('DEMO')) && <span class="px-2.5 py-1 rounded-pill text-[10px] font-semibold bg-card/90 text-muted shadow-sm">Demo data</span>}
          {moving && (
            <span class="pointer-events-auto bg-[#0F172A] text-white rounded-2xl shadow-capsule px-3 py-2 flex items-center gap-2 text-[13px]" data-testid="move-banner">
              <MapPin size={15} />{moveTo ? 'Move the fire here?' : 'Tap the map where the fire is'}
              {moveTo && <button data-testid="move-confirm" class="ml-1 px-2.5 py-1 rounded-lg bg-[#EF4444] font-semibold" onClick={() => void moveIncident(moving, moveTo[0], moveTo[1]).then(() => { toast('Location corrected'); setMoving(null); setMoveTo(null); }).catch((e) => toast((e as Error).message, 'err'))}>Move</button>}
              <button class="px-2 py-1 rounded-lg bg-white/15 font-semibold" onClick={() => { setMoving(null); setMoveTo(null); }}>Cancel</button>
            </span>
          )}
          {measure !== null && (
            <span class="pointer-events-auto bg-card rounded-pill shadow-capsule pl-3 pr-1.5 py-1 flex items-center gap-2">
              <Ruler size={14} /><span class="font-semibold num text-[13px]" data-testid="measure-out">{fmtDistance(measureM)}</span>
              <span class="text-[11px] text-muted">tap the map</span>
              <button aria-label="Clear" class="w-7 h-7 flex items-center justify-center rounded-full bg-sc" onClick={() => setMeasure([])}><X size={14} /></button>
            </span>
          )}
        </div>

        {/* Right tool rail */}
        <div class="absolute right-3 z-[1000] flex flex-col gap-2.5" style={top(12)}>
          <RailButton label="Map layers" testid="rail-layers" active={panel} onClick={() => { setPanel((p) => !p); closeAll(); }}><Layers size={20} /></RailButton>
          <RailButton label="My location" testid="rail-locate" tone="text-cobalt" onClick={() => { const f = gps.state.fix; if (f) ctl.current?.map.setView([f.lat, f.lon], Math.max(ctl.current.map.getZoom(), 16)); else toast('Waiting for GPS', 'warn'); }}><LocateFixed size={20} /></RailButton>
          <RailButton label="Reset north / site view" testid="rail-north" onClick={() => { const c = CONFIG.center; ctl.current?.map.setView([c.lat, c.lon], 14); }}><NorthDial /></RailButton>
          <RailButton label="Measure distance" testid="rail-measure" tone="text-muted" active={measure !== null} onClick={() => setMeasure((m) => (m === null ? [] : null))}><Ruler size={19} /></RailButton>
        </div>

        {deleting && <DeleteSheet id={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); setSel(null); }} />}
        {panel && (
          <div class="absolute right-[64px] z-[1001] w-[252px] bg-card/95 backdrop-blur-xl rounded-2xl shadow-sheet p-2 sheet-enter" style={top(12)} data-testid="layers-panel">
            <div class="flex items-center justify-between px-2 pt-1 pb-2">
              <span class="text-[15px] font-semibold tracking-[-.01em]">Map</span>
              <button aria-label="Close layers" class="w-7 h-7 rounded-full bg-sc flex items-center justify-center text-muted" onClick={() => setPanel(false)}><X size={15} /></button>
            </div>
            <div class="flex gap-1 mx-1 mb-2 p-0.5 bg-sc rounded-[10px]">
              {(['satellite', 'street'] as const).map((b) => (
                <button key={b} onClick={() => { setState({ basemap: b }); void metaSet('basemap', b); }} class={cx('flex-1 py-1.5 rounded-[8px] text-[13px] font-semibold transition', s.basemap === b ? 'bg-card text-ink shadow-sm' : 'text-muted')}>{b === 'satellite' ? 'Satellite' : 'Street'}</button>
              ))}
            </div>
            <div class="rounded-xl bg-surface-low divide-y divide-line">
              {LAYERS.map((l) => (
                <button key={l.k} role="switch" aria-checked={!!s.layers[l.k]} data-testid={'layer-' + l.k} onClick={() => toggleLayer(l.k)} class="w-full flex items-center gap-2.5 px-3 py-2 text-left">
                  <span class="w-7 flex items-center justify-center"><Swatch s={l.swatch} /></span>
                  <span class="flex-1 text-[14px]">{l.label}</span>
                  <span class="switch" aria-checked={!!s.layers[l.k]} />
                </button>
              ))}
            </div>
            {s.layers.compartments && (
              <div class="px-2 pt-2 pb-1 flex items-center justify-between gap-1 text-[10px] text-muted">
                {Object.values(RISK).map((r) => <span key={r.label} class="flex items-center gap-1"><span class="w-2 h-2 rounded-[2px]" style={{ background: r.c, boxShadow: 'inset 0 0 0 1px rgba(15,23,42,.35)' }} />{r.label.replace('Very high', 'V.high').replace('Moderate', 'Mod.')}</span>)}
              </div>
            )}
          </div>
        )}

        {/* Bottom: compact pills by default; a card only when something is selected */}
        <div class="absolute left-3 right-[72px] bottom-3 z-[1000] flex flex-col gap-2 items-start" data-testid="map-sheet">
          {inc ? (
            <IncidentCard inc={inc} r={routes.get(inc.id)} role={s.me?.role} onClose={() => setSel(null)} sharingFor={sharing && pr!.incident_id === inc.id ? pr!.status : null} wx={target?.id === inc.id ? wx : null} threats={target?.id === inc.id ? threatList : []} onMove={() => { setMoving(inc.id); setMoveTo(null); setSel(null); }} onDelete={() => setDeleting(inc.id)} />
          ) : det ? (
            <div class="w-full bg-card/95 backdrop-blur-xl rounded-2xl shadow-sheet p-4 flex flex-col gap-3 sheet-enter">
              <div class="flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5 flex-wrap"><span class="text-[16px] font-semibold">Satellite hotspot</span><SatChip text="Unverified" /></div>
                  <p class="text-[12px] text-muted mt-0.5">{det.compartment ? (det.distance_m != null && det.distance_m < 1 ? `Inside ${det.compartment} · ` : `${fmtDistance(det.distance_m ?? 0)} from ${det.compartment} · `) : ''}{det.source.replace('_NRT', '')} · {det.confidence} confidence · {ago(det.acq_time)}{here ? ` · ${fmtDistance(haversineM(here.lat, here.lon, det.lat, det.lon))} away` : ''}</p>
                </div>
                <button aria-label="Close" class="w-8 h-8 rounded-full bg-sc flex items-center justify-center text-muted shrink-0" onClick={() => setSelDet(null)}><X size={16} /></button>
              </div>
              <p class="text-[12px] text-muted">Pixel location is approximate (±375 m). Check it before calling crews.</p>
              <Button kind="danger" class="!min-h-[44px]" full icon={<Satellite size={18} />} onClick={() => go('report?det=' + det.id)}>Report as fire</Button>
            </div>
          ) : sheet === 'list' && active.length ? (
            <div class="w-full bg-card/95 backdrop-blur-xl rounded-2xl shadow-sheet sheet-enter overflow-hidden" data-testid="incident-list">
              <button class="w-full flex items-center justify-between px-4 pt-3 pb-2" onClick={() => setSheet('closed')}>
                <span class="text-[15px] font-semibold" data-testid="active-count">{active.length} active incident{active.length > 1 ? 's' : ''}</span>
                <ChevronDown size={18} class="text-muted" />
              </button>
              <div class="max-h-[38vh] overflow-y-auto divide-y divide-line">
                {ranked.map((i) => {
                  const r = routes.get(i.id);
                  const n = crewsFor(i.id).length;
                  return (
                    <button key={i.id} class="w-full flex items-center gap-3 px-4 py-2.5 text-left" onClick={() => { setSel(i.id); setSheet('closed'); ctl.current?.map.panTo([i.lat, i.lon]); }}>
                      <span class={cx('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', 'bg-fire-bg text-fire')}><Flame size={18} /></span>
                      <span class="flex-1 min-w-0">
                        <span class="block text-[14px] font-semibold truncate">{i.compartment ?? i.block ?? 'Unmapped area'} · {i.code ?? i.label}</span>
                        <span class="block text-[12px] text-muted truncate">{i.status === 'reported' ? 'Unverified' : 'Active'} · {ago(i.reported_at)}{n ? ` · ${n} crew live` : ''}</span>
                      </span>
                      {r && <span class="text-right shrink-0"><span class="block text-[14px] font-semibold num text-cobalt">{fmtEta(r.etaMin)}</span><span class="block text-[11px] text-muted num">{fmtDistance(r.distM)}</span></span>}
                    </button>
                  );
                })}
              </div>
              <div class="p-3 pt-2"><Button kind="secondary" class="!min-h-[40px]" full onClick={() => go('incidents')}>All incidents</Button></div>
            </div>
          ) : (
            <>
              {presenceMenu && (
                <div class="bg-card/95 backdrop-blur-xl rounded-2xl shadow-sheet p-3 w-[264px] max-w-full sheet-enter space-y-2.5" data-testid="presence-menu">
                  <div class="text-[13px] text-muted leading-snug">{sharing
                    ? `Sharing your location${pr!.status === 'standby' ? ' as standby' : ''} since ${new Date(pr!.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It is sent whenever you have network.`
                    : 'Check in to show the control room where you are while on standby.'}</div>
                  {sharing
                    ? <Button kind="secondary" full class="!min-h-[44px]" testid="checkout" onClick={() => { void (pr!.status === 'standby' ? setPresence('off') : stopResponding()); setPresenceMenu(false); toast(pr!.status === 'standby' ? 'Checked out. Location no longer shared.' : 'Stopped responding.'); }}>{pr!.status === 'standby' ? 'Check out' : 'Stop responding'}</Button>
                    : <Button kind="primary" full class="!min-h-[44px]" testid="checkin" icon={<Radio size={17} />} onClick={() => { void setPresence('standby'); setPresenceMenu(false); toast(here ? 'Checked in. Sharing your location.' : 'Checked in. Location is shared once GPS has a fix.'); }}>Check in for standby</Button>}
                </div>
              )}
              <div class="flex items-center gap-2 max-w-full">
                {active.length ? (
                  <button data-testid="active-pill" onClick={() => { setSheet('list'); setPresenceMenu(false); }} class="h-11 pl-1.5 pr-3.5 rounded-pill bg-[#0F172A] text-white shadow-sheet flex items-center gap-2 min-w-0 active:scale-[.98] transition">
                    <span class="w-8 h-8 rounded-full bg-[#EF4444] flex items-center justify-center shrink-0 pulse"><Flame size={16} /></span>
                    <span class="text-[13px] font-semibold whitespace-nowrap" data-testid="active-count">{active.length} active</span>
                    {target && routes.get(target.id) && <span class="text-[12px] text-white/70 num whitespace-nowrap truncate">{fmtEta(routes.get(target.id)!.etaMin)}</span>}
                  </button>
                ) : (
                  <span class="h-11 px-3.5 rounded-pill bg-card/95 backdrop-blur-xl shadow-capsule flex items-center gap-2 text-[13px] font-semibold whitespace-nowrap">
                    <span class="w-2 h-2 rounded-full bg-ok" /><span data-testid="active-count">No active incidents</span>
                  </span>
                )}
                <button data-testid="presence-pill" onClick={() => (pr && (pr.status === 'en_route' || pr.status === 'on_scene') && pr.incident_id ? go('navigate/incident/' + pr.incident_id) : setPresenceMenu((v) => !v))} class={cx('h-11 px-3.5 rounded-pill shadow-capsule flex items-center gap-2 text-[13px] font-semibold whitespace-nowrap active:scale-[.98] transition', sharing ? 'bg-cobalt text-white' : 'bg-card/95 backdrop-blur-xl text-ink')}>
                  {sharing
                    ? <><span class="w-2 h-2 rounded-full bg-white animate-pulse" />{pr!.status === 'standby' ? 'Standby' : pr!.status === 'en_route' ? 'En route' : 'On scene'}</>
                    : <><Radio size={16} />Check in</>}
                  {standbyN > 0 && <span class={cx('font-medium flex items-center gap-0.5', sharing ? 'text-white/75' : 'text-muted')}><Users size={13} />{standbyN}</span>}
                </button>
              </div>
            </>
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
    <div class="w-full max-h-[60vh] overflow-y-auto bg-card/95 backdrop-blur-xl rounded-2xl shadow-sheet p-4 flex flex-col gap-3 sheet-enter" data-testid="incident-sheet">
      <div class="flex items-start gap-2">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-[18px] font-semibold tracking-[-.01em] leading-tight truncate">{title}</span>
            <StatusChip s={inc.status} short />
          </div>
          <p class="text-[12px] text-muted mt-0.5 truncate">{inc.code ?? inc.label} · {ago(inc.reported_at)}</p>
        </div>
        {(canMove || canDelete) && (
          <div class="relative shrink-0">
            <button aria-label="More actions" data-testid="incident-menu" class="w-8 h-8 rounded-full bg-sc flex items-center justify-center text-muted" onClick={() => setMenu((v) => !v)}><MoreHorizontal size={16} /></button>
            {menu && (
              <div class="absolute right-0 top-9 z-10 w-48 bg-card rounded-xl shadow-sheet border border-line overflow-hidden text-[14px]">
                {canMove && <button data-testid="move-pin" class="w-full text-left px-3 py-2.5 flex items-center gap-2 active:bg-surface-low" onClick={() => { setMenu(false); onMove(); }}><MapPin size={16} />Move pin</button>}
                {canDelete && <button data-testid="delete-incident" class="w-full text-left px-3 py-2.5 flex items-center gap-2 text-fire-dark active:bg-surface-low border-t border-line" onClick={() => { setMenu(false); onDelete(); }}><Trash2 size={16} />Delete report</button>}
              </div>
            )}
          </div>
        )}
        <button aria-label="Close" class="w-8 h-8 rounded-full bg-sc flex items-center justify-center text-muted shrink-0" onClick={onClose}><X size={16} /></button>
      </div>

      <CoordLine lat={inc.lat} lon={inc.lon} />

      <div class="flex items-center gap-2">
        {open && (sharingFor
          ? <Button kind="primary" class="flex-1 !min-h-[48px]" icon={<Navigation size={17} />} testid="navigate" onClick={() => go('navigate/incident/' + inc.id)}>Navigate{r ? ` · ${fmtEta(r.etaMin)}` : ''}</Button>
          : <Button kind="primary" class="flex-1 !min-h-[48px]" icon={<Navigation size={17} />} testid="respond" onClick={() => void setPresence('en_route', inc.id).then(() => { toast('Responding: control can see your location.'); go('navigate/incident/' + inc.id); })}>Respond{r ? ` · ${fmtEta(r.etaMin)}` : ''}</Button>)}
        <button aria-label="Fire details" class={cx('h-12 rounded-xl bg-sc text-ink flex items-center justify-center shrink-0 gap-1.5 text-[14px] font-semibold', open ? 'w-12' : 'flex-1')} onClick={() => go('incident/' + inc.id)}><ClipboardList size={18} />{!open && 'Details'}</button>
      </div>
      {open && sharingFor && <div class="text-[12px] text-cobalt -mt-1 flex items-center justify-between">You are responding · location shared <button class="font-semibold text-muted" onClick={() => void stopResponding().then(() => toast('Stopped responding.'))}>Stop</button></div>}

      {open && <SpreadPanel wx={wx} th={th} />}
    </div>
  );
}

/** Fire position in one tap-to-copy line (decimal degrees), UTM underneath for radio read-out. */
function CoordLine({ lat, lon }: { lat: number; lon: number }) {
  const u = toUtm30(lat, lon);
  const g3 = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (
    <button data-testid="card-coords" aria-label="Copy coordinates" class="w-full text-left rounded-xl bg-[#0F172A] text-white px-3.5 py-2 active:opacity-90"
      onClick={() => { void navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)} | UTM 30N ${g3(u.e)} E ${g3(u.n)} N`); toast('Coordinates copied'); }}>
      <div class="font-mono text-[18px] font-semibold num whitespace-nowrap">{Math.abs(lat).toFixed(5)}° {lat >= 0 ? 'N' : 'S'}  {Math.abs(lon).toFixed(5)}° {lon >= 0 ? 'E' : 'W'}</div>
      <div class="font-mono text-[13px] text-white/70 num whitespace-nowrap">UTM 30N {g3(u.e)} E {g3(u.n)} N</div>
    </button>
  );
}

const WindArrow = ({ from, size = 16 }: { from: number; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${(from + 180) % 360}deg)` }} aria-label={`Wind from ${Math.round(from)}°`}>
    <path d="M12 21V5" stroke="#0284C7" stroke-width="2.6" stroke-linecap="round" />
    <path d="M6 10l6-7 6 7" fill="none" stroke="#0284C7" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

const LEVEL_STYLE: Record<string, string> = { burning: 'bg-[#DC2626] text-white', very_high: 'bg-fire-bg text-on-fire-bg', high: 'bg-fire-bg text-on-fire-bg', moderate: 'bg-amber-bg text-amber', low: 'bg-sc text-muted' };
const fmtMin = (m: number) => (m < 1 ? 'now' : m < 60 ? `~${Math.round(m)} min` : m < 600 ? `~${(m / 60).toFixed(1)} h` : '>10 h');

/** Which compartments the fire could reach first if the wind holds. One summary line; tap for the list. */
function SpreadPanel({ wx, th }: { wx: Weather | null; th: Threat[] }) {
  const [openList, setOpenList] = useState(false);
  const list = th.filter((t) => t.level !== 'low');
  if (!list.length) return null;
  const first = list.find((t) => t.level !== 'burning') ?? list[0];
  return (
    <div class="rounded-xl bg-surface-low" data-testid="spread-panel">
      <button class="w-full flex items-center gap-2 px-3 py-2.5 text-left" onClick={() => setOpenList((v) => !v)} data-testid="spread-summary">
        <span class={cx('px-1.5 py-0.5 rounded-md text-[10px] font-semibold shrink-0', LEVEL_STYLE[first.level])}>{THREAT_LABEL[first.level]}</span>
        <span class="flex-1 min-w-0 text-[13px] truncate">
          <b>{first.code}</b>{first.young ? ' (young)' : ''} {first.level === 'burning' ? 'is burning' : `in ${fmtMin(first.etaMin!)}`}
          {list.length > 1 && <span class="text-muted"> · +{list.length - 1} more</span>}
        </span>
        {wx && <span class="flex items-center gap-0.5 text-[11px] text-muted num shrink-0"><WindArrow from={wx.windFrom} size={12} />{Math.round(wx.windKmh)}</span>}
        <ChevronDown size={16} class={cx('text-muted shrink-0 transition-transform', openList && 'rotate-180')} />
      </button>
      {openList && (
        <div class="px-3 pb-2.5 divide-y divide-line">
          {list.map((t) => (
            <div key={t.id} class="py-1.5 flex items-center gap-2" data-testid="threat-row">
              <span class="text-[14px] font-semibold min-w-[48px] whitespace-nowrap shrink-0">{t.code}</span>
              <span class="flex-1 min-w-0 text-[12px] text-muted truncate">{t.level === 'burning' ? 'fire inside' : `${fmtDistanceShort(t.distM)} ${cardinal(t.bearing)}${t.downwind ? ' · downwind' : ''}`}{t.yop != null ? ` · ${t.young ? 'young' : 'bamboo'} ${t.yop}` : ''}</span>
              <span class="text-[13px] font-semibold num shrink-0">{t.level === 'burning' ? 'Now' : fmtMin(t.etaMin!)}</span>
            </div>
          ))}
          <div class="pt-1.5 text-[10px] text-faint leading-snug">If the current wind{wx ? ` (${compass8(wx.windFrom)} ${Math.round(wx.windKmh)} km/h)` : ''} holds. Rough guide; confirm on the ground.</div>
        </div>
      )}
    </div>
  );
}
const fmtDistanceShort = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

export const DANGER_LABEL: Record<string, string> = { low: 'Low', moderate: 'Moderate', high: 'High', very_high: 'Very high', extreme: 'Extreme' };
export const DANGER_STYLE: Record<string, string> = {
  low: 'bg-card/90 text-ink', moderate: 'bg-[#FEF3C7] text-[#92400E]', high: 'bg-[#EA580C] text-white', very_high: 'bg-[#DC2626] text-white', extreme: 'bg-[#7F1D1D] text-white',
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
    <button data-testid="alerts-nudge" disabled={busy} class="pointer-events-auto px-2.5 py-1.5 rounded-pill text-[12px] font-semibold bg-[#0F172A] text-white shadow-capsule flex items-center gap-1.5"
      onClick={async () => {
        if (st === 'blocked') { toast('Notifications are blocked: allow them for this site in the browser settings.', 'warn'); return; }
        setBusy(true);
        try { const r = await enablePush(); setSt(r); toast(r === 'on' ? 'Fire alerts are on for this phone.' : 'Alerts not turned on.', r === 'on' ? 'ok' : 'warn'); }
        catch (e) { toast((e as Error).message, 'err'); }
        setBusy(false);
      }}>
      <BellRing size={13} />{st === 'blocked' ? 'Alerts blocked' : 'Turn on fire alerts'}
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
    <span class="pointer-events-auto flex items-center rounded-pill bg-[#0F172A] text-white shadow-capsule text-[12px] font-semibold" data-testid="install-nudge">
      <button class="pl-2.5 pr-1.5 py-1.5 flex items-center gap-1.5" onClick={async () => {
        if (mode === 'prompt') { if (await promptInstall()) toast('Installed. Open EPB Fire from your home screen.'); }
        else toast('On iPhone: tap Share, then "Add to Home Screen".', 'warn');
      }}><Download size={13} />Install app (full screen)</button>
      <button aria-label="Dismiss" class="pr-2 pl-1 py-1.5 opacity-70" onClick={dismiss}><X size={13} /></button>
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
      <button data-testid="conditions" onClick={() => setOpen((v) => !v)} class="rounded-pill shadow-capsule flex items-stretch overflow-hidden text-[12px] font-semibold num bg-card/90 backdrop-blur-xl">
        {d && <span data-testid="danger-pill" class={cx('px-2.5 py-1.5 flex items-center gap-1', DANGER_STYLE[d.level])}><Flame size={12} fill="currentColor" />{DANGER_LABEL[d.level].toUpperCase()}</span>}
        {wx && <span data-testid="wx-chip" class="px-2.5 py-1.5 flex items-center gap-1.5"><WindArrow from={wx.windFrom} size={14} />{compass8(wx.windFrom)} {Math.round(wx.windKmh)} km/h<span class="text-muted font-medium">· {Math.round(wx.tempC)}°C</span>{age > 60 && <span class="text-amber font-medium">· old</span>}</span>}
      </button>
      {open && (
        <div class="bg-card/95 backdrop-blur-xl rounded-2xl shadow-sheet p-3 w-[272px] text-[12px] space-y-1.5 sheet-enter" data-testid="danger-detail">
          {d && <div class="text-[13px] font-semibold">Fire danger {DANGER_LABEL[d.level].toLowerCase()}{d.id !== today ? ' (yesterday)' : ''}: {DANGER_ACTION[d.level]}</div>}
          {wx && <div class="text-muted num">Now: wind {compass8(wx.windFrom)} {Math.round(wx.windKmh)} km/h{wx.gustKmh != null ? `, gusts ${Math.round(wx.gustKmh)}` : ''} · {Math.round(wx.tempC)}°C · humidity <span class={wx.rh < 30 ? 'text-fire-dark font-semibold' : ''}>{Math.round(wx.rh)}%</span>{age > 60 ? ` · reading ${age >= 120 ? `${Math.round(age / 60)} h` : `${age} min`} old` : ''}</div>}
          {d && <div class="text-muted num">Today: max {d.temp_max_c != null ? Math.round(d.temp_max_c) : '—'}°C, min humidity {d.rh_min_pct ?? '—'}%, wind up to {d.wind_max_kmh ?? '—'} km/h{d.days_since_rain != null ? ` · ${d.days_since_rain === 0 ? 'rain yesterday' : `no rain for ${d.days_since_rain >= 14 ? '14+' : d.days_since_rain} days`}` : ''}</div>}
          {d && <div class="text-[10px] text-faint leading-snug">Rating from the afternoon forecast and days since rain. {d.basis}</div>}
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
    <div class="absolute inset-0 z-[1500] bg-black/40 flex items-end" onClick={onClose}>
      <div class="w-full bg-card rounded-t-3xl p-4 pb-6 space-y-3 sheet-enter" onClick={(e) => e.stopPropagation()} data-testid="delete-sheet">
        <div class="text-[17px] font-semibold">Delete this fire report?</div>
        <p class="text-[13px] text-muted">It disappears from every map and list. The record is kept for audit with your reason. If it was a real fire that turned out false, use “False alarm” in the fire details instead.</p>
        <div class="flex flex-wrap gap-2">{REASONS.map((r) => <button key={r} onClick={() => setReason(r)} class={cx('px-3 h-9 rounded-pill text-[13px] font-semibold', reason === r ? 'bg-brand text-on-brand' : 'bg-sc')}>{r}</button>)}</div>
        <input class="w-full h-11 rounded-xl bg-surface-low px-3 text-[15px] outline-none focus:ring-2 focus:ring-brand" placeholder="Or type a reason" value={reason} onInput={(e) => setReason((e.target as HTMLInputElement).value)} />
        <div class="grid grid-cols-2 gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="danger" testid="delete-confirm" disabled={busy || !reason.trim()} icon={<Trash2 size={17} />} onClick={() => { setBusy(true); void deleteIncident(id, reason).then(() => { toast('Fire report deleted'); onDone(); }).catch((e) => { toast((e as Error).message, 'err'); setBusy(false); }); }}>Delete</Button>
        </div>
      </div>
    </div>
  );
}
