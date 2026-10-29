import { useState } from 'preact/hooks';
import { Flame } from 'lucide-preact';
import { signIn } from '../boot';
import { CONFIG, IS_DEMO } from '../config';
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
  const field = 'w-full min-h-[54px] rounded-2xl border border-line bg-card px-4 text-[16px] outline-none focus:border-brand transition-colors';
  return (
    <div class="h-full overflow-y-auto bg-surface px-6 pt-safe">
      <div class="max-w-md mx-auto min-h-full flex flex-col pt-16 pb-10 screen-in">
        <div class="w-14 h-14 rounded-[18px] bg-brand flex items-center justify-center shadow-l2"><Flame size={28} class="text-[#F0675C]" fill="#F0675C" /></div>
        <h1 class="font-display text-[38px] leading-[1.05] mt-8">{CONFIG.appName}</h1>
        <p class="text-[17px] mt-1">Fire response · Bandai Hills</p>
        <p class="text-[15px] text-muted mt-3">Works with no signal after the first sign-in.</p>
        <div class="mt-10 space-y-3">
          {err && <Banner tone="err">{err}</Banner>}
          {IS_DEMO ? (
            <div class="space-y-2" data-testid="demo-login">
              <p class="text-[13px] text-muted pb-1">Demo · pick a role</p>
              {DEMO_USERS.map((u) => <Button key={u.id} full testid={'login-' + u.role} disabled={busy} onClick={() => void go(u.email, '')}>{u.name.replace(/^Demo /, '')}</Button>)}
            </div>
          ) : (
            <form class="space-y-3" onSubmit={(e) => { e.preventDefault(); void go(email, pw); }}>
              <input data-testid="email" type="email" autocomplete="username" class={field} placeholder="Email" value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
              <input data-testid="password" type="password" autocomplete="current-password" class={field} placeholder="Password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} />
              <div class="pt-2"><Button kind="primary" size="lg" full type="submit" disabled={busy || !email || !pw} testid="signin">{busy ? 'Signing in…' : 'Sign in'}</Button></div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
