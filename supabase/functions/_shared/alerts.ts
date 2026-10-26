// Shared by the alert functions: service-role client, caller check, and phone push sending.
import webpush from 'npm:web-push@3.6.7';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const sb: SupabaseClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } });

export const appKey = async (k: string) => ((await sb.rpc('app_key_get', { p_k: k })).data as string | null) ?? null;
const key = appKey;

/**
 * Who is calling: the database/scheduler (shared hook secret) or a signed-in user (their JWT).
 * Returns null when neither is valid.
 */
/** Constant-time string compare (shared secret). */
const safeEq = (a: string, b: string) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };

export async function caller(req: Request): Promise<{ kind: 'hook' } | { kind: 'user'; id: string; role: string } | null> {
  const hook = req.headers.get('x-epb-hook');
  if (hook) { const k = await key('hook_secret'); return k && safeEq(hook, k) ? { kind: 'hook' } : null; }
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await sb.auth.getUser(token);
  if (!data.user) return null;
  const { data: p } = await sb.from('profiles').select('role').eq('id', data.user.id).single();
  return { kind: 'user', id: data.user.id, role: (p?.role as string) ?? 'reporter' };
}

/** VAPID keys are generated once, on the server, and kept in private.app_keys. The public half goes to app_config for phones. */
let vapidReady = false;
export async function ensureVapid() {
  if (vapidReady) return;
  let pub = await key('vapid_public'), priv = await key('vapid_private');
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await sb.rpc('app_key_put', { p_k: 'vapid_public', p_v: k.publicKey });
    await sb.rpc('app_key_put', { p_k: 'vapid_private', p_v: k.privateKey });
    pub = await key('vapid_public'); priv = await key('vapid_private'); // another run may have won the race
  }
  await sb.from('app_config').upsert({ k: 'vapid_public', v: pub!, updated_at: new Date().toISOString() });
  webpush.setVapidDetails(Deno.env.get('VAPID_SUBJECT') ?? 'mailto:gmaphane@ecoplanetbamboo.com', pub!, priv!);
  vapidReady = true;
}

export interface Push {
  title: string;
  body: string;
  url?: string; // in-app route, e.g. /#/incident/<id>
  tag?: string; // same tag replaces an older notification
  urgent?: boolean; // keep on screen until tapped, strong vibration
  kind?: string;
}

/** Recipients by user id and/or role. */
export async function users(opts: { ids?: string[]; roles?: string[]; crewId?: string | null; all?: boolean; except?: string | null }): Promise<string[]> {
  const out = new Set<string>(opts.ids ?? []);
  if (opts.all || opts.roles?.length || opts.crewId) {
    const { data } = await sb.from('profiles').select('id, role, crew_id');
    for (const p of data ?? []) {
      if (opts.all || (opts.roles && opts.roles.includes(p.role)) || (opts.crewId && p.crew_id === opts.crewId)) out.add(p.id);
    }
  }
  if (opts.except) out.delete(opts.except);
  return [...out];
}

/** Send to every phone the given users have registered. Dead subscriptions are removed. */
export async function sendPush(userIds: string[], msg: Push): Promise<{ users: number; phones: number; sent: number; failed: number }> {
  if (!userIds.length) return { users: 0, phones: 0, sent: 0, failed: 0 };
  await ensureVapid();
  const { data: subs } = await sb.from('push_subscriptions').select('endpoint, p256dh, auth').in('user_id', userIds);
  let sent = 0, failed = 0;
  const payload = JSON.stringify(msg);
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: msg.urgent ? 3600 : 6 * 3600, urgency: msg.urgent ? 'high' : 'normal' });
      sent++;
    } catch (e) {
      failed++;
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint);
      else console.error('push failed', code, (e as Error).message);
    }
  }));
  return { users: userIds.length, phones: subs?.length ?? 0, sent, failed };
}

export const COORDINATORS = ['coordinator', 'manager', 'admin'];
export const dd = (lat: number, lon: number) => `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}`;
const CARD = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass8 = (deg: number) => CARD[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
