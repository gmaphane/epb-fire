export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} d ago`;
}
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const hhmmss = (sec: number) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
};
export const nowIso = () => new Date().toISOString();
