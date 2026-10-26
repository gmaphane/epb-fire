import { openDB, type IDBPDatabase } from 'idb';
import { APPEND_ONLY, TABLES, type TableName } from './types';
import { IS_DEMO } from '../config';

/**
 * Device database (IndexedDB). Single source for the UI.
 * Every write goes through putLocal(): row + outbox item in ONE transaction (docs/05 §3.1).
 */
export interface OutboxItem {
  key: string; // `${table}:${id}`  (coalesces repeated edits of the same row)
  table: TableName;
  id: string;
  payload: Record<string, unknown>;
  seq: number; // FIFO order, kept when the item is coalesced
  rev: number; // bumps on every re-write of the same row
  attempts: number;
  status: 'pending' | 'error';
  error: string | null;
  created: number;
}

// Demo and live builds can run on the same address (localhost:4173); separate databases stop
// demo rows and sync cursors leaking into the live app.
const DB_NAME = IS_DEMO ? 'epb-fire-demo' : 'epb-fire';
let _db: Promise<IDBPDatabase> | null = null;

export function db(): Promise<IDBPDatabase> {
  if (!_db) {
    // v2 adds map_layers, v3 crew_positions, v4 fire_danger. Upgrades only create stores that are missing, so data on the phone is kept.
    _db = openDB(DB_NAME, 4, {
      upgrade(d) {
        for (const t of TABLES) if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: 'id' });
        if (!d.objectStoreNames.contains('outbox')) {
          const ob = d.createObjectStore('outbox', { keyPath: 'key' });
          ob.createIndex('seq', 'seq');
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      },
    });
  }
  return _db;
}

/** Test helper: drop the connection so a fresh fake-indexeddb can be used. */
export async function resetDbForTests() {
  if (_db) (await _db).close();
  _db = null;
}

type Listener = (table: TableName | 'outbox' | 'meta') => void;
const listeners = new Set<Listener>();
export const onDbChange = (l: Listener) => (listeners.add(l), () => listeners.delete(l));
const emit = (t: TableName | 'outbox' | 'meta') => listeners.forEach((l) => l(t));

/** Columns the server computes; sending them back is rejected (e.g. generated PostGIS geom). */
export const SERVER_ONLY = new Set(['updated_at', 'received_at', 'geom']);

export function toPayload(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('_')) continue; // local-only
    if (SERVER_ONLY.has(k)) continue; // server-owned
    out[k] = v;
  }
  return out;
}

export async function getAll<T>(table: TableName): Promise<T[]> {
  return (await (await db()).getAll(table)) as T[];
}
export async function countRows(table: TableName): Promise<number> {
  return (await db()).count(table);
}
export async function getRow<T>(table: TableName, id: string): Promise<T | undefined> {
  return (await (await db()).get(table, id)) as T | undefined;
}

export async function metaGet<T>(k: string): Promise<T | undefined> {
  const r = await (await db()).get('meta', k);
  return r?.v as T | undefined;
}
export async function metaSet(k: string, v: unknown) {
  await (await db()).put('meta', { k, v });
  emit('meta');
}

/** Save a row locally AND queue it for upload, atomically. */
export async function putLocal<T extends { id: string }>(table: TableName, row: T): Promise<T> {
  const d = await db();
  const tx = d.transaction([table, 'outbox', 'meta'], 'readwrite');
  const saved = { ...row, _sync: 'pending' } as T;
  await tx.objectStore(table).put(saved);
  const ob = tx.objectStore('outbox');
  const key = `${table}:${row.id}`;
  const existing = (await ob.get(key)) as OutboxItem | undefined;
  let seq = existing?.seq;
  if (seq === undefined) {
    const m = await tx.objectStore('meta').get('outboxSeq');
    seq = ((m?.v as number) ?? 0) + 1;
    await tx.objectStore('meta').put({ k: 'outboxSeq', v: seq });
  }
  const item: OutboxItem = {
    key,
    table,
    id: row.id,
    payload: toPayload(saved as unknown as Record<string, unknown>),
    seq,
    rev: (existing?.rev ?? 0) + 1,
    attempts: 0,
    status: 'pending',
    error: null,
    created: existing?.created ?? Date.now(),
  };
  await ob.put(item);
  await tx.done;
  emit(table);
  emit('outbox');
  return saved;
}

/** Save locally without queueing (drafts, reference data). */
export async function putLocalOnly<T extends { id: string }>(table: TableName, row: T) {
  await (await db()).put(table, row);
  emit(table);
}

export async function outboxAll(): Promise<OutboxItem[]> {
  const items = (await (await db()).getAllFromIndex('outbox', 'seq')) as OutboxItem[];
  return items;
}
/** Live positions are ephemeral: an unsent one from a previous user is simply dropped. */
export async function dropOutbox(table: TableName) {
  const d = await db();
  const tx = d.transaction('outbox', 'readwrite');
  for (const it of (await tx.store.getAll()) as OutboxItem[]) if (it.table === table) await tx.store.delete(it.key);
  await tx.done;
  emit('outbox');
}
export async function outboxCounts() {
  const all = await outboxAll();
  return { pending: all.filter((i) => i.status === 'pending').length, errors: all.filter((i) => i.status === 'error').length };
}

/** After a successful push: drop the item unless the row changed again while it was in flight. */
export async function markPushed(item: OutboxItem) {
  const d = await db();
  const tx = d.transaction([item.table, 'outbox'], 'readwrite');
  const cur = (await tx.objectStore('outbox').get(item.key)) as OutboxItem | undefined;
  if (cur && cur.rev === item.rev) {
    await tx.objectStore('outbox').delete(item.key);
    const row = await tx.objectStore(item.table).get(item.id);
    if (row) await tx.objectStore(item.table).put({ ...row, _sync: 'synced' });
  }
  await tx.done;
  emit(item.table);
  emit('outbox');
}

export async function markFailed(item: OutboxItem, error: string, park: boolean) {
  const d = await db();
  const tx = d.transaction([item.table, 'outbox'], 'readwrite');
  const cur = (await tx.objectStore('outbox').get(item.key)) as OutboxItem | undefined;
  if (cur) {
    await tx.objectStore('outbox').put({ ...cur, attempts: cur.attempts + 1, error, status: park ? 'error' : cur.status });
    if (park) {
      const row = await tx.objectStore(item.table).get(item.id);
      if (row) await tx.objectStore(item.table).put({ ...row, _sync: 'error' });
    }
  }
  await tx.done;
  emit('outbox');
  if (park) emit(item.table);
}

export async function retryParked() {
  const d = await db();
  const tx = d.transaction(['outbox'], 'readwrite');
  const os = tx.objectStore('outbox');
  for (const it of (await os.getAll()) as OutboxItem[]) {
    if (it.status === 'error') await os.put({ ...it, status: 'pending', error: null, attempts: 0 });
  }
  await tx.done;
  emit('outbox');
}

/** Merge a row received from the server. Newer local edits that are still queued win (last-writer-wins). */
export async function applyRemote(table: TableName, incoming: Record<string, any>) {
  const { geom: _g, ...row } = incoming; // the device never needs the server's PostGIS geometry column
  const d = await db();
  const tx = d.transaction(table, 'readwrite');
  const cur = (await tx.store.get(row.id)) as Record<string, any> | undefined;
  let write = true;
  if (cur) {
    if (cur._sync === 'synced' && row.updated_at && cur.updated_at === row.updated_at) write = false; // overlap re-read: unchanged
    else if (APPEND_ONLY.includes(table)) write = cur._sync !== 'synced' || !!row.updated_at; // keep identity, refresh server fields
    else if (cur._sync === 'pending' || cur._sync === 'error') {
      const lc = cur.client_updated_at as string | undefined;
      const rc = row.client_updated_at as string | undefined;
      if (lc && rc && lc > rc) write = false;
    }
  }
  if (write) await tx.store.put({ ...cur, ...row, _sync: 'synced' });
  await tx.done;
  if (write) emit(table);
}

/** Merge a page of server rows in ONE transaction (first sync of reference layers is hundreds of rows). */
export async function applyRemoteBatch(table: TableName, rows: Record<string, any>[]) {
  if (!rows.length) return;
  const d = await db();
  const tx = d.transaction(table, 'readwrite');
  let changed = false;
  for (const incoming of rows) {
    const { geom: _g, ...row } = incoming;
    const cur = (await tx.store.get(row.id)) as Record<string, any> | undefined;
    let write = true;
    if (cur) {
      if (cur._sync === 'synced' && row.updated_at && cur.updated_at === row.updated_at) write = false; // unchanged
      else if (APPEND_ONLY.includes(table)) write = cur._sync !== 'synced' || !!row.updated_at;
      else if (cur._sync === 'pending' || cur._sync === 'error') {
        const lc = cur.client_updated_at as string | undefined;
        const rc = row.client_updated_at as string | undefined;
        if (lc && rc && lc > rc) write = false;
      }
    }
    if (write) { await tx.store.put({ ...cur, ...row, _sync: 'synced' }); changed = true; }
  }
  await tx.done;
  if (changed) emit(table);
}

/** Remove local reference rows the server no longer has (deleted there). Never touches unsent local edits. */
export async function pruneMissing(table: TableName, serverIds: string[]): Promise<number> {
  const keep = new Set(serverIds);
  const d = await db();
  const tx = d.transaction(table, 'readwrite');
  let n = 0;
  for (const row of (await tx.store.getAll()) as Record<string, any>[]) {
    if (!keep.has(row.id) && row._sync !== 'pending' && row._sync !== 'error') {
      await tx.store.delete(row.id);
      n++;
    }
  }
  await tx.done;
  if (n) emit(table);
  return n;
}

export async function putBlob(id: string, blob: Blob) {
  await (await db()).put('blobs', { id, blob });
}
export async function getBlob(id: string): Promise<Blob | undefined> {
  return ((await (await db()).get('blobs', id)) as { blob: Blob } | undefined)?.blob;
}

export async function storageEstimate() {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
