import type { ComponentChildren, JSX } from 'preact';
import { ChevronLeft, Check, CircleCheck, CircleHelp, CircleX, CloudCheck, CloudOff, Flame, Info, RefreshCw, Satellite, Search, ShieldCheck, TriangleAlert, Truck, User, Users, WifiOff } from 'lucide-preact';
import { quality, type GpsState } from '../core/gps';
import type { SyncState } from '../core/sync';
import type { IncidentStatus, SyncState as RowSync } from '../core/types';
import { STATUS_LABEL } from '../core/flow';
import { setState, toast } from '../core/store';
import { toUtm30 } from '../core/geo';

export const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(' ');

/** Calm buttons: pill shaped. primary = deep forest, danger = fire red (fire actions only), secondary = quiet outline. */
export function Button(p: {
  children: ComponentChildren; onClick?: () => void; kind?: 'primary' | 'danger' | 'secondary' | 'tonal' | 'ghost' | 'outline'; icon?: JSX.Element;
  disabled?: boolean; class?: string; full?: boolean; testid?: string; type?: 'button' | 'submit'; size?: 'md' | 'lg';
}) {
  const k = p.kind ?? 'secondary';
  return (
    <button
      type={p.type ?? 'button'} disabled={p.disabled} onClick={p.onClick} data-testid={p.testid}
      class={cx(
        'press rounded-pill font-semibold text-[15px] tracking-[-.005em] inline-flex items-center justify-center gap-2 px-5',
        p.size === 'lg' ? 'min-h-[54px] text-[16px]' : 'min-h-[48px]',
        k === 'primary' && 'bg-brand text-on-brand shadow-l1',
        k === 'danger' && 'bg-fire text-on-fire shadow-l1',
        k === 'secondary' && 'bg-card text-ink border border-line',
        k === 'tonal' && 'bg-sc text-ink',
        k === 'outline' && 'bg-transparent text-ink border border-outline-v',
        k === 'ghost' && 'bg-transparent text-muted',
        p.full && 'w-full', p.class,
      )}
    >
      {p.icon}{p.children}
    </button>
  );
}

/** Selectable option: pill chip (small choices) or tile (icon + label), CalmRoutes style. */
export function Choice(p: { selected: boolean; onClick: () => void; children: ComponentChildren; testid?: string; tile?: boolean; icon?: JSX.Element; class?: string }) {
  return (
    <button data-testid={p.testid} aria-pressed={p.selected} onClick={p.onClick}
      class={cx('press border font-medium', p.tile ? 'rounded-2xl flex flex-col items-center justify-center gap-1.5 min-h-[76px] px-2 text-[13px]' : 'rounded-pill min-h-[40px] px-4 text-[14px] inline-flex items-center gap-1.5',
        p.selected ? 'bg-brand border-brand text-on-brand' : 'bg-card border-line text-ink', p.class)}>
      {p.icon}{p.children}
    </button>
  );
}

/** Vertical swipe on a drawer: up / down by more than 30 px (or a plain tap, if onTap is given). */
export function swipe(on: { up?: () => void; down?: () => void; tap?: () => void }) {
  let y0: number | null = null, t0 = 0;
  return {
    onPointerDown: (e: PointerEvent) => { y0 = e.clientY; t0 = Date.now(); },
    onPointerUp: (e: PointerEvent) => {
      if (y0 == null) return;
      const dy = e.clientY - y0; y0 = null;
      if (dy < -30) on.up?.();
      else if (dy > 30) on.down?.();
      else if (Math.abs(dy) < 8 && Date.now() - t0 < 500) on.tap?.();
    },
    onPointerCancel: () => { y0 = null; },
    style: { touchAction: 'pan-x' } as any,
  };
}

/** Bottom sheet surface (floats over the map). */
export function Sheet(p: { children: ComponentChildren; class?: string; testid?: string; handle?: boolean; onUp?: () => void; onDown?: () => void; onHandle?: () => void; swipeAll?: boolean }) {
  return (
    <div data-testid={p.testid} class={cx('bg-card rounded-t-sheet shadow-sheet sheet-enter', p.class)} {...(p.swipeAll ? swipe({ up: p.onUp, down: p.onDown }) : {})}>
      {p.handle !== false && (
        <div role={p.onHandle ? 'button' : undefined} aria-label={p.onHandle ? 'Expand or collapse' : undefined} data-testid={p.testid ? p.testid + '-handle' : undefined}
          class={cx('pt-2.5 pb-2 flex justify-center select-none', (p.onHandle || p.onUp || p.onDown) && 'cursor-pointer')}
          {...swipe({ up: p.swipeAll ? undefined : p.onUp, down: p.swipeAll ? undefined : p.onDown, tap: p.onHandle })}>
          <span class="w-10 h-1.5 rounded-full bg-schh" />
        </div>
      )}
      {p.children}
    </div>
  );
}

/** Grouped list (settings style). */
export function Group(p: { title?: string; children: ComponentChildren; testid?: string }) {
  return (
    <section data-testid={p.testid}>
      {p.title && <h2 class="px-1 mb-2 text-[13px] font-medium text-muted">{p.title}</h2>}
      <div class="bg-card rounded-card border border-line divide-y divide-line overflow-hidden">{p.children}</div>
    </section>
  );
}
export function Row(p: { label: ComponentChildren; value?: ComponentChildren; icon?: JSX.Element; onClick?: () => void; testid?: string; sub?: ComponentChildren }) {
  const Tag = (p.onClick ? 'button' : 'div') as any;
  return (
    <Tag data-testid={p.testid} onClick={p.onClick} class={cx('w-full flex items-center gap-3 px-4 min-h-[52px] py-2.5 text-left', p.onClick && 'press active:bg-surface-low')}>
      {p.icon && <span class="text-muted shrink-0">{p.icon}</span>}
      <span class="flex-1 min-w-0"><span class="block text-[15px] truncate">{p.label}</span>{p.sub && <span class="block text-[13px] text-muted truncate">{p.sub}</span>}</span>
      {p.value !== undefined && <span class="text-[15px] text-muted num shrink-0 text-right">{p.value}</span>}
    </Tag>
  );
}

const STATUS_STYLE: Record<IncidentStatus, { c: string; dot: string; label: string }> = {
  reported: { c: 'text-on-fire-bg bg-fire-bg', dot: 'bg-fire', label: 'Unverified report' },
  confirmed: { c: 'text-on-fire-bg bg-fire-bg', dot: 'bg-fire', label: 'Active' },
  responding: { c: 'text-on-fire-bg bg-fire-bg', dot: 'bg-fire', label: 'Active · crews responding' },
  on_scene: { c: 'text-on-fire-bg bg-fire-bg', dot: 'bg-fire', label: 'Active · crews on scene' },
  contained: { c: 'text-on-moss bg-moss', dot: 'bg-ok', label: 'Contained' },
  controlled: { c: 'text-on-moss bg-moss', dot: 'bg-ok', label: 'Mop-up' },
  out: { c: 'text-on-moss bg-moss', dot: 'bg-ok', label: 'Out (cold)' },
  dismissed: { c: 'text-muted bg-sc', dot: 'bg-outline', label: 'False alarm' },
};
export const statusBar = (s: IncidentStatus) =>
  ({ reported: 'bg-fire', confirmed: 'bg-fire', responding: 'bg-fire', on_scene: 'bg-fire', contained: 'bg-ok', controlled: 'bg-ok', out: 'bg-ok', dismissed: 'bg-outline-v' })[s];

export function StatusChip({ s, short }: { s: IncidentStatus; short?: boolean }) {
  const st = STATUS_STYLE[s];
  const live = ['reported', 'confirmed', 'responding', 'on_scene'].includes(s);
  return (
    <span class={cx('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-[12px] leading-4 font-semibold whitespace-nowrap', st.c)} data-status={s}>
      <span class={cx('w-1.5 h-1.5 rounded-full', st.dot, live && 'animate-pulse')} />
      {short ? STATUS_LABEL[s] : st.label}
    </span>
  );
}
export const _unused = [Truck, Users, Check, Flame, User, CircleHelp, CircleX, CircleCheck, ShieldCheck];

export function SatChip({ text = 'Satellite · unverified' }: { text?: string }) {
  return <span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-pill text-[12px] font-semibold bg-sat-bg text-sat"><Satellite size={13} />{text}</span>;
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
    <button data-testid="sync-chip" onClick={onClick} class={cx('press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-[12px] font-semibold min-h-[26px] whitespace-nowrap', c)}>
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
    <span data-testid="gps-chip" class="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted num whitespace-nowrap">
      <span class={cx('w-1.5 h-1.5 rounded-full', dot, q === 'good' && 'animate-pulse')} />{text}
    </span>
  );
}

/** Stitch metric tile: tonal block, label over value, no borders. */
export function Metric(p: { label: string; value: string; unit?: string; big?: boolean; tone?: string; testid?: string }) {
  return (
    <div class="min-w-0 flex flex-col">
      <span class={cx('num font-semibold leading-tight truncate tracking-[-.02em]', p.big ? 'text-[30px]' : 'text-[18px]', p.tone ?? 'text-ink')} data-testid={p.testid}>
        {p.value}{p.unit && <span class="text-[13px] font-medium text-muted ml-1">{p.unit}</span>}
      </span>
      <span class="text-[12px] text-muted mt-0.5">{p.label}</span>
    </div>
  );
}

export function Banner(p: { tone: 'warn' | 'err' | 'info' | 'ok'; children: ComponentChildren; testid?: string }) {
  const c = { warn: 'bg-amber-bg text-amber', err: 'bg-fire-bg text-on-fire-bg', info: 'bg-sch text-ink', ok: 'bg-moss text-on-moss' }[p.tone];
  return <div data-testid={p.testid} class={cx('rounded-2xl px-4 py-3 text-[14px] font-medium fade-in', c)}>{p.children}</div>;
}

/** Calm header: serif title, no bar chrome. Back screens get a plain chevron. */
export function AppBar(p: { title: string; sub?: string; back?: () => void; right?: ComponentChildren }) {
  return (
    <header class="pt-safe shrink-0 z-[1050] relative bg-surface">
      <div class={cx('px-4 flex items-center gap-2', p.back ? 'h-14' : 'h-16')}>
        {p.back && <button aria-label="Back" onClick={p.back} class="press -ml-2 w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-ink"><ChevronLeft size={26} strokeWidth={2} /></button>}
        <div class="flex flex-col min-w-0 flex-1">
          <h1 class={cx('font-display truncate leading-tight', p.back ? 'text-[20px]' : 'text-[24px]')} data-testid="appbar-title">{p.title}</h1>
          {p.sub && <span class="text-[13px] text-muted truncate">{p.sub}</span>}
        </div>
        <div class="flex items-center shrink-0 -mr-2">
          {p.right}
          {!p.back && <button aria-label="Search" data-testid="appbar-search" onClick={() => setState({ overlay: 'search' })} class="press w-11 h-11 flex items-center justify-center rounded-full text-ink"><Search size={21} /></button>}
          <button aria-label="Status and info" data-testid="appbar-info" onClick={() => setState({ overlay: 'info' })} class="press w-11 h-11 flex items-center justify-center rounded-full text-ink"><Info size={21} /></button>
        </div>
      </div>
    </header>
  );
}

export function Screen(p: { title: string; sub?: string; right?: ComponentChildren; children: ComponentChildren; back?: () => void; pad?: boolean }) {
  return (
    <div class="h-full flex flex-col bg-surface screen-in">
      <AppBar title={p.title} sub={p.sub} back={p.back} right={p.right} />
      <main class={cx('flex-1 overflow-y-auto', p.pad !== false && 'px-4 pt-2 pb-28 space-y-5')}>{p.children}</main>
    </div>
  );
}

/** Stitch card: white, 12px radius, soft shadow, optional 6px status accent bar. */
export function Card(p: { children: ComponentChildren; class?: string; bar?: string; onClick?: () => void; testid?: string; pad?: string }) {
  return (
    <div data-testid={p.testid} onClick={p.onClick} class={cx('relative bg-card rounded-card border border-line overflow-hidden', p.onClick && 'press', p.class)}>
      {p.bar && <div class={cx('absolute left-0 top-4 bottom-4 w-1 rounded-r-full', p.bar)} />}
      <div class={p.pad ?? (p.bar ? 'pl-6 pr-5 py-5' : 'p-5')}>{p.children}</div>
    </div>
  );
}

export const SectionLabel = ({ children }: { children: ComponentChildren }) => (
  <div class="text-[13px] font-medium text-muted mb-2">{children}</div>
);

/** Round floating map tool button (Stitch tool rail). */
export function RailButton(p: { label: string; onClick: () => void; children: ComponentChildren; active?: boolean; testid?: string; tone?: string }) {
  return (
    <button aria-label={p.label} data-testid={p.testid} onClick={p.onClick}
      class={cx('press w-11 h-11 rounded-full shadow-rail flex items-center justify-center', p.active ? 'bg-brand text-on-brand' : cx('bg-card', p.tone ?? 'text-ink'))}>
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
    <button data-testid={testid} class="press w-full text-left rounded-2xl bg-surface-low border border-line px-4 py-3" aria-label="Copy coordinates"
      onClick={() => { void navigator.clipboard?.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)} | UTM 30N ${utm}`); toast('Coordinates copied'); }}>
      <div class={cx('num font-semibold tracking-[-.01em] whitespace-nowrap text-ink', compact ? 'text-[19px]' : 'text-[22px]')}>{dd}</div>
      <div class="flex items-baseline justify-between gap-2 mt-0.5">
        <span class={cx('num text-muted whitespace-nowrap', compact ? 'text-[13px]' : 'text-[14px]')}>UTM 30N {utm}</span>
        <span class="text-[12px] text-faint">Tap to copy</span>
      </div>
    </button>
  );
}
