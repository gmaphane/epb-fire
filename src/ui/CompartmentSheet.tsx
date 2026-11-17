import { useState } from 'preact/hooks';
import { ChevronDown, X } from 'lucide-preact';
import { Banner, Metric, Sheet, cx } from './kit';
import { RATING_STYLE } from './mapview';
import type { Compartment } from '../core/types';
import type { Driver, Rating, RiskResult } from '../core/compartmentRisk';

/* Compartment card (17 Nov 2026): the bottom-sheet pattern used for fires and detections. One answer (rating +
   a sentence), three numbers, and the full driver list only on request. */

const INK: Record<Rating, string> = { low: '#166534', moderate: '#854D0E', high: '#9A3412', extreme: '#FFFFFF', unknown: '#334155' };
const DRY: Record<string, string> = { Low: 'moist', Moderate: 'moderately dry', High: 'dry', Extreme: 'very dry', 'Very high': 'very dry' };
const cls = (v: string) => v.replace(/ \(.*$/, '').replace(/,.*$/, '');
const LABEL: Record<string, string> = {
  dryness_in: 'Fuel dryness inside', dryness_out: 'Fuel dryness 2 km outside', barriers: 'Firebreaks on the estate edge',
  detections: 'Satellite fire detections', weather: 'Fire weather today',
};

function reason(d: Driver, c: Compartment): string {
  switch (d.key) {
    case 'dryness_in': return `fuel is ${DRY[cls(d.value)] ?? cls(d.value).toLowerCase()}`;
    case 'dryness_out': return `land outside is ${DRY[cls(d.value)] ?? cls(d.value).toLowerCase()}`;
    case 'barriers': return (c.edge_gap_pct ?? 0) > 0 ? `${c.edge_gap_pct}% of the estate edge has no firebreak` : 'edge firebreaks not checked in the field';
    case 'detections': return `satellite fire ${d.value}`;
    default: return `fire weather ${cls(d.value).toLowerCase()}`;
  }
}

export function CompartmentSheet({ c, r, onClose }: { c: Compartment; r?: RiskResult; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const p = (c.props ?? {}) as Record<string, any>;
  const rating: Rating = r?.rating ?? 'unknown';
  const st = RATING_STYLE[rating];
  const ap = r?.drivers.filter((d) => d.applies) ?? [];
  const concerns = ap.filter((d) => (d.score ?? 0) >= 1).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 2);
  const sentence = rating === 'unknown' ? 'Not enough current data to rate this compartment.'
    : concerns.length ? concerns.map((d) => reason(d, c)).join('; ').replace(/^./, (x) => x.toUpperCase()) + '.'
    : 'Nothing above low right now.';
  const stale = ap.filter((d) => d.stale);
  const dry = ap.find((d) => d.key === 'dryness_in');
  const burnt = p.burnt_2025_26_s2_ha ?? p.burnt_2023_24_s2_ha;
  const sub = [c.block.replace(/^(Block\s*)?/i, 'Block '), p.area_ha != null && `${Math.round(p.area_ha)} ha`, p.yop_youngest != null && `planted ${p.yop_youngest}`].filter(Boolean).join(' · ');

  return (
    <Sheet testid="compartment-sheet" class="px-5 pb-5 space-y-4 max-h-[62vh] overflow-y-auto" onDown={onClose}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="font-display text-[20px] leading-tight">{c.code}</h2>
          <p class="text-[14px] text-muted mt-1">{sub}</p>
        </div>
        <button aria-label="Close" class="press w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-muted shrink-0" onClick={onClose}><X size={20} /></button>
      </div>

      <div class="space-y-2">
        <span data-testid="risk-popup" class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-pill text-[12px] leading-4 font-semibold"
          style={{ background: rating === 'extreme' ? st.c : st.c + '40', color: INK[rating] }}>
          <span class="w-1.5 h-1.5 rounded-full" style={{ background: rating === 'extreme' ? '#fff' : st.c }} />
          {st.label} fire risk
        </span>
        <p class="text-[15px] leading-snug">{sentence}</p>
      </div>

      <div class="grid grid-cols-3 gap-3 rounded-2xl bg-surface-low px-4 py-3">
        <Metric label="Fuel dryness" value={dry && dry.score != null ? cls(dry.value) : '—'} />
        {c.edge
          ? <Metric label="Edge checked" value={c.edge_checked_at ? `${c.edge_protected_pct ?? 0}` : '—'} unit={c.edge_checked_at ? '%' : undefined} />
          : <Metric label="Fire weather" value={cls(ap.find((d) => d.key === 'weather')?.value ?? '—')} />}
        <Metric label={p.burnt_2025_26_s2_ha != null ? 'Burnt 2025/26' : 'Burnt 2023/24'} value={burnt != null ? `${Math.round(burnt)}` : '—'} unit={burnt != null ? 'ha' : undefined} />
      </div>

      {stale.length > 0 && <Banner tone="warn">Old or missing data: {stale.map((d) => LABEL[d.key].toLowerCase()).join(', ')}.</Banner>}

      <div>
        <button data-testid="compartment-more" class="press w-full flex items-center justify-between py-1 text-[14px] font-semibold text-muted" onClick={() => setMore((v) => !v)}>
          Why this rating
          <ChevronDown size={18} class={cx('transition-transform', more && 'rotate-180')} />
        </button>
        {more && (
          <div class="mt-2 divide-y divide-line">
            {ap.map((d) => (
              <div key={d.key} class="flex items-center justify-between gap-3 py-2.5 text-[14px]">
                <span class="min-w-0">{LABEL[d.key]}</span>
                <span class={cx('text-right shrink-0 font-medium', d.stale ? 'text-fire' : 'text-muted')}>{d.score == null ? 'unknown' : d.key === 'barriers' ? ((c.edge_gap_pct ?? 0) > 0 ? `${c.edge_gap_pct}% no firebreak` : `${c.edge_protected_pct ?? 0}% checked in field`) : d.key === 'detections' ? d.value.replace('none within 5 km in 7 days', 'none in 7 days') : cls(d.value)}</span>
              </div>
            ))}
            {p.hrz_overlap_pct != null && (
              <div class="flex items-center justify-between gap-3 py-2.5 text-[14px]"><span>2025 FMP high-risk zone</span><span class="text-muted font-medium">{p.hrz_overlap_pct}% of area</span></div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}
