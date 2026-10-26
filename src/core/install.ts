import { useEffect, useState } from 'preact/hooks';

/**
 * "Install app" support. Installed (from the home screen) the app opens without the browser's
 * address bar and tabs, like a native app. Android/desktop Chrome offer a one-tap install prompt;
 * iPhone needs Share → Add to Home Screen.
 */
let deferred: any = null;
const subs = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; subs.forEach((f) => f()); });
  window.addEventListener('appinstalled', () => { deferred = null; subs.forEach((f) => f()); });
}

export const isStandalone = () =>
  typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);
export const isIOS = () => typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);

/** 'prompt' = one-tap install available, 'ios' = show Share → Add to Home Screen, null = installed or not possible. */
export function useInstall(): 'prompt' | 'ios' | null {
  const calc = (): 'prompt' | 'ios' | null => (isStandalone() ? null : deferred ? 'prompt' : isIOS() ? 'ios' : null);
  const [v, setV] = useState(calc);
  useEffect(() => { const f = () => setV(calc()); subs.add(f); f(); return () => void subs.delete(f); }, []);
  return v;
}

export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  subs.forEach((f) => f());
  return outcome === 'accepted';
}
