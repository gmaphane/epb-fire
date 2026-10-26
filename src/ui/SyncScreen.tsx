import { useEffect, useState } from 'preact/hooks';
import { Download, FileSpreadsheet, HardDrive, RefreshCw, Sun, Moon, Smartphone, Users } from 'lucide-preact';
import { downloadBlob, incidentsWorkbook } from '../core/exportIncidents';
import { engine, signOut } from '../boot';
import { CONFIG, IS_DEMO } from '../config';
import { getAll, outboxAll, storageEstimate, onDbChange, type OutboxItem, metaSet } from '../core/db';
import { setReadiness, saveTheme } from '../core/actions';
import { can } from '../core/flow';
import { downloadPack, packStatus, planPack, clearTiles } from '../core/tiles';
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
    <Screen title="Settings" sub="Sync, alerts, offline map" right={<SyncChip s={sy} onClick={() => engine.kick(true)} />}>
      <Card testid="sync-status">
        <div class="flex items-center justify-between"><div class="text-[18px] font-bold">{sy?.simulateOffline || sy?.reachable === false ? 'Offline' : sy?.needsAuth ? 'Sign in needed' : sy?.reachable ? 'Connected' : 'Checking…'}</div><GpsChip g={g} /></div>
        <div class="grid grid-cols-3 gap-2 mt-3 text-center">
          <div class="bg-surface-low rounded-xl py-2"><div class="text-[22px] font-bold num" data-testid="count-pending">{pending.length}</div><div class="text-[11px] text-muted font-semibold">waiting</div></div>
          <div class="bg-surface-low rounded-xl py-2"><div class={cx('text-[22px] font-bold num', errs.length > 0 && 'text-fire')} data-testid="count-errors">{errs.length}</div><div class="text-[11px] text-muted font-semibold">errors</div></div>
          <div class="bg-surface-low rounded-xl py-2"><div class="text-[14px] font-bold pt-1.5">{sy?.lastOkAt ? ago(new Date(sy.lastOkAt).toISOString(), now) : 'never'}</div><div class="text-[11px] text-muted font-semibold">last sync</div></div>
        </div>
        {sy?.lastError && <div class="mt-3"><Banner tone={sy.needsAuth ? 'err' : 'info'}>{sy.lastError}{sy.nextRetryAt ? ` · retrying in ${Math.max(0, Math.round((sy.nextRetryAt - now) / 1000))} s` : ''}</Banner></div>}
        {pending.length > 0 && sy?.reachable === false && <div class="mt-3"><Banner tone="ok">Everything is saved on this phone. It sends by itself when signal returns.</Banner></div>}
        <div class="mt-3 grid grid-cols-2 gap-2">
          <Button kind="primary" testid="sync-now" icon={<RefreshCw size={18} class={sy?.running ? 'animate-spin' : ''} />} onClick={() => void engine.kick(true)}>Sync now</Button>
          <Button disabled={!errs.length} testid="retry-errors" onClick={() => void engine.retryErrors()}>Retry errors</Button>
        </div>
        {sy?.needsAuth && <div class="mt-3"><Button full kind="danger" onClick={() => void signOut()}>Sign in again</Button></div>}
      </Card>

      {items.length > 0 && (
        <Card>
          <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Waiting to send</div>
          <div class="space-y-1.5 max-h-56 overflow-y-auto" data-testid="outbox-list">
            {items.slice(0, 40).map((i) => (
              <div key={i.key} class="flex items-start justify-between gap-2 text-[13px] border-b border-line pb-1.5">
                <div class="min-w-0"><b>{i.table}</b> <span class="text-muted">{i.id.slice(0, 8)}</span>{i.error && <div class={cx('text-xs truncate', i.status === 'error' ? 'text-fire' : 'text-muted')}>{i.error}</div>}</div>
                <span class={cx('text-xs font-bold shrink-0', i.status === 'error' ? 'text-fire' : 'text-amber')}>{i.status === 'error' ? 'ERROR' : i.attempts ? `try ${i.attempts + 1}` : 'queued'}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {can(role, 'admin') && (
        <Card testid="admin-card">
          <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Admin</div>
          <div class="grid grid-cols-2 gap-2">
            <Button kind="primary" testid="open-admin" icon={<Users size={17} />} onClick={() => go('admin')}>Users</Button>
            <Button testid="admin-export" icon={<FileSpreadsheet size={17} />} onClick={() => { downloadBlob(`EPB_fire_incidents_${new Date().toISOString().slice(0, 10)}.xlsx`, incidentsWorkbook()); toast('Spreadsheet downloaded'); }}>Incidents (Excel)</Button>
          </div>
        </Card>
      )}

      <AlertsCard />

      <Card>
        <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Ready for offline use?</div>
        <ul class="space-y-1.5 text-[14px] font-semibold">
          <Check ok={s.compartments.length > 0} label={`Site data on phone (${s.compartments.length} compartments, ${s.assets.length} assets, ${s.roads.length} roads)`} bad="Not downloaded yet — go online once and tap Sync now" />
          <Check ok={!!pack && pack.have >= pack.total * 0.9} label={`Offline map (${pack?.have ?? 0}/${pack?.total ?? 0} tiles sampled)`} bad="Map not saved — download below while on Wi-Fi" />
          <Check ok={persisted === true} label="Storage protected from clean-up" bad="Not protected — install the app to the home screen" />
          <Check ok={g.status === 'ok'} label="GPS working" bad={g.status === 'denied' ? 'Location blocked' : 'Waiting for GPS'} />
        </ul>
        {est && <div class="text-xs text-muted mt-2 flex items-center gap-1"><HardDrive size={13} /> Phone storage used by app: {mb(est.usage)} MB of {mb(est.quota)} MB available</div>}
      </Card>

      <Card>
        <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Offline map pack</div>
        <div class="flex gap-2 mb-3">{(['satellite', 'street'] as const).map((b) => <button key={b} onClick={() => { setState({ basemap: b }); void metaSet('basemap', b); }} class={cx('flex-1 min-h-[44px] rounded-pill text-[13px] font-semibold', s.basemap === b ? 'bg-brand text-on-brand' : 'bg-card shadow-sm')}>{b === 'satellite' ? 'Satellite' : 'Street'}</button>)}</div>
        <div class="text-[13px] text-muted">Site area, zoom {CONFIG.packZoom.min}–{CONFIG.packZoom.max}: <b>{plan.tiles} tiles ≈ {plan.estMb} MB</b></div>
        {prog && <div class="mt-2"><div class="h-2 rounded-full bg-surface-mid overflow-hidden"><div class="h-full bg-brand" style={{ width: `${(prog.done / Math.max(1, prog.total)) * 100}%` }} /></div><div class="text-xs text-muted mt-1 num">{prog.done}/{prog.total}{prog.failed ? ` · ${prog.failed} failed` : ''}</div></div>}
        <div class="grid grid-cols-2 gap-2 mt-3"><Button testid="download-pack" icon={<Download size={18} />} disabled={!!prog || !plan.allowed} onClick={() => void doPack()}>Download map</Button><Button onClick={async () => { await clearTiles(); void refresh(); toast('Saved map tiles removed'); }}>Remove</Button></div>
        <div class="mt-3"><Banner tone="warn">Development tile source. Public tile servers generally do not allow bulk download — switch to licensed or self-hosted tiles before the pilot (see docs/05 §7).</Banner></div>
      </Card>

      {can(role, 'readiness') && (
        <Card>
          <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Season readiness (shown to everyone)</div>
          <div class="grid grid-cols-3 gap-2">
            {([['green', 'Green', 'bg-moss text-ok'], ['amber', 'Amber', 'bg-amber-bg text-amber'], ['red', 'Red', 'bg-fire-bg text-fire']] as const).map(([k, l, c]) => (
              <button key={k} data-testid={'ready-' + k} onClick={async () => { await setReadiness(k, s.readiness?.note ?? ''); toast(`Readiness ${l}`); }} class={cx('min-h-[48px] rounded-lg font-bold border-2', c, (s.readiness?.level ?? 'green') === k ? 'border-ink' : 'border-transparent')}>{l}</button>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Display</div>
        <div class="grid grid-cols-3 gap-2">{([['auto', 'Auto', <Smartphone size={16} />], ['day', 'Day', <Sun size={16} />], ['night', 'Night', <Moon size={16} />]] as const).map(([k, l, ic]) => <Button key={k} testid={'theme-' + k} class={s.theme === k ? '!bg-brand !text-on-brand' : ''} icon={ic} onClick={() => { setState({ theme: k }); void saveTheme(k); }}>{l}</Button>)}</div>
        <p class="text-xs text-muted mt-2">Auto switches to night mode 18:00–06:00.</p>
      </Card>

      <Card>
        <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Data</div>
        <div class="grid grid-cols-2 gap-2"><Button onClick={() => void exportGeo()} testid="export-geojson">Export GeoJSON</Button><Button onClick={() => void exportCsv()}>Export CSV</Button></div>
      </Card>

      <Card>
        <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Testing &amp; account</div>
        <label class="flex items-center gap-3 min-h-[48px] font-semibold"><input data-testid="sim-offline" type="checkbox" class="w-6 h-6 accent-[#16A34A]" checked={!!sy?.simulateOffline} onChange={(e) => engine.setSimulateOffline((e.target as HTMLInputElement).checked)} /> Simulate no network (testing)</label>
        <div class="text-[13px] text-muted mt-1">{s.me?.name} · {s.me?.role} · v{CONFIG.version}{IS_DEMO ? ' · DEMO server' : ''}</div>
        <div class="grid grid-cols-2 gap-2 mt-3">
          <Button onClick={() => void signOut()} testid="signout" disabled={pending.length > 0}>{pending.length > 0 ? 'Send records before switching user' : 'Switch user / sign out'}</Button>
          {IS_DEMO && <Button kind="danger" onClick={async () => { if (!confirm('Delete ALL data on this phone (demo)?')) return; indexedDB.deleteDatabase('epb-fire'); await clearTiles(); location.reload(); }}>Reset demo</Button>}
        </div>
      </Card>
      <div class="h-24" />
    </Screen>
  );
}

function Check({ ok, label, bad }: { ok: boolean; label: string; bad: string }) {
  return <li class="flex items-start gap-2"><span class={cx('mt-0.5 w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0', ok ? 'bg-ok text-on-brand' : 'bg-amber-bg text-amber')}>{ok ? '✓' : '!'}</span><span class={ok ? '' : 'text-amber'}>{ok ? label : `${label} — ${bad}`}</span></li>;
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
    on: 'On: this phone rings for call-outs and new fires, even when the app is closed.',
    off: 'Off: you only see alerts while the app is open.',
    blocked: 'Blocked: allow notifications for this site in the browser or phone settings, then come back.',
    demo: 'Not available in demo mode.',
    unsupported: 'This browser cannot receive alerts. On iPhone, add the app to the Home Screen first and open it from there.',
  };
  return (
    <Card testid="alerts-card">
      <div class="text-[12px] font-bold uppercase text-muted tracking-wide mb-2">Fire alerts on this phone</div>
      <p class={cx('text-[14px] font-semibold', st === 'on' ? 'text-ok' : st === 'blocked' ? 'text-fire' : 'text-ink')}>{st ? text[st] : 'Checking…'}</p>
      <p class="text-xs text-muted mt-1">Alerts: call-outs to your crew, new fire reports (coordinators), satellite hotspots near the estate (coordinators), and the fire danger rating every morning at 05:45.</p>
      <div class="grid grid-cols-2 gap-2 mt-3">
        {st === 'on'
          ? <Button disabled={busy} onClick={() => void run(disablePush)}>Turn off</Button>
          : <Button kind="primary" testid="alerts-enable" disabled={busy || st === 'demo' || st === 'unsupported'} onClick={() => void run(enablePush)}>Turn on alerts</Button>}
        <Button disabled={busy || st !== 'on'} onClick={() => void run(sendTestPush)}>Send test alert</Button>
      </div>
    </Card>
  );
}
