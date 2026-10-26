import { useEffect, useState } from 'preact/hooks';
import { Copy, Download, KeyRound, Plus, UserX, UserCheck, X } from 'lucide-preact';
import { remote } from '../boot';
import { SupabaseRemote } from '../core/remote';
import { toast, useStore } from '../core/store';
import { ago } from '../core/time';
import { can } from '../core/flow';
import { downloadBlob, incidentsWorkbook } from '../core/exportIncidents';
import { Banner, Button, Card, Screen, cx } from './kit';
import { back } from './hooks';
import type { Role } from '../core/types';

interface UserRow { id: string; full_name: string; role: Role; crew_id: string | null; email: string | null; last_sign_in_at: string | null; disabled: boolean }
const ROLES: [Role, string, string][] = [
  ['reporter', 'Reporter', 'Reports fires only'],
  ['responder', 'Responder', 'Crew: call-outs, status up to Contained, perimeters'],
  ['coordinator', 'Coordinator', 'Control room: dispatch, close fires, readiness'],
  ['manager', 'Manager', 'Sees everything, read-only'],
  ['admin', 'Admin', 'Everything, plus users and exports'],
];

async function call(body: Record<string, unknown>) {
  if (!(remote instanceof SupabaseRemote)) throw new Error('Not available in demo mode');
  const { data, error } = await remote.client.functions.invoke('admin-users', { body });
  if (error) {
    // supabase-js wraps non-2xx; read the server's message
    const msg = await (error as any).context?.json?.().then((j: any) => j?.error).catch(() => null);
    throw new Error(msg ?? error.message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export function AdminScreen() {
  const { me, crews, incidents } = useStore((x) => ({ me: x.me, crews: x.crews, incidents: x.incidents }));
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState<UserRow | 'new' | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);

  const load = async () => { setErr(null); try { setUsers((await call({ action: 'list' })).users); } catch (e) { setErr((e as Error).message); } };
  useEffect(() => { if (can(me?.role, 'admin')) void load(); }, []);

  if (!can(me?.role, 'admin')) return <Screen title="Admin" back={back}><Banner tone="err">Only an admin can open this page.</Banner></Screen>;
  const crewName = (id: string | null) => crews.find((c) => c.id === id)?.name ?? 'No crew';

  return (
    <Screen title="Admin" sub="Users and data" back={back}>
      <Card testid="export-card">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[15px] font-semibold">Fire incidents spreadsheet</div>
            <div class="text-[12px] text-muted">{incidents.filter((i) => !i.deleted_at).length} incidents · Excel with sheets for incidents, timeline, call-outs and perimeters.</div>
          </div>
          <Button kind="primary" class="shrink-0 !min-h-[44px]" testid="export-xlsx" icon={<Download size={17} />} onClick={() => { downloadBlob(`EPB_fire_incidents_${new Date().toISOString().slice(0, 10)}.xlsx`, incidentsWorkbook()); toast('Spreadsheet downloaded'); }}>Download</Button>
        </div>
      </Card>

      {secret && (
        <Card testid="temp-password">
          <div class="text-[13px] font-semibold">Temporary password for {secret.email}</div>
          <div class="text-[12px] text-muted mb-2">Shown once. Give it to the person in person or by phone; they should change it after signing in.</div>
          <div class="flex items-center gap-2">
            <code class="flex-1 font-mono text-[18px] font-semibold bg-surface-low rounded-lg px-3 py-2 select-all">{secret.password}</code>
            <button aria-label="Copy password" class="w-11 h-11 rounded-xl bg-sc flex items-center justify-center" onClick={() => { void navigator.clipboard?.writeText(secret.password); toast('Copied'); }}><Copy size={18} /></button>
            <button aria-label="Hide" class="w-11 h-11 rounded-xl bg-sc flex items-center justify-center" onClick={() => setSecret(null)}><X size={18} /></button>
          </div>
        </Card>
      )}

      <div class="flex items-center justify-between px-1">
        <div class="text-[12px] font-semibold uppercase tracking-[.06em] text-muted">Users{users ? ` · ${users.length}` : ''}</div>
        <Button kind="secondary" class="!min-h-[36px] !px-3 !text-[13px]" testid="add-user" icon={<Plus size={16} />} onClick={() => setEdit('new')}>Add user</Button>
      </div>
      {err && <Banner tone="err">{err}</Banner>}
      {!users && !err && <div class="text-center text-muted py-6">Loading users…</div>}
      {users && (
        <div class="bg-card rounded-2xl border border-line divide-y divide-line overflow-hidden" data-testid="user-list">
          {users.map((u) => (
            <button key={u.id} class="w-full flex items-center gap-3 px-3.5 py-2.5 text-left active:bg-surface-low" onClick={() => setEdit(u)}>
              <span class={cx('w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-[13px] font-semibold', u.disabled ? 'bg-sc text-faint' : 'bg-[#0F172A] text-white')}>{(u.full_name || '?').slice(0, 1).toUpperCase()}</span>
              <span class="flex-1 min-w-0">
                <span class="block text-[14px] font-semibold truncate">{u.full_name}{u.id === me?.id ? ' (you)' : ''}{u.disabled ? ' · disabled' : ''}</span>
                <span class="block text-[12px] text-muted truncate">{u.email} · {ROLES.find((r) => r[0] === u.role)?.[1] ?? u.role} · {crewName(u.crew_id)}</span>
              </span>
              <span class="text-[11px] text-faint shrink-0 text-right">{u.last_sign_in_at ? `signed in\n${ago(u.last_sign_in_at)}` : 'never signed in'}</span>
            </button>
          ))}
        </div>
      )}

      {edit && (
        <UserSheet user={edit === 'new' ? null : edit} crews={crews} meId={me!.id} onClose={() => setEdit(null)}
          onDone={(pw) => { setEdit(null); if (pw) setSecret(pw); void load(); }} />
      )}
    </Screen>
  );
}

function UserSheet({ user, crews, meId, onClose, onDone }: { user: UserRow | null; crews: { id: string; name: string }[]; meId: string; onClose: () => void; onDone: (pw?: { email: string; password: string }) => void }) {
  const [name, setName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'responder');
  const [crew, setCrew] = useState(user?.crew_id ?? '');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f(); } catch (e) { toast((e as Error).message, 'err'); } setBusy(false); };
  const self = user?.id === meId;

  return (
    <div class="fixed inset-0 z-[2600] bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div class="w-full max-w-md bg-card rounded-t-3xl sm:rounded-3xl p-4 pb-6 space-y-3 sheet-enter max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} data-testid="user-sheet">
        <div class="flex items-center justify-between">
          <div class="text-[17px] font-semibold">{user ? 'Edit user' : 'Add user'}</div>
          <button aria-label="Close" class="w-8 h-8 rounded-full bg-sc flex items-center justify-center" onClick={onClose}><X size={16} /></button>
        </div>
        <label class="block"><span class="text-[12px] text-muted">Full name</span>
          <input data-testid="user-name" class="mt-1 w-full h-11 rounded-xl bg-surface-low px-3 text-[15px] outline-none focus:ring-2 focus:ring-brand" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
        {!user && <label class="block"><span class="text-[12px] text-muted">Email (used to sign in)</span>
          <input data-testid="user-email" type="email" autoCapitalize="off" class="mt-1 w-full h-11 rounded-xl bg-surface-low px-3 text-[15px] outline-none focus:ring-2 focus:ring-brand" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} /></label>}
        <div>
          <span class="text-[12px] text-muted">Role</span>
          <div class="mt-1 rounded-xl bg-surface-low divide-y divide-line">
            {ROLES.map(([k, l, d]) => (
              <button key={k} disabled={self && k !== 'admin'} onClick={() => setRole(k)} class="w-full flex items-center gap-3 px-3 py-2 text-left disabled:opacity-40">
                <span class={cx('w-4 h-4 rounded-full border-2 shrink-0', role === k ? 'border-brand bg-brand' : 'border-schh')} />
                <span class="flex-1"><span class="block text-[14px] font-semibold">{l}</span><span class="block text-[11px] text-muted">{d}</span></span>
              </button>
            ))}
          </div>
        </div>
        <label class="block"><span class="text-[12px] text-muted">Crew (who gets their call-outs)</span>
          <select data-testid="user-crew" class="mt-1 w-full h-11 rounded-xl bg-surface-low px-3 text-[15px]" value={crew} onChange={(e) => setCrew((e.target as HTMLSelectElement).value)}>
            <option value="">No crew</option>
            {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>

        <Button kind="primary" full disabled={busy} testid="user-save" onClick={() => void run(async () => {
          if (user) { await call({ action: 'update', id: user.id, full_name: name, role, crew_id: crew || null }); toast('Saved'); onDone(); }
          else { const r = await call({ action: 'create', email, full_name: name, role, crew_id: crew || null }); toast('User added'); onDone({ email: r.email, password: r.password }); }
        })}>{user ? 'Save changes' : 'Add user'}</Button>

        {user && !self && (
          <div class="grid grid-cols-2 gap-2">
            <Button disabled={busy} icon={<KeyRound size={16} />} onClick={() => void run(async () => { const r = await call({ action: 'reset_password', id: user.id }); onDone({ email: user.email ?? user.full_name, password: r.password }); })}>Reset password</Button>
            <Button disabled={busy} icon={user.disabled ? <UserCheck size={16} /> : <UserX size={16} />} onClick={() => void run(async () => { await call({ action: user.disabled ? 'enable' : 'disable', id: user.id }); toast(user.disabled ? 'Account enabled' : 'Account disabled'); onDone(); })}>{user.disabled ? 'Enable' : 'Disable'}</Button>
          </div>
        )}
        {!user && <p class="text-[11px] text-muted">A temporary password is created and shown once after saving.</p>}
      </div>
    </div>
  );
}
