import { useEffect, useRef, useState } from 'preact/hooks';
import L from 'leaflet';
import { Camera, CircleCheck, CirclePause, CirclePlay, Compass, Database, Layers, LocateFixed, MapPinPlus, Play, Undo2, Mountain, Ruler, Waypoints, ChevronRight } from 'lucide-preact';
import { addPhoto, finishPerimeter, shouldCapture, startPerimeter, updatePerimeter } from '../core/actions';
import { gps, keepAwake, quality } from '../core/gps';
import { getState, setState, toast, useStore } from '../core/store';
import { fmtHa } from '../core/geo';
import { hhmmss } from '../core/time';
import { isOpen } from '../core/flow';
import { AppBar, Banner, RailButton, StatusChip, cx } from './kit';
import { go, useGps } from './hooks';
import { MapController } from './mapview';
import { metaSet } from '../core/db';
import type { Vertex } from '../core/types';

let chain: Promise<unknown> = Promise.resolve();
const enqueue = (fn: () => Promise<unknown>) => (chain = chain.then(fn, fn));

export function PerimeterScreen({ incidentId }: { incidentId?: string }) {
  const s = useStore((x) => x);
  const g = useGps();
  const el = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);
  const rejected = useRef(0);
  const lastTs = useRef(0);
  const lastTick = useRef(Date.now());
  const file = useRef<HTMLInputElement>(null);
  const [bg, setBg] = useState(false);
  const [, force] = useState(0);

  const open = s.incidents.filter((i) => isOpen(i.status) && !i.deleted_at);
  const closedNoArea = s.incidents.filter((i) => !isOpen(i.status) && i.status !== 'dismissed' && i.area_ha == null);
  const inc = s.incidents.find((i) => i.id === incidentId);
  const per = incidentId ? s.perimeters.filter((p) => p.incident_id === incidentId).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0] : undefined;
  const rec = per?.state === 'recording';

  useEffect(() => {
    if (!el.current) return;
    const c = new MapController(el.current, inc ?? undefined, 17);
    ctl.current = c; c.setBasemap(getState().basemap);
    return () => { c.destroy(); ctl.current = null; };
  }, [!!inc]);

  // draw walked edge
  useEffect(() => {
    const c = ctl.current; if (!c) return;
    c.render(s, {});
    c.setMe(g.fix);
    const grp = c.extra(); grp.clearLayers();
    const vs = per?.vertices ?? [];
    if (vs.length) {
      const ll = vs.map((v) => [v.lat, v.lon] as [number, number]);
      if (vs.length >= 3) L.polygon(ll, { color: '#16A34A', weight: 0, fillColor: '#86EFAC', fillOpacity: 0.35 }).addTo(grp);
      L.polyline(ll, { color: '#16A34A', weight: 4 }).addTo(grp);
      if (vs.length >= 3 && per?.state !== 'closed') L.polyline([ll[ll.length - 1], ll[0]], { color: '#16A34A', weight: 2, dashArray: '4 6' }).addTo(grp);
      ll.forEach((p, i) => {
        const last = i === ll.length - 1;
        const m = L.circleMarker(p, { radius: last ? 8 : 5, color: last ? '#15803D' : '#16A34A', weight: last ? 3 : 2, fillColor: '#fff', fillOpacity: 1 }).addTo(grp);
        if (last && per?.state !== 'closed') m.bindTooltip(`<span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:#15803D;margin-right:6px"></span>Vertex #${ll.length} <span style="color:rgb(var(--c-muted));font-weight:500">• Auto-capture ${rec ? 'on' : 'paused'}</span>`, { permanent: true, direction: 'top', offset: [0, -10], className: 'vtx' });
      });
    }
  }, [s.incidents, s.perimeters, g.fix, per?.vertices.length, rec]);
  useEffect(() => { if (inc && ctl.current) ctl.current.map.setView([g.fix?.lat ?? inc.lat, g.fix?.lon ?? inc.lon], 17); }, [incidentId, !!ctl.current]);

  // capture engine (FR-PER-02)
  useEffect(() => {
    if (!rec || !per) return;
    void keepAwake(true);
    lastTick.current = Date.now();
    const onVis = () => { if (document.hidden) setBg(true); };
    document.addEventListener('visibilitychange', onVis);
    const unsub = gps.subscribe((st) => {
      const f = st.fix;
      if (!f || f.ts === lastTs.current) return;
      lastTs.current = f.ts;
      const cur = getState().perimeters.find((p) => p.id === per.id);
      const prev = cur?.vertices[cur.vertices.length - 1];
      const d = shouldCapture(prev, f, Date.now());
      if (d === 'reject') { rejected.current++; force((n) => n + 1); return; }
      if (d === 'skip') return;
      const rj = rejected.current; rejected.current = 0;
      const dt = (Date.now() - lastTick.current) / 1000; lastTick.current = Date.now();
      void enqueue(() => updatePerimeter(per.id, (p) => ({ ...p, rejected_fixes: p.rejected_fixes + rj, walk_seconds: p.walk_seconds + dt, vertices: [...p.vertices, { lat: f.lat, lon: f.lon, acc: f.acc, ts: new Date().toISOString() }] })));
    });
    return () => { document.removeEventListener('visibilitychange', onVis); unsub(); };
  }, [rec, per?.id]);

  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const walk = per ? per.walk_seconds + (rec ? (Date.now() - lastTick.current) / 1000 : 0) : 0;

  if (!incidentId || !inc) {
    const pick = [...open, ...closedNoArea];
    return (
      <div class="h-full flex flex-col bg-surface">
        <AppBar title="Perimeter" />
        <main class="flex-1 overflow-y-auto px-4 pt-3 pb-24 space-y-3">
          <div class="flex justify-center"><span class="px-3 py-1 rounded-pill bg-sch text-[10px] font-semibold text-muted">Choose the fire whose burnt edge you are walking</span></div>
          {pick.length === 0 && <div class="bg-card rounded-xl shadow-md p-6 text-center text-muted font-semibold">No incidents need a perimeter.</div>}
          {pick.map((i) => (
            <button key={i.id} onClick={() => go('perimeter/' + i.id)} class="w-full bg-card rounded-xl shadow-md p-4 flex items-center justify-between gap-3 text-left">
              <div class="flex items-center gap-3 min-w-0">
                <div class="w-9 h-9 rounded-full bg-sc flex items-center justify-center text-brand-deep shrink-0"><Waypoints size={20} /></div>
                <div class="min-w-0"><div class="text-[16px] font-semibold truncate">{i.compartment ?? i.block ?? 'Unmapped area'} fire #{i.code ?? i.label}</div><StatusChip s={i.status} short /></div>
              </div>
              <ChevronRight size={20} class="text-outline shrink-0" />
            </button>
          ))}
        </main>
      </div>
    );
  }

  const add = (v: Partial<Vertex> & { manual?: boolean }) => per && enqueue(() => updatePerimeter(per.id, (p) => ({ ...p, vertices: [...p.vertices, { lat: v.lat!, lon: v.lon!, acc: v.acc ?? null, ts: new Date().toISOString(), manual: v.manual }] })));
  const setWalk = (st: 'recording' | 'paused') => per && enqueue(() => updatePerimeter(per.id, (p) => ({ ...p, state: st, walk_seconds: p.walk_seconds + (rec ? (Date.now() - lastTick.current) / 1000 : 0) }))).then(() => { if (st === 'paused') void keepAwake(false); });
  const q = quality(g.fix, g.now);
  const stateChip = !per ? { t: 'Ready', c: 'bg-sc text-muted', d: 'bg-outline' } : per.state === 'closed' ? { t: 'Closed', c: 'bg-moss/60 text-on-moss', d: 'bg-ok' } : rec ? { t: 'Tracking', c: 'bg-moss/40 text-on-moss', d: 'bg-ok animate-pulse' } : { t: 'Paused', c: 'bg-amber-bg text-amber', d: 'bg-amber' };
  const syncText = s.sync?.simulateOffline || s.sync?.reachable === false ? 'Offline' : s.sync?.pending ? `${s.sync.pending} to send` : 'Ready';

  return (
    <div class="h-full flex flex-col bg-surface">
      <AppBar title="Perimeter" sub={`${inc.code ?? inc.label} · Field GIS`} back={() => go('incident/' + inc.id)} />
      <div class="relative flex-1 min-h-[220px]">
        <div ref={el} class="absolute inset-0" data-testid="perimeter-map" />
        {/* GNSS pill */}
        <div class="absolute top-4 left-4 z-[1000] flex items-center gap-1.5 bg-card/95 backdrop-blur-md px-3 py-1.5 rounded-pill shadow-md">
          <span class={cx('w-2 h-2 rounded-full', q === 'good' ? 'bg-ok animate-pulse' : q === 'fair' ? 'bg-amber' : 'bg-fire')} />
          <span class="text-[12px] font-semibold num">{g.fix ? `GPS FIX • ±${g.fix.acc < 10 ? g.fix.acc.toFixed(1) : Math.round(g.fix.acc)} m` : 'NO FIX'}</span>
          <span class="text-[12px] text-outline">• 1 Hz</span>
        </div>
        {(bg && rec) || (rec && g.fix && g.fix.acc > 15) ? (
          <div class="absolute top-14 left-4 right-20 z-[1000] space-y-1.5">
            {bg && rec && <Banner tone="warn" testid="bg-warning">App was in the background — points may be missing. Keep the screen on.</Banner>}
            {rec && g.fix && g.fix.acc > 15 && <Banner tone="warn">Weak GPS (±{Math.round(g.fix.acc)} m) — points skipped until ±15 m.</Banner>}
          </div>
        ) : null}
        {/* right rail */}
        <div class="absolute top-4 right-4 z-[1000] flex flex-col gap-2 items-center">
          <RailButton label="Switch basemap" onClick={() => { const b = getState().basemap === 'satellite' ? 'street' : 'satellite'; setState({ basemap: b }); void metaSet('basemap', b); ctl.current?.setBasemap(b); }}><Layers size={20} /></RailButton>
          <RailButton label="Centre on me" tone="text-brand-deep" onClick={() => { const f = gps.state.fix; if (f) ctl.current?.map.setView([f.lat, f.lon], 18); }}><LocateFixed size={21} /></RailButton>
          {per && per.state !== 'closed' && <RailButton label="Add point here" testid="per-add" onClick={() => { const r = gps.forRecord(); if (!r.fix) return toast('No GPS fix yet', 'warn'); void add({ lat: r.fix.lat, lon: r.fix.lon, acc: r.fix.acc, manual: true }); toast(`Vertex #${(per.vertices.length ?? 0) + 1} dropped`); }}><MapPinPlus size={20} /></RailButton>}
          {per && per.state !== 'closed' && <RailButton label="Undo last point" testid="per-undo" tone="text-muted" onClick={() => { if (per.vertices.length) void enqueue(() => updatePerimeter(per.id, (p) => ({ ...p, vertices: p.vertices.slice(0, -1) }))); }}><Undo2 size={20} /></RailButton>}
          <RailButton label="Fit perimeter" tone="text-brand-deep" onClick={() => { const v = per?.vertices ?? []; if (v.length) ctl.current?.fit(v.map((x) => [x.lat, x.lon])); }}><Compass size={20} /></RailButton>
        </div>
      </div>

      {/* tracking panel */}
      <div class="bg-card rounded-t-[28px] -mt-5 z-[1001] relative shadow-[0_-8px_30px_rgba(0,0,0,0.06)] px-4 pt-3 pb-4 flex flex-col gap-3">
        <div class="w-10 h-1 bg-schh rounded-full mx-auto" />
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="w-2.5 h-2.5 rounded-full bg-moss shrink-0" />
            <h2 class="text-[16px] font-semibold truncate">{inc.compartment ?? inc.block ?? 'Unmapped area'} • {inc.code ?? inc.label}</h2>
          </div>
          <div class={cx('flex items-center gap-1 px-2.5 py-0.5 rounded-pill shrink-0', stateChip.c)}>
            <span class={cx('w-1.5 h-1.5 rounded-full', stateChip.d)} /><span class="text-[10px] font-bold uppercase tracking-wide">{stateChip.t}</span>
          </div>
        </div>
        <div class="grid grid-cols-3 gap-1 py-1 bg-surface-low rounded-xl px-2">
          <div class="flex flex-col items-center justify-center py-2 text-center">
            <span class="text-[28px] font-bold text-brand-deep tracking-tight num leading-9" data-testid="per-area">{fmtHa(per?.area_ha ?? null)}</span>
            <span class="text-[10px] font-semibold text-muted">Hectares burnt</span>
          </div>
          <div class="flex flex-col items-center justify-center py-2 text-center bg-card rounded-lg shadow-sm">
            <span class="text-[28px] font-bold tracking-tight num leading-9">{per?.length_km != null ? per.length_km.toFixed(2) : '—'}</span>
            <span class="text-[10px] font-semibold text-muted">Perimeter (km)</span>
          </div>
          <div class="flex flex-col items-center justify-center py-2 text-center">
            <span class="text-[20px] font-bold tracking-tight font-mono leading-9">{hhmmss(walk)}</span>
            <span class="text-[10px] font-semibold text-muted">Walk time</span>
          </div>
        </div>
        <div class="flex items-center justify-around px-1 text-[12px] text-muted">
          <span class="flex items-center gap-1"><Mountain size={15} class="text-outline" />{g.fix?.alt != null ? `Elev ${Math.round(g.fix.alt)} m` : 'Elev —'}</span>
          <span class="w-1 h-1 rounded-full bg-outline-v" />
          <span class="flex items-center gap-1"><Ruler size={15} class="text-outline" />{(per?.rejected_fixes ?? 0) + rejected.current} weak skipped</span>
          <span class="w-1 h-1 rounded-full bg-outline-v" />
          <span class="flex items-center gap-1 text-ink font-semibold" data-testid="per-vertices"><Waypoints size={15} class="text-brand-deep" />{per?.vertices.length ?? 0} points</span>
        </div>

        {!per ? (
          <button data-testid="per-start" class="w-full py-3.5 rounded-xl bg-brand text-on-brand flex items-center justify-center gap-2 shadow-md text-[14px] font-bold" onClick={async () => { await startPerimeter(incidentId); }}><Play size={20} />Start walking the edge</button>
        ) : per.state === 'closed' ? (
          <div class="grid grid-cols-2 gap-2">
            <button class="h-11 rounded-lg bg-sc text-ink text-[12px] font-semibold" onClick={() => go('incident/' + incidentId)}>Back to incident</button>
            <button class="h-11 rounded-lg bg-sc text-ink text-[12px] font-semibold" onClick={async () => { await enqueue(() => updatePerimeter(per.id, (p) => ({ ...p, state: 'recording', closed_at: null }))); }}>Re-open &amp; continue</button>
          </div>
        ) : (
          <>
            <button data-testid="per-finish" disabled={per.vertices.length < 3} class="w-full py-3.5 rounded-xl bg-brand text-on-brand flex items-center justify-center gap-2 shadow-md text-[14px] font-bold tracking-wide active:scale-[.99] disabled:opacity-50"
              onClick={async () => { try { await chain; await finishPerimeter(per.id); toast(`Perimeter closed — ${fmtHa(getState().perimeters.find((p) => p.id === per.id)?.area_ha ?? null)} ha`); } catch (e) { toast((e as Error).message, 'err'); } }}>
              <CircleCheck size={22} />Finish &amp; close polygon
            </button>
            <div class="grid grid-cols-2 gap-2">
              {rec
                ? <button data-testid="per-pause" class="h-11 px-3 rounded-lg bg-sc text-ink flex items-center justify-center gap-1.5 text-[12px] font-semibold" onClick={() => void setWalk('paused')}><CirclePause size={18} class="text-muted" />Pause walk</button>
                : <button data-testid="per-resume" class="h-11 px-3 rounded-lg bg-moss text-on-moss flex items-center justify-center gap-1.5 text-[12px] font-bold" onClick={() => void setWalk('recording')}><CirclePlay size={18} />Resume walk</button>}
              <button class="h-11 px-3 rounded-lg bg-sc text-ink flex items-center justify-center gap-1.5 text-[12px] font-semibold" onClick={() => file.current?.click()}><Camera size={18} class="text-ok" />Add geotag</button>
              <input ref={file} type="file" accept="image/*" capture="environment" class="hidden" onChange={async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) { await addPhoto(incidentId, f); toast('Geotagged photo saved'); } }} />
            </div>
          </>
        )}
        <div class="pt-1 flex items-center justify-between text-outline text-[12px]">
          <span class="flex items-center gap-1.5 truncate"><Database size={15} class="text-ok" />Auto-saved on this phone</span>
          <span class="flex items-center gap-1.5 shrink-0"><span class={cx('w-1.5 h-1.5 rounded-full', syncText === 'Ready' ? 'bg-ok' : 'bg-amber')} /><span class="text-ink text-[10px] font-semibold">Supabase sync: {syncText}</span></span>
        </div>
      </div>
    </div>
  );
}
