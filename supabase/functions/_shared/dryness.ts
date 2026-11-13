// Fuel dryness from Sentinel-2 (pure helpers: used by the fuel-dryness function, its tests and the app).
// Index: NDMI = (B8A - B11) / (B8A + B11). Wet, green vegetation is high; dry fuel is low.

export type DrynessClass = 'low' | 'moderate' | 'high' | 'extreme' | 'unknown';
export type Cadence = 'weekly' | 'fortnightly' | 'monthly' | 'none';
export interface ClassRule { class: Exclude<DrynessClass, 'unknown'>; min_ndmi: number }
export interface DrynessParams {
  classes: ClassRule[];
  windows_days: number[];
  min_usable_pct: number;
  resolution_m: number;
  clear_scene_classes: number[];
  stale_after_days: number;
}
export const DEFAULT_DRYNESS: DrynessParams = {
  classes: [{ class: 'low', min_ndmi: 0.2 }, { class: 'moderate', min_ndmi: 0.1 }, { class: 'high', min_ndmi: 0 }, { class: 'extreme', min_ndmi: -1 }],
  windows_days: [7, 14, 30],
  min_usable_pct: 30,
  resolution_m: 20,
  clear_scene_classes: [4, 5],
  stale_after_days: 16,
};

/** Class from the zone's median NDMI: the first rule (wettest first) whose minimum it reaches. Missing → unknown. */
export function drynessClass(p50: number | null | undefined, rules: ClassRule[] = DEFAULT_DRYNESS.classes): DrynessClass {
  if (p50 == null || !Number.isFinite(p50)) return 'unknown';
  for (const r of [...rules].sort((a, b) => b.min_ndmi - a.min_ndmi)) if (p50 >= r.min_ndmi) return r.class;
  return 'extreme';
}

export const cadenceOf = (days: number): Cadence => (days <= 7 ? 'weekly' : days <= 14 ? 'fortnightly' : 'monthly');

/**
 * Share of the zone with at least one clear observation in the window. The Statistical API counts pixels of the
 * bounding box; pixels outside the zone come back as no-data, so the denominator is the zone's own pixel count
 * (area / resolution²), not sampleCount.
 */
export function usablePct(valid: number, areaM2: number, resM: number): number {
  const px = areaM2 / (resM * resM);
  if (!(px > 0)) return 0;
  return Math.max(0, Math.min(100, (100 * valid) / px));
}

export interface ZoneStats { p25: number | null; p50: number | null; p75: number | null; valid: number }
/** Read one interval of a Statistical API response (output "ndmi"). */
export function readStats(resp: unknown): ZoneStats | null {
  const d = (resp as { data?: { outputs?: { ndmi?: { bands?: { B0?: { stats?: Record<string, unknown> } } } } }[] })?.data?.[0];
  const st = d?.outputs?.ndmi?.bands?.B0?.stats as { sampleCount?: number; noDataCount?: number; percentiles?: Record<string, number> } | undefined;
  if (!st || st.sampleCount == null) return null;
  const valid = Math.max(0, st.sampleCount - (st.noDataCount ?? 0));
  const p = st.percentiles ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return { p25: valid ? num(p['25.0']) : null, p50: valid ? num(p['50.0']) : null, p75: valid ? num(p['75.0']) : null, valid };
}

/** Per pixel: median NDMI of its clear observations in the window (clear = scene classes given); else no data. */
export function evalscript(clear: number[] = DEFAULT_DRYNESS.clear_scene_classes): string {
  return `//VERSION=3
function setup(){return{input:[{bands:["B8A","B11","SCL","dataMask"]}],output:[{id:"ndmi",bands:1,sampleType:"FLOAT32"},{id:"dataMask",bands:1}],mosaicking:"ORBIT"}}
var CLEAR=${JSON.stringify(clear)};
function evaluatePixel(samples){var v=[];for(var i=0;i<samples.length;i++){var s=samples[i];if(s.dataMask===1&&CLEAR.indexOf(s.SCL)>=0&&(s.B8A+s.B11)>0)v.push((s.B8A-s.B11)/(s.B8A+s.B11));}
if(!v.length)return{ndmi:[NaN],dataMask:[0]};v.sort(function(a,b){return a-b});var m=v.length>>1;return{ndmi:[v.length%2?v[m]:(v[m-1]+v[m])/2],dataMask:[1]};}`;
}

export interface Attempt { days: number; stats: ZoneStats | null; usable: number }
/** Pick the result: the shortest window with enough clear pixels; none good enough → unknown (but keep the best try). */
export function chooseWindow(attempts: Attempt[], minUsable: number): { attempt: Attempt | null; cadence: Cadence; cls_ok: boolean } {
  const ok = attempts.find((a) => a.stats && a.stats.p50 != null && a.usable >= minUsable);
  if (ok) return { attempt: ok, cadence: cadenceOf(ok.days), cls_ok: true };
  return { attempt: attempts[attempts.length - 1] ?? null, cadence: 'none', cls_ok: false };
}

/** Is a dryness result too old to trust? (computed more than stale_after_days ago) */
export const drynessStale = (computedAt: string | null | undefined, staleDays = DEFAULT_DRYNESS.stale_after_days, now = Date.now()) =>
  !computedAt || now - Date.parse(computedAt) > staleDays * 864e5;

export const DRYNESS_LABEL: Record<DrynessClass, string> = { low: 'Low', moderate: 'Moderate', high: 'High', extreme: 'Extreme', unknown: 'Unknown' };
