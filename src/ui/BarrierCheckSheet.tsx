import { useState } from 'preact/hooks';
import { ClipboardCheck, X } from 'lucide-preact';
import { recordBarrierCheck } from '../core/actions';
import { toast, useStore } from '../core/store';
import { ago } from '../core/time';
import type { BarrierCheck } from '../core/types';
import type { BarrierRef } from './mapview';
import { Button, Choice, Sheet } from './kit';

const KIND: Record<string, string> = { road: 'Road', track: 'Track', firebreak: 'Firebreak', waterway: 'Stream', plantain_farm: 'Plantain farm' };
const CONT: [BarrierCheck['continuity'], string][] = [['continuous', 'Continuous'], ['broken', 'Has gaps'], ['unknown', 'Not sure']];
const COND: [BarrierCheck['condition'], string][] = [['good', 'Good'], ['fair', 'Fair'], ['poor', 'Poor / overgrown'], ['unknown', 'Not sure']];
const WIDTHS = [4, 6, 8, 10, 15, 20];

/**
 * Field check of a possible fire barrier. What makes it count as a real barrier (server rule, settings in
 * risk_config): checked within the last year, measured at least 10 m wide, continuous, and in good or fair condition.
 * Anything else stays "unverified" on the map and in alerts. Saved on the phone first; works with no signal.
 */
export function BarrierCheckSheet({ b, onClose }: { b: BarrierRef; onClose: () => void }) {
  const checks = useStore((s) => s.barrierChecks).filter((c) => c.barrier_id === b.id).sort((x, y) => y.checked_at.localeCompare(x.checked_at));
  const [width, setWidth] = useState('');
  const [cont, setCont] = useState<BarrierCheck['continuity'] | null>(null);
  const [cond, setCond] = useState<BarrierCheck['condition'] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const w = width.trim() === '' ? null : Number(width.replace(',', '.'));
  const widthBad = w != null && !(w > 0 && w < 500);
  const ready = cont != null && cond != null && !widthBad;
  const counts = w != null && w >= 10 && cont === 'continuous' && (cond === 'good' || cond === 'fair');

  const save = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      await recordBarrierCheck(b, { width_m: w, continuity: cont!, condition: cond!, note });
      toast(counts ? 'Check saved: counts as a barrier once synced' : 'Check saved (still not a reliable barrier)');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'err');
      setBusy(false);
    }
  };

  return (
    <Sheet testid="barrier-check" class="px-5 pb-5 space-y-4 max-h-[80vh] overflow-y-auto" onDown={onClose}>
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="font-display text-[20px] leading-tight flex items-center gap-2"><ClipboardCheck size={20} />Field check</h2>
          <p class="text-[14px] text-muted mt-1 truncate">{KIND[b.kind] ?? 'Barrier'} · {b.name}</p>
        </div>
        <button aria-label="Close" class="press w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-muted shrink-0" onClick={onClose}><X size={20} /></button>
      </div>

      <p class="text-[13px] text-muted">
        {checks.length
          ? <>Last checked {ago(checks[0].checked_at)} by {checks[0].by_name || 'crew'}: {checks[0].width_m != null ? `${checks[0].width_m} m, ` : 'width not measured, '}{CONT.find((c) => c[0] === checks[0].continuity)?.[1].toLowerCase()}, {COND.find((c) => c[0] === checks[0].condition)?.[1].toLowerCase()}{checks[0]._sync === 'pending' ? ' (waiting to sync)' : ''}.</>
          : 'Not checked in the field yet. Until it is, the map and alerts treat it as unverified.'}
      </p>

      <div>
        <label class="block text-[14px] font-medium mb-1.5" for="bw">Cleared width (m)</label>
        <div class="flex flex-wrap gap-1.5 mb-2">
          {WIDTHS.map((x) => <Choice key={x} selected={w === x} onClick={() => setWidth(String(x))} testid={`bw-${x}`}>{x}</Choice>)}
        </div>
        <input id="bw" data-testid="barrier-width" inputMode="decimal" value={width} onInput={(e) => setWidth((e.target as HTMLInputElement).value)}
          placeholder="Pace or tape it; leave empty if not measured"
          class="w-full h-11 rounded-2xl border border-line bg-card px-4 text-[15px]" />
        {widthBad && <p class="text-[13px] text-fire mt-1">Enter a width between 0 and 500 m.</p>}
      </div>

      <div>
        <div class="text-[14px] font-medium mb-1.5">Along the stretch you can see</div>
        <div class="flex flex-wrap gap-1.5">{CONT.map(([k, l]) => <Choice key={k} selected={cont === k} onClick={() => setCont(k)} testid={`bc-${k}`}>{l}</Choice>)}</div>
      </div>
      <div>
        <div class="text-[14px] font-medium mb-1.5">Condition (bare ground vs grass / regrowth)</div>
        <div class="flex flex-wrap gap-1.5">{COND.map(([k, l]) => <Choice key={k} selected={cond === k} onClick={() => setCond(k)} testid={`bq-${k}`}>{l}</Choice>)}</div>
      </div>
      <textarea data-testid="barrier-note" value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} rows={2}
        placeholder="Note (optional): e.g. grass regrown near the stream crossing"
        class="w-full rounded-2xl border border-line bg-card px-4 py-3 text-[15px]" />

      {ready && (
        <p data-testid="barrier-verdict" class="text-[13px] rounded-2xl px-3 py-2 bg-surface-low">
          {counts
            ? 'This will count as a reliable barrier (at least 10 m, continuous, good/fair) for the next 12 months.'
            : `This stays unverified: ${[w == null ? 'width not measured' : w < 10 ? 'narrower than 10 m' : '', cont !== 'continuous' ? 'not continuous' : '', cond === 'poor' || cond === 'unknown' ? 'condition not good/fair' : ''].filter(Boolean).join(', ')}.`}
        </p>
      )}
      <Button kind="primary" size="lg" full testid="barrier-save" disabled={!ready || busy} onClick={() => void save()}>Save check</Button>
      <p class="text-[12px] text-muted">Saved on this phone with your GPS position; it updates the map and alerts once synced.</p>
    </Sheet>
  );
}
