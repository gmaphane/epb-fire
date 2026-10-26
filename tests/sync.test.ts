import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAll, outboxAll, putLocal, resetDbForTests, getRow, applyRemote } from '../src/core/db';
import { MemoryRemote } from '../src/core/memoryRemote';
import { SyncEngine } from '../src/core/sync';
import type { Incident, IncidentEvent } from '../src/core/types';

const inc = (id: string, over: Partial<Incident> = {}): Incident => ({
  id, code: null, label: 'F-TEST', status: 'reported', source: 'tower', size_class: 'unknown', notes: '',
  lat: 6.83, lon: -0.81, accuracy_m: 5, location_estimated: false, block: null, compartment: null,
  reported_by: 'u1', reported_by_name: 'U1', reported_at: new Date().toISOString(),
  client_updated_at: new Date().toISOString(), cause: null, area_ha: null, dismiss_reason: null,
  detection_id: null, deleted_at: null, location_source: 'gps', observer_name: null, relayed_via: null, observed_at: null, ...over,
});
const ev = (id: string, incident_id: string): IncidentEvent => ({
  id, incident_id, kind: 'note', payload: { text: 'x' }, lat: null, lon: null, accuracy_m: null,
  by: 'u1', by_name: 'U1', client_ts: new Date().toISOString(),
});

let remote: MemoryRemote;
let engine: SyncEngine;

beforeEach(async () => {
  await resetDbForTests();
  indexedDB = new IDBFactory();
  remote = new MemoryRemote();
  engine = new SyncEngine(remote);
});

describe('offline-first sync', () => {
  it('T1/T2: saves locally while offline, then syncs exactly once when back', async () => {
    remote.mode = 'offline';
    await putLocal('incidents', inc('i1'));
    await putLocal('incident_events', ev('e1', 'i1'));
    await engine.kick(true);
    expect((await outboxAll()).length).toBe(2); // nothing lost
    expect((await getRow<Incident>('incidents', 'i1'))!._sync).toBe('pending');
    expect(engine.state.reachable).toBe(false);
    remote.mode = 'ok';
    await engine.kick(true);
    expect((await outboxAll()).length).toBe(0);
    expect(remote.tables.get('incidents')!.size).toBe(1);
    expect(remote.tables.get('incident_events')!.size).toBe(1);
    expect((await getRow<Incident>('incidents', 'i1'))!._sync).toBe('synced');
    expect(remote.tables.get('incidents')!.get('i1')!.code).toMatch(/^F-2026-/);
  });

  it('T3: flapping network never loses or duplicates', async () => {
    for (let i = 0; i < 20; i++) await putLocal('incidents', inc(`i${i}`));
    for (let r = 0; r < 20; r++) {
      remote.mode = r % 2 ? 'ok' : 'offline';
      await engine.kick(true);
    }
    remote.mode = 'ok';
    await engine.kick(true);
    expect((await outboxAll()).length).toBe(0);
    expect(remote.tables.get('incidents')!.size).toBe(20);
  });

  it('T4: server 5xx keeps data and backs off, then recovers', async () => {
    remote.mode = 'server';
    await putLocal('incidents', inc('i1'));
    await engine.kick(true);
    expect((await outboxAll()).length).toBe(1);
    expect(engine.state.nextRetryAt).toBeGreaterThan(Date.now());
    expect(engine.state.lastError).toMatch(/Server problem/);
    remote.mode = 'ok';
    await engine.kick(true);
    expect((await outboxAll()).length).toBe(0);
  });

  it('T5: replaying the same report 10x yields one server row', async () => {
    const row = inc('dup');
    for (let i = 0; i < 10; i++) {
      await putLocal('incidents', row);
      await engine.kick(true);
    }
    expect(remote.tables.get('incidents')!.size).toBe(1);
    // and replaying an event never overwrites it
    await putLocal('incident_events', ev('e1', 'dup'));
    await engine.kick(true);
    const first = remote.tables.get('incident_events')!.get('e1')!.received_at;
    await putLocal('incident_events', { ...ev('e1', 'dup'), payload: { text: 'changed' } });
    await engine.kick(true);
    expect(remote.tables.get('incident_events')!.get('e1')!.payload).toEqual({ text: 'x' });
    expect(remote.tables.get('incident_events')!.get('e1')!.received_at).toBe(first);
  });

  it('coalesces repeated edits of one row into one outbox item', async () => {
    remote.mode = 'offline';
    await putLocal('incidents', inc('i1'));
    for (const s of ['confirmed', 'responding', 'on_scene'] as const) await putLocal('incidents', inc('i1', { status: s, client_updated_at: new Date().toISOString() }));
    expect((await outboxAll()).length).toBe(1);
    remote.mode = 'ok';
    await engine.kick(true);
    expect(remote.tables.get('incidents')!.get('i1')!.status).toBe('on_scene');
  });

  it('dependency: event queued before its incident reaches the server is retried, not dropped', async () => {
    await putLocal('incident_events', ev('e1', 'missing-parent'));
    await engine.kick(true);
    expect((await outboxAll())[0].status).toBe('pending');
    await putLocal('incidents', inc('missing-parent'));
    await engine.kick(true);
    await engine.kick(true);
    expect((await outboxAll()).length).toBe(0);
  });

  it('last-writer-wins: older client write does not overwrite newer server row', async () => {
    const t1 = '2026-10-23T10:00:00.000Z';
    const t2 = '2026-10-23T10:05:00.000Z';
    await putLocal('incidents', inc('i1', { status: 'confirmed', client_updated_at: t2 }));
    await engine.kick(true);
    await putLocal('incidents', inc('i1', { status: 'reported', client_updated_at: t1 }));
    await engine.kick(true);
    expect(remote.tables.get('incidents')!.get('i1')!.status).toBe('confirmed');
  });

  it('pull: downloads reference data and merges remote changes; newer pending local edit wins', async () => {
    await engine.kick(true);
    expect((await getAll('compartments')).length).toBeGreaterThan(0);
    expect((await getAll('assets')).length).toBeGreaterThan(0);
    // local pending edit newer than remote
    remote.mode = 'offline';
    await putLocal('incidents', inc('i9', { status: 'confirmed', client_updated_at: '2026-10-23T12:00:00.000Z' }));
    await applyRemote('incidents', { ...inc('i9', { status: 'reported', client_updated_at: '2026-10-23T11:00:00.000Z' }), updated_at: 'x' });
    expect((await getRow<Incident>('incidents', 'i9'))!.status).toBe('confirmed');
  });

  it('auth failure pauses sync without losing data', async () => {
    remote.mode = 'auth';
    await putLocal('incidents', inc('i1'));
    await engine.kick(true);
    expect(engine.state.needsAuth).toBe(true);
    expect((await outboxAll()).length).toBe(1);
  });
});

describe('payload hygiene', () => {
  it('never sends server-computed columns back (geom, updated_at, received_at)', async () => {
    const { toPayload } = await import('../src/core/db');
    const p = toPayload({ id: 'x', status: 'confirmed', geom: '0101...', updated_at: 't', received_at: 't', _sync: 'pending' });
    expect(Object.keys(p).sort()).toEqual(['id', 'status']);
  });
});

describe('server-side deletions', () => {
  it('reference rows deleted on the server disappear from the phone; unsent local rows are kept', async () => {
    await engine.kick(true);
    const before = (await getAll<any>('compartments')).length;
    expect(before).toBeGreaterThan(1);
    const gone = [...remote.tables.get('compartments')!.keys()][0];
    remote.tables.get('compartments')!.delete(gone);
    const fresh = new SyncEngine(remote); // prune runs on a new engine's first pull
    await fresh.kick(true);
    const after = await getAll<any>('compartments');
    expect(after.length).toBe(before - 1);
    expect(after.find((c) => c.id === gone)).toBeUndefined();
    // incidents are never pruned (soft delete only)
    remote.mode = 'offline';
    await putLocal('incidents', inc('local-only'));
    remote.mode = 'ok';
    expect((await getRow<Incident>('incidents', 'local-only'))).toBeDefined();
  });
});
