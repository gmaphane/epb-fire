/**
 * Runs the app's real sync code (SupabaseRemote → supabase-js → PostgREST) against
 * Postgres + PostGIS with the project's migrations and Row-Level Security.
 * Needs: PostgREST at SUPA_REST (default http://localhost:3300) using JWT_SECRET, users seeded.
 *   npm run test:db
 */
import 'fake-indexeddb/auto';
import http from 'http';
import crypto from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { SupabaseRemote } from '../../src/core/remote';
import { SyncEngine } from '../../src/core/sync';
import { getAll, getRow, outboxAll, putLocal, resetDbForTests } from '../../src/core/db';
import type { Assignment, Incident, IncidentEvent } from '../../src/core/types';

const REST = process.env.SUPA_REST ?? 'http://localhost:3300';
const SECRET = process.env.JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';
const U = { reporter: '00000000-0000-4000-8000-0000000000a1', responder: '00000000-0000-4000-8000-0000000000a2', coordinator: '00000000-0000-4000-8000-0000000000a3' };
const CREW_B_DAY = '00000000-0000-4000-8000-000000000303';

const b64 = (o: object | Buffer) => Buffer.from(o instanceof Buffer ? o : JSON.stringify(o)).toString('base64url');
function jwt(sub: string) {
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${p}.${crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}

// Supabase URL layout: /rest/v1/<table> → PostgREST /<table>
let proxy: http.Server;
let base = '';
let down = false; // simulate the network/server going away
beforeAll(async () => {
  proxy = http.createServer((req, res) => {
    if (down) { req.socket.destroy(); return; }
    const url = new URL(REST + (req.url ?? '').replace(/^\/rest\/v1/, ''));
    const fwd = http.request(url, { method: req.method, headers: { ...req.headers, host: url.host } }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
    fwd.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(fwd);
  });
  await new Promise<void>((r) => proxy.listen(0, r));
  base = `http://127.0.0.1:${(proxy.address() as any).port}`;
});
afterAll(() => proxy.close());

class TestRemote extends SupabaseRemote {
  async ready() { return true; }
  subscribe() { return () => {}; } // Realtime isn't part of this harness; pull covers it
}
const remoteFor = (sub: string) => new TestRemote(createClient(base, 'anon-key-not-used', { accessToken: async () => jwt(sub) }));

async function freshDevice() {
  await resetDbForTests();
  indexedDB = new IDBFactory();
}

const now = () => new Date().toISOString();
const inc = (over: Partial<Incident> = {}): Incident => ({
  id: crypto.randomUUID(), code: null, label: 'F-TEST', status: 'reported', source: 'patrol', size_class: 'small', notes: 'integration',
  lat: 6.8165, lon: -0.81, accuracy_m: 5, location_estimated: false, block: 'Block C', compartment: 'DEMO-C05',
  reported_by: U.reporter, reported_by_name: 'Reporter', reported_at: now(), client_updated_at: now(),
  cause: null, area_ha: null, dismiss_reason: null, detection_id: null, deleted_at: null,
  location_source: 'manual', observer_name: 'Kwame', relayed_via: 'radio', observed_at: now(), ...over,
});
const ev = (incident_id: string, by: string): IncidentEvent => ({ id: crypto.randomUUID(), incident_id, kind: 'reported', payload: { relayed_via: 'radio' }, lat: 6.8165, lon: -0.81, accuracy_m: 5, by, by_name: 'x', client_ts: now() });

describe('real Supabase client path against Postgres + RLS', () => {
  let shared: Incident;
  beforeEach(freshDevice);

  it('camp operator: radio-relayed report saved offline, synced once, server assigns code; reference data downloaded', async () => {
    const remote = remoteFor(U.reporter);
    const eng = new SyncEngine(remote);
    shared = inc();
    down = true;
    await putLocal('incidents', shared);
    await putLocal('incident_events', ev(shared.id, U.reporter));
    await eng.kick(true);
    expect(eng.state.reachable).toBe(false);
    expect((await outboxAll()).length).toBe(2);
    down = false;
    await eng.kick(true);
    expect((await outboxAll()).length).toBe(0);
    const back = await getRow<Incident>('incidents', shared.id);
    expect(back?.code).toMatch(/^F-\d{4}-\d{4}$/);
    expect(back?.relayed_via).toBe('radio');
    expect((await getAll('compartments')).length).toBeGreaterThan(0); // demo (6) or real estate (84)
    expect((await getAll('crews')).length).toBe(7);
    // replay the same report (lost response) → no duplicate, no error
    await putLocal('incidents', { ...shared });
    await eng.kick(true);
    expect((await outboxAll()).length).toBe(0);
    expect(eng.state.errors).toBe(0);
  });

  it('reporter cannot dispatch: server rejects, item parked as error (not lost, not retried forever)', async () => {
    const eng = new SyncEngine(remoteFor(U.reporter));
    await eng.kick(true); // pull incident
    const a: Assignment = { id: crypto.randomUUID(), incident_id: shared.id, crew_id: CREW_B_DAY, user_id: null, state: 'dispatched', instruction: '', need_support: false, dispatched_by: U.reporter, dispatched_at: now(), acked_at: null, acked_by: null, en_route_at: null, on_scene_at: null, client_updated_at: now() };
    await putLocal('assignments', a);
    await eng.kick(true);
    const ob = await outboxAll();
    expect(ob.length).toBe(1);
    expect(ob[0].status).toBe('error');
    expect(ob[0].error).toMatch(/row-level security/i);
  });

  it('coordinator (another phone) pulls the relayed fire, confirms and dispatches crew B day', async () => {
    const eng = new SyncEngine(remoteFor(U.coordinator));
    await eng.kick(true);
    const got = await getRow<Incident>('incidents', shared.id);
    expect(got?.observer_name).toBe('Kwame');
    await putLocal('incidents', { ...got!, status: 'confirmed', client_updated_at: now() });
    await putLocal('assignments', { id: '00000000-0000-4000-8000-00000000b001', incident_id: shared.id, crew_id: CREW_B_DAY, user_id: null, state: 'dispatched', instruction: 'Meet at camp', need_support: false, dispatched_by: U.coordinator, dispatched_at: now(), acked_at: null, acked_by: null, en_route_at: null, on_scene_at: null, client_updated_at: now() } as Assignment);
    await eng.kick(true);
    expect((await outboxAll()).length).toBe(0);
  });

  it('responder in crew B sees the call-out and acknowledges; cannot close the fire', async () => {
    const eng = new SyncEngine(remoteFor(U.responder));
    await eng.kick(true);
    const a = await getRow<Assignment>('assignments', '00000000-0000-4000-8000-00000000b001');
    expect(a?.state).toBe('dispatched');
    await putLocal('assignments', { ...a!, state: 'acknowledged', acked_at: now(), acked_by: U.responder, client_updated_at: now() });
    const i = await getRow<Incident>('incidents', shared.id);
    expect(i?.status).toBe('confirmed');
    await putLocal('incidents', { ...i!, status: 'out', cause: 'Unknown', client_updated_at: now() });
    await eng.kick(true);
    const ob = await outboxAll();
    expect(ob.find((x) => x.table === 'assignments')).toBeUndefined(); // ack accepted
    const parked = ob.find((x) => x.table === 'incidents');
    expect(parked?.status).toBe('error');
    expect(parked?.error).toMatch(/Only a coordinator/);
  });

  it('last-writer-wins: a stale edit from a phone that was offline does not overwrite a newer one', async () => {
    const eng = new SyncEngine(remoteFor(U.coordinator));
    await eng.kick(true);
    const i = (await getRow<Incident>('incidents', shared.id))!;
    await putLocal('incidents', { ...i, status: 'responding', client_updated_at: new Date(Date.now() - 3600_000).toISOString() });
    await eng.kick(true);
    await freshDevice();
    const eng2 = new SyncEngine(remoteFor(U.coordinator));
    await eng2.kick(true);
    expect((await getRow<Incident>('incidents', shared.id))?.status).toBe('confirmed');
  });
});
