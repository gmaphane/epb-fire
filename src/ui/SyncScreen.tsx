import { resetTour } from './Tour';
import { useEffect, useState } from 'preact/hooks';
import { Download, FileSpreadsheet, HardDrive, RefreshCw, Sun, Moon, Smartphone, Users } from 'lucide-preact';
import { downloadBlob, incidentsWorkbook } from '../core/exportIncidents';
import { engine, signOut } from '../boot';
import { CONFIG, IS_DEMO } from '../config';
import { getAll, outboxAll, storageEstimate, onDbChange, type OutboxItem, metaSet } from '../core/db';
import { setReadiness, saveTheme } from '../core/actions';
import { can } from '../core/flow';
import { downloadPack, packStatus, planPack, clearTiles, autoPackState, type AutoPack } from '../core/tiles';
import { getState, setState, toast, useStore } from '../core/store';
import { ago } from '../core/time';
import { Banner, Button, Card, GpsChip, Screen, SyncChip, cx } from './kit';
import { go, useGps, useNow } from './hooks';
import type { Incident, Perimeter } from '../core/types';
import { disablePush, enablePush, pushState, sendTestPush, type PushState } from '../core/push';

function download(name: string, mime: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function SyncScreen() {
  const s = useStore((x) => x);
  const g = useGps();
  const now = useNow(1000);
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [est, setEst] = useState<{ usage: number; quota: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const [pack, setPack] = useState<{ have: number; total: number } | null>(null);
  const [prog, setProg] = useState<{ done: number; total: number; failed: number } | null>(null);
  const plan = planPack();
  const sy = s.sync;
  const role = s.me?.role;

  const refresh = async () => { setItems(await outboxAll()); setEst(await storageEstimate()); setPersisted((await navigator.storage?.persisted?.()) ?? null); try { setPack(await packStatus(s.basemap)); } catch { /* no cache API */ } };
  useEffect(() => { void refresh(); const u = onDbChange((t) => { if (t === 'outbox') void refresh(); }); return u; }, [s.basemap]);
  // background download (started automatically after sign-in) shows its progress here too
  const [auto, setAuto] = useState<AutoPack | null>(autoPackState?.running ? autoPackState : null);
  useEffect(() => {
    const f = (e: Event) => { const d = (e as CustomEvent<AutoPack>).detail; setAuto(d.running ? d : null); if (!d.running) void refresh(); };
    window.addEventListener('ew-pack', f); return () => window.removeEventListener('ew-pack', f);
  }, [s.basemap]);

  const exportGeo = async () => {
    const inc = await getAll<Incident>('incidents'); const per = await getAll<Perimeter>('perimeters');
    const fc = { type: 'FeatureCollection', features: [
      ...inc.map((i) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [i.lon, i.lat] }, properties: { kind: 'incident', code: i.code, label: i.label, status: i.status, source: i.source, reported_at: i.reported_at, accuracy_m: i.accuracy_m, block: i.block, compartment: i.compartment, cause: i.cause, area_ha: i.area_ha } })),
      ...per.filter((p) => p.vertices.length >= 3).map((p) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...p.vertices.map((v) => [v.lon, v.lat]), [p.vertices[0].lon, p.vertices[0].lat]]] }, properties: { kind: 'perimeter', incident_id: p.incident_id, area_ha: p.area_ha, length_km: p.length_km, state: p.state } })),
    ] };
    download(`epb-fire-${new Date().toISOString().slice(0, 10)}.geojson`, 'application/geo+json', JSON.stringify(fc, null, 2));
  };
  const exportCsv = async () => {
    const inc = await getAll<Incident>('incidents');
    const cols = ['code', 'label', 'status', 'source', 'size_class', 'reported_at', 'lat', 'lon', 'accuracy_m', 'block', 'compartment', 'cause', 'area_ha', 'reported_by_name'] as const;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    download(`epb-fire-incidents-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv', [cols.join(','), ...inc.map((i) => cols.map((c) => esc((i as any)[c])).join(','))].join('\n'));
  };

  const doPack = async () => {
    setProg({ done: 0, total: plan.tiles, failed: 0 });
    try {
      const r = await downloadPack(s.basemap, (done, total, failed) => setProg({ done, total, failed }));
      toast(r.failed ? `Map pack: ${r.done - r.failed}/${r.total} tiles saved (${r.failed} failed)` : 'Offline map saved', r.failed ? 'warn' : 'ok');
    } catch (e) { toast((e as Error).message, 'err'); }
    setProg(null); void refresh();
  };

  const pending = items.filter((i) => i.status === 'pending'), errs = items.filter((i) => i.status === 'error');
  const mb = (n: number) => (n / 1048576).toFixed(0);

  return (
    <Screen title="Settings" right={<SyncChip s={sy} onClick={() => engine.kick(true)} />}>
      <Card testid="sync-status" pad="p-5">
        <div class="flex items-center justify-between"><div class="font-display text-[24px]">{sy?.simulateOffline || sy?.reachable === false ? 'Offline' : sy?.needsAuth ? 'Sign in needed' : sy?.reachable ? 'Connected' : 'Checking…'}</div><GpsChip g={g} /></div>
        <div class="grid grid-cols-3 gap-3 mt-4">
          <div><div class="text-[26px] font-semibold num leading-none" data-testid="count-pending">{pending.length}</div><div class="text-[12px] text-muted mt-1">waiting</div></div>
          <div><div class={cx('text-[26px] font-semibold num leading-none', errs.length > 0 && 'text-fire')} data-testid="count-errors">{errs.length}</div><div class="text-[12px] text-muted mt-1">errors</div></div>
          <div><div class="text-[16px] font-semibold leading-[26px]">{sy?.lastOkAt ? ago(new Date(sy.lastOkAt).toISOString(), now) : 'never'}</div><div class="text-[12px] text-muted mt-1">last sync</div></div>
        </div>
        {sy?.lastError && <div class="mt-3"><Banner tone={sy.needsAuth ? 'err' : 'info'}>{sy.lastError}{sy.nextRetryAt ? ` · retrying in ${Math.max(0, Math.round((sy.nextRetryAt - now) / 1000))} s` : ''}</Banner></div>}
        {pending.length > 0 && sy?.reachable === false && <div class="mt-3"><Banner tone="ok">Saved on this phone · sends when signal returns</Banner></div>}
        <div class="mt-4 grid grid-cols-2 gap-2">
          <Button kind="primary" testid="sync-now" icon={<RefreshCw size={18} class={sy?.running ? 'animate-spin' : ''} />} onClick={() => void engine.kick(true)}>Sync now</Button>
          <Button disabled={!errs.length} testid="retry-errors" onClick={() => void engine.retryErrors()}>Retry errors</Button>
        </div>
        {sy?.needsAuth && <div class="mt-3"><Button full kind="danger" onClick={() => void signOut()}>Sign in again</Button></div>}
      </Card>

      {items.length > 0 && (
        <Card>
          <h2 class="font-display text-[20px] mb-3">Waiting to send</h2>
          <div class="space-y-1.5 max-h-56 overflow-y-auto" data-testid="outbox-list">
            {items.slice(0, 40).map((i) => (
              <div key={i.key} class="flex items-start justify-between gap-2 text-[14px] border-b border-line last:border-0 pb-2">
                <div class="min-w-0"><b>{i.table}</b> <span class="text-muted">{i.id.slice(0, 8)}</span>{i.error && <div class={cx('text-xs truncate', i.status === 'error' ? 'text-fire' : 'text-muted')}>{i.error}</div>}</div>
                <span class={cx('text-xs font-bold shrink-0', i.status === 'error' ? 'text-fire' : 'text-amber')}>{i.status === 'error' ? 'ERROR' : i.attempts ? `try ${i.attempts + 1}` : 'queued'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {can(role, 'admin') && (
        <Card testid="admin-card">
          <h2 class="font-display text-[20px] mb-3">Admin</h2>
          <div class="grid grid-cols-2 gap-2">
            <Button kind="primary" testid="open-admin" icon={<Users size={17} />} onClick={() => go('admin')}>Users</Button>
            <Button testid="admin-export" icon={<FileSpreadsheet size={17} />} onClick={() => { downloadBlob(`EPB_fire_incidents_${new Date().toISOString().slice(0, 10)}.xlsx`, incidentsWorkbook()); toast('Spreadsheet downloaded'); }}>Incidents (Excel)</Button>
          </div>
        </Card>
      )}

      <AlertsCard />

      <Card>
        <h2 class="font-display text-[20px] mb-3">Ready for offline use?</h2>
        <ul class="space-y-2.5 text-[14px]">
          <Check ok={s.compartments.length > 0} label={`Site data (${s.compartments.length} compartments)`} bad="go online once and tap Sync now" />
          <Check ok={!!pack && pack.have >= pack.total * 0.9} label="Offline map" bad="downloads automatically when online" />
          <Check ok={persisted === true} label="Storage protected" bad="install the app to the home screen" />
          <Check ok={g.status === 'ok'} label="GPS working" bad={g.status === 'denied' ? 'Location blocked' : 'Waiting for GPS'} />
        </ul>
        {est && <div class="text-[13px] text-muted mt-3 flex items-center gap-1.5"><HardDrive size={14} />{mb(est.usage)} MB used</div>}
      </Card>

      <Card>
        <h2 class="font-display text-[20px] mb-3">Offline map pack</h2>
        <div class="flex p-1 bg-sc rounded-pill mb-3">{(['satellite', 'street'] as const).map((b) => <button key={b} onClick={() => { setState({ basemap: b }); void metaSet('basemap', b); }} class={cx('press flex-1 h-9 rounded-pill text-[14px] font-medium', s.basemap === b ? 'bg-card text-ink shadow-l1' : 'text-muted')}>{b === 'satellite' ? 'Satellite' : 'Street'}</button>)}</div>
        <div class="text-[14px] text-muted num">About {plan.estMb} MB · {plan.tiles} tiles</div>
        {!prog && auto && <div class="mt-2" data-testid="auto-pack"><div class="h-2 rounded-full bg-surface-mid overflow-hidden"><div class="h-full bg-brand" style={{ width: `${(auto.done / Math.max(1, auto.total)) * 100}%` }} /></div><div class="text-xs text-muted mt-1 num">Downloading automatically · {auto.done}/{auto.total}</div></div>}
        {prog && <div class="mt-2"><div class="h-2 rounded-full bg-surface-mid overflow-hidden"><div class="h-full bg-brand" style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} /></div><div class="text-xs text-muted mt-1 num">{prog.done}/{prog.total}{prog.failed ? ` · ${prog.failed} failed` : ''}</div></div>}
        <div class="grid grid-cols-2 gap-2 mt-3"><Button testid="download-pack" icon={<Download size={18} />} disabled={!!prog || !!auto || !plan.allowed} onClick={() => void doPack()}>Download map</Button><Button onClick={async () => { await clearTiles(); void refresh(); toast('Saved map tiles removed'); }}>Remove</Button></div>
        <p class="text-[12px] text-faint mt-3">Saves itself in the background when the phone is online (skipped on data saver). Development tile source; use licensed tiles before the pilot.</p>
      </Card>

      {can(role, 'readiness') && (
        <Card>
          <h2 class="font-display text-[20px] mb-3">Season readiness (shown to everyone)</h2>
          <div class="grid grid-cols-3 gap-2">
            {([['green', 'Green', 'bg-moss text-ok'], ['amber', 'Amber', 'bg-amber-bg text-amber'], ['red', 'Red', 'bg-fire-bg text-fire']] as const).map(([k, l, c]) => (
              <button key={k} data-testid={'ready-' + k} onClick={async () => { await setReadiness(k, s.readiness?.note ?? ''); toast(`Readiness ${l}`); }} class={cx('press min-h-[48px] rounded-pill font-semibold border-2', c, (s.readiness?.level ?? 'green') === k ? 'border-ink' : 'border-transparent')}>{l}</button>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <h2 class="font-display text-[20px] mb-3">Display</h2>
        <div class="flex p-1 bg-sc rounded-pill">{([['auto', 'Auto', <Smartphone size={16} />], ['day', 'Day', <Sun size={16} />], ['night', 'Night', <Moon size={16} />]] as const).map(([k, l, ic]) => <button key={k} data-testid={'theme-' + k} class={cx('press flex-1 h-10 rounded-pill text-[14px] font-medium inline-flex items-center justify-center gap-1.5', s.theme === k ? 'bg-card text-ink shadow-l1' : 'text-muted')} onClick={() => { setState({ theme: k }); void saveTheme(k); }}>{ic}{l}</button>)}</div>
        <p class="text-[13px] text-muted mt-2">Auto turns night mode on 18:00–06:00.</p>
      </Card>

      <Card>
        <h2 class="font-display text-[20px] mb-3">Data</h2>
        <div class="grid grid-cols-2 gap-2"><Button onClick={() => void exportGeo()} testid="export-geojson">Export GeoJSON</Button><Button onClick={() => void exportCsv()}>Export CSV</Button></div>
      </Card>

      <Card>
        <h2 class="font-display text-[20px] mb-3">Testing &amp; account</h2>
        <label class="flex items-center justify-between gap-3 min-h-[48px] text-[15px]">Simulate no network<input data-testid="sim-offline" type="checkbox" class="w-6 h-6 accent-[#2F8F5B]" checked={!!sy?.simulateOffline} onChange={(e) => engine.setSimulateOffline((e.target as HTMLInputElement).checked)} /></label>
        <div class="text-[13px] text-muted mt-1">{s.me?.name} · {s.me?.role} · v{CONFIG.version}{IS_DEMO ? ' · DEMO server' : ''}</div>
        <div class="grid grid-cols-2 gap-2 mt-3">
          <Button onClick={() => { if (s.me) resetTour(s.me.id); window.dispatchEvent(new Event('ew-tour')); }} testid="show-tour">Welcome tour</Button>
          <Button onClick={() => void signOut()} testid="signout" disabled={pending.length > 0}>{pending.length > 0 ? 'Send records first' : 'Sign out'}</Button>
          {IS_DEMO && <Button kind="danger" onClick={async () => { if (!confirm('Delete ALL data on this phone (demo)?')) return; indexedDB.deleteDatabase('epb-fire'); await clearTiles(); location.reload(); }}>Reset demo</Button>}
        </div>
      </Card>
    </Screen>
  );
}

function Check({ ok, label, bad }: { ok: boolean; label: string; bad: string }) {
  return <li class="flex items-start gap-3"><span class={cx('mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0', ok ? 'bg-moss text-on-moss' : 'bg-amber-bg text-amber')}>{ok ? '✓' : '!'}</span><span><span class="block">{label}</span>{!ok && <span class="block text-[13px] text-amber">{bad}</span>}</span></li>;
}

/** Push alerts on this phone: call-outs, new fire reports, satellite hotspots, daily fire danger. */
function AlertsCard() {
  const [st, setSt] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void pushState().then(setSt).catch(() => setSt('unsupported')); }, []);
  const run = async (f: () => Promise<PushState | string>) => {
    setBusy(true);
    try { const r = await f(); if (r === 'on' || r === 'off' || r === 'blocked' || r === 'demo' || r === 'unsupported') setSt(r); else toast(r); }
    catch (e) { toast((e as Error).message, 'err'); }
    setBusy(false);
  };
  const text: Record<PushState, string> = {
    on: 'On · this phone rings for call-outs and new fires',
    off: 'Off · alerts only while the app is open',
    blocked: 'Blocked · allow notifications in the phone settings',
    demo: 'Not available in demo mode',
    unsupported: 'Not supported here · on iPhone, add to Home Screen first',
  };
  return (
    <Card testid="alerts-card">
      <h2 class="font-display text-[20px] mb-3">Fire alerts on this phone</h2>
      <p class={cx('text-[15px]', st === 'on' ? 'text-ok' : st === 'blocked' ? 'text-fire' : 'text-ink')}>{st ? text[st] : 'Checking…'}</p>
      <div class="grid grid-cols-2 gap-2 mt-3">
        {st === 'on'
          ? <Button disabled={busy} onClick={() => void run(disablePush)}>Turn off</Button>
          : <Button kind="primary" testid="alerts-enable" disabled={busy || st === 'demo' || st === 'unsupported'} onClick={() => void run(enablePush)}>Turn on alerts</Button>}
        <Button disabled={busy || st !== 'on'} onClick={() => void run(sendTestPush)}>Send test alert</Button>
      </div>
    </Card>
  );
}
