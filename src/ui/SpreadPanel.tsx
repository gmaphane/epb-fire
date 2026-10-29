import { useState } from 'preact/hooks';
import { cardinal } from '../core/geo';
import { compass8, wxAge, type Weather } from '../core/weather';
import { THREAT_LABEL, type Threat } from '../core/spread';
import { cx } from './kit';

export const WindArrow = ({ from, size = 16 }: { from: number; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ transform: `rotate(${(from + 180) % 360}deg)` }} aria-label={`Wind from ${Math.round(from)}°`}>
    <path d="M12 21V5" stroke="#2563EB" stroke-width="2.6" stroke-linecap="round" />
    <path d="M6 10l6-7 6 7" fill="none" stroke="#2563EB" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

const LEVEL_STYLE: Record<string, string> = { burning: 'bg-fire text-on-fire', very_high: 'bg-fire-bg text-on-fire-bg', high: 'bg-fire-bg text-on-fire-bg', moderate: 'bg-amber-bg text-amber', low: 'bg-sc text-muted' };
const fmtMin = (m: number) => (m < 1 ? 'now' : m < 60 ? `~${Math.round(m)} min` : m < 600 ? `~${(m / 60).toFixed(1)} h` : '>10 h');
export const fmtDistanceShort = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/**
 * Compartments around the fire: distance and direction from the fire, and how long the fire would take
 * to reach each one if the current wind holds. Always visible for an open fire; the nearest 3 first.
 */
export function SpreadPanel({ wx, th }: { wx: Weather | null; th: Threat[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? th : th.slice(0, 3);
  const age = wx ? wxAge(wx) : 0;
  return (
    <section class="border-t border-line pt-3" data-testid="spread-panel">
      <div class="flex items-center justify-between gap-2">
        <h3 class="text-[15px] font-semibold">Compartments at risk</h3>
        {wx
          ? <span class="flex items-center gap-1 text-[13px] text-muted num" data-testid="spread-wind"><WindArrow from={wx.windFrom} size={14} />{compass8(wx.windFrom)} {Math.round(wx.windKmh)} km/h{wx.gustKmh != null ? ` · gust ${Math.round(wx.gustKmh)}` : ''}{age > 60 ? <span class="text-amber"> · old</span> : ''}</span>
          : <span class="text-[13px] text-amber" data-testid="spread-wind">No wind data · distance only</span>}
      </div>
      {shown.length ? (
        <div class="mt-1 divide-y divide-line">
          {shown.map((t) => (
            <div key={t.id} class="py-2 flex items-center gap-3" data-testid="threat-row">
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-1.5">
                  <span class="text-[15px] font-semibold whitespace-nowrap">{t.code}</span>
                  {t.yop != null && <span class={cx('px-1.5 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap', t.young ? 'bg-fire-bg text-on-fire-bg' : 'bg-sc text-muted')}>{t.young ? 'Young' : 'Bamboo'} {t.yop}</span>}
                </div>
                <div class="text-[13px] text-muted num truncate">{t.level === 'burning' ? 'Fire is inside' : `${fmtDistanceShort(t.distM)} ${cardinal(t.bearing)} of the fire${t.downwind ? ' · downwind' : ''}`}</div>
              </div>
              <div class="text-right shrink-0">
                <div class="text-[15px] font-semibold num">{t.level === 'burning' ? 'Now' : fmtMin(t.etaMin!)}</div>
                <span class={cx('inline-block px-1.5 py-0.5 rounded-md text-[11px] font-semibold', LEVEL_STYLE[t.level])}>{THREAT_LABEL[t.level]}</span>
              </div>
            </div>
          ))}
          {th.length > 3 && <button class="press pt-2 text-[14px] font-semibold text-cobalt" data-testid="spread-all" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${th.length}`}</button>}
        </div>
      ) : <p class="mt-2 text-[13px] text-muted">No compartment within 6 km of this fire.</p>}
      <p class="mt-2 text-[12px] text-faint leading-snug">Time for the fire to reach each compartment if the wind holds. A rough guide from wind speed and direction only; confirm on the ground.</p>
    </section>
  );
}
