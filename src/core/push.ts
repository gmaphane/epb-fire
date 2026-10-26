import { remote } from '../boot';
import { SupabaseRemote } from './remote';

/**
 * Phone push alerts (call-outs, new fire reports, satellite hotspots, daily fire danger).
 * Works with the app closed on Android/desktop Chrome. On iPhone (iOS 16.4+) only after
 * "Add to Home Screen" and opening it from there.
 */
export type PushState = 'unsupported' | 'demo' | 'blocked' | 'off' | 'on';

const urlB64 = (s: string) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};
const client = () => (remote instanceof SupabaseRemote ? remote.client : null);

export function pushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return 'unsupported';
  if (!client()) return 'demo';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Ask permission, subscribe this phone and register it with the server. Needs network. */
export async function enablePush(): Promise<PushState> {
  const sb = client();
  if (!pushSupported()) return 'unsupported';
  if (!sb) return 'demo';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off';
  const reg = await navigator.serviceWorker.ready;
  let { data: cfg } = await sb.from('app_config').select('v').eq('k', 'vapid_public').maybeSingle();
  if (!cfg) {
    await sb.functions.invoke('notify', { body: { event: 'init' } }).catch(() => {});
    ({ data: cfg } = await sb.from('app_config').select('v').eq('k', 'vapid_public').maybeSingle());
  }
  if (!cfg?.v) throw new Error('Alerts are not set up on the server yet');
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    // re-subscribe if the server key changed
    const cur = sub.options.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
    if (cur && cur !== cfg.v) { await sub.unsubscribe(); sub = null; }
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(cfg.v) });
  const j = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  const { data: u } = await sb.auth.getUser();
  const { error } = await sb.from('push_subscriptions').upsert({
    endpoint: j.endpoint, user_id: u.user?.id, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 200), updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
  return 'on';
}

export async function disablePush(): Promise<PushState> {
  const sb = client();
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await sb?.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
    await sub.unsubscribe();
  }
  return 'off';
}

/** Ask the server to push a test alert to this user's phones. */
export async function sendTestPush(): Promise<string> {
  const sb = client();
  if (!sb) return 'Not available in demo mode';
  const { data, error } = await sb.functions.invoke('notify', { body: { event: 'test' } });
  if (error) throw new Error(error.message);
  return data?.sent ? `Test alert sent to ${data.sent} phone${data.sent > 1 ? 's' : ''}` : 'No registered phone found for your account';
}
