import { MapPin, Radio, Truck, User, Flame } from 'lucide-preact';
import { setState, toast, useStore } from '../core/store';
import { isStale, setPresence, stopResponding } from '../core/presence';
import { cardinal, bearingDeg, fmtDistance, haversineM } from '../core/geo';
import { ago } from '../core/time';
import { Button, Card, Screen, cx } from './kit';
import { go, useGpsFix, useNow } from './hooks';
import type { CrewPosition } from '../core/types';

/**
 * Who is out there: everyone sharing a location, grouped by what they are doing.
 * The control room's accountability view (who went to the fire, when each was last seen).
 */
const GROUPS: { key: string; title: string; test: (p: CrewPosition) => boolean; tone: string; icon: typeof User }[] = [
  { key: 'on_scene', title: 'On scene', test: (p) => p.status === 'on_scene' && !isStale(p), tone: 'bg-fire text-on-fire', icon: Flame },
  { key: 'en_route', title: 'En route', test: (p) => p.status === 'en_route' && !isStale(p), tone: 'bg-cobalt text-white', icon: Truck },
  { key: 'standby', title: 'Standby', test: (p) => p.status === 'standby' && !isStale(p), tone: 'bg-sc text-ink', icon: User },
  { key: 'stale', title: 'Not seen in the last 5 min', test: (p) => p.status !== 'off' && isStale(p), tone: 'bg-amber-bg text-amber', icon: User },
];

export function CrewsScreen() {
  const s = useStore((x) => ({ crewPositions: x.crewPositions, crews: x.crews, incidents: x.incidents, me: x.me, presence: x.presence }));
  const g = useGpsFix();
  useNow(30_000); // refresh "x min ago"
  const here = g.fix;
  const sharing = s.presence && s.presence.status !== 'off';
  const crewName = (id: string | null) => s.crews.find((c) => c.id === id)?.name ?? null;
  const incCode = (id: string | null) => { const i = s.incidents.find((x) => x.id === id); return i ? i.code ?? i.label : null; };
  const openFire = (id: string | null) => { const i = id ? s.incidents.find((x) => x.id === id) : null; return !!i && !i.deleted_at && i.status !== 'out' && i.status !== 'dismissed'; };
  // "en route / on scene" for a fire that is closed or gone counts as standby, so it never sticks on screen
  const people = s.crewPositions.filter((p) => p.status !== 'off')
    .map((p) => ((p.status === 'en_route' || p.status === 'on_scene') && !openFire(p.incident_id) ? { ...p, status: 'standby' as const, incident_id: null } : p));
  const total = people.filter((p) => !isStale(p)).length;

  return (
    <Screen title="Crews" sub={`${total} sharing location`}>
      <Card class={sharing ? 'bg-moss border-transparent' : ''}>
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="font-display text-[19px] leading-snug">{sharing ? (s.presence!.status === 'standby' ? 'You are on standby' : s.presence!.status === 'en_route' ? `You are en route${incCode(s.presence!.incident_id) ? ` to ${incCode(s.presence!.incident_id)}` : ''}` : 'You are on scene') : 'You are not sharing your location'}</div>
            <div class="text-[13px] text-muted mt-0.5">{sharing ? 'Control can see where you are' : 'Check in when your shift starts'}</div>
          </div>
          {sharing
            ? <Button kind="secondary" class="shrink-0" testid="crews-checkout" onClick={() => void (s.presence!.status === 'standby' ? setPresence('off') : stopResponding()).then(() => toast('Location sharing updated'))}>{s.presence!.status === 'standby' ? 'Check out' : 'Stop'}</Button>
            : <Button kind="primary" class="shrink-0" icon={<Radio size={16} />} testid="crews-checkin" onClick={() => void setPresence('standby').then(() => toast('Checked in. Sharing your location.'))}>Check in</Button>}
        </div>
      </Card>

      {GROUPS.map((gr) => {
        const list = people.filter(gr.test).sort((a, b) => (a.fix_at < b.fix_at ? 1 : -1));
        if (!list.length) return null;
        const Icon = gr.icon;
        return (
          <section key={gr.key} data-testid={'crews-' + gr.key}>
            <h2 class="font-display text-[20px] mb-3 flex items-center gap-2">{gr.title} <span class="font-sans text-[14px] text-muted">{list.length}</span></h2>
            <div class="bg-card rounded-card border border-line divide-y divide-line overflow-hidden">
              {list.map((p) => {
                const me = p.id === s.me?.id;
                const d = here && !me ? haversineM(here.lat, here.lon, p.lat, p.lon) : null;
                const inc = incCode(p.incident_id);
                return (
                  <button key={p.id} class="press w-full flex items-center gap-3 px-4 py-3 text-left active:bg-surface-low"
                    onClick={() => { setState({ mapFocus: { lat: p.lat, lon: p.lon, zoom: 16, t: Date.now() } }); go('map'); }}>
                    <span class={cx('w-10 h-10 rounded-full flex items-center justify-center shrink-0', gr.tone)}><Icon size={18} /></span>
                    <span class="flex-1 min-w-0">
                      <span class="block text-[15px] font-semibold truncate">{p.name}{me ? ' (you)' : ''}</span>
                      <span class="block text-[13px] text-muted truncate">{[crewName(p.crew_id), inc ? `→ ${inc}` : null, `seen ${ago(p.fix_at)}`].filter(Boolean).join(' · ')}</span>
                    </span>
                    {d != null && <span class="text-right shrink-0 text-[14px] font-medium num">{fmtDistance(d)}<span class="block text-[12px] text-muted font-normal">{cardinal(bearingDeg(here!.lat, here!.lon, p.lat, p.lon))}</span></span>}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {!people.length && <div class="text-center py-12 fade-in"><div class="font-display text-[22px]">No one out yet</div><div class="text-[14px] text-muted mt-1">Crews appear here when they check in.</div></div>}
    </Screen>
  );
}
