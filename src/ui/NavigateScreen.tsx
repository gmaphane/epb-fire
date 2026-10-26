import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import L from 'leaflet';
import { ChevronRight, Compass, Maximize2, Minimize2, Droplets, Layers, LocateFixed, NotebookText, RadioTower, Satellite, TriangleAlert, Footprints, Truck } from 'lucide-preact';
import { assignmentAction, addNote, reportHazard } from '../core/actions';
import { getState, setState, toast, useStore } from '../core/store';
import { CONFIG } from '../config';
import { bearingDeg, cardinal, fmtDd, fmtDistance, haversineM } from '../core/geo';
import { isOpen } from '../core/flow';
import { quality, keepAwake } from '../core/gps';
import { AppBar, Banner, Button, cx } from './kit';
import { go, useCompass, useGps } from './hooks';
import { MapController } from './mapview';
import { metaSet } from '../core/db';
import { route } from '../core/route';
import { setPresence } from '../core/presence';

const startDist = new Map<string, number>(); // distance when navigation to a target began (progress bar); reset on each visit

export function NavigateScreen({ kind, id }: { kind?: string; id?: string }) {
  const s = useStore((x) => x);
  const g = useGps();
  const compass = useCompass();
  const [mode, setMode] = useState<'walk' | 'drive'>('drive');
  const [hz, setHz] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);
  // full-screen map (details collapsed); remembered on this phone
  const [full, setFull] = useState(() => { try { return localStorage.getItem('epb-nav-full') === '1'; } catch { return false; } });
  const setFullPref = (v: boolean) => { setFull(v); try { localStorage.setItem('epb-nav-full', v ? '1' : '0'); } catch { /* private mode */ } };
  useEffect(() => { const c = ctl.current; if (!c) return; setTimeout(() => { c.map.invalidateSize(); fitBoth(); }, 60); }, [full]);
  useEffect(() => { startDist.clear(); }, []);

  const open = s.incidents.filter((i) => isOpen(i.status) && !i.deleted_at);
  const myAssign = s.assignments.find((a) => a.state !== 'released' && s.me && (a.user_id === s.me.id || (a.crew_id && a.crew_id === s.me.crew_id)));
  let target: { key: string; lat: number; lon: number; name: string; note: string; incidentId?: string; priority?: boolean } | null = null;
  if (kind === 'water') {
    const a = s.assets.find((x) => x.id === id);
    if (a) target = { key: a.id, lat: a.lat, lon: a.lon, name: a.name, note: String(a.props?.capacity ?? 'Water point') };
  } else {
    const inc = (kind === 'incident' && s.incidents.find((i) => i.id === id)) || (myAssign && s.incidents.find((i) => i.id === myAssign.incident_id)) || open[0];
    if (inc) target = { key: inc.id, lat: inc.lat, lon: inc.lon, name: `${inc.compartment ?? inc.block ?? 'Unmapped area'} fire (#${inc.code ?? inc.label})`, note: inc.notes || `Reported by ${inc.reported_by_name} ${inc.location_estimated ? '(location estimated)' : ''}`, incidentId: inc.id, priority: inc.status !== 'reported' };
  }
  const f = g.fix;
  const straight = f && target ? haversineM(f.lat, f.lon, target.lat, target.lon) : NaN;
  // best route over passable tracks + firebreaks (offline); falls back to the straight line
  const fixKey = f ? `${f.lat.toFixed(4)},${f.lon.toFixed(4)}` : '';
  const r = useMemo(() => (f && target ? route(s.roads, s.mapLayers, f, target, mode) : null), [fixKey, target?.key, mode, s.roads, s.mapLayers]);
  const dist = r ? r.distM : straight;
  const brg = f && target ? bearingDeg(f.lat, f.lon, target.lat, target.lon) : NaN;
  const moving = f?.speed != null && f.speed > 1 && f.heading != null && !Number.isNaN(f.heading);
  const heading = moving ? f!.heading! : compass;
  const speedKmh = f?.speed != null && f.speed > 0.8 ? f.speed * 3.6 : mode === 'walk' ? CONFIG.walkSpeedKmh : CONFIG.driveSpeedKmh;
  const moveEta = f?.speed != null && f.speed > 0.8 && isFinite(dist) ? (dist / 1000 / speedKmh) * 60 : null;
  const etaMin = r ? Math.max(1, Math.round(moveEta ?? r.etaMin)) : isFinite(dist) ? Math.max(1, Math.round((dist / 1000 / speedKmh) * 60)) : NaN;
  const q = quality(f);
  const assign = target && myAssign && myAssign.incident_id === target.incidentId ? myAssign : null;
  const water = f ? s.assets.filter((a) => a.kind === 'water').map((a) => ({ a, d: haversineM(f.lat, f.lon, a.lat, a.lon), b: bearingDeg(f.lat, f.lon, a.lat, a.lon) })).sort((x, y) => x.d - y.d) : [];
  if (target && isFinite(dist) && !startDist.has(target.key)) startDist.set(target.key, Math.max(dist, 1));
  const progress = target && isFinite(dist) ? Math.min(1, Math.max(0, 1 - dist / (startDist.get(target.key) ?? dist))) : 0;

  // mini map
  useEffect(() => {
    if (!el.current) return;
    const c = new MapController(el.current, target ?? CONFIG.center, 15);
    c.map.zoomControl?.remove();
    ctl.current = c;
    c.setBasemap(getState().basemap);
    void keepAwake(true);
    return () => { c.destroy(); ctl.current = null; void keepAwake(false); };
  }, [!!target]);
  useEffect(() => {
    const c = ctl.current; if (!c || !target) return;
    c.render(getState(), {});
    c.setMe(f);
    const grp = c.extra(); grp.clearLayers();
    c.setRoutes(r ? [{ coords: r.coords, primary: true }] : []);
    if (kind === 'water') L.marker([target.lat, target.lon], { interactive: false, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div style="transform:translate(-50%,-16px);display:flex;flex-direction:column;align-items:center"><span class="pulse" style="width:32px;height:32px;border-radius:9999px;background:${kind === 'water' ? '#0284C7' : '#EF4444'};display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.25)"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${kind === 'water' ? '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>' : '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'}</svg></span><span style="margin-top:4px;background:rgb(var(--c-card));padding:2px 8px;border-radius:9999px;box-shadow:0 2px 8px rgba(0,0,0,.15);font:600 10px inherit;white-space:nowrap;color:rgb(var(--c-ink))">● Target</span></div>` }) }).addTo(grp);
  }, [f?.lat, f?.lon, target?.key, s.incidents, s.assets, r]);
  const fitBoth = () => { if (ctl.current && target) ctl.current.fit(r ? r.coords : f ? [[f.lat, f.lon], [target.lat, target.lon]] : [[target.lat, target.lon]], 40); };
  useEffect(() => { setTimeout(fitBoth, 50); }, [target?.key, !!f]);

  if (!target) {
    return (
      <div class="h-full flex flex-col bg-surface"><AppBar title="Navigate" />
        <main class="flex-1 p-4"><div class="bg-card rounded-xl shadow-md p-8 text-center text-muted font-semibold">No active incident to navigate to.<br />Choose one from Incidents or the Map.</div></main>
      </div>
    );
  }

  return (
    <div class="h-full flex flex-col bg-surface">
      <AppBar title="Navigate" />
      <main class="flex-1 overflow-y-auto pb-24">
        {/* telemetry capsule */}
        <div class="px-4 pt-3 pb-2">
          <div class="bg-card shadow-md rounded-pill px-4 py-2 flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <div class="w-7 h-7 rounded-full bg-sc flex items-center justify-center shrink-0"><Compass size={18} class="text-cobalt" style={{ transform: `rotate(${heading ?? 0}deg)`, transition: 'transform .3s' }} /></div>
              <div class="flex flex-col min-w-0">
                <div class="flex items-center gap-1 truncate text-[12px] font-semibold num">
                  <span>Heading {heading != null ? `${String(Math.round(heading)).padStart(3, '0')}° ${cardinal(heading)}` : '—'}</span>
                  <span class="text-muted">•</span>
                  <span class="text-cobalt" data-testid="nav-bearing">Bearing {isFinite(brg) ? `${String(Math.round(brg)).padStart(3, '0')}° ${cardinal(brg)}` : '—'}</span>
                </div>
                <span class="text-[10px] font-semibold text-muted truncate">{f ? `GPS precision ±${Math.round(f.acc)} m • ${q === 'good' ? 'High accuracy' : q === 'fair' ? 'Fair' : 'Poor — check direction'}` : g.status === 'denied' ? 'Location blocked' : 'Acquiring GPS…'}</span>
              </div>
            </div>
            <div class={cx('flex items-center gap-1.5 shrink-0 px-2 py-0.5 rounded-pill', assign?.state === 'en_route' || moving ? 'bg-cobalt-bg text-cobalt' : 'bg-sc text-muted')}>
              <span class={cx('w-2 h-2 rounded-full', assign?.state === 'en_route' || moving ? 'bg-cobalt animate-pulse' : 'bg-outline')} />
              <span class="text-[10px] font-bold">{assign?.state === 'on_scene' ? 'ON SCENE' : assign?.state === 'en_route' || moving ? 'ON ROUTE' : 'READY'}</span>
            </div>
          </div>
        </div>

        {/* map: inline, or full screen with a slim summary bar (details collapsed) */}
        <div class="px-4 mb-3">
          <div class={full ? 'fixed inset-x-0 top-0 z-[1300] bg-sch' : 'relative w-full h-72 rounded-xl overflow-hidden bg-sch shadow-sm'} style={full ? { bottom: 'calc(env(safe-area-inset-bottom, 0px) + 64px)' } : undefined} data-testid="nav-map-wrap">
            <div ref={el} class="absolute inset-0" data-testid="nav-map" />
            {full && (
              <div class="absolute inset-x-3 bottom-3 z-[1000] bg-card/95 backdrop-blur-xl rounded-2xl shadow-sheet px-4 py-3 flex items-center gap-3" data-testid="nav-summary">
                <div class="flex-1 min-w-0 grid grid-cols-3 gap-2 text-center">
                  <div><div class="text-[20px] font-bold num leading-tight">{isFinite(dist) ? (dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`) : '—'}</div><div class="text-[10px] text-muted uppercase tracking-wide">{r?.viaTracks ? 'by road' : 'distance'}</div></div>
                  <div><div class="text-[20px] font-bold num leading-tight text-cobalt">{isFinite(etaMin) ? `${etaMin} min` : '—'}</div><div class="text-[10px] text-muted uppercase tracking-wide">arrival</div></div>
                  <div><div class="text-[20px] font-bold num leading-tight">{isFinite(brg) ? `${Math.round(brg)}° ${cardinal(brg)}` : '—'}</div><div class="text-[10px] text-muted uppercase tracking-wide">bearing</div></div>
                </div>
                <button aria-label="Show details" data-testid="nav-collapse" onClick={() => setFullPref(false)} class="w-11 h-11 rounded-full bg-sc flex items-center justify-center shrink-0"><Minimize2 size={19} /></button>
              </div>
            )}
            <div class={cx('absolute right-2 z-[1000] flex flex-col gap-1', full ? 'top-3' : 'bottom-2')}>
              <button aria-label={full ? 'Show details' : 'Full-screen map'} data-testid="nav-expand" onClick={() => setFullPref(!full)} class="w-10 h-10 rounded-full bg-card shadow-md flex items-center justify-center text-ink">{full ? <Minimize2 size={19} /> : <Maximize2 size={19} />}</button>
              <button aria-label="Fit me and target" onClick={fitBoth} class="w-10 h-10 rounded-full bg-card shadow-md flex items-center justify-center text-cobalt"><LocateFixed size={20} /></button>
              <button aria-label="Switch basemap" onClick={() => { const b = getState().basemap === 'satellite' ? 'street' : 'satellite'; setState({ basemap: b }); void metaSet('basemap', b); ctl.current?.setBasemap(b); }} class="w-10 h-10 rounded-full bg-card shadow-md flex items-center justify-center text-ink"><Layers size={20} /></button>
            </div>
            <div class="absolute left-2 top-2 z-[1000] bg-card/90 backdrop-blur-sm px-2 py-1 rounded-lg shadow-sm flex items-center gap-1">
              <span class="text-[10px] font-semibold text-muted font-mono">WGS84 • {f ? fmtDd(f.lat, f.lon) : '—'}</span>
            </div>
          </div>
        </div>

        <div class="px-4 flex flex-col gap-3">
          {g.status === 'denied' && <Banner tone="err">Location is blocked — allow it in browser settings.</Banner>}
          {/* metrics trio */}
          <div class="bg-card rounded-xl shadow-lg p-4 flex flex-col gap-3">
            <div class="grid grid-cols-3 gap-2 text-center">
              <div class="flex flex-col items-center">
                <span class="text-[10px] uppercase tracking-[.06em] font-semibold text-muted">Distance</span>
                <span class="text-[32px] font-bold leading-none mt-1 num tracking-tight" data-testid="nav-distance">{isFinite(dist) ? (dist < 1000 ? Math.round(dist) : (dist / 1000).toFixed(dist < 10_000 ? 2 : 1)) : '—'}</span>
                <span class="text-[12px] font-semibold text-muted mt-0.5">{isFinite(dist) && dist < 1000 ? 'm' : 'km'} {r?.viaTracks ? 'by track' : 'remaining'}</span>
              </div>
              <div class="flex flex-col items-center bg-surface-low/70 py-1 rounded-lg">
                <span class="text-[10px] uppercase tracking-[.06em] font-semibold text-muted">Est. Arrival</span>
                <span class="text-[32px] font-bold leading-none mt-1 num text-cobalt">{isFinite(etaMin) ? etaMin : '—'}</span>
                <span class="text-[12px] font-semibold text-muted mt-0.5">min{moveEta != null ? ` @ ${Math.round(speedKmh)} km/h` : r?.viaTracks ? ' via tracks' : ' on foot'}</span>
              </div>
              <div class="flex flex-col items-center">
                <span class="text-[10px] uppercase tracking-[.06em] font-semibold text-muted">Bearing</span>
                <span class="text-[32px] font-bold leading-none mt-1 num tracking-tight">{isFinite(brg) ? `${Math.round(brg)}°` : '—'}</span>
                <span class="text-[12px] font-semibold text-outline mt-0.5">{isFinite(brg) ? cardinal(brg) : ''} straight line</span>
              </div>
            </div>
            <div class="w-full bg-sc rounded-full h-2 overflow-hidden flex">
              <div class="bg-brand h-full transition-all duration-500" style={{ width: `${progress * 100}%` }} />
              <div class="bg-cobalt/30 h-full transition-all duration-500" style={{ width: `${Math.min(20, (1 - progress) * 100)}%` }} />
            </div>
            {r?.viaTracks && <div class="text-[12px] text-muted num" data-testid="nav-legs">{mode === 'drive' ? 'Drive' : 'Walk'} {fmtDistance(r.onTrackM)} on {mode === 'drive' ? 'roads' : 'roads and firebreaks'}{r.offRoadM > 40 ? `, then walk ${fmtDistance(r.offRoadM)} off-road (dashed on the map)` : ''}.</div>}
            <div class="flex items-center justify-between text-[11px] font-semibold text-muted">
              <div class="flex gap-1.5">
                {(['walk', 'drive'] as const).map((m) => (
                  <button key={m} onClick={() => setMode(m)} class={cx('inline-flex items-center gap-1 px-2 py-0.5 rounded-pill', mode === m ? 'bg-brand text-on-brand' : 'bg-surface-low')}>{m === 'walk' ? <Footprints size={12} /> : <Truck size={12} />}{m === 'walk' ? 'On foot' : 'Vehicle'}</button>
                ))}
              </div>
              <span class="text-ink">{Math.round(progress * 100)}% of the way</span>
            </div>
          </div>

          {/* target card */}
          <div class="bg-card rounded-xl shadow-md p-3 flex flex-col gap-2">
            <div class="flex items-start justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <div class={cx('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', kind === 'water' ? 'bg-sc text-[#0284c7]' : 'bg-fire-bg text-on-fire-bg')}>{kind === 'water' ? <Droplets size={22} /> : <TriangleAlert size={22} />}</div>
                <div class="flex flex-col min-w-0">
                  <h2 class="text-[16px] font-semibold leading-6 truncate">{target.name}</h2>
                  <span class="text-[12px] text-muted num">Coordinates: {fmtDd(target.lat, target.lon)}</span>
                </div>
              </div>
              {target.priority && <span class="px-2 py-1 bg-sc rounded-pill text-[10px] font-semibold text-muted shrink-0">Priority 1</span>}
            </div>
            <div class="bg-surface-low rounded-lg p-2 flex items-start gap-1.5">
              <NotebookText size={18} class="text-brand-deep shrink-0 mt-0.5" />
              <p class="text-[14px]"><span class="font-semibold text-brand-deep">Field note:</span> {target.note}</p>
            </div>
            {target.incidentId && <button class="text-left text-[12px] font-semibold text-brand-deep flex items-center gap-1" onClick={() => go('incident/' + target!.incidentId)}>Open incident <ChevronRight size={14} /></button>}
          </div>

          {/* nearest water (replaces the mockup's wind card: no weather feed offline) */}
          {water[0] && kind !== 'water' && (
            <button onClick={() => go('navigate/water/' + water[0].a.id)} class="bg-cobalt-bg rounded-xl p-3 flex items-center justify-between gap-2 shadow-sm text-left">
              <div class="flex items-center gap-2 min-w-0">
                <div class="w-8 h-8 rounded-full bg-cobalt flex items-center justify-center text-white shrink-0"><Droplets size={18} /></div>
                <div class="flex flex-col min-w-0">
                  <span class="text-[12px] font-semibold text-cobalt truncate">Nearest water: {water[0].a.name} • {fmtDistance(water[0].d)} {cardinal(water[0].b)}</span>
                  <span class="text-[12px] text-muted truncate">{String(water[0].a.props?.capacity ?? '')}{water[1] ? ` · next: ${water[1].a.name} ${fmtDistance(water[1].d)}` : ''}</span>
                </div>
              </div>
              <ChevronRight size={20} class="text-cobalt shrink-0" />
            </button>
          )}

          {assign && (
            <div class="grid grid-cols-2 gap-2">
              {assign.state === 'dispatched' && <Button kind="primary" class="col-span-2" onClick={() => void assignmentAction(assign, 'ack')}>Acknowledge call-out</Button>}
              <Button kind="secondary" onClick={() => void assignmentAction(assign, 'en_route')} disabled={assign.state === 'en_route' || assign.state === 'on_scene'}>En route</Button>
              <Button kind="secondary" onClick={() => void assignmentAction(assign, 'on_scene')} disabled={assign.state === 'on_scene'}>On scene</Button>
            </div>
          )}

          <div class="flex flex-col gap-2 pt-1">
            {target.incidentId && (
              <button data-testid="send-position" class="w-full bg-brand text-on-brand py-3.5 px-4 rounded-xl text-[14px] font-semibold flex items-center justify-center gap-2 shadow-md active:scale-[.99]" onClick={async () => { await addNote(target!.incidentId!, 'Position update'); if (s.presence?.status !== 'en_route' && s.presence?.status !== 'on_scene') await setPresence('en_route', target!.incidentId!); toast('Sharing your live location. It sends whenever there is signal.'); }}>
                <RadioTower size={20} />{s.presence && s.presence.status !== 'off' && s.presence.incident_id === target.incidentId ? 'Sharing live location · send update' : 'Share live location with team'}
              </button>
            )}
            <button class="w-full bg-card text-ink py-3 px-4 rounded-xl text-[14px] font-semibold flex items-center justify-center gap-2 shadow-sm active:scale-[.99]" onClick={() => setHz((v) => !v)}>
              <TriangleAlert size={20} class="text-fire" />Report road obstruction or hazard
            </button>
            {hz && (
              <div class="grid grid-cols-2 gap-2">
                {([['road_blocked', 'Road blocked'], ['tree_down', 'Tree down'], ['bridge', 'Bridge unsafe'], ['other', 'Other hazard']] as const).map(([k, l]) => (
                  <Button key={k} kind="secondary" onClick={async () => { try { await reportHazard(k, ''); toast('Hazard saved at your position'); setHz(false); } catch (e) { toast((e as Error).message, 'err'); } }}>{l}</Button>
                ))}
              </div>
            )}
          </div>

          <div class="flex items-center justify-center gap-3 py-1 text-[11px] font-semibold text-muted flex-wrap">
            <span class="flex items-center gap-1"><span class={cx('w-2 h-2 rounded-full', s.sync?.reachable ? 'bg-ok' : 'bg-outline')} />Offline map: {s.basemap === 'satellite' ? 'Satellite' : 'Street'}</span>
            <span>•</span>
            <span class="flex items-center gap-1"><Satellite size={14} />{f ? `GPS fix ±${Math.round(f.acc)} m` : 'No fix yet'}</span>
          </div>
        </div>
      </main>
    </div>
  );
}
