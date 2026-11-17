import L from 'leaflet';
import { basemap } from '../core/tiles';
import { CONFIG } from '../config';
import type { AppState } from '../core/store';
import type { Compartment, FuelDryness, GpsFix, Incident, Vertex } from '../core/types';
import { drynessStale, type DrynessClass } from '../../supabase/functions/_shared/dryness';
import { rateCompartment, riskParams, type Driver, type Rating, type RiskResult } from '../core/compartmentRisk';
import { STATUS_LABEL, can } from '../core/flow';

/**
 * Compartment risk strokes, tuned to read on muted satellite imagery:
 * every outline sits on a dark casing, so even "low" stays visible over green canopy.
 */
export const RISK: Record<string, { c: string; label: string; w: number; f: number }> = {
  low: { c: '#E2E8F0', label: 'Low', w: 1.6, f: 0.05 },
  moderate: { c: '#FDE047', label: 'Moderate', w: 1.8, f: 0.08 },
  high: { c: '#FB923C', label: 'High', w: 2.2, f: 0.12 },
  very_high: { c: '#EF233C', label: 'Very high', w: 2.6, f: 0.16 },
  extreme: { c: '#D90429', label: 'Extreme', w: 3.2, f: 0.24 },
};
const CASING = '#2B2D42';

const SVG = (inner: string, size = 16, fill = 'none', stroke = '#fff') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const PATHS = {
  flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  drop: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  tent: '<path d="M3.5 21 14 3"/><path d="M20.5 21 10 3"/><path d="M15.5 21 12 15l-3.5 6"/><path d="M2 21h20"/>',
  flag: '<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  house: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
};
const esc = (t: string) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Stitch speech-bubble callout anchored on the point. */
function callout(html: string, base: string, big = false) {
  return L.divIcon({
    className: '', iconSize: [0, 0], iconAnchor: [0, 0],
    html: `<div class="callout anc" style="position:absolute;left:0;top:0;transform:translate(-50%,calc(-100% + 5px))"><div class="callout-body${big ? ' big' : ''}">${html}</div><div class="callout-tip"></div><div class="callout-base" style="background:${base}"></div></div>`,
  });
}
const ICON = {
  flame: SVG('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>', 18),
  drop: SVG('<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>'),
  eye: SVG('<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>'),
  camera: SVG('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
  tent: SVG('<path d="M3.5 21 14 3"/><path d="M20.5 21 10 3"/><path d="M15.5 21 12 15l-3.5 6"/><path d="M2 21h20"/>'),
  alert: SVG('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  flag: SVG('<path d="M4 22V4"/><path d="M4 4h12l-2 4 2 4H4"/>'),
};
const assetStyle: Record<string, { c: string; p: string }> = {
  water: { c: '#2563EB', p: PATHS.drop },
  camera: { c: '#475569', p: PATHS.camera },
  tower: { c: '#1E293B', p: PATHS.eye },
  camp: { c: '#334155', p: PATHS.tent },
  assembly: { c: '#64748B', p: PATHS.flag },
  standby_post: { c: '#2B2D42', p: PATHS.user },
  parking: { c: '#475569', p: PATHS.truck },
  community: { c: '#94A3B8', p: PATHS.house },
};
/**
 * Labels only at street-level zoom; below it, compact dots (tap for the name).
 * When labels would overlap, higher-priority kinds win and the rest stay dots.
 */
const LABEL_ZOOM: Record<string, number> = { camp: 15, camera: 15, tower: 15, water: 16, parking: 16, assembly: 16, standby_post: 17, community: 17 };
const LABEL_PRIORITY = ['camp', 'camera', 'tower', 'water', 'parking', 'assembly', 'standby_post', 'community'];
type Box = { x0: number; y0: number; x1: number; y1: number };
/** A point well inside the polygon for its label: area centroid, or the middle of the widest
 *  horizontal chord through it when the centroid falls outside (C- or L-shaped compartments). */
const labelCache = new WeakMap<object, [number, number]>();
function labelPoint(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] {
  const hit = labelCache.get(g);
  if (hit) return hit;
  const r = labelPointCalc(g);
  labelCache.set(g, r);
  return r;
}
function labelPointCalc(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number] {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let best = polys[0][0], bestA = -1;
  for (const p of polys) {
    let a = 0; const r = p[0];
    for (let i = 1; i < r.length; i++) a += r[i - 1][0] * r[i][1] - r[i][0] * r[i - 1][1];
    if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = r; }
  }
  let A = 0, cx = 0, cy = 0;
  for (let i = 1; i < best.length; i++) {
    const [x0, y0] = best[i - 1], [x1, y1] = best[i], f = x0 * y1 - x1 * y0;
    A += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (!A) return [best[0][1], best[0][0]];
  cx /= 3 * A; cy /= 3 * A;
  // inside test on the main ring
  let inside = false;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const [xi, yi] = best[i], [xj, yj] = best[j];
    if (yi > cy !== yj > cy && cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) inside = !inside;
  }
  if (inside) return [cy, cx];
  const xs: number[] = [];
  for (let i = 1; i < best.length; i++) {
    const [x0, y0] = best[i - 1], [x1, y1] = best[i];
    if (y0 > cy !== y1 > cy) xs.push(x0 + ((cy - y0) * (x1 - x0)) / (y1 - y0));
  }
  xs.sort((a, b) => a - b);
  let w = -1, mx = cx;
  for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > w) { w = xs[i + 1] - xs[i]; mx = (xs[i] + xs[i + 1]) / 2; }
  return [cy, mx];
}
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

const OVERLAY_STYLE: Record<string, L.PathOptions> = {
  high_risk_zone: { color: '#EF233C', weight: 1.5, dashArray: '6 4', fillColor: '#EF233C', fillOpacity: 0.06 },
  burnt_area: { color: '#1E293B', weight: 1, fillColor: '#2B2D42', fillOpacity: 0.4 },
  camera_coverage: { color: '#F8FAFC', weight: 1.2, dashArray: '2 6', fillColor: '#F8FAFC', fillOpacity: 0.05 },
  firebreak: { color: '#F8FAFC', weight: 2, dashArray: '5 5', opacity: 0.95 },
  standby_route: { color: '#F8FAFC', weight: 2, dashArray: '1 6', lineCap: 'round', opacity: 0.9 },
  waterway: { color: '#38BDF8', weight: 2, opacity: 0.85 },
  plantain_farm: { color: '#65A30D', weight: 1, fillColor: '#84CC16', fillOpacity: 0.3 },
  estate_boundary: { color: '#F8FAFC', weight: 1.5, opacity: 0.7, fill: false, interactive: false },
};
/** Estate edge stretches: red = no mapped barrier in the 2 km outside; amber dashed = only unverified barriers. */
export const EDGE_GAP_STYLE: Record<string, L.PathOptions & { label: string }> = {
  gap: { color: '#EF233C', weight: 5, opacity: 0.95, lineCap: 'butt', label: 'No mapped barrier' },
  uncertain: { color: '#F59E0B', weight: 4, opacity: 0.95, dashArray: '7 5', lineCap: 'butt', label: 'Only unverified barriers' },
};
/** Map layers that can act as fire barriers (and can be field-checked). Roads are barriers too. */
const BARRIER_LAYERS = new Set(['firebreak', 'waterway', 'plantain_farm']);
export interface BarrierRef { id: string; name: string; kind: string }
/** Popup button for crew/coordinators/admins: record a field check of this possible barrier. */
const checkButton = (s: MapData, b: BarrierRef) =>
  s.me && can(s.me.role, 'respond')
    ? `<button data-barrier-id="${esc(b.id)}" data-barrier-name="${esc(b.name)}" data-barrier-kind="${esc(b.kind)}" style="margin-top:8px;width:100%;min-height:40px;border-radius:9999px;background:#2B2D42;color:#fff;font:600 13px inherit;border:0">Record field check</button>`
    : '';
/** Fire risk rating colours (Stage 4). Unknown = not enough current data, never "low". */
export const RATING_STYLE: Record<Rating, { c: string; label: string }> = {
  low: { c: '#4ADE80', label: 'Low' },
  moderate: { c: '#FDE047', label: 'Moderate' },
  high: { c: '#FB923C', label: 'High' },
  extreme: { c: '#D90429', label: 'Extreme' },
  unknown: { c: '#94A3B8', label: 'Unknown' },
};
const agoShort = (iso: string | null) => {
  if (!iso) return 'never';
  const h = (Date.now() - Date.parse(iso)) / 3600e3;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};
/** Rating with every driver: what was found, its score (0–3 or ?), and when that data was last updated. */
function riskHtml(r: RiskResult | undefined): string {
  if (!r) return '';
  const st = RATING_STYLE[r.rating];
  const rows = r.drivers.filter((d) => d.applies).map((d) =>
    `<tr><td style="color:#475569;padding:1px 8px 1px 0;vertical-align:top">${esc(d.label)}</td><td style="vertical-align:top"><b>${d.score == null ? '?' : d.score}</b>/3 · ${esc(d.value)}<div style="font-size:10.5px;color:${d.stale ? '#B91C1C' : '#64748B'}">${d.stale ? 'OLD / MISSING DATA · ' : ''}updated ${agoShort(d.updated)}</div></td></tr>`).join('');
  return `<div data-testid="risk-popup" style="margin:6px 0 4px;padding:6px 8px;border-radius:10px;background:${st.c}22;border:1px solid ${st.c}"><div style="font-weight:700;font-size:13px">Fire risk: <span style="color:${r.rating === 'moderate' ? '#854D0E' : r.rating === 'low' ? '#166534' : st.c}">${st.label.toUpperCase()}</span></div><div style="font-size:11px;color:#475569">${esc(r.why)}</div><table style="margin-top:4px;font-size:11.5px">${rows}</table></div>`;
}

/** Fuel dryness classes (NDMI from Sentinel-2): moist green → very dry red; unknown grey. */
export const DRYNESS_STYLE: Record<DrynessClass, { c: string; label: string }> = {
  low: { c: '#4ADE80', label: 'Low' },
  moderate: { c: '#FDE047', label: 'Moderate' },
  high: { c: '#FB923C', label: 'High' },
  extreme: { c: '#B91C1C', label: 'Extreme' },
  unknown: { c: '#94A3B8', label: 'Unknown' },
};
const fmtDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const fmtWindow = (d: Pick<FuelDryness, 'window_from' | 'window_to'>) => (d.window_from && d.window_to ? `${fmtDay(d.window_from)}–${fmtDay(d.window_to)}` : '—');
function drynessRows(s: MapData, code: string): string[] {
  const out: string[] = [];
  for (const [kind, label] of [['compartment', 'fuel dryness'], ['edge_zone', 'fuel dryness 2 km outside']] as const) {
    const d = s.fuelDryness?.find((x) => x.id === `${kind}|${code}`);
    if (!d) continue;
    const v = d.class === 'unknown' ? `Unknown (too cloudy, ${Math.round(d.usable_pct ?? 0)}% clear)` : `${DRYNESS_STYLE[d.class].label} · NDMI ${d.ndmi_p50?.toFixed(2)} · ${fmtWindow(d)}`;
    out.push(fmtProp(label, v + (drynessStale(d.computed_at) ? ' · OLD' : '')));
  }
  const fl = s.fuelDryness?.find((x) => x.id === `compartment|${code}`)?.fuel_load_t_ha;
  if (fl != null) out.push(fmtProp('fuel load', `${fl} t/ha`));
  return out;
}

/* Compartment card (17 Nov 2026): one clear answer first (rating + main concerns), then the five drivers as
   short rows with 0-3 dots, then history and the estate edge as a bar. Nothing is shown twice. */
const SHORT: Record<string, string> = {
  dryness_in: 'Fuel dryness inside', dryness_out: 'Fuel dryness 2 km out', barriers: 'Edge firebreaks',
  detections: 'Satellite fires', weather: 'Fire weather today',
};
const DOT = ['#CBD5E1', '#EAB308', '#F97316', '#DC2626'];
const dots = (n: number | null) => n == null
  ? '<span style="color:#64748B;font-size:11px">unknown</span>'
  : `<span style="letter-spacing:2px;white-space:nowrap">${[1, 2, 3].map((i) => `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${i <= n ? DOT[n] : '#E2E8F0'}"></span>`).join(' ')}</span>`;
const shortValue = (d: Driver, c: Compartment) => {
  if (d.key === 'barriers' && c.edge_checked_at) {
    const gap = c.edge_gap_pct ?? 0, unv = c.edge_uncertain_pct ?? 0;
    return gap > 0 ? `${gap}% with no barrier` : unv > 0 ? `${unv}% not checked` : 'all checked';
  }
  if (d.key === 'detections') return d.value.replace('none within 5 km in 7 days', 'none in 7 days');
  return d.value.replace(/ \(NDMI [^)]*\)/, '');
};
const sec = (t: string) => `<div style="margin:10px 0 4px;font-size:10.5px;font-weight:700;letter-spacing:.06em;color:#64748B;text-transform:uppercase">${t}</div>`;
function compartmentCard(c: Compartment, p: Record<string, unknown>, r: RiskResult | undefined, baseline: string): string {
  const head = `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
    <div style="font-size:16px;font-weight:700">${esc(c.code)} <span style="font-weight:500;color:#64748B;font-size:13px">· Block ${esc(c.block)}</span></div>
    ${p.area_ha != null ? `<div style="font-size:13px;color:#475569">${esc(String(p.area_ha))} ha</div>` : ''}</div>`;
  let risk = '';
  if (r) {
    const st = RATING_STYLE[r.rating];
    const ink = r.rating === 'moderate' ? '#854D0E' : r.rating === 'low' ? '#166534' : r.rating === 'unknown' ? '#334155' : '#FFFFFF';
    const bg = r.rating === 'moderate' || r.rating === 'low' || r.rating === 'unknown' ? st.c : st.c;
    const ap = r.drivers.filter((d) => d.applies);
    const concerns = ap.filter((d) => (d.score ?? 0) >= 1).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const stale = ap.filter((d) => d.stale);
    const main = r.rating === 'unknown' ? 'Not enough current data to rate.'
      : concerns.length ? `Main concern${concerns.length > 1 ? 's' : ''}: ${concerns.slice(0, 2).map((d) => SHORT[d.key].toLowerCase()).join(' and ')}.`
      : 'Nothing above low right now.';
    risk = `<div data-testid="risk-popup" style="margin-top:8px;padding:8px 10px;border-radius:12px;background:${st.c}26;border:1px solid ${st.c}">
      <div style="display:flex;align-items:center;gap:8px"><span style="background:${bg};color:${ink};font-weight:800;font-size:12px;letter-spacing:.04em;padding:3px 8px;border-radius:999px">${st.label.toUpperCase()}</span><span style="font-weight:600;font-size:13px">fire risk</span></div>
      <div style="margin-top:4px;font-size:12.5px;color:#1E293B">${esc(main)}</div>
      ${stale.length ? `<div style="margin-top:2px;font-size:11.5px;color:#B91C1C">Old or missing data: ${esc(stale.map((d) => SHORT[d.key].toLowerCase()).join(', '))}</div>` : ''}
    </div>`;
    risk += sec('What drives it') + `<table style="width:100%;font-size:12.5px;border-collapse:collapse">${ap.map((d) =>
      `<tr><td style="padding:3px 6px 3px 0;color:#334155">${esc(SHORT[d.key])}</td><td style="padding:3px 6px;width:44px">${dots(d.score)}</td><td style="padding:3px 0;text-align:right;color:${d.stale ? '#B91C1C' : '#0F172A'};font-weight:600">${esc(shortValue(d, c))}</td></tr>`).join('')}</table>`;
  }
  // history and baseline
  const burnt = [p.burnt_2024_field_ha != null && `${p.burnt_2024_field_ha} ha in 2024 (field)`,
    p.burnt_2023_24_s2_ha != null && `${p.burnt_2023_24_s2_ha} ha in 2023/24`,
    p.burnt_2025_26_s2_ha != null && `${p.burnt_2025_26_s2_ha} ha in 2025/26`].filter(Boolean).join(' · ');
  const line = (k: string, v: string) => `<tr><td style="padding:2px 8px 2px 0;color:#64748B;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:2px 0;font-weight:600">${esc(v)}</td></tr>`;
  const fl = (p as Record<string, unknown>).fuel_load_t_ha;
  const hist = [
    burnt && line('Burnt', burnt),
    line('2025 FMP zone', baseline + (p.hrz_overlap_pct != null ? ` · ${p.hrz_overlap_pct}% in high-risk zone` : '')),
    p.yop_youngest != null && line('Planted', `${p.yop_youngest}${p.yop_oldest != null && p.yop_oldest !== p.yop_youngest ? ` (oldest ${p.yop_oldest})` : ''}`),
    fl != null && line('Fuel load', `${fl} t/ha`),
    c.treatment_status && line('Treatment', String(c.treatment_status)),
  ].filter(Boolean).join('');
  let edge = '';
  if (c.edge) {
    const km = ((c.edge_length_m ?? 0) / 1000).toFixed(1);
    if (c.edge_checked_at) {
      const gap = c.edge_gap_pct ?? 0, unv = c.edge_uncertain_pct ?? 0, ok = c.edge_protected_pct ?? 0;
      const seg = (w: number, col: string, pat = false) => w > 0 ? `<div style="width:${w}%;background:${pat ? `repeating-linear-gradient(135deg,${col} 0 5px,#FEF3C7 5px 9px)` : col}"></div>` : '';
      edge = sec(`Estate edge · ${km} km`) + `<div style="display:flex;height:10px;border-radius:5px;overflow:hidden;background:#E2E8F0">${seg(gap, '#DC2626')}${seg(unv, '#F59E0B', true)}${seg(ok, '#16A34A')}</div>
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:11.5px;color:#334155"><span><b style="color:#DC2626">${gap}%</b> no barrier</span><span><b style="color:#B45309">${unv}%</b> not checked</span><span><b style="color:#15803D">${ok}%</b> checked</span></div>`;
    } else edge = sec(`Estate edge · ${km} km`) + `<div style="font-size:12px;color:#64748B">Barriers along the edge not analysed yet.</div>`;
  }
  const foot = [r?.score != null ? `Score ${r.score.toFixed(2)} of 3` : '', p.risk_basis ? `Baseline: ${String(p.risk_basis)}` : ''].filter(Boolean).join(' · ');
  return `<div style="min-width:250px">${head}${risk}${sec('History and baseline')}<table style="font-size:12.5px">${hist}</table>${edge}${foot ? `<div style="margin-top:10px;font-size:10.5px;color:#94A3B8">${esc(foot)}</div>` : ''}</div>`;
}

const POLY_LAYERS = ['high_risk_zone', 'burnt_area', 'camera_coverage', 'plantain_farm', 'estate_boundary'];
const CASED = new Set(['firebreak', 'standby_route']);
const fmtProp = (k: string, v: unknown) => `<tr><td style="color:#475569;padding-right:8px">${esc(k.replace(/_/g, ' '))}</td><td><b>${esc(String(v))}</b></td></tr>`;

const pin = (bg: string, inner: string, size = 28, cls = '') =>
  L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px;background:${bg}">${inner}</div>` });

const incidentColor = (s: Incident['status']) =>
  ({ reported: '#EF233C', confirmed: '#D90429', responding: '#D90429', on_scene: '#D90429', contained: '#2F8F5B', controlled: '#2F8F5B', out: '#64748B', dismissed: '#94A3B8' })[s];

const CREW_STYLE: Record<string, { c: string; label: string; p: string }> = {
  standby: { c: '#475569', label: 'Standby', p: PATHS.user },
  en_route: { c: '#2563EB', label: 'En route', p: PATHS.truck },
  on_scene: { c: '#2B2D42', label: 'On scene', p: PATHS.flame },
};
export interface RouteLine { coords: [number, number][]; primary?: boolean }

/** The slices of app state the map draws. */
export type MapData = Pick<AppState, 'incidents' | 'assets' | 'compartments' | 'roads' | 'detections' | 'hazards' | 'perimeters' | 'mapLayers' | 'layers' | 'crewPositions' | 'crews' | 'me'> & Partial<Pick<AppState, 'fuelDryness' | 'fireDanger' | 'feedStatus' | 'riskConfig'>>;

export interface RenderOpts {
  selectedId?: string | null;
  onIncident?: (id: string) => void;
  onDetection?: (id: string) => void;
  onAsset?: (id: string) => void;
  onHazard?: (id: string) => void;
  /** "Record field check" tapped in a road / firebreak / stream / plantain farm popup */
  onBarrier?: (b: BarrierRef) => void;
  onMapClick?: (lat: number, lon: number) => void;
}

export class MapController {
  map: L.Map;
  private base: L.TileLayer | null = null;
  private baseKind: string | null = null;
  private g: Record<string, L.LayerGroup> = {};
  private meMarker: L.Marker | null = null;
  private meCircle: L.Circle | null = null;
  private clickHandler: ((e: L.LeafletMouseEvent) => void) | null = null;
  private canvas = L.canvas({ padding: 0.5 });
  private last: { s: MapData; o: RenderOpts } | null = null;

  constructor(el: HTMLElement, center = CONFIG.center, zoom = 14) {
    // tolerance: a finger can hit a 3 px road or firebreak line (for field checks) without pixel-perfect aim
    this.map = L.map(el, { zoomControl: false, attributionControl: true, preferCanvas: true, renderer: L.canvas({ tolerance: 6 }), zoomSnap: 0.5 }).setView([center.lat, center.lon], zoom);
    for (const k of ['compartments', 'riskRating', 'dryness', 'overlayPoly', 'roads', 'overlayLine', 'spread', 'compLabels', 'routes', 'assets', 'crews', 'detections', 'hazards', 'perimeters', 'incidents', 'extra']) this.g[k] = L.layerGroup().addTo(this.map);
    // label visibility and collisions depend on zoom
    this.map.on('zoomend', () => { if (this.last) { this.renderAssets(this.last.s, this.last.o); this.renderCompLabels(this.last.s); this.renderCrews(this.last.s); } });
    this.map.attributionControl.setPrefix('');
    // "Record field check" buttons live in popup HTML: wire them when a popup opens
    this.map.on('popupopen', (e: L.PopupEvent) => {
      const btn = e.popup.getElement()?.querySelector<HTMLButtonElement>('[data-barrier-id]');
      if (!btn) return;
      btn.onclick = () => { this.map.closePopup(); this.last?.o.onBarrier?.({ id: btn.dataset.barrierId!, name: btn.dataset.barrierName ?? '', kind: btn.dataset.barrierKind ?? '' }); };
    });
    L.control.scale({ metric: true, imperial: false, position: 'bottomleft', maxWidth: 90 }).addTo(this.map);
  }

  setBasemap(kind: 'street' | 'satellite') {
    if (this.baseKind === kind) return;
    this.base?.remove();
    this.base = basemap(kind).addTo(this.map);
    this.base.bringToBack();
    this.baseKind = kind;
    const el = this.map.getContainer();
    el.classList.toggle('basemap-satellite', kind === 'satellite');
    el.classList.toggle('basemap-street', kind === 'street');
  }

  /**
   * Heading-up view: turn the map so `bearing` (degrees clockwise from north) points to the top of the screen.
   * Leaflet can't rotate, so the map element is made a square big enough to cover the screen at any angle, centred
   * `focusY` of the way down its parent (so you sit low on screen with the way ahead visible), and turned with CSS.
   * Marker pins and labels are turned back (CSS var --map-bearing) so they stay upright; "your direction" cones and the
   * wind arrow are map directions and turn with the map. While rotated, panning by finger is off and pinch zooms on
   * the centre (Leaflet's touch maths assumes an unrotated map). null = back to north-up.
   */
  private rot: { side: number; cy: number; deg: number } | null = null;
  setRotation(bearing: number | null, focusY = 0.6) {
    const el = this.map.getContainer();
    const m = this.map;
    if (bearing == null || !Number.isFinite(bearing)) {
      if (!this.rot) return;
      this.rot = null;
      el.classList.remove('map-rot');
      for (const k of ['width', 'height', 'left', 'top', 'right', 'bottom', 'transform', '--map-bearing']) el.style.removeProperty(k);
      m.dragging.enable();
      Object.assign(m.options, { touchZoom: true, scrollWheelZoom: true, doubleClickZoom: true });
      m.invalidateSize({ pan: false });
      return;
    }
    const parent = el.parentElement!;
    const W = parent.clientWidth, H = parent.clientHeight;
    const cy = Math.round(H * focusY);
    const side = Math.ceil(2 * Math.hypot(W / 2, Math.max(cy, H - cy))) + 2;
    if (!this.rot || this.rot.side !== side || this.rot.cy !== cy) {
      const center = m.getCenter();
      Object.assign(el.style, { width: `${side}px`, height: `${side}px`, left: `${Math.round(W / 2 - side / 2)}px`, top: `${cy - Math.round(side / 2)}px`, right: 'auto', bottom: 'auto' });
      el.classList.add('map-rot');
      m.dragging.disable();
      Object.assign(m.options, { touchZoom: 'center', scrollWheelZoom: 'center', doubleClickZoom: 'center' });
      m.invalidateSize({ pan: false });
      m.setView(center, m.getZoom(), { animate: false });
    }
    // keep the angle continuous (359° → 1° turns 2°, not 358° backwards)
    const prev = this.rot?.deg ?? bearing;
    const deg = prev + ((((bearing - prev) % 360) + 540) % 360) - 180;
    this.rot = { side, cy, deg };
    el.style.transform = `rotate(${-deg}deg)`;
    el.style.setProperty('--map-bearing', `${deg}deg`);
  }
  get rotated() { return !!this.rot; }

  setMe(fix: GpsFix | null, heading?: number | null) {
    if (!fix) return;
    const ll: L.LatLngExpression = [fix.lat, fix.lon];
    if (!this.meMarker) {
      this.meMarker = L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="me-wrap"><div class="me-ping"></div><div class="me-halo"><div class="me-dot"></div></div><div class="me-cone" style="display:none"></div></div>' }), interactive: false, zIndexOffset: 1000 }).addTo(this.map);
      this.meCircle = L.circle(ll, { radius: fix.acc, color: '#2563EB', weight: 1, opacity: 0.5, fillColor: '#2563EB', fillOpacity: 0.1, interactive: false }).addTo(this.map);
    } else {
      this.meMarker.setLatLng(ll);
      this.meCircle!.setLatLng(ll).setRadius(fix.acc);
    }
    const cone = this.meMarker.getElement()?.querySelector('.me-cone') as HTMLElement | null;
    if (cone) {
      const h = heading != null && Number.isFinite(heading) ? heading : fix.heading != null && !Number.isNaN(fix.heading) && (fix.speed ?? 0) > 0.5 ? fix.heading : null;
      cone.style.display = h == null ? 'none' : 'block';
      if (h != null) cone.style.transform = `rotate(${h}deg)`;
    }
  }

  /** While true, taps inside compartments place points (report, measure, move) instead of opening details. */
  private pick = false;
  setPick(on: boolean) { this.pick = on; if (on) this.map.closePopup(); }

  onClick(fn: ((lat: number, lon: number) => void) | null) {
    if (this.clickHandler) this.map.off('click', this.clickHandler);
    this.clickHandler = fn ? (e) => fn(e.latlng.lat, e.latlng.lng) : null;
    if (this.clickHandler) this.map.on('click', this.clickHandler);
  }

  private renderAssets(s: MapData, o: RenderOpts) {
    const on = s.layers;
    const z = this.map.getZoom();
    this.g.assets.clearLayers();
    // reserve space for open-incident callouts first: fires always keep their labels
    const placed: Box[] = [];
    for (const i of s.incidents) {
      if (i.deleted_at || i.status === 'out' || i.status === 'dismissed') continue;
      const p = this.map.latLngToContainerPoint([i.lat, i.lon]);
      placed.push({ x0: p.x - 80, x1: p.x + 80, y0: p.y - 56, y1: p.y + 4 });
    }
    const assets = s.assets
      .filter((a) => on[a.kind])
      .sort((a, b) => LABEL_PRIORITY.indexOf(a.kind) - LABEL_PRIORITY.indexOf(b.kind));
    for (const a of assets) {
      const st = assetStyle[a.kind] ?? assetStyle.camp;
      let labelled = z >= (LABEL_ZOOM[a.kind] ?? 16);
      if (labelled) {
        const p = this.map.latLngToContainerPoint([a.lat, a.lon]);
        const w = 44 + a.name.length * 7 + (a.props?.capacity ? String(a.props.capacity).length * 6 : 0);
        const box = { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - 40, y1: p.y + 4 };
        if (placed.some((b) => overlaps(b, box))) labelled = false;
        else placed.push(box);
      }
      const cap = a.props?.capacity ? `<span class="sub" style="color:rgb(var(--c-muted));font-weight:500">${esc(String(a.props.capacity))}</span>` : '';
      const icon = labelled
        ? callout(`<span class="callout-ico">${SVG(st.p, 13, 'none', st.c)}</span><span>${esc(a.name)}</span>${cap}`, st.c)
        : L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 9], html: `<div class="pin" style="width:18px;height:18px;background:${st.c}">${SVG(st.p, 10)}</div>` });
      const m = L.marker([a.lat, a.lon], { icon });
      if (!labelled) m.bindTooltip(esc(a.name));
      const rows = Object.entries(a.props ?? {}).filter(([k]) => k !== 'source').slice(0, 8).map(([k, v]) => fmtProp(k, v)).join('');
      m.bindPopup(`<b>${esc(a.name)}</b><table style="margin-top:4px;font-size:12px">${rows}</table>`);
      m.on('click', () => o.onAsset?.(a.id));
      m.addTo(this.g.assets);
    }
  }

  /** Compartment codes ("C026") inside each compartment; threatened ones turn ember. */
  private renderCompLabels(s: MapData) {
    const g = this.g.compLabels;
    g.clearLayers();
    const z = this.map.getZoom();
    if (!s.layers.compartments || z < 12.5) return;
    const b = this.map.getBounds().pad(0.2);
    const size = z >= 15 ? 13 : z >= 14 ? 12 : 10.5;
    for (const c of s.compartments) {
      const [la, lo] = labelPoint(c.geojson);
      if (!b.contains([la, lo])) continue;
      const t = this.threat.get(c.id);
      const hot = t === 'burning' || t === 'very_high' || t === 'high';
      const style = hot
        ? `background:#D90429;color:#fff;padding:2px 6px;border-radius:6px;box-shadow:0 1px 4px rgba(43,45,66,.5)`
        : `color:#fff;text-shadow:0 0 3px rgba(43,45,66,.95),0 0 6px rgba(43,45,66,.7)`;
      L.marker([la, lo], { interactive: false, keyboard: false, zIndexOffset: hot ? 400 : 0, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="anc" style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);font:700 ${size}px/1.1 -apple-system,system-ui,sans-serif;letter-spacing:.02em;white-space:nowrap;${style}">${esc(c.code)}</div>` }) }).addTo(g);
    }
  }

  private threat = new Map<string, string>();
  /**
   * Fire spread overlay for the focused fire: likely area after 1 h (ember, dashed), a wind arrow,
   * and threatened compartments outlined. Pass null to clear.
   */
  setSpread(sp: { fire: { lat: number; lon: number }; ellipse: [number, number][] | null; windFrom: number | null; threats: { id: string; level: string }[] } | null) {
    const g = this.g.spread ?? (this.g.spread = L.layerGroup().addTo(this.map));
    g.clearLayers();
    this.threat = new Map((sp?.threats ?? []).map((t) => [t.id, t.level]));
    if (sp && this.last) {
      for (const c of this.last.s.compartments) {
        const lv = this.threat.get(c.id);
        if (lv !== 'burning' && lv !== 'very_high' && lv !== 'high') continue;
        L.geoJSON(c.geojson as any, { style: { color: '#D90429', weight: lv === 'high' ? 3 : 4.5, opacity: 0.95, fillColor: '#EF233C', fillOpacity: lv === 'high' ? 0.12 : 0.22, dashArray: lv === 'high' ? '6 5' : undefined }, interactive: false } as any).addTo(g);
      }
      if (sp.ellipse) L.polygon(sp.ellipse, { renderer: this.canvas, color: '#EF233C', weight: 2, dashArray: '4 6', fillColor: '#EF233C', fillOpacity: 0.1, interactive: false }).addTo(g);
      if (sp.windFrom != null) {
        const down = (sp.windFrom + 180) % 360;
        L.marker([sp.fire.lat, sp.fire.lon], { interactive: false, zIndexOffset: -10, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="map-dir" style="position:absolute;left:0;top:0;width:0;height:0;transform:rotate(${down}deg)"><svg width="26" height="90" viewBox="0 0 26 90" style="position:absolute;left:-13px;top:-90px;overflow:visible"><path d="M13 88 V18" stroke="#2B2D42" stroke-width="7" stroke-linecap="round" opacity=".55"/><path d="M13 88 V18" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M2 22 L13 2 L24 22 Z" fill="#fff" stroke="#2B2D42" stroke-width="1.5" stroke-linejoin="round"/></svg></div>` }) }).addTo(g);
      }
    }
    if (this.last) this.renderCompLabels(this.last.s);
  }

  /** Live crew positions (not mine): standby, en route, on scene. Old fixes fade. */
  private renderCrews(s: MapData) {
    const g = this.g.crews;
    g.clearLayers();
    if (!s.layers.crews) return;
    const now = Date.now();
    const z = this.map.getZoom();
    for (const p of s.crewPositions ?? []) {
      if (p.status === 'off' || p.id === s.me?.id) continue;
      const inc = p.incident_id ? s.incidents.find((i) => i.id === p.incident_id) : null;
      // a phone that still says "en route" for a fire that is closed or gone is shown as standby
      const responding = (p.status === 'en_route' || p.status === 'on_scene') && !!inc && !inc.deleted_at && inc.status !== 'out' && inc.status !== 'dismissed';
      const st = (responding ? CREW_STYLE[p.status] : p.status === 'standby' || p.status === 'en_route' || p.status === 'on_scene' ? CREW_STYLE.standby : CREW_STYLE[p.status]) ?? CREW_STYLE.standby;
      const age = now - Date.parse(p.fix_at);
      const stale = age > 5 * 60_000;
      const crew = s.crews.find((c) => c.id === p.crew_id);
      const short = (crew?.name ?? p.name).replace(/^Block /, '').replace(' — ', ' ');
      const tag = z >= 14 ? `<div class="crew-tag">${esc(short)}${stale ? ` · ${Math.round(age / 60_000)} min` : ''}</div>` : '';
      const m = L.marker([p.lat, p.lon], {
        zIndexOffset: 700,
        icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="crew${stale ? ' stale' : ''}"><div class="crew-in" style="background:${st.c}">${SVG(st.p, 13)}</div>${tag}</div>` }),
      });
      m.bindPopup(`<b>${esc(p.name)}</b>${crew ? `<div style="font-size:12px;color:#475569">${esc(crew.name)}</div>` : ''}<div style="margin-top:4px;font-size:12px"><b style="color:${st.c}">${st.label}</b>${inc && responding ? ` → ${esc(inc.code ?? inc.label)}` : ''} · ${age < 60_000 ? 'just now' : Math.round(age / 60_000) + ' min ago'}${p.acc != null ? ` · ±${Math.round(p.acc)} m` : ''}</div>`);
      m.addTo(g);
    }
  }

  /** Cobalt routes: the primary one (mine) cased and solid, others (crews en route) thin dashed. */
  setRoutes(routes: RouteLine[]) {
    const g = this.g.routes;
    g.clearLayers();
    for (const r of routes.filter((x) => !x.primary)) {
      L.polyline(r.coords, { renderer: this.canvas, color: '#2563EB', weight: 2.5, opacity: 0.8, dashArray: '2 6', lineCap: 'round', interactive: false }).addTo(g);
    }
    for (const r of routes.filter((x) => x.primary)) {
      // route = [you, onto the network, ...roads..., off the network, fire]: the first and last legs are on foot (dashed)
      const c = r.coords;
      const road = c.length > 3 ? c.slice(1, -1) : c;
      if (c.length > 3) for (const leg of [[c[0], c[1]], [c[c.length - 2], c[c.length - 1]]] as [number, number][][]) {
        L.polyline(leg, { renderer: this.canvas, color: '#FFFFFF', weight: 7, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(g);
        L.polyline(leg, { renderer: this.canvas, color: '#2563EB', weight: 4, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(g);
      }
      L.polyline(road, { renderer: this.canvas, color: '#FFFFFF', weight: 9, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(g);
      L.polyline(road, { renderer: this.canvas, color: '#2563EB', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(g);
      // make the start obvious: the route always begins at the user's own GPS position
      const [la, lo] = r.coords[0];
      L.marker([la, lo], { interactive: false, zIndexOffset: 1100, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="anc" style="position:absolute;left:0;top:0;transform:translate(-50%,calc(-100% - 16px));background:#2563EB;color:#fff;font:700 11px/1 -apple-system,system-ui,sans-serif;padding:4px 7px;border-radius:9999px;white-space:nowrap;box-shadow:0 2px 6px rgba(43,45,66,.35)">You</div>` }) }).addTo(g);
    }
  }

  /**
   * Draw the map. Only the layer groups whose data actually changed (by reference) are rebuilt,
   * so a crew position update or a tap on a fire doesn't redraw 84 compartments and 208 roads.
   */
  render(s: MapData, o: RenderOpts = {}) {
    const p = this.last?.s;
    const po = this.last?.o;
    this.last = { s, o };
    const ch = (...keys: (keyof MapData)[]) => !p || keys.some((k) => p[k] !== s[k]);
    if (ch('mapLayers', 'layers', 'me')) this.renderOverlays(s);
    if (ch('compartments', 'layers', 'fuelDryness')) { this.renderCompartments(s); this.renderCompLabels(s); }
    if (ch('fuelDryness', 'compartments', 'mapLayers', 'layers')) this.renderDryness(s);
    if (ch('fuelDryness', 'compartments', 'detections', 'fireDanger', 'feedStatus', 'riskConfig', 'layers')) this.renderRisk(s);
    if (ch('roads', 'layers', 'me')) this.renderRoads(s);
    if (ch('crewPositions', 'crews', 'layers', 'me', 'incidents')) this.renderCrews(s);
    if (ch('assets', 'layers', 'incidents')) this.renderAssets(s, o);
    if (ch('detections', 'layers') || po?.onDetection !== o.onDetection) this.renderDetections(s, o);
    if (ch('hazards', 'layers') || po?.onHazard !== o.onHazard) this.renderHazards(s, o);
    if (ch('perimeters', 'incidents')) this.renderPerimeters(s);
    if (ch('incidents') || po?.selectedId !== o.selectedId || po?.onIncident !== o.onIncident) this.renderIncidents(s, o);
  }

  private renderOverlays(s: MapData) {
    const on = s.layers;
    this.g.overlayPoly.clearLayers();
    this.g.overlayLine.clearLayers();
    for (const l of s.mapLayers ?? []) {
      // the estate outline is drawn with the edge gaps; edge zones are analysis areas, not drawn
      if (!(on[l.layer] || (l.layer === 'estate_boundary' && on.edge_gap)) || l.layer === 'edge_zone') continue;
      const st = l.layer === 'edge_gap' ? EDGE_GAP_STYLE[String(l.props?.status)] ?? EDGE_GAP_STYLE.gap : OVERLAY_STYLE[l.layer] ?? { color: '#F8FAFC', weight: 1.5 };
      const rows = Object.entries(l.props ?? {}).filter(([k]) => k !== 'source').slice(0, 8).map(([k, v]) => fmtProp(k, v)).join('');
      if (CASED.has(l.layer)) L.geoJSON(l.geojson as any, { style: { color: CASING, weight: (st.weight ?? 2) + 2.5, opacity: 0.55 }, interactive: false } as any).addTo(this.g.overlayLine);
      L.geoJSON(l.geojson as any, { style: st })
        .bindTooltip(esc(l.name + (l.props?.area_ha != null ? ` · ${l.props.area_ha} ha` : '')), { sticky: true })
        .bindPopup(`<b>${esc(l.name)}</b><table style="margin-top:4px;font-size:12px">${rows}</table>${BARRIER_LAYERS.has(l.layer) ? checkButton(s, { id: l.id, name: l.name, kind: l.layer }) : ''}`)
        .addTo(POLY_LAYERS.includes(l.layer) ? this.g.overlayPoly : this.g.overlayLine);
    }
  }

  /** Fuel dryness (Sentinel-2): compartments filled by class, their 2 km edge zones lighter. Unknown = grey, dashed. */
  private renderDryness(s: MapData) {
    const g = this.g.dryness;
    g.clearLayers();
    if (!s.layers.dryness || !s.fuelDryness?.length) return;
    const by = new Map(s.fuelDryness.map((d) => [d.id, d]));
    const tip = (code: string, d: FuelDryness, outer: boolean) =>
      `${code}${outer ? ' · 2 km outside' : ''} · fuel dryness ${DRYNESS_STYLE[d.class].label}` +
      (d.class === 'unknown' ? ' (too cloudy)' : ` · NDMI ${d.ndmi_p50?.toFixed(2)} · ${fmtWindow(d)} · ${Math.round(d.usable_pct ?? 0)}% clear`) +
      (drynessStale(d.computed_at) ? ' · OLD DATA' : '');
    const draw = (geo: GeoJSON.Geometry, d: FuelDryness, code: string, outer: boolean) => {
      const st = DRYNESS_STYLE[d.class];
      L.geoJSON(geo as any, { style: { color: st.c, weight: outer ? 0.8 : 1.2, opacity: 0.9, dashArray: d.class === 'unknown' ? '4 4' : undefined, fillColor: st.c, fillOpacity: d.class === 'unknown' ? 0.08 : outer ? 0.22 : 0.42 }, interactive: true } as any)
        .bindTooltip(esc(tip(code, d, outer)), { sticky: true }).addTo(g);
    };
    for (const m of s.mapLayers) if (m.layer === 'edge_zone') { const code = String(m.props?.compartment ?? ''); const d = by.get('edge_zone|' + code); if (d) draw(m.geojson, d, code, true); }
    for (const c of s.compartments) { const d = by.get('compartment|' + c.code); if (d) draw(c.geojson, d, c.code, false); }
  }

  /** Ratings for every compartment, recomputed when any input changes or at most once a minute (ages move on). */
  private riskCache: { keys: unknown[]; t: number; map: Map<string, RiskResult> } | null = null;
  ratings(s: MapData): Map<string, RiskResult> {
    const keys = [s.compartments, s.fuelDryness, s.detections, s.fireDanger, s.feedStatus, s.riskConfig];
    const c = this.riskCache;
    if (c && c.keys.every((k, i) => k === keys[i]) && Date.now() - c.t < 60_000) return c.map;
    const params = riskParams(s.riskConfig?.find((r) => r.id === 'site')?.params);
    const dry = new Map((s.fuelDryness ?? []).map((d) => [d.id, d]));
    const recent = s.detections.filter((d) => Date.now() - Date.parse(d.acq_time) < params.detections.km5_h * 3600e3);
    const map = new Map<string, RiskResult>();
    for (const cp of s.compartments) {
      map.set(cp.code, rateCompartment({ compartment: cp, dryIn: dry.get('compartment|' + cp.code), dryOut: dry.get('edge_zone|' + cp.code),
        detections: recent, danger: s.fireDanger ?? [], feeds: s.feedStatus ?? [], params }));
    }
    this.riskCache = { keys, t: Date.now(), map };
    return map;
  }

  /** Fire risk rating layer: compartments filled by rating; unknown grey and dashed. */
  private renderRisk(s: MapData) {
    const g = this.g.riskRating;
    g.clearLayers();
    if (!s.layers.risk_rating) return;
    const rs = this.ratings(s);
    for (const c of s.compartments) {
      const r = rs.get(c.code);
      if (!r) continue;
      const st = RATING_STYLE[r.rating];
      L.geoJSON(c.geojson as any, { style: { color: st.c, weight: 1.6, opacity: 1, dashArray: r.rating === 'unknown' ? '4 4' : undefined, fillColor: st.c, fillOpacity: r.rating === 'unknown' ? 0.1 : 0.45 }, interactive: false } as any).addTo(g);
    }
  }

  private renderCompartments(s: MapData) {
    this.g.compartments.clearLayers();
    if (!s.layers.compartments) return;
    for (const c of s.compartments) {
      const r = RISK[c.risk_class] ?? RISK.moderate;
      L.geoJSON(c.geojson as any, { style: { color: CASING, weight: r.w + 2.6, opacity: 0.6, fill: false }, interactive: false } as any).addTo(this.g.compartments);
      const info = () => compartmentCard(c, (c.props ?? {}) as Record<string, unknown>,
        this.ratings(this.last?.s ?? s).get(c.code), `${r.label}${c.risk_score != null ? ` (${c.risk_score})` : ''}`);
      // A tap inside a compartment shows its details, unless the screen is placing something
      // (fire pin, measuring, moving a pin): then the tap goes to the screen like any map tap.
      L.geoJSON(c.geojson as any, { style: { color: r.c, weight: r.w, opacity: 1, fillColor: r.c, fillOpacity: r.f }, bubblingMouseEvents: false } as any)
        .bindTooltip(esc(`${c.code} · baseline ${r.label}`), { permanent: false, direction: 'center' })
        .on('click', (e: L.LeafletMouseEvent) => {
          if (this.pick && this.clickHandler) this.clickHandler(e);
          else L.popup({ maxWidth: 330, minWidth: 260, maxHeight: Math.round(window.innerHeight * 0.55), autoPanPaddingTopLeft: L.point(12, 150), autoPanPaddingBottomRight: L.point(12, 190) }).setLatLng(e.latlng).setContent(info()).openOn(this.map);
        })
        .addTo(this.g.compartments);
    }
  }

  private renderRoads(s: MapData) {
    this.g.roads.clearLayers();
    if (!s.layers.roads) return;
    for (const r of s.roads) {
      L.geoJSON(r.geojson as any, { style: { color: CASING, weight: 5.5, opacity: 0.5 }, interactive: false } as any).addTo(this.g.roads);
      L.geoJSON(r.geojson as any, { style: { color: r.passable ? '#F8FAFC' : '#EF233C', weight: 2.8, dashArray: r.passable ? undefined : '4 6', opacity: 0.95 } })
        .bindTooltip(esc(r.name + (r.props?.Status ? ` · ${r.props.Status}` : '') + (r.passable ? '' : ' — NOT PASSABLE')))
        .bindPopup(`<b>${esc(r.name)}</b><table style="margin-top:4px;font-size:12px">${[r.props?.Type && fmtProp('type', r.props.Type), r.props?.Status && fmtProp('status', r.props.Status), r.props?.length_m != null && fmtProp('length', `${r.props.length_m} m`)].filter(Boolean).join('')}</table>${checkButton(s, { id: r.id, name: r.name, kind: String(r.props?.Type ?? r.props?.type ?? '').toLowerCase() === 'track' ? 'track' : 'road' })}`)
        .addTo(this.g.roads);
    }
  }

  private renderDetections(s: MapData, o: RenderOpts) {
    this.g.detections.clearLayers();
    if (!s.layers.detections) return;
    const now = Date.now();
    for (const d of s.detections) {
      if (d.promoted_incident_id) continue;
      if (now - Date.parse(d.acq_time) > 48 * 3600_000) continue; // only recent passes on the map
      const m = L.marker([d.lat, d.lon], { icon: L.divIcon({ className: '', iconSize: [24, 24], iconAnchor: [12, 12], html: '<div style="width:18px;height:18px;transform:rotate(45deg);background:#C026D3;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);margin:3px"></div>' }) })
        .bindTooltip(esc(`Satellite fire detection (unverified) · ${d.source} · ${d.confidence}`));
      m.on('click', () => o.onDetection?.(d.id));
      m.addTo(this.g.detections);
    }
  }

  private renderHazards(s: MapData, o: RenderOpts = {}) {
    this.g.hazards.clearLayers();
    if (!s.layers.hazards) return;
    for (const h of s.hazards) {
      if (h.resolved_at) continue;
      const m = L.marker([h.lat, h.lon], { icon: pin('#D90429', ICON.alert, 26), title: 'Road hazard' }).bindTooltip(esc(`Hazard: ${h.kind.replace('_', ' ')}${h.note ? ' — ' + h.note : ''}`));
      if (o.onHazard) m.on('click', () => o.onHazard?.(h.id));
      m.addTo(this.g.hazards);
    }
  }

  private renderPerimeters(s: MapData) {
    this.g.perimeters.clearLayers();
    for (const p of s.perimeters) {
      const ll = p.vertices.map((v: Vertex) => [v.lat, v.lon] as [number, number]);
      const st = s.incidents.find((i) => i.id === p.incident_id)?.status;
      // green once the fire is contained or better, red while it is still active
      const col = st === 'contained' || st === 'controlled' || st === 'out' ? '#2F8F5B' : '#EF233C';
      if (p.state === 'closed' && ll.length >= 3) L.polygon(ll, { renderer: this.canvas, color: col, weight: 3, fillColor: col, fillOpacity: 0.22 }).addTo(this.g.perimeters);
      else if (ll.length) L.polyline(ll, { renderer: this.canvas, color: col, weight: 4 }).addTo(this.g.perimeters);
    }
  }

  private renderIncidents(s: MapData, o: RenderOpts) {
    this.g.incidents.clearLayers();
    for (const i of s.incidents) {
      if (i.deleted_at) continue;
      const open = i.status !== 'out' && i.status !== 'dismissed';
      const sel = o.selectedId === i.id;
      const col = incidentColor(i.status);
      const sub = i.status === 'reported' ? 'Unverified' : open ? `Active · ${STATUS_LABEL[i.status]}` : STATUS_LABEL[i.status];
      const icon = open
        ? callout(`<span class="callout-ico sq ${i.status !== 'reported' ? 'pulse' : ''}" style="background:${col}">${SVG(PATHS.flame, 18)}</span><span style="display:flex;flex-direction:column;padding-right:4px"><span style="font-weight:700;font-size:13px">${esc(i.code ?? i.label)} <span style="display:inline-block;width:6px;height:6px;border-radius:9999px;background:${col}"></span></span><span class="sub" style="color:${i.status === 'reported' ? '#B91C1C' : col}">${esc(sub)}</span></span>`, col, true)
        : pin(col, ICON.flame, 24);
      const m = L.marker([i.lat, i.lon], { icon, zIndexOffset: sel ? 900 : open ? 500 : 0, opacity: open ? 1 : 0.6 });
      if (sel) setTimeout(() => (m.getElement()?.querySelector('.callout-body') as HTMLElement | null)?.style.setProperty('outline', '2px solid #2B2D42'));
      m.on('click', () => o.onIncident?.(i.id));
      m.addTo(this.g.incidents);
    }
  }

  extra(): L.LayerGroup {
    return this.g.extra;
  }
  fit(pts: [number, number][], pad = 60, extra?: { top?: number; bottom?: number }) {
    if (!pts.length) return;
    this.map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [pad, pad + (extra?.top ?? 0)], paddingBottomRight: [pad, pad + (extra?.bottom ?? 0)], maxZoom: 17 });
  }
  destroy() {
    this.map.remove();
  }
}
