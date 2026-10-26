import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import L from 'leaflet';
import { ArrowLeft, ChevronRight, ClipboardList, Droplets, Flame, Footprints, Layers, LocateFixed, Navigation2, RadioTower, TriangleAlert, Truck } from 'lucide-preact';
import { assignmentAction, addNote, reportHazard } from '../core/actions';
import { getState, setState, toast, useStore } from '../core/store';
import { CONFIG } from '../config';
import { bearingDeg, cardinal, fmtDistance, haversineM } from '../core/geo';
import { isOpen } from '../core/flow';
import { quality, keepAwake } from '../core/gps';
import { AppBar, Button, CoordReadout, cx } from './kit';
import { back, go, useCompass, useGpsFix } from './hooks';
import { MapController } from './mapview';
import { metaSet } from '../core/db';
import { route } from '../core/route';
import { setPresence } from '../core/presence';


export function NavigateScreen({ kind, id }: { kind?: string; id?: string }) {
  const s = useStore((x) => ({ incidents: x.incidents, assignments: x.assignments, assets: x.assets, roads: x.roads, mapLayers: x.mapLayers, me: x.me, presence: x.presence }));
  const g = useGpsFix();
  const compass = useCompass();
  const [mode, setMode] = useState<'walk' | 'drive'>('drive');
  const [hz, setHz] = useState(false);
  const [more, setMore] = useState(false);
  const el = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);

  const open = s.incidents.filter((i) => isOpen(i.status) && !i.deleted_at);
  const myAssign = s.assignments.find((a) => a.state !== 'released' && s.me && (a.user_id === s.me.id || (a.crew_id && a.crew_id === s.me.crew_id)));
  let target: { key: string; lat: number; lon: number; name: string; note: string; incidentId?: string; priority?: boolean } | null = null;
  if (kind === 'water') {
    const a = s.assets.find((x) => x.id === id);
    if (a) target = { key: a.id, lat: a.lat, lon: a.lon, name: a.name, note: String(a.props?.capacity ?? 'Water point') };
  } else {
    const inc = (kind === 'incident' && s.incidents.find((i) => i.id === id)) || (myAssign && s.incidents.find((i) => i.id === myAssign.incident_id)) || open[0];
    if (inc) target = { key: inc.id, lat: inc.lat, lon: inc.lon, name: `${inc.compartment ?? inc.block ?? 'Fire'} · ${inc.code ?? inc.label}`, note: inc.notes || `Reported by ${inc.reported_by_name} ${inc.location_estimated ? '(location estimated)' : ''}`, incidentId: inc.id, priority: inc.status !== 'reported' };
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
  const fitBoth = () => { if (ctl.current && target) ctl.current.fit(r ? r.coords : f ? [[f.lat, f.lon], [target.lat, target.lon]] : [[target.lat, target.lon]], 40, { top: 120, bottom: 230 }); };
  useEffect(() => { setTimeout(fitBoth, 50); }, [target?.key, !!f]);

  if (!target) {
    return (
      <div class="h-full flex flex-col bg-surface"><AppBar title="Navigate" back={back} />
        <main class="flex-1 p-4"><div class="bg-card rounded-2xl border border-line p-8 text-center text-muted font-semibold">No active fire to navigate to.<br />Choose one from Fires or the Map.</div></main>
      </div>
    );
  }

  // direction arrow: relative to where the phone points when we know the heading, else north-up
  const arrowDeg = isFinite(brg) ? (heading != null ? brg - heading : brg) : 0;
  const nextAction = assign ? (assign.state === 'dispatched' ? 'ack' : assign.state === 'acknowledged' ? 'en_route' : assign.state === 'en_route' ? 'on_scene' : null) : null;
  const sharingHere = !!s.presence && s.presence.status !== 'off' && s.presence.incident_id === target.incidentId;

  return (
    <div class="h-full relative bg-sch overflow-hidden">
      {/* the map is the screen */}
      <div ref={el} class="absolute inset-0" data-testid="nav-map" />

      {/* top: back + where you are going + GPS quality */}
      <div class="absolute inset-x-3 z-[1000] flex items-center gap-2" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
        <button aria-label="Back" onClick={back} class="w-11 h-11 rounded-full bg-card/95 backdrop-blur-xl shadow-capsule flex items-center justify-center shrink-0"><ArrowLeft size={20} /></button>
        <div class="flex-1 min-w-0 h-11 rounded-full bg-card/95 backdrop-blur-xl shadow-capsule pl-3 pr-2 flex items-center gap-2">
          <span class={cx('w-7 h-7 rounded-full flex items-center justify-center shrink-0', kind === 'water' ? 'bg-cobalt text-white' : 'bg-[#EF4444] text-white')}>{kind === 'water' ? <Droplets size={15} /> : <Flame size={15} />}</span>
          <span class="flex-1 min-w-0 text-[14px] font-semibold truncate">{target.name}</span>
          <span data-testid="gps-quality" class={cx('px-2 py-0.5 rounded-pill text-[11px] font-semibold num shrink-0', !f ? 'bg-sc text-muted' : q === 'good' ? 'bg-moss text-on-moss' : q === 'fair' ? 'bg-amber-bg text-amber' : 'bg-fire-bg text-on-fire-bg')}>{f ? `±${Math.round(f.acc)} m` : g.status === 'denied' ? 'GPS off' : 'GPS…'}</span>
        </div>
      </div>
      <div class="absolute right-3 z-[1000] flex flex-col gap-2" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 68px)' }}>
        <button aria-label="Show me and the target" onClick={fitBoth} class="w-11 h-11 rounded-full bg-card/95 shadow-rail flex items-center justify-center text-cobalt"><LocateFixed size={20} /></button>
        <button aria-label="Switch basemap" onClick={() => { const b = getState().basemap === 'satellite' ? 'street' : 'satellite'; setState({ basemap: b }); void metaSet('basemap', b); ctl.current?.setBasemap(b); }} class="w-11 h-11 rounded-full bg-card/95 shadow-rail flex items-center justify-center"><Layers size={20} /></button>
      </div>

      {/* bottom sheet: the essentials always; the rest on demand */}
      <div class="absolute inset-x-0 bottom-0 z-[1000] bg-card rounded-t-3xl shadow-sheet pb-3" data-testid="nav-sheet">
        <button aria-label={more ? 'Show less' : 'Show more'} data-testid="nav-more" onClick={() => setMore((v) => !v)} class="w-full pt-2 pb-1 flex justify-center"><span class="w-10 h-1.5 rounded-full bg-schh" /></button>
        <div class="px-4 flex items-center gap-3">
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-2">
              <span class="text-[30px] font-bold num leading-none text-cobalt">{isFinite(etaMin) ? `${etaMin} min` : '—'}</span>
              <span class="text-[17px] font-semibold num text-ink" data-testid="nav-distance">{isFinite(dist) ? (dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(dist < 10_000 ? 1 : 0)} km`) : '—'}</span>
            </div>
            <div class="text-[12px] text-muted mt-1 truncate" data-testid="nav-legs">
              {r?.viaTracks ? `${mode === 'drive' ? 'Drive' : 'Walk'} ${fmtDistance(r.onTrackM)} ${mode === 'drive' ? 'by road' : 'on tracks'}${r.offRoadM > 40 ? `, then ${fmtDistance(r.offRoadM)} on foot` : ''}` : 'Straight line on foot'}
            </div>
          </div>
          {/* one direction readout: arrow + bearing */}
          <div class="flex flex-col items-center shrink-0 w-[68px]">
            <span class="w-11 h-11 rounded-full bg-cobalt-bg flex items-center justify-center"><Navigation2 size={22} class="text-cobalt" fill="currentColor" style={{ transform: `rotate(${arrowDeg}deg)`, transition: 'transform .3s' }} /></span>
            <span class="text-[11px] font-semibold num mt-0.5" data-testid="nav-bearing">Bearing {isFinite(brg) ? `${String(Math.round(brg)).padStart(3, '0')}° ${cardinal(brg)}` : '—'}</span>
          </div>
        </div>

        <div class="px-4 mt-3 flex items-center gap-2">
          <div class="flex p-0.5 bg-sc rounded-[10px] shrink-0">
            {(['drive', 'walk'] as const).map((m) => (
              <button key={m} aria-label={m === 'drive' ? 'Vehicle' : 'On foot'} aria-pressed={mode === m} onClick={() => setMode(m)} class={cx('w-11 h-10 rounded-[8px] flex items-center justify-center', mode === m ? 'bg-card shadow-sm text-ink' : 'text-muted')}>{m === 'drive' ? <Truck size={18} /> : <Footprints size={18} />}</button>
            ))}
          </div>
          {assign && nextAction ? (
            <Button kind="primary" class="flex-1 !min-h-[44px]" testid={nextAction === 'ack' ? 'nav-ack' : nextAction === 'en_route' ? 'nav-enroute' : 'nav-onscene'} onClick={() => void assignmentAction(assign, nextAction)}>
              {nextAction === 'ack' ? 'Acknowledge call-out' : nextAction === 'en_route' ? "I'm on my way" : "I'm on scene"}
            </Button>
          ) : target.incidentId ? (
            <Button kind={sharingHere ? 'secondary' : 'primary'} class="flex-1 !min-h-[44px]" testid="send-position" icon={<RadioTower size={17} />} onClick={async () => { await addNote(target!.incidentId!, 'Position update'); if (!sharingHere) await setPresence('en_route', target!.incidentId!); toast(sharingHere ? 'Position update sent' : 'Sharing your live location with control.'); }}>
              {sharingHere ? 'Send position update' : 'Share my location'}
            </Button>
          ) : <div class="flex-1" />}
        </div>

        {more && (
          <div class="px-4 mt-3 space-y-2.5 max-h-[45vh] overflow-y-auto sheet-enter" data-testid="nav-details">
            <CoordReadout lat={target.lat} lon={target.lon} compact />
            {target.note && <p class="text-[13px] text-muted"><span class="font-semibold text-ink">Note:</span> {target.note}</p>}
            {water[0] && kind !== 'water' && (
              <button onClick={() => go('navigate/water/' + water[0].a.id)} class="w-full flex items-center gap-3 rounded-xl bg-cobalt-bg px-3 py-2.5 text-left">
                <Droplets size={18} class="text-cobalt shrink-0" />
                <span class="flex-1 min-w-0 text-[13px] truncate"><b class="text-cobalt">Nearest water</b> · {water[0].a.name} · {fmtDistance(water[0].d)} {cardinal(water[0].b)}</span>
                <ChevronRight size={18} class="text-cobalt shrink-0" />
              </button>
            )}
            {hz ? (
              <div class="grid grid-cols-2 gap-2">
                {([['road_blocked', 'Road blocked'], ['tree_down', 'Tree down'], ['bridge', 'Bridge unsafe'], ['other', 'Other hazard']] as const).map(([k, l]) => (
                  <Button key={k} kind="secondary" onClick={async () => { try { await reportHazard(k, ''); toast('Hazard saved at your position'); setHz(false); } catch (e) { toast((e as Error).message, 'err'); } }}>{l}</Button>
                ))}
              </div>
            ) : (
              <div class="grid grid-cols-2 gap-2">
                <Button kind="secondary" icon={<TriangleAlert size={16} class="text-fire" />} onClick={() => setHz(true)}>Road hazard</Button>
                {target.incidentId && <Button kind="secondary" icon={<ClipboardList size={16} />} onClick={() => go('incident/' + target!.incidentId)}>Fire details</Button>}
              </div>
            )}
            {assign && assign.state !== 'dispatched' && <div class="text-[12px] text-muted">Call-out: {assign.state.replace('_', ' ')}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
