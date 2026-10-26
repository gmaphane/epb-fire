import { IS_DEMO } from './config';
import { dropOutbox, metaGet, metaSet, outboxCounts, requestPersistence } from './core/db';
import { gps } from './core/gps';
import { MemoryRemote } from './core/memoryRemote';
import { SupabaseRemote, type Remote } from './core/remote';
import { getState, hydrate, setState, startStoreSync } from './core/store';
import { SyncEngine } from './core/sync';
import { setPresence, startPresence } from './core/presence';
import type { Me } from './core/types';

export const remote: Remote = IS_DEMO ? new MemoryRemote({ latencyMs: 150 }) : new SupabaseRemote();
export const engine = new SyncEngine(remote);
let started = false;

function begin() {
  if (started) return;
  started = true;
  gps.start(); // warm the GNSS fix as early as possible
  engine.start();
  void startPresence();
}

export async function startApp() {
  engine.onState((s) => setState({ sync: s }));
  startStoreSync();
  void requestPersistence();
  await hydrate();
  const me = await metaGet<Me>('me');
  if (me) begin();
}

export async function signIn(email: string, password: string) {
  const me = await remote.signIn(email, password);
  const owner = await metaGet<string>('ownerId');
  if (owner && owner !== me.id) await dropOutbox('crew_positions');
  const { pending } = await outboxCounts();
  if (owner && owner !== me.id && pending > 0) {
    await remote.signOut();
    throw new Error('This phone still has unsent records from another user. Sign in as that user first so they can send.');
  }
  await metaSet('ownerId', me.id);
  await metaSet('me', me);
  setState({ me });
  begin();
  void engine.kick(true);
}

export async function signOut() {
  if (getState().presence && getState().presence!.status !== 'off') {
    await setPresence('off').catch(() => {});
    await engine.kick(true).catch(() => {}); // try to send the check-out before leaving
  }
  await remote.signOut();
  await metaSet('me', null);
  setState({ me: null });
}
