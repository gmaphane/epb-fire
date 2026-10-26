import { metaGet, metaSet, putLocal } from './db';
import { gps } from './gps';
import { haversineM } from './geo';
import { getState, setState } from './store';
import { nowIso } from './time';
import type { CrewPosition, CrewPosStatus } from './types';

/**
 * Live crew location sharing.
 * - Standby crews check in (status "standby") and their position is shared.
 * - Crews heading to a fire share "en_route", then "on_scene" (set automatically from the call-out buttons).
 * One row per user, overwritten in place. Offline, the outbox keeps only the latest position,
 * which is sent as soon as there is network.
 */
export interface Presence { status: CrewPosStatus; incident_id: string | null; since: string; before?: CrewPosStatus }

const SHARE_EVERY_MS = 30_000;
const SHARE_MOVE_M = 25;
const STALE_MS = 5 * 60_000;

let last: { lat: number; lon: number; t: number } | null = null;
let unsub: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export const isStale = (p: Pick<CrewPosition, 'fix_at'>, now = Date.now()) => now - Date.parse(p.fix_at) > STALE_MS;

async function share(force = false) {
  const me = getState().me;
  const pr = getState().presence;
  if (!me || !pr || pr.status === 'off') return;
  const f = gps.state.fix;
  if (!f) return;
  const now = Date.now();
  if (!force && last && now - last.t < SHARE_EVERY_MS && haversineM(last.lat, last.lon, f.lat, f.lon) < SHARE_MOVE_M) return;
  last = { lat: f.lat, lon: f.lon, t: now };
  const row: CrewPosition = {
    id: me.id, user_id: me.id, name: me.name, crew_id: me.crew_id,
    status: pr.status, incident_id: pr.incident_id,
    lat: f.lat, lon: f.lon, acc: Math.round(f.acc), heading: f.heading, speed: f.speed,
    fix_at: new Date(f.ts).toISOString(), client_updated_at: nowIso(),
  };
  await putLocal('crew_positions', row);
}

function run() {
  stop();
  const pr = getState().presence;
  if (!pr || pr.status === 'off') return;
  unsub = gps.subscribe(() => void share());
  timer = setInterval(() => void share(true), SHARE_EVERY_MS);
  void share(true);
}
function stop() {
  unsub?.(); unsub = null;
  if (timer) clearInterval(timer);
  timer = null;
}

export async function setPresence(status: CrewPosStatus, incident_id: string | null = null) {
  const prev = getState().presence;
  const responding = (x?: CrewPosStatus) => x === 'en_route' || x === 'on_scene';
  // remember what the person was doing before they responded, so "Stop" returns them there (not into sharing)
  const before = responding(status) ? (responding(prev?.status) ? prev?.before : prev?.status) ?? 'off' : undefined;
  const p: Presence = { status, incident_id, since: prev?.status === status && prev.incident_id === incident_id ? prev.since : nowIso(), before };
  setState({ presence: p });
  await metaSet('presence', p);
  last = null;
  if (status === 'off') {
    stop();
    const me = getState().me;
    const f = gps.state.fix;
    const mine = getState().crewPositions.find((c) => c.id === me?.id);
    // tell the server we stopped sharing (keeps last point, marked off) — only if we were sharing
    if (me && prev && prev.status !== 'off' && (mine || f)) {
      const base = mine ?? { id: me.id, user_id: me.id, name: me.name, crew_id: me.crew_id, lat: f!.lat, lon: f!.lon, acc: f!.acc, heading: null, speed: null, fix_at: new Date(f!.ts).toISOString() };
      await putLocal('crew_positions', { ...base, status: 'off', incident_id: null, client_updated_at: nowIso() } as CrewPosition);
    }
  } else run();
}

/** Leave a fire response: back to standby if they were checked in before, otherwise stop sharing. */
export async function stopResponding() {
  const pr = getState().presence;
  await setPresence(pr?.before && pr.before !== 'en_route' && pr.before !== 'on_scene' ? pr.before : 'off', null);
}

export async function startPresence() {
  const p = (await metaGet<Presence>('presence')) ?? null;
  setState({ presence: p });
  if (p && p.status !== 'off') run();
}
