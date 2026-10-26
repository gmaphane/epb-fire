import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from '../config';
import type { Me, Role, TableName } from './types';
import { APPEND_ONLY } from './types';

export class RemoteError extends Error {
  constructor(
    public kind: 'network' | 'auth' | 'dependency' | 'rejected' | 'server',
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export interface Remote {
  readonly demo: boolean;
  /** Is there a usable signed-in session? */
  ready(): Promise<boolean>;
  signIn(email: string, password: string): Promise<Me>;
  signOut(): Promise<void>;
  upsert(table: TableName, rows: Record<string, unknown>[]): Promise<void>;
  pull(table: TableName, since: string | null, limit: number): Promise<Record<string, any>[]>;
  uploadPhoto(path: string, blob: Blob): Promise<void>;
  /** All ids currently on the server (reference tables only), to drop rows deleted there. */
  listIds(table: TableName): Promise<string[]>;
  subscribe(onRow: (table: TableName, row: Record<string, any>) => void): () => void;
}

const TIMEOUT_MS = 15_000;
const REALTIME: TableName[] = ['incidents', 'incident_events', 'assignments', 'perimeters', 'hazards', 'detections', 'readiness', 'crew_positions', 'fire_danger'];

function classify(err: { message?: string; code?: string; details?: string } | null, status: number): RemoteError {
  const msg = err?.message || `HTTP ${status}`;
  if (!status || /failed to fetch|networkerror|load failed|aborted|timeout/i.test(msg)) return new RemoteError('network', msg, 0);
  if (status === 401 || /jwt/i.test(msg)) return new RemoteError('auth', msg, status);
  if (status === 409 && err?.code === '23503') return new RemoteError('dependency', msg, status);
  if (status === 408 || status === 429 || status >= 500) return new RemoteError('server', msg, status);
  return new RemoteError('rejected', msg, status);
}

export class SupabaseRemote implements Remote {
  readonly demo = false;
  client: SupabaseClient;
  constructor(client?: SupabaseClient) {
    if (client) { this.client = client; return; }
    this.client = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 10 } },
    });
  }

  private signal() {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), TIMEOUT_MS);
    return { signal: c.signal, done: () => clearTimeout(t) };
  }

  async ready() {
    try {
      const { data } = await this.client.auth.getSession();
      return !!data.session;
    } catch {
      return false;
    }
  }

  async signIn(email: string, password: string): Promise<Me> {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw new Error(error?.message ?? 'Sign-in failed');
    const { data: p, error: pe } = await this.client.from('profiles').select('*').eq('id', data.user.id).single();
    if (pe || !p) throw new Error('No profile for this user. Ask an admin to create one.');
    return { id: p.id, name: p.full_name, role: p.role as Role, crew_id: p.crew_id ?? null };
  }

  async signOut() {
    await this.client.auth.signOut().catch(() => {});
  }

  async upsert(table: TableName, rows: Record<string, unknown>[]) {
    const s = this.signal();
    try {
      const ignore = APPEND_ONLY.includes(table);
      const { error, status } = await this.client
        .from(table)
        .upsert(rows, { onConflict: 'id', ignoreDuplicates: ignore })
        .abortSignal(s.signal);
      if (error) throw classify(error, status);
    } catch (e) {
      if (e instanceof RemoteError) throw e;
      throw classify({ message: String((e as Error)?.message ?? e) }, 0);
    } finally {
      s.done();
    }
  }

  async pull(table: TableName, since: string | null, limit: number) {
    const s = this.signal();
    try {
      let q = this.client.from(table).select('*').order('updated_at', { ascending: true }).limit(limit);
      if (since) q = q.gt('updated_at', since);
      const { data, error, status } = await q.abortSignal(s.signal);
      if (error) throw classify(error, status);
      return (data ?? []) as Record<string, any>[];
    } catch (e) {
      if (e instanceof RemoteError) throw e;
      throw classify({ message: String((e as Error)?.message ?? e) }, 0);
    } finally {
      s.done();
    }
  }

  async listIds(table: TableName) {
    const ids: string[] = [];
    for (let from = 0; from < 100_000; from += 1000) {
      const s = this.signal();
      try {
        const { data, error, status } = await this.client.from(table).select('id').order('id').range(from, from + 999).abortSignal(s.signal);
        if (error) throw classify(error, status);
        ids.push(...((data ?? []) as { id: string }[]).map((r) => r.id));
        if (!data || data.length < 1000) break;
      } catch (e) {
        if (e instanceof RemoteError) throw e;
        throw classify({ message: String((e as Error)?.message ?? e) }, 0);
      } finally {
        s.done();
      }
    }
    return ids;
  }

  async uploadPhoto(path: string, blob: Blob) {
    const { error } = await this.client.storage
      .from('incident-photos')
      .upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' });
    if (error) {
      const status = Number((error as any).statusCode ?? (error as any).status ?? 0);
      throw classify({ message: error.message }, status);
    }
  }

  subscribe(onRow: (table: TableName, row: Record<string, any>) => void) {
    let ch = this.client.channel('epb-live');
    for (const t of REALTIME) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, (p: any) => {
        if (p.new && p.new.id) onRow(t, p.new);
      });
    }
    ch.subscribe();
    return () => {
      void this.client.removeChannel(ch);
    };
  }
}
