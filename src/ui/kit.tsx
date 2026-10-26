import type { ComponentChildren, JSX } from 'preact';
import { ArrowLeft, Check, CircleCheck, CircleHelp, CircleX, CloudCheck, CloudOff, Flame, Info, RefreshCw, Satellite, Search, ShieldCheck, TriangleAlert, Truck, User, Users, WifiOff } from 'lucide-preact';
import { quality, type GpsState } from '../core/gps';
import type { SyncState } from '../core/sync';
import type { IncidentStatus, SyncState as RowSync } from '../core/types';
import { STATUS_LABEL } from '../core/flow';
import { setState, toast } from '../core/store';
import { toUtm30 } from '../core/geo';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/** Alpine buttons: primary = obsidian, danger = ember (fire actions only), secondary = subtle slate. */
export function Button(p: {
  children: ComponentChildren; onClick?: () => void; kind?: 'primary' | 'danger' | 'secondary' | 'tonal' | 'ghost' | 'outline'; icon?: JSX.Element;
  disabled?: boolean; class?: string; full?: boolean; testid?: string; type?: 'button' | 'submit'; size?: 'md' | 'lg';
}) {
  const k = p.kind ?? 'secondary';
  return (
    <button
      type={p.type ?? 'button'} disabled={p.disabled} onClick={p.onClick} data-testid={p.testid}
      class={cx(
        'rounded-xl font-semibold text-[15px] tracking-[-.01em] inline-flex items-center justify-center gap-2 px-4 active:scale-[.98] active:opacity-90 transition',
        p.size === 'lg' ? 'min-h-[52px] text-[15px]' : 'min-h-[48px]',
        k === 'primary' && 'bg-brand text-on-brand hover:bg-brand-c',
        k === 'danger' && 'bg-fire text-on-fire hover:bg-fire-dark',
        k === 'secondary' && 'bg-sc text-ink',
        k === 'tonal' && 'bg-sc text-brand-deep',
        k === 'outline' && 'bg-card text-ink border border-schh',
        k === 'ghost' && 'bg-transparent text-muted',
        p.full && 'w-full', p.class,
      )}
    >
      {p.icon}{p.children}
    </button>
  );
}

const STATUS_STYLE: Record<IncidentStatus, { c: string; dot?: string; icon?: JSX.Element; label?: string }> = {
  reported: { c: 'bg-fire-bg text-on-fire-bg', icon: <CircleHelp size={13} />, label: 'Unverified report' },
  confirmed: { c: 'bg-fire-bg text-on-fire-bg', dot: 'bg-fire', label: 'Active firefront' },
  responding: { c: 'bg-fire-bg text-on-fire-bg', dot: 'bg-fire', label: 'Active · crews responding' },
  on_scene: { c: 'bg-fire-bg text-on-fire-bg', dot: 'bg-fire', label: 'Active · crews on scene' },
  contained: { c: 'bg-cont-bg text-on-moss', icon: <ShieldCheck size={13} />, label: 'Contained' },
  controlled: { c: 'bg-moss text-on-moss', icon: <ShieldCheck size={13} />, label: 'Controlled' },
  out: { c: 'bg-moss text-on-moss', icon: <CircleCheck size={13} />, label: 'Out (cold black)' },
  dismissed: { c: 'bg-sc text-muted', icon: <CircleX size={13} />, label: 'False alarm' },
};
export const statusBar = (s: IncidentStatus) =>
  ({ reported: 'bg-fire', confirmed: 'bg-fire', responding: 'bg-fire', on_scene: 'bg-fire', contained: 'bg-ok', controlled: 'bg-ok', out: 'bg-ok', dismissed: 'bg-outline-v' })[s];

export function StatusChip({ s, short }: { s: IncidentStatus; short?: boolean }) {
  const st = STATUS_STYLE[s];
  return (
    <span class={cx('inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] leading-4 font-bold whitespace-nowrap', st.c)} data-status={s}>
      {st.dot ? <span class={cx('w-1.5 h-1.5 rounded-full', st.dot, 'animate-pulse')} /> : st.icon}
      {short ? STATUS_LABEL[s] : st.label}
    </span>
  );
}
export const _unused = [Truck, Users, Check];

export function SatChip({ text = 'Satellite · unverified' }: { text?: string }) {
  return <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-bold bg-sat-bg text-sat"><Satellite size={13} />{text}</span>;
}

export function RowSyncDot({ s }: { s?: RowSync }) {
  if (!s || s === 'synced') return <span class="inline-flex items-center gap-1 text-[11px] text-ok font-semibold" title="Synced"><CloudCheck size={13} />Synced</span>;
  if (s === 'error') return <span class="inline-flex items-center gap-1 text-[11px] text-fire font-semibold"><TriangleAlert size={13} />Sync error</span>;
  return <span class="inline-flex items-center gap-1 text-[11px] text-amber font-semibold" data-testid="row-pending"><CloudOff size={13} />On this phone</span>;
}

/** Compact sync pill (Stitch "Synced" pill in the map capsule). */
export function SyncChip({ s, onClick }: { s: SyncState | null; onClick: () => void }) {
  let text = 'Starting', c = 'bg-sc text-muted', dot = 'bg-outline', icon: JSX.Element | null = null;
  if (s) {
    if (s.needsAuth) { text = 'Sign in'; c = 'bg-fire-bg text-on-fire-bg'; dot = 'bg-fire'; }
    else if (s.errors > 0) { text = `${s.errors} error${s.errors > 1 ? 's' : ''}`; c = 'bg-fire-bg text-on-fire-bg'; dot = 'bg-fire'; }
    else if (s.simulateOffline || s.reachable === false) { text = s.pending ? `Offline · ${s.pending}` : 'Offline'; c = 'bg-sc text-slate'; icon = <WifiOff size={12} />; }
    else if (s.pending > 0) { text = `${s.pending} to send`; c = 'bg-amber-bg text-amber'; icon = <RefreshCw size={12} class={s.running ? 'animate-spin' : ''} />; }
    else if (s.reachable) { text = 'Synced'; c = 'bg-moss text-on-moss'; dot = 'bg-ok'; }
  }
  return (
    <button data-testid="sync-chip" onClick={onClick} class={cx('inline-flex items-center gap-1 px-2 py-0.5 rounded-pill text-[11px] font-semibold min-h-[24px] whitespace-nowrap', c)}>
      {icon ?? <span class={cx('w-1.5 h-1.5 rounded-full animate-pulse', dot)} />}<span>{text}</span>
    </button>
  );
}

export function GpsChip({ g, compact }: { g: GpsState; compact?: boolean }) {
  const q = quality(g.fix, g.now);
  const dot = { good: 'bg-ok', fair: 'bg-amber', poor: 'bg-fire', none: 'bg-outline' }[q];
  const text =
    g.status === 'denied' ? 'GPS blocked' :
    g.status === 'unavailable' ? 'No GPS' :
    !g.fix ? 'GPS acquiring…' :
    compact ? `±${Math.round(g.fix.acc)} m` : `GPS ±${Math.round(g.fix.acc)} m · ${Math.max(0, Math.round((g.now - g.fix.ts) / 1000))} s`;
  return (
    <span data-testid="gps-chip" class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted num whitespace-nowrap">
      <span class={cx('w-1.5 h-1.5 rounded-full', dot, q === 'good' && 'animate-pulse')} />{text}
    </span>
  );
}

/** Stitch metric tile: tonal block, label over value, no borders. */
export function Metric(p: { label: string; value: string; unit?: string; big?: boolean; tone?: string; testid?: string }) {
  return (
    <div class="bg-surface-low rounded-xl p-2.5 min-w-0 flex flex-col">
      <span class="text-[11px] font-semibold text-muted">{p.label}</span>
      <span class={cx('num font-semibold leading-tight mt-0.5 truncate', p.big ? 'text-[24px]' : 'text-[16px]', p.tone ?? 'text-ink')} data-testid={p.testid}>
        {p.value}{p.unit && <span class="text-[12px] font-semibold text-muted ml-1">{p.unit}</span>}
      </span>
    </div>
  );
}

export function Banner(p: { tone: 'warn' | 'err' | 'info' | 'ok'; children: ComponentChildren; testid?: string }) {
  const c = { warn: 'bg-amber-bg text-amber', err: 'bg-fire-bg text-on-fire-bg', info: 'bg-sch text-ink', ok: 'bg-moss text-on-moss' }[p.tone];
  return <div data-testid={p.testid} class={cx('rounded-xl px-3 py-2.5 text-[13px] font-semibold', c)}>{p.children}</div>;
}

/** Top app bar: obsidian flame mark, title, search, info, avatar. */
export function AppBar(p: { title: string; sub?: string; back?: () => void; right?: ComponentChildren }) {
  return (
    <header class="pt-safe blur-bar border-b border-line shrink-0 z-[1050] relative">
      <div class="h-14 px-4 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0 flex-1">
          {p.back ? (
            <button aria-label="Back" onClick={p.back} class="w-9 h-9 rounded-full bg-sc flex items-center justify-center shrink-0 text-ink"><ArrowLeft size={20} /></button>
          ) : (
            <div class="w-9 h-9 rounded-[10px] bg-[#0F172A] flex items-center justify-center shrink-0"><Flame size={19} class="text-[#EF4444]" fill="#EF4444" /></div>
          )}
          <div class="flex flex-col min-w-0">
            <h1 class="text-[17px] font-semibold tracking-[-.02em] leading-6 truncate" data-testid="appbar-title">{p.title}</h1>
            <span class="text-[10px] font-semibold tracking-[.06em] uppercase text-muted leading-[14px] truncate">{p.sub ?? 'EPBWA Fire'}</span>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          {p.right}
          {!p.back && <button aria-label="Search" data-testid="appbar-search" onClick={() => setState({ overlay: 'search' })} class="w-11 h-11 flex items-center justify-center rounded-full text-muted"><Search size={22} /></button>}
          <button aria-label="Status and info" data-testid="appbar-info" onClick={() => setState({ overlay: 'info' })} class="w-11 h-11 flex items-center justify-center rounded-full text-muted"><Info size={22} /></button>
        </div>
      </div>
    </header>
  );
}

export function Screen(p: { title: string; sub?: string; right?: ComponentChildren; children: ComponentChildren; back?: () => void; pad?: boolean }) {
  return (
    <div class="h-full flex flex-col bg-surface">
      <AppBar title={p.title} sub={p.sub} back={p.back} right={p.right} />
      <main class={cx('flex-1 overflow-y-auto', p.pad !== false && 'px-4 pt-3 pb-4 space-y-3')}>{p.children}</main>
    </div>
  );
}

/** Stitch card: white, 12px radius, soft shadow, optional 6px status accent bar. */
export function Card(p: { children: ComponentChildren; class?: string; bar?: string; onClick?: () => void; testid?: string; pad?: string }) {
  return (
    <div data-testid={p.testid} onClick={p.onClick} class={cx('relative bg-card rounded-2xl border border-line shadow-l1 overflow-hidden', p.onClick && 'active:scale-[.99] transition-transform', p.class)}>
      {p.bar && <div class={cx('absolute left-0 top-0 bottom-0 w-1.5', p.bar)} />}
      <div class={p.pad ?? (p.bar ? 'pl-5 pr-4 py-4' : 'p-4')}>{p.children}</div>
    </div>
  );
}

export const SectionLabel = ({ children }: { children: ComponentChildren }) => (
  <div class="text-[10px] font-semibold uppercase tracking-[.06em] text-muted mb-2">{children}</div>
);

/** Round floating map tool button (Stitch tool rail). */
export function RailButton(p: { label: string; onClick: () => void; children: ComponentChildren; active?: boolean; testid?: string; tone?: string }) {
  return (
    <button aria-label={p.label} data-testid={p.testid} onClick={p.onClick}
      class={cx('w-11 h-11 rounded-full shadow-rail flex items-center justify-center active:scale-95 transition-transform', p.active ? 'bg-brand text-on-brand' : cx('bg-card/95 backdrop-blur', p.tone ?? 'text-ink'))}>
      {p.children}
    </button>
  );
}

/** Stitch red "N" compass dial. */
export const NorthDial = () => (
  <span class="flex flex-col items-center leading-none pointer-events-none">
    <span class="text-[9px] font-bold text-fire -mb-0.5">N</span>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 19 21 12 17 5 21 12 2" /></svg>
  </span>
);

/** Groups digits in threes for reading over the radio: 741380 → "741 380". */
const g3 = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const radioDd = (lat: number, lon: number) => `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;
export const radioUtm = (lat: number, lon: number) => { const u = toUtm30(lat, lon); return `${g3(u.e)} E  ${g3(u.n)} N`; };

/** Large, radio-ready fire coordinates (decimal degrees + UTM 30N). Tap to copy. */
export function CoordReadout({ lat, lon, testid, compact }: { lat: number; lon: number; testid?: string; compact?: boolean }) {
  const dd = radioDd(lat, lon), utm = radioUtm(lat, lon);
  return (
    <button data-testid={testid} class="w-full text-left rounded-xl bg-[#0F172A] text-white px-3.5 py-2.5 active:opacity-90" aria-label="Copy coordinates"
      onClick={() => { void navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)} | UTM 30N ${utm}`); toast('Coordinates copied'); }}>
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-[10px] font-semibold uppercase tracking-[.08em] text-white/60">Fire position · WGS84</span>
        <span class="text-[10px] text-white/50">tap to copy</span>
      </div>
      <div class={cx('font-mono font-semibold num tracking-tight whitespace-nowrap', compact ? 'text-[19px]' : 'text-[22px]')}>{dd}</div>
      <div class={cx('font-mono num text-white/85 whitespace-nowrap', compact ? 'text-[15px]' : 'text-[17px]')}><span class="text-white/55 text-[11px] font-sans font-semibold mr-1.5">UTM 30N</span>{utm}</div>
    </button>
  );
}
