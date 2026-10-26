import { DEMO_ASSETS, DEMO_COMPARTMENTS, DEMO_CREWS, DEMO_ROADS, DEMO_USERS, demoCrewPositions, demoDetections } from '../data/demoSeed';
import { RemoteError, type Remote } from './remote';
import { APPEND_ONLY, TABLES, type Me, type TableName } from './types';

export type FailMode = 'ok' | 'offline' | 'server' | 'auth';

/**
 * In-memory stand-in for the server. Implements the same semantics as the SQL
 * migration (upsert, append-only, last-writer-wins, FK dependency, server updated_at)
 * so the sync engine can be tested and demoed without Supabase.
 */
export class MemoryRemote implements Remote {
  readonly demo = true;
  mode: FailMode = 'ok';
  latencyMs: number;
  tables = new Map<TableName, Map<string, Record<string, any>>>();
  photos = new Map<string, number>();
  upsertCalls = 0;
  me: Me | null = null;
  private subs = new Set<(t: TableName, r: Record<string, any>) => void>();
  private lastTs = 0;

  constructor(opts: { latencyMs?: number; seed?: boolean } = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
    for (const t of TABLES) this.tables.set(t, new Map());
    if (opts.seed !== false) {
      const put = (t: TableName, rows: Record<string, any>[]) => rows.forEach((r) => this.tables.get(t)!.set(r.id, { ...r, updated_at: this.stamp() }));
      put('compartments', DEMO_COMPARTMENTS);
      put('assets', DEMO_ASSETS);
      put('roads', DEMO_ROADS);
      put('crews', DEMO_CREWS);
      put('detections', demoDetections());
      put('crew_positions', demoCrewPositions());
      const today = new Date().toISOString().slice(0, 10);
      put('fire_danger', [{ id: today, day: today, level: 'high', ffwi: 24.1, temp_max_c: 34, rh_min_pct: 28, wind_max_kmh: 18, wind_from_deg: 45, days_since_rain: 9, rain_24h_mm: 0, basis: 'Fosberg index 24 at 14:00; +1: no rain for 9 days (demo)', client_updated_at: new Date().toISOString() }]);
      // keep the demo standby crews "live"
      if (typeof window !== 'undefined')
        setInterval(() => {
          const now = new Date().toISOString();
          for (const r of this.tables.get('crew_positions')!.values()) {
            if (!String(r.id).startsWith('00000000-0000-4000-8000-0000000006')) continue;
            const next = { ...r, fix_at: now, client_updated_at: now, updated_at: this.stamp() };
            this.tables.get('crew_positions')!.set(r.id, next);
            this.subs.forEach((s) => s('crew_positions', next));
          }
        }, 60_000);
    }
  }

  private stamp() {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    return new Date(this.lastTs).toISOString();
  }

  private async gate() {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (this.mode === 'offline') throw new RemoteError('network', 'Failed to fetch');
    if (this.mode === 'server') throw new RemoteError('server', 'HTTP 503', 503);
    if (this.mode === 'auth') throw new RemoteError('auth', 'JWT expired', 401);
  }

  async ready() {
    return true;
  }
  async signIn(email: string): Promise<Me> {
    const u = DEMO_USERS.find((x) => x.email === email.trim().toLowerCase());
    if (!u) throw new Error('Unknown demo user');
    this.me = { id: u.id, name: u.name, role: u.role, crew_id: u.crew_id };
    return this.me;
  }
  async signOut() {
    this.me = null;
  }

  async upsert(table: TableName, rows: Record<string, unknown>[]) {
    await this.gate();
    this.upsertCalls++;
    const store = this.tables.get(table)!;
    for (const r of rows as Record<string, any>[]) {
      if (['incident_events', 'assignments', 'perimeters', 'photos'].includes(table)) {
        if (!this.tables.get('incidents')!.has(r.incident_id)) throw new RemoteError('dependency', 'violates foreign key constraint', 409);
      }
      const cur = store.get(r.id);
      if (cur) {
        if (APPEND_ONLY.includes(table)) continue;
        if (r.client_updated_at && cur.client_updated_at && r.client_updated_at < cur.client_updated_at) continue; // LWW trigger
      }
      const next: Record<string, any> = { ...cur, ...r, updated_at: this.stamp() };
      if (table === 'incident_events') next.received_at = cur?.received_at ?? next.updated_at;
      if (table === 'incidents' && !next.code) next.code = `F-2026-${String(store.size + 1).padStart(4, '0')}`;
      store.set(r.id, next);
      queueMicrotask(() => this.subs.forEach((s) => s(table, next)));
    }
  }

  async pull(table: TableName, since: string | null, limit: number) {
    await this.gate();
    return [...this.tables.get(table)!.values()]
      .filter((r) => !since || r.updated_at > since)
      .sort((a, b) => (a.updated_at < b.updated_at ? -1 : 1))
      .slice(0, limit);
  }

  async listIds(table: TableName) {
    await this.gate();
    return [...this.tables.get(table)!.keys()];
  }

  async uploadPhoto(path: string, blob: Blob) {
    await this.gate();
    this.photos.set(path, blob.size);
  }

  subscribe(fn: (t: TableName, r: Record<string, any>) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
