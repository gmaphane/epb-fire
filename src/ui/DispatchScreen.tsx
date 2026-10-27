import { useState } from 'preact/hooks';
import { dispatchCrews } from '../core/actions';
import { getState, toast, useStore } from '../core/store';
import { Check } from 'lucide-preact';
import { Banner, Button, Screen, cx } from './kit';
import { back, go } from './hooks';
import { can } from '../core/flow';

export function DispatchScreen({ id }: { id: string }) {
  const s = useStore((x) => x);
  const inc = s.incidents.find((i) => i.id === id);
  const hr = new Date().getHours();
  const night = hr >= 18 || hr < 6;
  const suggested = (cid: string) => {
    const c = s.crews.find((x) => x.id === cid)!;
    return !!inc?.block && c.block === inc.block && c.shift === (night ? 'night' : 'day');
  };
  const [sel, setSel] = useState<string[] | null>(null);
  const [text, setText] = useState('');
  const chosen = sel ?? s.crews.filter((c) => suggested(c.id)).map((c) => c.id);
  const toggle = (cid: string) => setSel(chosen.includes(cid) ? chosen.filter((x) => x !== cid) : [...chosen, cid]);
  if (!inc) return <Screen title="Dispatch" back={back}><Banner tone="warn">Incident not found.</Banner></Screen>;
  if (!can(s.me?.role, 'dispatch')) return <Screen title="Dispatch" back={back}><Banner tone="warn">Only a coordinator can dispatch crews.</Banner></Screen>;
  const already = new Set(s.assignments.filter((a) => a.incident_id === id && a.state !== 'released').map((a) => a.crew_id));

  const n = chosen.filter((c) => !already.has(c)).length;
  return (
    <Screen title="Dispatch crews" sub={`${inc.compartment ?? inc.block ?? 'Unmapped'} · ${night ? 'night shift' : 'day shift'}`} back={back}>
      <div class="bg-card rounded-card border border-line divide-y divide-line overflow-hidden">
        {s.crews.map((c) => {
          const on = chosen.includes(c.id), done = already.has(c.id);
          return (
            <button key={c.id} disabled={done} data-testid={'crew-' + c.name.replace(/\W+/g, '-')} aria-pressed={on} onClick={() => toggle(c.id)} class={cx('press w-full text-left px-4 py-3.5 flex items-center gap-3 min-h-[64px] transition-colors', on && 'bg-moss/60')}>
              <span class="flex-1 min-w-0"><span class="block text-[16px] font-semibold">{c.name}</span><span class="block text-[13px] text-muted">{c.shift === 'support' ? 'Support' : c.shift === 'night' ? 'Night standby' : 'Day standby'}{suggested(c.id) ? ' · suggested' : ''}{done ? ' · already called' : ''}</span></span>
              <span class={cx('w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors shrink-0', on ? 'bg-brand border-brand text-on-brand' : 'border-outline-v')}>{on && <Check size={14} strokeWidth={3} />}</span>
            </button>
          );
        })}
      </div>
      <input data-testid="instruction" aria-label="Instruction (optional)" class="w-full min-h-[52px] rounded-2xl border border-line bg-card px-4 text-[16px] outline-none focus:border-brand" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder="Instruction (optional)" />
      <div class="space-y-2">
        <Button kind="danger" size="lg" full testid="send-dispatch" disabled={!n}
          onClick={async () => { await dispatchCrews(id, chosen.filter((c) => !already.has(c)), text); toast('Crews called'); go('incident/' + id); }}>
          {n ? `Call ${n} crew${n > 1 ? 's' : ''}` : 'Choose a crew'}
        </Button>
        <p class="text-[13px] text-faint text-center">Their phones ring until they acknowledge</p>
      </div>
    </Screen>
  );
}
