import { useEffect, useRef, useState } from 'preact/hooks';
import L from 'leaflet';
import { Camera, Flame, Keyboard, LocateFixed, MapPin, Radio } from 'lucide-preact';
import { nearbyOpenIncidents, reportFire } from '../core/actions';
import { gps, quality } from '../core/gps';
import { getState, toast, useStore } from '../core/store';
import { CONFIG } from '../config';
import { MapController } from './mapview';
import { Banner, Button, GpsChip, Screen, cx } from './kit';
import { back, go, useGps } from './hooks';
import { fmtDd, fmtDistance, fmtDms, haversineM, toUtm30 } from '../core/geo';
import { parseCoordinates, radioDigits, siteDistanceKm } from '../core/coords';
import { locate } from '../core/actions';
import type { Incident } from '../core/types';

const SOURCES: [Incident['source'], string][] = [['patrol', 'Patrol / field'], ['tower', 'Lookout tower'], ['camera', 'Camera'], ['community', 'Community'], ['satellite', 'Satellite'], ['other', 'Other']];
const SIZES: [Incident['size_class'], string][] = [['unknown', 'Not sure'], ['small', 'Small (≈ <1 ha)'], ['medium', 'Medium'], ['large', 'Large / spreading fast']];

const lastSource = (): Incident['source'] => { try { return (localStorage.getItem('epb.lastSource') as Incident['source']) || 'patrol'; } catch { return 'patrol'; } };

export function ReportScreen({ detection }: { detection: string | null }) {
  const s = useStore((x) => x);
  const g = useGps();
  const det = detection ? s.detections.find((d) => d.id === detection) : null;
  const [source, setSource] = useState<Incident['source']>(det ? 'satellite' : lastSource());
  const [size, setSize] = useState<Incident['size_class']>('unknown');
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

  const submit = async () => {
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
        source, size_class: size, notes, lat: at.lat, lon: at.lon,
        accuracy_m: mode === 'manual' ? (Number(accText) > 0 ? Number(accText) : null) : mode === 'map' ? (det ? 375 : null) : rec.fix?.acc ?? null,
        estimated: mode === 'map' && (!!det || !rec.fix || haversineM(at.lat, at.lon, rec.fix.lat, rec.fix.lon) > 15),
        photo, detection_id: det?.id ?? null,
        location_source: mode === 'manual' ? 'manual' : det ? 'satellite' : mode === 'map' ? 'map' : 'gps',
        observer_name: mode === 'manual' ? observer : null, relayed_via: mode === 'manual' ? via : null, observed_at: observedAt,
      });
      (window as any).__lastReportMs = Math.round(performance.now() - t0);
      toast(mode === 'manual' ? 'Relayed fire saved — sending to everyone when signal allows' : 'Saved on this phone — sending when signal allows');
      go('incident/' + inc.id);
    } catch (e) { toast((e as Error).message, 'err'); setBusy(false); }
  };

  return (
    <Screen title="Report fire" sub={det ? 'From satellite detection' : 'Takes 2 taps'} back={back} pad={false}>
      <div class="relative h-[34%] min-h-[210px]">
        <div ref={el} class="absolute inset-0" data-testid="report-map" />
        <div class="absolute top-2 left-2 right-2 z-[1000] pointer-events-none">
          <div class="bg-card/95 rounded-pill px-4 py-2 text-[13px] shadow-capsule">
            <div class="flex items-center justify-between"><GpsChip g={g} /><span class="text-[10px] font-bold uppercase tracking-wide text-muted">{mode === 'manual' ? 'Typed in' : mode === 'map' ? 'Pinned' : 'My GPS'}</span></div>
            <div class="num font-semibold" data-testid="report-coords">{pos ? fmtDd(pos.lat, pos.lon) : mode === 'manual' ? 'Enter the coordinate below' : 'No position yet — tap the map to place the fire'}</div>
          </div>
        </div>
      </div>
      <div class="p-4 space-y-4 overflow-y-auto" style={{ height: '66%' }}>
        {g.status === 'denied' && <Banner tone="err">Location permission is blocked. Tap the map to place the fire, and allow location in browser settings.</Banner>}
        {g.fix && q === 'poor' && mode === 'gps' && <Banner tone="warn">GPS is weak (±{Math.round(g.fix.acc)} m). You can still report; drag the flame on the map to correct it.</Banner>}
        <div>
          <div class="text-[13px] font-bold text-muted mb-1.5">Fire location</div>
          <div class="grid grid-cols-3 gap-1 p-1 bg-surface-low rounded-pill" role="tablist">
            {([['gps', 'My GPS', <LocateFixed size={15} />], ['map', 'Pin on map', <MapPin size={15} />], ['manual', 'Type / radio', <Keyboard size={15} />]] as const).map(([k, l, ic]) => (
              <button key={k} role="tab" aria-selected={mode === k} data-testid={'loc-' + k} onClick={() => { setMode(k); if (k === 'map' && !pin && live) setPin({ lat: live.lat, lon: live.lon }); }} class={cx('min-h-[40px] rounded-pill text-[12px] font-semibold inline-flex items-center justify-center gap-1', mode === k ? 'bg-card shadow-sm text-brand-deep' : 'text-muted')}>{ic}{l}</button>
            ))}
          </div>
          {mode === 'map' && <p class="text-[12px] text-muted mt-1.5">Tap the map or drag the flame to where the fire is.</p>}
        </div>
        {mode === 'manual' && (
          <div class="bg-card rounded-xl shadow-md p-3 space-y-3" data-testid="manual-panel">
            <div>
              <label class="text-[12px] font-semibold text-muted" for="coord">Coordinates read out from the field</label>
              <input id="coord" data-testid="coord-input" inputMode="text" autoComplete="off" spellcheck={false} class="mt-1 w-full min-h-[52px] rounded-lg border border-outline-v bg-card px-3 text-[17px] font-semibold num tracking-wide" placeholder="6.8287 N 0.8093 W  ·  or UTM 742110 755363" value={coordText} onInput={(e) => setCoordText((e.target as HTMLInputElement).value)} />
              <p class="text-[11px] text-muted mt-1">Accepts decimal degrees, degrees-minutes-seconds, or UTM 30N easting/northing. No N/S/E/W given → site default N and W.</p>
            </div>
            {parsed && !parsed.ok && <Banner tone="err" testid="coord-error">{parsed.error}</Banner>}
            {parsed?.ok && manualPos && (() => { const u = toUtm30(manualPos.lat, manualPos.lon); const where = locate(manualPos.lat, manualPos.lon); return (
              <div class={cx('rounded-xl p-3 space-y-1', farKm > 30 ? 'bg-fire-bg' : 'bg-cobalt-bg')} data-testid="readback">
                <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-muted"><Radio size={14} />Read back to the caller</div>
                <div class="text-[18px] font-bold num leading-6">{fmtDms(manualPos.lat, 'lat')}  {fmtDms(manualPos.lon, 'lon')}</div>
                <div class="text-[14px] font-semibold num">{fmtDd(manualPos.lat, manualPos.lon)} · UTM 30N {radioDigits(u.e)} E {radioDigits(u.n)} N</div>
                <div class="text-[12px] font-semibold">{where.compartment ? `${where.compartment} · ${where.block}` : 'Outside mapped compartments'}{live ? ` · ${fmtDistance(haversineM(live.lat, live.lon, manualPos.lat, manualPos.lon))} from you` : ''}</div>
                {parsed.assumedHemisphere && <div class="text-[12px] font-semibold text-amber">No N/S/E/W given — assumed North and West (site default). Confirm with the caller.</div>}
                {farKm > 30 && <div class="text-[13px] font-bold text-on-fire-bg" data-testid="far-warning">This is {Math.round(farKm)} km from the site — check the digits and E/W with the caller.</div>}
              </div>
            ); })()}
            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="text-[12px] font-semibold text-muted" for="observer">Seen by (field person)</label>
                <input id="observer" data-testid="observer" class="mt-1 w-full min-h-[48px] rounded-lg border border-outline-v bg-card px-3" placeholder="e.g. Kwame, Block B patrol" value={observer} onInput={(e) => setObserver((e.target as HTMLInputElement).value)} />
              </div>
              <div>
                <label class="text-[12px] font-semibold text-muted" for="seen">Time seen</label>
                <input id="seen" type="time" data-testid="seen-at" class="mt-1 w-full min-h-[48px] rounded-lg border border-outline-v bg-card px-3 num" value={seenAt} onInput={(e) => setSeenAt((e.target as HTMLInputElement).value)} />
              </div>
            </div>
            <div class="grid grid-cols-2 gap-2 items-end">
              <div>
                <div class="text-[12px] font-semibold text-muted mb-1">Received by</div>
                <div class="flex gap-1.5">{([['radio', 'Radio'], ['phone', 'Phone call']] as const).map(([k, l]) => <button key={k} data-testid={'via-' + k} onClick={() => setVia(k)} class={cx('flex-1 min-h-[44px] rounded-pill text-[12px] font-semibold', via === k ? 'bg-brand text-on-brand' : 'bg-sc')}>{l}</button>)}</div>
              </div>
              <div>
                <label class="text-[12px] font-semibold text-muted" for="acc">GPS accuracy read out (m)</label>
                <input id="acc" inputMode="decimal" class="mt-1 w-full min-h-[44px] rounded-lg border border-outline-v bg-card px-3 num" placeholder="optional" value={accText} onInput={(e) => setAccText((e.target as HTMLInputElement).value.replace(/[^\d.]/g, ''))} />
              </div>
            </div>
          </div>
        )}
        {dups.length > 0 && !ack && (
          <Banner tone="warn" testid="dup-banner">
            Possible duplicate: {dups[0].code ?? dups[0].label} is {fmtDistance(haversineM(pos!.lat, pos!.lon, dups[0].lat, dups[0].lon))} away.
            <div class="flex gap-2 mt-2"><Button class="flex-1" onClick={() => go('incident/' + dups[0].id)}>View it</Button><Button class="flex-1" testid="report-anyway" onClick={() => setAck(true)}>Report anyway</Button></div>
          </Banner>
        )}
        <div>
          <div class="text-[13px] font-bold text-muted mb-1.5">Detected by</div>
          <div class="flex flex-wrap gap-2">{SOURCES.map(([k, l]) => <button key={k} data-testid={'src-' + k} onClick={() => setSource(k)} class={cx('px-3.5 min-h-[44px] rounded-pill text-[13px] font-semibold', source === k ? 'bg-brand text-on-brand' : 'bg-card shadow-sm')}>{l}</button>)}</div>
        </div>
        <div>
          <div class="text-[13px] font-bold text-muted mb-1.5">Size</div>
          <div class="flex flex-wrap gap-2">{SIZES.map(([k, l]) => <button key={k} data-testid={'size-' + k} onClick={() => setSize(k)} class={cx('px-3.5 min-h-[44px] rounded-pill text-[13px] font-semibold', size === k ? 'bg-brand text-on-brand' : 'bg-card shadow-sm')}>{l}</button>)}</div>
        </div>
        <div class="flex gap-2">
          <input data-testid="notes" class="flex-1 min-h-[48px] rounded-lg border border-outline-v bg-card px-3" placeholder="Notes (optional) — smoke colour, wind, access…" value={notes} onInput={(e) => setNotes((e.target as HTMLInputElement).value)} />
          <button aria-label="Add photo" class={cx('w-12 rounded-lg flex items-center justify-center', photo ? 'bg-moss text-on-moss' : 'bg-sc')} onClick={() => file.current?.click()}><Camera size={20} /></button>
          <input ref={file} type="file" accept="image/*" capture="environment" class="hidden" onChange={(e) => setPhoto((e.target as HTMLInputElement).files?.[0] ?? null)} />
        </div>
        <Button kind="danger" full testid="submit-report" disabled={busy || (dups.length > 0 && !ack) || (mode === 'manual' && !manualPos)} icon={<Flame size={22} />} class="min-h-[64px] text-[18px]" onClick={() => void submit()}>
          {busy ? 'Saving…' : mode === 'manual' ? 'REPORT RELAYED FIRE' : 'REPORT FIRE'}
        </Button>
        <p class="text-[12px] text-muted text-center">Saved on this phone first. It sends by itself as soon as there is any signal.</p>
        <div class="h-8" />
      </div>
    </Screen>
  );
}
