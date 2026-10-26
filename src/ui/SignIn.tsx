import { useState } from 'preact/hooks';
import { Flame } from 'lucide-preact';
import { signIn } from '../boot';
import { IS_DEMO } from '../config';
import { Banner, Button } from './kit';
import { DEMO_USERS } from '../data/demoSeed';

export function SignIn() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e: string, p: string) => {
    setBusy(true); setErr('');
    try { await signIn(e, p); } catch (x) { setErr(navigator.onLine ? (x as Error).message : 'You are offline. First sign-in needs a connection; after that the app works with no signal.'); setBusy(false); }
  };
  return (
    <div class="h-full overflow-y-auto bg-surface p-6 pt-safe">
      <div class="max-w-md mx-auto space-y-5 pt-10">
        <div class="w-16 h-16 rounded-2xl bg-brand text-on-brand flex items-center justify-center"><Flame size={34} /></div>
        <div><h1 class="text-[28px] font-bold leading-9">EPB Fire Response</h1><p class="text-muted font-semibold">Bandai Hills · North Bandai</p></div>
        {err && <Banner tone="err">{err}</Banner>}
        {IS_DEMO ? (
          <div class="space-y-3" data-testid="demo-login">
            <Banner tone="info">DEMO MODE — no Supabase configured. Data stays on this device; a built-in demo server stands in for sync. Pick a role to try.</Banner>
            {DEMO_USERS.map((u) => <Button key={u.id} full testid={'login-' + u.role} disabled={busy} onClick={() => void go(u.email, '')}>{u.name} — {u.role}</Button>)}
          </div>
        ) : (
          <form class="space-y-3" onSubmit={(e) => { e.preventDefault(); void go(email, pw); }}>
            <input data-testid="email" type="email" autocomplete="username" class="w-full min-h-[52px] rounded-lg border border-line bg-card px-4" placeholder="Email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
            <input data-testid="password" type="password" autocomplete="current-password" class="w-full min-h-[52px] rounded-lg border border-line bg-card px-4" placeholder="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
            <Button kind="primary" full type="submit" disabled={busy || !email || !pw} testid="signin">{busy ? 'Signing in…' : 'Sign in'}</Button>
            <p class="text-xs text-muted">Sign in once while online. After that the app opens and works with no signal.</p>
          </form>
        )}
      </div>
    </div>
  );
}
