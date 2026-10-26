import { useState } from 'preact/hooks';
import { dispatchCrews } from '../core/actions';
import { getState, toast, useStore } from '../core/store';
import { Banner, Button, Card, Screen, cx } from './kit';
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

  return (
    <Screen title="Dispatch crews" sub={`${inc.code ?? inc.label} · ${inc.block ?? 'unmapped'}`} back={back}>
      <Banner tone="info">{night ? 'Night shift: night crews pre-selected (after 18:00).' : 'Day shift: day crews pre-selected.'} Change as needed. Crews are told on their phone with an alarm; they must acknowledge.</Banner>
      <div class="space-y-2">
        {s.crews.map((c) => {
          const on = chosen.includes(c.id), done = already.has(c.id);
          return (
            <button key={c.id} disabled={done} data-testid={'crew-' + c.name.replace(/\W+/g, '-')} aria-pressed={on} onClick={() => toggle(c.id)} class={cx('w-full text-left rounded-xl shadow-md p-4 flex items-center gap-3 min-h-[64px]', on ? 'bg-surface-low ring-2 ring-brand' : 'bg-card')}>
              <span class={cx('w-6 h-6 rounded-md border-2 flex items-center justify-center text-xs font-bold', on ? 'bg-brand border-brand text-on-brand' : 'border-outline')}>{on ? '✓' : ''}</span>
              <span class="flex-1"><b>{c.name}</b><span class="block text-xs text-muted">{c.shift === 'support' ? 'Support' : c.shift === 'night' ? 'Night standby' : 'Day standby'}{suggested(c.id) ? ' · suggested' : ''}{done ? ' · already dispatched' : ''}</span></span>
            </button>
          );
        })}
      </div>
      <Card>
        <label class="text-[13px] font-semibold">Instruction (optional)</label>
        <input data-testid="instruction" class="mt-1 w-full min-h-[48px] rounded-lg border border-outline-v bg-card px-3" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} placeholder="e.g. Meet at assembly point, bring beaters" />
      </Card>
      <Button kind="danger" full testid="send-dispatch" disabled={!chosen.filter((c) => !already.has(c)).length}
        onClick={async () => { await dispatchCrews(id, chosen.filter((c) => !already.has(c)), text); toast('Dispatched — saved, sending when signal allows'); go('incident/' + id); }}>
        Dispatch {chosen.filter((c) => !already.has(c)).length} crew(s)
      </Button>
      <div class="h-24" />
    </Screen>
  );
}
