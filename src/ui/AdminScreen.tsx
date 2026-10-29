import { useEffect, useState } from 'preact/hooks';
import { Check, Copy, Download, KeyRound, Plus, Share2, UserX, UserCheck, X } from 'lucide-preact';
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

  const load = async () => { setErr(null); try { setUsers((await call({ action: 'list' })).users); } catch (e) { setErr((e as Error).message); } };
  useEffect(() => { if (can(me?.role, 'admin')) void load(); }, []);

  if (!can(me?.role, 'admin')) return <Screen title="Admin" back={back}><Banner tone="err">Only an admin can open this page.</Banner></Screen>;
  const crewName = (id: string | null) => crews.find((c) => c.id === id)?.name ?? 'No crew';

  return (
    <Screen title="Admin" back={back}>
      <Card testid="export-card">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="font-display text-[16px]">Fire spreadsheet</div>
            <div class="text-[13px] text-muted">{incidents.filter((i) => !i.deleted_at).length} fires · Excel</div>
          </div>
          <Button kind="primary" class="shrink-0" testid="export-xlsx" icon={<Download size={17} />} onClick={() => { downloadBlob(`EPB_fire_incidents_${new Date().toISOString().slice(0, 10)}.xlsx`, incidentsWorkbook()); toast('Spreadsheet downloaded'); }}>Download</Button>
        </div>
      </Card>


      <div class="flex items-center justify-between px-1">
        <h2 class="font-display text-[18px] flex items-center gap-2">Users <span class="font-sans text-[14px] text-muted">{users ? users.length : ''}</span></h2>
        <Button kind="secondary" class="!min-h-[40px] !px-4 !text-[14px]" testid="add-user" icon={<Plus size={16} />} onClick={() => setEdit('new')}>Add</Button>
      </div>
      {err && <Banner tone="err">{err}</Banner>}
      {!users && !err && <div class="text-center text-muted py-6">Loading users…</div>}
      {users && (
        <div class="bg-card rounded-card border border-line divide-y divide-line overflow-hidden" data-testid="user-list">
          {users.map((u) => (
            <button key={u.id} class="press w-full flex items-center gap-3 px-4 py-3 text-left active:bg-surface-low" onClick={() => setEdit(u)}>
              <span class={cx('w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-[13px] font-semibold', u.disabled ? 'bg-sc text-faint' : 'bg-moss text-on-moss')}>{(u.full_name || '?').slice(0, 1).toUpperCase()}</span>
              <span class="flex-1 min-w-0">
                <span class="block text-[14px] font-semibold truncate">{u.full_name}{u.id === me?.id ? ' (you)' : ''}{u.disabled ? ' · disabled' : ''}</span>
                <span class="block text-[12px] text-muted truncate">{u.email} · {ROLES.find((r) => r[0] === u.role)?.[1] ?? u.role} · {crewName(u.crew_id)}</span>
              </span>
              <span class="text-[12px] text-faint shrink-0 text-right">{u.last_sign_in_at ? ago(u.last_sign_in_at) : 'never'}</span>
            </button>
          ))}
        </div>
      )}

      {edit && (
        <UserSheet user={edit === 'new' ? null : edit} crews={crews} meId={me!.id} onClose={() => setEdit(null)}
          onDone={() => { setEdit(null); void load(); }} onChanged={() => void load()} />
      )}
    </Screen>
  );
}

function UserSheet({ user, crews, meId, onClose, onDone, onChanged }: { user: UserRow | null; crews: { id: string; name: string }[]; meId: string; onClose: () => void; onDone: () => void; onChanged: () => void }) {
  const [secret, setSecret] = useState<{ email: string; name: string; password: string; isNew: boolean } | null>(null);
  const [name, setName] = useState(user?.full_name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'responder');
  const [crew, setCrew] = useState(user?.crew_id ?? '');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f(); } catch (e) { toast((e as Error).message, 'err'); } setBusy(false); };
  const self = user?.id === meId;

  return (
    <div class="fixed inset-0 z-[2600] bg-black/30 flex items-end sm:items-center justify-center fade-in" onClick={secret ? undefined : onClose}>
      <div class="w-full max-w-md bg-card rounded-t-sheet sm:rounded-sheet px-5 pt-2 pb-6 pb-safe space-y-4 sheet-enter max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} data-testid="user-sheet">
        <div class="w-9 h-1 bg-schh rounded-full mx-auto" />
        <div class="flex items-center justify-between">
          <h2 class="font-display text-[20px]">{secret ? '' : user ? 'Edit user' : 'Add user'}</h2>
          <button aria-label="Close" class="press w-9 h-9 -mr-1 rounded-full flex items-center justify-center text-muted" onClick={secret ? onDone : onClose}><X size={20} /></button>
        </div>
        {secret ? (
          <div class="space-y-4 text-center pt-2 pb-1 fade-in" data-testid="temp-password">
            <div class="w-16 h-16 rounded-full bg-moss text-on-moss mx-auto flex items-center justify-center pop-in"><Check size={30} strokeWidth={2.5} /></div>
            <div>
              <div class="font-display text-[20px]">{secret.isNew ? `${secret.name} added` : 'New password set'}</div>
              <div class="text-[14px] text-muted mt-1">Give them this temporary password. It's shown only once.</div>
            </div>
            <div class="rounded-[20px] bg-surface-low border border-line p-4 text-left space-y-2">
              <div class="flex justify-between gap-3 text-[14px]"><span class="text-muted">Email</span><span class="font-medium truncate">{secret.email}</span></div>
              <div class="flex justify-between items-center gap-3"><span class="text-[14px] text-muted">Password</span><code class="font-mono text-[20px] font-semibold select-all tracking-wide" data-testid="temp-password-value">{secret.password}</code></div>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <Button icon={<Copy size={17} />} onClick={() => { void navigator.clipboard?.writeText(`${secret.email}\n${secret.password}`); toast('Copied'); }}>Copy</Button>
              <Button icon={<Share2 size={17} />} onClick={() => { const t = `EmberWatch (fire app)\nSign in at ${location.origin}\nEmail: ${secret.email}\nTemporary password: ${secret.password}`; if (navigator.share) void navigator.share({ text: t }).catch(() => {}); else { void navigator.clipboard?.writeText(t); toast('Copied'); } }}>Share</Button>
            </div>
            <Button kind="primary" full testid="temp-password-done" onClick={onDone}>Done</Button>
          </div>
        ) : <>
        <label class="block"><span class="text-[13px] text-muted">Full name</span>
          <input data-testid="user-name" class="mt-1.5 w-full h-12 rounded-2xl border border-line bg-surface-low px-4 text-[16px] outline-none focus:border-brand" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
        {!user && <label class="block"><span class="text-[13px] text-muted">Email (used to sign in)</span>
          <input data-testid="user-email" type="email" autoCapitalize="off" class="mt-1.5 w-full h-12 rounded-2xl border border-line bg-surface-low px-4 text-[16px] outline-none focus:border-brand" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} /></label>}
        <div>
          <span class="text-[13px] text-muted">Role</span>
          <div class="mt-1.5 rounded-2xl border border-line divide-y divide-line">
            {ROLES.map(([k, l, d]) => (
              <button key={k} disabled={self && k !== 'admin'} onClick={() => setRole(k)} class="w-full flex items-center gap-3 px-4 py-2.5 text-left disabled:opacity-40">
                <span class={cx('w-4 h-4 rounded-full border-2 shrink-0', role === k ? 'border-brand bg-brand' : 'border-schh')} />
                <span class="flex-1"><span class="block text-[15px] font-medium">{l}</span><span class="block text-[12px] text-muted">{d}</span></span>
              </button>
            ))}
          </div>
        </div>
        <label class="block"><span class="text-[13px] text-muted">Crew (who gets their call-outs)</span>
          <select data-testid="user-crew" class="mt-1.5 w-full h-12 rounded-2xl border border-line bg-surface-low px-4 text-[16px]" value={crew} onChange={(e) => setCrew((e.target as HTMLSelectElement).value)}>
            <option value="">No crew</option>
            {crews.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select></label>

        <Button kind="primary" full disabled={busy} testid="user-save" onClick={() => void run(async () => {
          if (user) { await call({ action: 'update', id: user.id, full_name: name, role, crew_id: crew || null }); toast('Saved'); onDone(); }
          else { const r = await call({ action: 'create', email, full_name: name, role, crew_id: crew || null }); if (!r?.password) throw new Error('User added, but no password came back. Use Reset password on their name.'); setSecret({ email: r.email, name, password: r.password, isNew: true }); onChanged(); }
        })}>{user ? 'Save changes' : 'Add user'}</Button>

        {user && !self && (
          <div class="grid grid-cols-2 gap-2">
            <Button disabled={busy} icon={<KeyRound size={16} />} onClick={() => void run(async () => { const r = await call({ action: 'reset_password', id: user.id }); if (!r?.password) throw new Error('No password came back. Try again.'); setSecret({ email: user.email ?? '', name: user.full_name, password: r.password, isNew: false }); })}>Reset password</Button>
            <Button disabled={busy} icon={user.disabled ? <UserCheck size={16} /> : <UserX size={16} />} onClick={() => void run(async () => { await call({ action: user.disabled ? 'enable' : 'disable', id: user.id }); toast(user.disabled ? 'Account enabled' : 'Account disabled'); onDone(); })}>{user.disabled ? 'Enable' : 'Disable'}</Button>
          </div>
        )}
        {!user && <p class="text-[13px] text-faint text-center">A temporary password is shown once after saving</p>}
        </>}
      </div>
    </div>
  );
}
