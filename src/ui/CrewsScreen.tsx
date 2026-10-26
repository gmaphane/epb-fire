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
  { key: 'on_scene', title: 'On scene', test: (p) => p.status === 'on_scene' && !isStale(p), tone: 'bg-[#0F172A] text-white', icon: Flame },
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
  const people = s.crewPositions.filter((p) => p.status !== 'off');
  const total = people.filter((p) => !isStale(p)).length;

  return (
    <Screen title="Crews" sub={`${total} sharing location`}>
      <Card>
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[15px] font-semibold">{sharing ? (s.presence!.status === 'standby' ? 'You are on standby' : s.presence!.status === 'en_route' ? `You are en route${incCode(s.presence!.incident_id) ? ` to ${incCode(s.presence!.incident_id)}` : ''}` : 'You are on scene') : 'You are not sharing your location'}</div>
            <div class="text-[12px] text-muted">{sharing ? 'Control can see where you are. Sent whenever there is signal.' : 'Check in when you start a standby shift.'}</div>
          </div>
          {sharing
            ? <Button kind="secondary" class="!min-h-[40px] shrink-0" testid="crews-checkout" onClick={() => void (s.presence!.status === 'standby' ? setPresence('off') : stopResponding()).then(() => toast('Location sharing updated'))}>{s.presence!.status === 'standby' ? 'Check out' : 'Stop'}</Button>
            : <Button kind="primary" class="!min-h-[40px] shrink-0" icon={<Radio size={16} />} testid="crews-checkin" onClick={() => void setPresence('standby').then(() => toast('Checked in. Sharing your location.'))}>Check in</Button>}
        </div>
      </Card>

      {GROUPS.map((gr) => {
        const list = people.filter(gr.test).sort((a, b) => (a.fix_at < b.fix_at ? 1 : -1));
        if (!list.length) return null;
        const Icon = gr.icon;
        return (
          <section key={gr.key} data-testid={'crews-' + gr.key}>
            <div class="text-[12px] font-semibold uppercase tracking-[.06em] text-muted mb-1.5 px-1">{gr.title} · {list.length}</div>
            <div class="bg-card rounded-2xl border border-line divide-y divide-line overflow-hidden">
              {list.map((p) => {
                const me = p.id === s.me?.id;
                const d = here && !me ? haversineM(here.lat, here.lon, p.lat, p.lon) : null;
                const inc = incCode(p.incident_id);
                return (
                  <button key={p.id} class="w-full flex items-center gap-3 px-3.5 py-2.5 text-left active:bg-surface-low"
                    onClick={() => { setState({ mapFocus: { lat: p.lat, lon: p.lon, zoom: 16, t: Date.now() } }); go('map'); }}>
                    <span class={cx('w-9 h-9 rounded-full flex items-center justify-center shrink-0', gr.tone)}><Icon size={17} /></span>
                    <span class="flex-1 min-w-0">
                      <span class="block text-[14px] font-semibold truncate">{p.name}{me ? ' (you)' : ''}</span>
                      <span class="block text-[12px] text-muted truncate">{[crewName(p.crew_id), inc ? `→ ${inc}` : null, `seen ${ago(p.fix_at)}`].filter(Boolean).join(' · ')}</span>
                    </span>
                    {d != null && <span class="text-right shrink-0 text-[12px] text-muted num">{fmtDistance(d)}<br />{cardinal(bearingDeg(here!.lat, here!.lon, p.lat, p.lon))}</span>}
                    <MapPin size={16} class="text-faint shrink-0" />
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
      {!people.length && <div class="text-center text-muted text-[14px] py-10">No one is sharing a location right now.<br />Crews appear here when they check in or respond to a fire.</div>}
    </Screen>
  );
}
