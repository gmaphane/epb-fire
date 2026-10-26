import { CONFIG } from '../config';
import {
  applyRemote,
  applyRemoteBatch,
  countRows,
  getBlob,
  getRow,
  markFailed,
  markPushed,
  metaGet,
  metaSet,
  outboxAll,
  outboxCounts,
  pruneMissing,
  putLocalOnly,
  retryParked,
  type OutboxItem,
} from './db';
import { RemoteError, type Remote } from './remote';
import { TABLES, type PhotoRow, type TableName } from './types';

export interface SyncState {
  running: boolean;
  /** true = last request succeeded, false = failed, null = unknown yet */
  reachable: boolean | null;
  pending: number;
  errors: number;
  lastOkAt: number | null;
  lastError: string | null;
  needsAuth: boolean;
  nextRetryAt: number | null;
  clockSkewMs: number | null;
  simulateOffline: boolean;
}

const OVERLAP_MS = 5000;
/** Reference tables are edited/deleted on the server (by admins or loaders); phones must mirror deletions. */
const REFERENCE: TableName[] = ['compartments', 'roads', 'assets', 'map_layers', 'crews', 'detections', 'fire_danger'];
const PRUNE_EVERY_MS = 5 * 60_000; // re-read a little behind the cursor so late-committing rows are not missed

export class SyncEngine {
  state: SyncState = {
    running: false,
    reachable: null,
    pending: 0,
    errors: 0,
    lastOkAt: null,
    lastError: null,
    needsAuth: false,
    nextRetryAt: null,
    clockSkewMs: null,
    simulateOffline: (() => { try { return sessionStorage.getItem('epb.simOffline') === '1'; } catch { return false; } })(),
  };
  private failStreak = 0;
  private again = false;
  private timers: ReturnType<typeof setInterval>[] = [];
  private lastPull = 0;
  private lastPrune = 0;
  private unsub: (() => void) | null = null;
  private listeners = new Set<(s: SyncState) => void>();

  constructor(public remote: Remote) {}

  onState(fn: (s: SyncState) => void) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }
  private set(patch: Partial<SyncState>) {
    if ((Object.keys(patch) as (keyof SyncState)[]).every((k) => Object.is(this.state[k], patch[k]))) return; // nothing changed
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  start() {
    this.timers.push(setInterval(() => void this.tick(), CONFIG.sync.tickMs));
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('offline', this.onOffline);
      document.addEventListener('visibilitychange', this.onVisible);
    }
    void this.refreshCounts();
    void this.kick(true);
    this.unsub = this.remote.subscribe((t, row) => void applyRemote(t, row));
  }
  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.unsub?.();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
      document.removeEventListener('visibilitychange', this.onVisible);
    }
  }
  private onOnline = () => void this.kick(true);
  private onOffline = () => this.set({ reachable: false });
  private onVisible = () => {
    if (document.visibilityState === 'visible') void this.kick(false);
  };

  async refreshCounts() {
    const c = await outboxCounts();
    this.set({ pending: c.pending, errors: c.errors });
  }

  private async tick() {
    await this.refreshCounts();
    const now = Date.now();
    const due = !this.state.nextRetryAt || now >= this.state.nextRetryAt;
    const needPull = now - this.lastPull > CONFIG.sync.pullMs;
    if (due && (this.state.pending > 0 || needPull)) await this.kick(false);
  }

  /** Run a sync now. `force` ignores back-off (manual sync, regained signal). */
  async kick(force: boolean) {
    if (force) {
      this.failStreak = 0;
      this.set({ nextRetryAt: null });
      if (this.state.errors > 0 && this.state.needsAuth === false) {
        /* parked items are retried only by an explicit user action */
      }
    }
    if (this.state.running) {
      this.again = true;
      return;
    }
    if (this.state.simulateOffline) {
      this.set({ reachable: false });
      await this.refreshCounts();
      return;
    }
    this.set({ running: true });
    try {
      do {
        this.again = false;
        await this.cycle();
      } while (this.again && this.failStreak === 0);
    } finally {
      await this.refreshCounts();
      this.set({ running: false });
    }
  }

  async retryErrors() {
    await retryParked();
    await this.kick(true);
  }

  setSimulateOffline(v: boolean) {
    try { sessionStorage.setItem('epb.simOffline', v ? '1' : '0'); } catch { /* tests / private mode */ }
    this.set({ simulateOffline: v, reachable: v ? false : this.state.reachable });
    if (!v) void this.kick(true);
  }

  private fail(e: unknown) {
    const err = e instanceof RemoteError ? e : new RemoteError('network', String((e as Error)?.message ?? e));
    if (err.kind === 'auth') {
      this.set({ needsAuth: true, lastError: 'Sign in again to sync', reachable: true });
      return;
    }
    this.failStreak++;
    const delay = Math.min(1000 * 2 ** (this.failStreak - 1), CONFIG.sync.backoffMaxMs);
    this.set({
      reachable: err.kind === 'network' ? false : true,
      lastError: err.kind === 'network' ? 'No connection — data is safe on this phone' : `Server problem (${err.status || err.message})`,
      nextRetryAt: Date.now() + delay,
    });
  }

  private ok() {
    this.failStreak = 0;
    this.set({ reachable: true, lastError: null, needsAuth: false, nextRetryAt: null, lastOkAt: Date.now() });
  }

  private async cycle() {
    if (!(await this.remote.ready())) {
      this.set({ needsAuth: true });
      return;
    }
    const pushed = await this.push();
    if (pushed === 'stop') return;
    await this.pull();
  }

  // ---------- push ----------
  private async push(): Promise<'done' | 'stop'> {
    const skipped = new Set<string>();
    for (let guard = 0; guard < 10_000; guard++) {
      const items = (await outboxAll()).filter((i) => i.status === 'pending' && !skipped.has(i.key));
      if (!items.length) return 'done';
      const first = items[0];
      const group: OutboxItem[] = [first];
      if (first.table !== 'photos') {
        for (const it of items.slice(1)) {
          if (it.table !== first.table || group.length >= CONFIG.sync.batch) break;
          group.push(it);
        }
      }
      try {
        if (first.table === 'photos') await this.pushPhoto(first);
        else await this.remote.upsert(first.table, group.map((g) => g.payload));
        for (const g of group) await markPushed(g);
        this.ok();
        await this.refreshCounts();
      } catch (e) {
        const err = e instanceof RemoteError ? e : new RemoteError('network', String((e as Error)?.message ?? e));
        if (err.kind === 'dependency') {
          // parent row not on the server yet; try again later, keep going with others
          for (const g of group) {
            await markFailed(g, err.message, false);
            skipped.add(g.key);
          }
          continue;
        }
        if (err.kind === 'rejected') {
          if (group.length > 1) {
            // isolate the poison row: retry singly
            for (const g of group) {
              try {
                await this.remote.upsert(g.table, [g.payload]);
                await markPushed(g);
              } catch (e2) {
                const er2 = e2 instanceof RemoteError ? e2 : new RemoteError('network', String((e2 as Error)?.message ?? e2));
                if (er2.kind !== 'rejected' && er2.kind !== 'dependency') { this.fail(er2); return 'stop'; } // signal lost: retry later, don't park
                await markFailed(g, er2.message, er2.kind === 'rejected');
              }
            }
            await this.refreshCounts();
            continue;
          }
          await markFailed(first, err.message, true);
          await this.refreshCounts();
          continue;
        }
        this.fail(err);
        return 'stop';
      }
    }
    return 'done';
  }

  private async pushPhoto(item: OutboxItem) {
    const row = await getRow<PhotoRow>('photos', item.id);
    if (row && !row.uploaded) {
      const blob = await getBlob(row.id);
      if (blob) {
        await this.remote.uploadPhoto(row.storage_path, blob);
        await putLocalOnly('photos', { ...row, uploaded: true });
        item.payload = { ...item.payload, uploaded: true };
      }
    } else if (row) {
      item.payload = { ...item.payload, uploaded: true };
    }
    await this.remote.upsert('photos', [item.payload]);
  }

  // ---------- pull ----------
  private async pull() {
    try {
      for (const t of TABLES) {
        const key = `cursor:${t}`;
        let cursor = (await metaGet<string>(key)) ?? null;
        // reference data missing on this phone (first run, cleared, or a stale cursor) → fetch it all again
        if (cursor && REFERENCE.includes(t as TableName) && (await countRows(t as TableName)) === 0) cursor = null;
        for (let page = 0; page < 200; page++) {
          const since = cursor ? new Date(new Date(cursor).getTime() - OVERLAP_MS).toISOString() : null;
          let rows: Record<string, any>[];
          try {
            rows = await this.remote.pull(t as TableName, since, 500);
          } catch (e) {
            // a table the server doesn't have yet (app newer than the database) must not stop the others
            if (e instanceof RemoteError && (e.status === 404 || /does not exist|schema cache/i.test(e.message))) break;
            throw e;
          }
          await applyRemoteBatch(t as TableName, rows);
          const max = rows.reduce<string | null>((m, r) => (r.updated_at && (!m || r.updated_at > m) ? r.updated_at : m), cursor);
          const advanced = max !== cursor;
          cursor = max;
          if (cursor) await metaSet(key, cursor);
          if (rows.length < 500 || !advanced) break;
        }
      }
      // Mirror server-side deletions of reference data (cheap: ids only), every few minutes.
      if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) {
        for (const t of REFERENCE) {
          try { await pruneMissing(t, await this.remote.listIds(t)); }
          catch (e) { if (!(e instanceof RemoteError && (e.status === 404 || /does not exist|schema cache/i.test(e.message)))) throw e; }
        }
        this.lastPrune = Date.now();
      }
      this.lastPull = Date.now();
      this.ok();
    } catch (e) {
      this.fail(e);
    }
  }
}
