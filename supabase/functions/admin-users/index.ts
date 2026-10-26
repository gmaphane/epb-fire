// Admin-only user management from the app: list, add, change role/crew/name, reset password, disable/enable.
// Runs with the service role on the server; the caller must be a signed-in admin.
import { caller, json, sb } from '../_shared/alerts.ts';

const ROLES = ['reporter', 'responder', 'coordinator', 'manager', 'admin'];
const tempPassword = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => a[x % a.length]).join('');
};
const cleanName = (s: unknown) => String(s ?? '').replace(/[<>]/g, '').trim().slice(0, 80);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return json({ ok: true });
  const who = await caller(req);
  if (!who || who.kind !== 'user' || who.role !== 'admin') return json({ error: 'Only an admin can manage users' }, 403);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? '');

  try {
    if (action === 'list') {
      const [{ data: profiles }, { data: au }] = await Promise.all([
        sb.from('profiles').select('id, full_name, role, crew_id, created_at'),
        sb.auth.admin.listUsers({ perPage: 1000 }),
      ]);
      const byId = new Map((au?.users ?? []).map((u) => [u.id, u]));
      const users = (profiles ?? []).map((p) => {
        const u = byId.get(p.id);
        return { ...p, email: u?.email ?? null, last_sign_in_at: u?.last_sign_in_at ?? null, disabled: !!(u?.banned_until && Date.parse(u.banned_until) > Date.now()) };
      }).sort((a, b) => String(a.full_name).localeCompare(String(b.full_name)));
      return json({ users });
    }

    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const full_name = cleanName(body.full_name);
      const role = ROLES.includes(body.role) ? body.role : 'reporter';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email address' }, 400);
      if (!full_name) return json({ error: 'Enter the person\'s name' }, 400);
      const password = typeof body.password === 'string' && body.password.length >= 8 ? body.password : tempPassword();
      const { data, error } = await sb.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name } });
      if (error || !data.user) return json({ error: error?.message ?? 'Could not create the user' }, 400);
      const { error: pe } = await sb.from('profiles').upsert({ id: data.user.id, full_name, role, crew_id: body.crew_id || null });
      if (pe) return json({ error: pe.message }, 500);
      return json({ id: data.user.id, email, password });
    }

    if (action === 'update') {
      const id = String(body.id ?? '');
      const patch: Record<string, unknown> = {};
      if (body.full_name !== undefined) patch.full_name = cleanName(body.full_name);
      if (body.crew_id !== undefined) patch.crew_id = body.crew_id || null;
      if (body.role !== undefined) {
        if (!ROLES.includes(body.role)) return json({ error: 'Unknown role' }, 400);
        if (id === who.id && body.role !== 'admin') return json({ error: 'You cannot remove your own admin role' }, 400);
        patch.role = body.role;
      }
      const { error } = await sb.from('profiles').update(patch).eq('id', id);
      if (error) return json({ error: error.message }, 400);
      if (patch.full_name) await sb.auth.admin.updateUserById(id, { user_metadata: { full_name: patch.full_name } });
      return json({ ok: true });
    }

    if (action === 'reset_password') {
      const password = tempPassword();
      const { error } = await sb.auth.admin.updateUserById(String(body.id), { password });
      if (error) return json({ error: error.message }, 400);
      return json({ password });
    }

    if (action === 'disable' || action === 'enable') {
      if (body.id === who.id) return json({ error: 'You cannot disable your own account' }, 400);
      const { error } = await sb.auth.admin.updateUserById(String(body.id), { ban_duration: action === 'disable' ? '876000h' : 'none' });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: `Unknown action ${action}` }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
