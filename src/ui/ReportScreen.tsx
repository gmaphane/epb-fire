import { useEffect, useRef, useState } from 'preact/hooks';
import L from 'leaflet';
import { Camera, Flame, Keyboard, LocateFixed, MapPin, Radio } from 'lucide-preact';
import { nearbyOpenIncidents, reportFire } from '../core/actions';
import { gps, quality } from '../core/gps';
import { getState, toast, useStore } from '../core/store';
import { CONFIG } from '../config';
import { MapController } from './mapview';
import { Banner, Button, Choice, GpsChip, Screen, cx } from './kit';
import { back, go, useGps } from './hooks';
import { fmtDd, fmtDistance, fmtDms, haversineM, toUtm30 } from '../core/geo';
import { parseCoordinates, radioDigits, siteDistanceKm } from '../core/coords';
import { locate } from '../core/actions';
import type { Incident } from '../core/types';
import { CATEGORIES, CATEGORY, sizeFromCategory, type Category } from '../core/flow';

const SOURCES: [Incident['source'], string][] = [['patrol', 'Patrol'], ['tower', 'Lookout tower'], ['camera', 'Camera'], ['community', 'Community'], ['satellite', 'Satellite'], ['other', 'Other']];

const lastSource = (): Incident['source'] => { try { return (localStorage.getItem('epb.lastSource') as Incident['source']) || 'patrol'; } catch { return 'patrol'; } };

export function ReportScreen({ detection }: { detection: string | null }) {
  const s = useStore((x) => x);
  const g = useGps();
  const det = detection ? s.detections.find((d) => d.id === detection) : null;
  const [source, setSource] = useState<Incident['source']>(det ? 'satellite' : lastSource());
  const [cat, setCat] = useState<Category | null>(null);
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [pin, setPin] = useState<{ lat: number; lon: number } | null>(det ? { lat: det.lat, lon: det.lon } : null);
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [mode, setMode] = useState<'gps' | 'map' | 'manual'>(det ? 'map' : 'gps');
  const [coordText, setCoordText] = useState('');
  const [observer, setObserver] = useState('');
  const [via, setVia] = useState<'radio' | 'phone' | null>('radio');
  const [seenAt, setSeenAt] = useState(() => new Date().toTimeString().slice(0, 5));
  const [accText, setAccText] = useState('');
  const el = useRef<HTMLDivElement>(null);
  const ctl = useRef<MapController | null>(null);
  const marker = useRef<L.Marker | null>(null);
  const file = useRef<HTMLInputElement>(null);

  // live GPS position unless the user pinned a spot or this is a satellite detection
  const live = g.fix;
  const parsed = mode === 'manual' && coordText.trim() ? parseCoordinates(coordText) : null;
  const manualPos = parsed?.ok ? { lat: parsed.lat, lon: parsed.lon } : null;
  const pos = mode === 'manual' ? manualPos : mode === 'map' ? pin : live ? { lat: live.lat, lon: live.lon } : null;
  const farKm = manualPos ? siteDistanceKm(manualPos.lat, manualPos.lon) : 0;
  const q = quality(live);
  const dups = pos ? nearbyOpenIncidents(pos.lat, pos.lon) : [];

  useEffect(() => {
    const c = new MapController(el.current!, pos ?? CONFIG.center, 16);
    ctl.current = c;
    c.setBasemap(getState().basemap);
    c.render(getState());
    c.setPick(true); // every tap places the fire, inside a compartment or not
    c.onClick((lat, lon) => { setPin({ lat, lon }); setMode('map'); });
    return () => c.destroy();
  }, []);
  useEffect(() => {
    const c = ctl.current;
    if (!c) return;
    c.setMe(live);
    if (!pos) { marker.current?.remove(); marker.current = null; return; }
    if (!marker.current) {
      marker.current = L.marker([pos.lat, pos.lon], { draggable: true, zIndexOffset: 2000, icon: L.divIcon({ className: '', iconSize: [34, 34], iconAnchor: [17, 34], html: '<div style="font-size:34px;line-height:34px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))">🔥</div>' }) }).addTo(c.map);
      marker.current.on('dragend', () => { const ll = marker.current!.getLatLng(); setPin({ lat: ll.lat, lon: ll.lng }); setMode('map'); });
      c.map.setView([pos.lat, pos.lon], 16);
    } else {
      marker.current.setLatLng([pos.lat, pos.lon]);
      if (mode === 'manual') c.map.setView([pos.lat, pos.lon], Math.max(c.map.getZoom(), 14));
    }
  }, [pos?.lat, pos?.lon, live, mode]);

  const submit = async (again = false) => {
    // use the freshest best GPS fix at the moment of tapping, unless the user placed the pin
    const rec = gps.forRecord();
    const at = mode === 'manual' ? manualPos : mode === 'map' ? pin : rec.fix ? { lat: rec.fix.lat, lon: rec.fix.lon } : null;
    if (!at) return toast(mode === 'manual' ? 'Enter a valid coordinate first' : 'Tap the map to place the fire first', 'warn');
    let observedAt: string | null = null;
    if (mode === 'manual' && /^\d{2}:\d{2}$/.test(seenAt)) {
      const d = new Date(); const [h, m] = seenAt.split(':').map(Number); d.setHours(h, m, 0, 0);
      if (d.getTime() > Date.now() + 60_000) d.setDate(d.getDate() - 1); // a time after now means yesterday
      observedAt = d.toISOString();
    }
    setBusy(true);
    const t0 = performance.now();
    try {
      try { localStorage.setItem('epb.lastSource', source); } catch { /* ignore */ }
      const inc = await reportFire({
        source, size_class: sizeFromCategory(cat), category: cat, notes, lat: at.lat, lon: at.lon,
        accuracy_m: mode === 'manual' ? (Number(accText) > 0 ? Number(accText) : null) : mode === 'map' ? (det ? 375 : null) : rec.fix?.acc ?? null,
        estimated: mode === 'map' && (!!det || !rec.fix || haversineM(at.lat, at.lon, rec.fix.lat, rec.fix.lon) > 15),
        photo, detection_id: det?.id ?? null,
        location_source: mode === 'manual' ? 'manual' : det ? 'satellite' : mode === 'map' ? 'map' : 'gps',
        observer_name: mode === 'manual' ? observer : null, relayed_via: mode === 'manual' ? via : null, observed_at: observedAt,
      });
      (window as any).__lastReportMs = Math.round(performance.now() - t0);
      if (again) {
        // stay here to pin the next fire
        toast(`${inc.label} saved · tap the map for the next one`);
        setNotes(''); setPhoto(null); setAck(false); setBusy(false);
        return;
      }
      toast(mode === 'manual' ? 'Relayed fire reported' : 'Fire reported');
      go('incident/' + inc.id);
    } catch (e) { toast((e as Error).message, 'err'); setBusy(false); }
  };

  const field = 'w-full min-h-[52px] rounded-2xl border border-line bg-card px-4 text-[16px] outline-none focus:border-brand transition-colors';
  return (
    <Screen title="Report fire" sub={det ? 'From a satellite hotspot' : undefined} back={back} pad={false}>
      <div class="relative h-[36%] min-h-[220px] mx-4 rounded-[24px] overflow-hidden shadow-l1">
        <div ref={el} class="absolute inset-0" data-testid="report-map" />
        <div class="absolute top-3 left-3 right-3 z-[1000] pointer-events-none">
          <div class="bg-card rounded-pill pl-4 pr-3 py-2 shadow-capsule inline-flex flex-col max-w-full">
            <div class="num font-semibold text-[15px] truncate" data-testid="report-coords">{pos ? fmtDd(pos.lat, pos.lon) : mode === 'manual' ? 'Type the coordinate below' : 'Tap the map to place the fire'}</div>
            <div class="flex items-center gap-2"><GpsChip g={g} compact /><span class="text-[12px] text-muted">· {mode === 'manual' ? 'Typed in' : mode === 'map' ? 'Pinned' : 'My GPS'}</span></div>
          </div>
        </div>
      </div>
      <div class="px-4 pt-5 pb-10 space-y-6 overflow-y-auto" style={{ height: '64%' }}>
        {g.status === 'denied' && <Banner tone="err">Location is blocked. Tap the map to place the fire.</Banner>}
        {g.fix && q === 'poor' && mode === 'gps' && <Banner tone="warn">Weak GPS (±{Math.round(g.fix.acc)} m). Drag the flame to correct it.</Banner>}
        <div>
          <h2 class="font-display text-[18px] mb-3">Where is it?</h2>
          <div class="grid grid-cols-3 gap-1 p-1 bg-sc rounded-pill" role="tablist">
            {([['gps', 'My GPS', <LocateFixed size={16} />], ['map', 'On map', <MapPin size={16} />], ['manual', 'Type in', <Keyboard size={16} />]] as const).map(([k, l, ic]) => (
              <button key={k} role="tab" aria-selected={mode === k} data-testid={'loc-' + k} onClick={() => { setMode(k); if (k === 'map' && !pin && live) setPin({ lat: live.lat, lon: live.lon }); }} class={cx('press min-h-[42px] rounded-pill text-[14px] font-medium inline-flex items-center justify-center gap-1.5', mode === k ? 'bg-card shadow-l1 text-ink' : 'text-muted')}>{ic}{l}</button>
            ))}
          </div>
        </div>
        {mode === 'manual' && (
          <div class="space-y-3 fade-in" data-testid="manual-panel">
            <input id="coord" aria-label="Coordinates read out from the field" data-testid="coord-input" inputMode="text" autoComplete="off" spellcheck={false} class={cx(field, 'min-h-[56px] text-[18px] font-semibold num')} placeholder="6.8287 N 0.8093 W  or  UTM" value={coordText} onInput={(e) => setCoordText((e.target as HTMLInputElement).value)} />
            {parsed && !parsed.ok && <Banner tone="err" testid="coord-error">{parsed.error}</Banner>}
            {parsed?.ok && manualPos && (() => { const u = toUtm30(manualPos.lat, manualPos.lon); const where = locate(manualPos.lat, manualPos.lon); return (
              <div class={cx('rounded-[20px] p-4 space-y-1 fade-in', farKm > 30 ? 'bg-fire-bg' : 'bg-moss')} data-testid="readback">
                <div class="flex items-center gap-1.5 text-[13px] text-muted"><Radio size={15} />Read back to the caller</div>
                <div class="text-[20px] font-semibold num leading-7">{fmtDms(manualPos.lat, 'lat')}  {fmtDms(manualPos.lon, 'lon')}</div>
                <div class="text-[14px] num">{fmtDd(manualPos.lat, manualPos.lon)} · UTM 30N {radioDigits(u.e)} E {radioDigits(u.n)} N</div>
                <div class="text-[14px] font-medium">{where.compartment ? `${where.compartment} · ${where.block}` : 'Outside mapped compartments'}{live ? ` · ${fmtDistance(haversineM(live.lat, live.lon, manualPos.lat, manualPos.lon))} from you` : ''}</div>
                {parsed.assumedHemisphere && <div class="text-[13px] font-medium text-amber">Assumed North and West. Confirm with the caller.</div>}
                {farKm > 30 && <div class="text-[14px] font-semibold text-on-fire-bg" data-testid="far-warning">This is {Math.round(farKm)} km from the site — check the digits and E/W with the caller.</div>}
              </div>
            ); })()}
            <div class="grid grid-cols-2 gap-2">
              <input id="observer" aria-label="Seen by" data-testid="observer" class={field} placeholder="Seen by" value={observer} onInput={(e) => setObserver((e.target as HTMLInputElement).value)} />
              <input id="seen" aria-label="Time seen" type="time" data-testid="seen-at" class={cx(field, 'num')} value={seenAt} onInput={(e) => setSeenAt((e.target as HTMLInputElement).value)} />
            </div>
            <div class="flex gap-2 items-center">
              {([['radio', 'Radio'], ['phone', 'Phone call']] as const).map(([k, l]) => <Choice key={k} testid={'via-' + k} selected={via === k} onClick={() => setVia(k)}>{l}</Choice>)}
              <input id="acc" aria-label="GPS accuracy read out (m)" inputMode="decimal" class={cx(field, 'flex-1 min-w-0 min-h-[40px] h-10 rounded-pill text-[14px] num')} placeholder="± m (optional)" value={accText} onInput={(e) => setAccText((e.target as HTMLInputElement).value.replace(/[^\d.]/g, ''))} />
            </div>
          </div>
        )}
        {dups.length > 0 && !ack && (
          <Banner tone="warn" testid="dup-banner">
            {dups[0].code ?? dups[0].label} is {fmtDistance(haversineM(pos!.lat, pos!.lon, dups[0].lat, dups[0].lon))} away. Same fire?
            <div class="flex gap-2 mt-3"><Button class="flex-1" onClick={() => go('incident/' + dups[0].id)}>View it</Button><Button class="flex-1" testid="report-anyway" onClick={() => setAck(true)}>Report anyway</Button></div>
          </Banner>
        )}
        <div>
          <h2 class="font-display text-[18px] mb-3">Who saw it?</h2>
          <div class="flex flex-wrap gap-2">{SOURCES.map(([k, l]) => <Choice key={k} testid={'src-' + k} selected={source === k} onClick={() => setSource(k)}>{l}</Choice>)}</div>
        </div>
        <div>
          <h2 class="font-display text-[18px] mb-3">How big? <span class="text-[14px] font-sans text-muted">SOP category</span></h2>
          <div class="flex flex-wrap gap-2">
            <Choice testid="cat-none" selected={cat === null} onClick={() => setCat(null)}>Not sure</Choice>
            {CATEGORIES.map((c) => <Choice key={c} testid={'cat-' + c} selected={cat === c} onClick={() => setCat(c)}>{c} · {CATEGORY[c].name}</Choice>)}
          </div>
          {cat && <p class="mt-2 text-[13px] text-muted" data-testid="cat-hint">{CATEGORY[cat].size} · {CATEGORY[cat].signs}</p>}
        </div>
        <div class="relative">
          <input data-testid="notes" class={cx(field, 'pr-14')} placeholder="Add a note (optional)" value={notes} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />
          <button aria-label="Add photo" class={cx('press absolute right-1.5 top-1.5 w-10 h-10 rounded-full flex items-center justify-center', photo ? 'bg-moss text-on-moss' : 'text-muted')} onClick={() => file.current?.click()}><Camera size={20} /></button>
          <input ref={file} type="file" accept="image/*" capture="environment" class="hidden" onChange={(e) => setPhoto((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </div>
        <div class="space-y-2">
          <Button kind="danger" size="lg" full testid="submit-report" disabled={busy || (dups.length > 0 && !ack) || (mode === 'manual' && !manualPos)} icon={<Flame size={20} fill="currentColor" />} class="min-h-[58px] text-[17px]" onClick={() => void submit(false)}>
            {busy ? 'Saving…' : mode === 'manual' ? 'Report relayed fire' : 'Report fire'}
          </Button>
          {mode === 'map' && !det && (
            <Button kind="ghost" full testid="submit-another" disabled={busy || (dups.length > 0 && !ack)} onClick={() => void submit(true)}>Save and pin another</Button>
          )}
          <p class="text-[13px] text-faint text-center">Works offline · sends when there's signal</p>
        </div>
      </div>
    </Screen>
  );
}
