import { useState } from 'preact/hooks';
import { BellRing, Flame, Map as MapIcon, Navigation } from 'lucide-preact';
import type { JSX } from 'preact';
import { useStore, toast } from '../core/store';
import { enablePush } from '../core/push';
import { CONFIG } from '../config';
import { Button, cx } from './kit';

const key = (id: string) => `ew-tour-done-${id}`;
export const tourSeen = (id: string) => { try { return localStorage.getItem(key(id)) === '1'; } catch { return true; } };
export const resetTour = (id: string) => { try { localStorage.removeItem(key(id)); } catch { /* ignore */ } };

/** A four-card welcome shown once per person on this phone (Settings → Show the welcome tour again). */
export function Tour({ onDone }: { onDone: () => void }) {
  const me = useStore((s) => s.me);
  const [i, setI] = useState(0);
  if (!me) return null;
  const first = me.name.replace(/^Demo /, '').split(' ')[0];
  const done = () => { try { localStorage.setItem(key(me.id), '1'); } catch { /* ignore */ } onDone(); };
  const steps: { icon: JSX.Element; tone: string; title: string; text: string }[] = [
    { icon: <MapIcon size={30} />, tone: 'bg-fire-bg text-fire', title: `Welcome, ${first}`, text: `${CONFIG.appName} shows fires, crews and the quickest way to reach them, even with no signal.` },
    { icon: <Flame size={30} fill="currentColor" />, tone: 'bg-fire text-on-fire', title: 'Report a fire in two taps', text: 'Tap the red button, check the pin (tap the map to move it), then Report. It sends as soon as there is signal.' },
    { icon: <Navigation size={30} />, tone: 'bg-cobalt text-white', title: 'Respond and navigate', text: 'Open a fire and tap Respond. The route follows the roads and control can see you. Tap Stop when you are done.' },
    { icon: <BellRing size={30} />, tone: 'bg-brand text-on-brand', title: 'Never miss a call-out', text: 'Turn on alerts so this phone rings for new fires and call-outs. Check in when your shift starts.' },
  ];
  const st = steps[i];
  const last = i === steps.length - 1;
  return (
    <div class="fixed inset-0 z-[2700] bg-black/40 flex items-end sm:items-center justify-center fade-in" data-testid="tour">
      <div class="w-full max-w-md bg-card rounded-t-sheet sm:rounded-sheet px-6 pt-8 pb-6 pb-safe sheet-enter">
        <div key={i} class="text-center fade-in">
          <div class={cx('w-16 h-16 rounded-full mx-auto flex items-center justify-center pop-in', st.tone)}>{st.icon}</div>
          <h2 class="font-display text-[24px] leading-tight mt-5" data-testid="tour-title">{st.title}</h2>
          <p class="text-[15px] text-muted mt-2 min-h-[66px]">{st.text}</p>
        </div>
        <div class="flex justify-center gap-1.5 my-5">{steps.map((_, k) => <span key={k} class={cx('h-1.5 rounded-full transition-all duration-300', k === i ? 'w-6 bg-brand' : 'w-1.5 bg-schh')} />)}</div>
        <div class="flex gap-2">
          {last
            ? <>
                <Button kind="secondary" size="lg" class="flex-1" testid="tour-done" onClick={done}>Later</Button>
                <Button kind="primary" size="lg" class="flex-1" icon={<BellRing size={18} />} onClick={async () => { try { const r = await enablePush(); toast(r === 'on' ? 'Alerts are on for this phone' : 'Alerts not turned on', r === 'on' ? 'ok' : 'warn'); } catch (e) { toast((e as Error).message, 'warn'); } done(); }}>Turn on alerts</Button>
              </>
            : <>
                <Button kind="ghost" size="lg" testid="tour-skip" onClick={done}>Skip</Button>
                <Button kind="primary" size="lg" class="flex-1" testid="tour-next" onClick={() => setI(i + 1)}>Next</Button>
              </>}
        </div>
      </div>
    </div>
  );
}
