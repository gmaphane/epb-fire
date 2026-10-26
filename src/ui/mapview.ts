import L from 'leaflet';
import { basemap } from '../core/tiles';
import { CONFIG } from '../config';
import type { AppState } from '../core/store';
import type { GpsFix, Incident, Vertex } from '../core/types';
import { STATUS_LABEL } from '../core/flow';

/**
 * Compartment risk strokes, tuned to read on muted satellite imagery:
 * every outline sits on a dark casing, so even "low" stays visible over green canopy.
 */
export const RISK: Record<string, { c: string; label: string; w: number; f: number }> = {
  low: { c: '#E2E8F0', label: 'Low', w: 1.6, f: 0.05 },
  moderate: { c: '#FDE047', label: 'Moderate', w: 1.8, f: 0.08 },
  high: { c: '#FB923C', label: 'High', w: 2.2, f: 0.12 },
  very_high: { c: '#EF4444', label: 'Very high', w: 2.6, f: 0.16 },
  extreme: { c: '#DC2626', label: 'Extreme', w: 3.2, f: 0.24 },
};
const CASING = '#0F172A';

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
    html: `<div class="callout" style="position:absolute;left:0;top:0;transform:translate(-50%,calc(-100% + 5px))"><div class="callout-body${big ? ' big' : ''}">${html}</div><div class="callout-tip"></div><div class="callout-base" style="background:${base}"></div></div>`,
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
  water: { c: '#0284C7', p: PATHS.drop },
  camera: { c: '#475569', p: PATHS.camera },
  tower: { c: '#1E293B', p: PATHS.eye },
  camp: { c: '#334155', p: PATHS.tent },
  assembly: { c: '#64748B', p: PATHS.flag },
  standby_post: { c: '#0F172A', p: PATHS.user },
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
  high_risk_zone: { color: '#EF4444', weight: 1.5, dashArray: '6 4', fillColor: '#EF4444', fillOpacity: 0.06 },
  burnt_area: { color: '#1E293B', weight: 1, fillColor: '#0F172A', fillOpacity: 0.4 },
  camera_coverage: { color: '#F8FAFC', weight: 1.2, dashArray: '2 6', fillColor: '#F8FAFC', fillOpacity: 0.05 },
  firebreak: { color: '#F8FAFC', weight: 2, dashArray: '5 5', opacity: 0.95 },
  standby_route: { color: '#F8FAFC', weight: 2, dashArray: '1 6', lineCap: 'round', opacity: 0.9 },
  waterway: { color: '#38BDF8', weight: 2, opacity: 0.85 },
};
const POLY_LAYERS = ['high_risk_zone', 'burnt_area', 'camera_coverage'];
const CASED = new Set(['firebreak', 'standby_route']);
const fmtProp = (k: string, v: unknown) => `<tr><td style="color:#475569;padding-right:8px">${esc(k.replace(/_/g, ' '))}</td><td><b>${esc(String(v))}</b></td></tr>`;

const pin = (bg: string, inner: string, size = 28, cls = '') =>
  L.divIcon({ className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2], html: `<div class="pin ${cls}" style="width:${size}px;height:${size}px;background:${bg}">${inner}</div>` });

const incidentColor = (s: Incident['status']) =>
  ({ reported: '#EF4444', confirmed: '#DC2626', responding: '#DC2626', on_scene: '#DC2626', contained: '#16A34A', controlled: '#16A34A', out: '#64748B', dismissed: '#94A3B8' })[s];

const CREW_STYLE: Record<string, { c: string; label: string; p: string }> = {
  standby: { c: '#475569', label: 'Standby', p: PATHS.user },
  en_route: { c: '#0284C7', label: 'En route', p: PATHS.truck },
  on_scene: { c: '#0F172A', label: 'On scene', p: PATHS.flame },
};
export interface RouteLine { coords: [number, number][]; primary?: boolean }

/** The slices of app state the map draws. */
export type MapData = Pick<AppState, 'incidents' | 'assets' | 'compartments' | 'roads' | 'detections' | 'hazards' | 'perimeters' | 'mapLayers' | 'layers' | 'crewPositions' | 'crews' | 'me'>;

export interface RenderOpts {
  selectedId?: string | null;
  onIncident?: (id: string) => void;
  onDetection?: (id: string) => void;
  onAsset?: (id: string) => void;
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
    this.map = L.map(el, { zoomControl: false, attributionControl: true, preferCanvas: true, zoomSnap: 0.5 }).setView([center.lat, center.lon], zoom);
    for (const k of ['compartments', 'overlayPoly', 'roads', 'overlayLine', 'spread', 'compLabels', 'routes', 'assets', 'crews', 'detections', 'hazards', 'perimeters', 'incidents', 'extra']) this.g[k] = L.layerGroup().addTo(this.map);
    // label visibility and collisions depend on zoom
    this.map.on('zoomend', () => { if (this.last) { this.renderAssets(this.last.s, this.last.o); this.renderCompLabels(this.last.s); this.renderCrews(this.last.s); } });
    this.map.attributionControl.setPrefix('');
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

  setMe(fix: GpsFix | null) {
    if (!fix) return;
    const ll: L.LatLngExpression = [fix.lat, fix.lon];
    if (!this.meMarker) {
      this.meMarker = L.marker(ll, { icon: L.divIcon({ className: '', iconSize: [28, 28], iconAnchor: [14, 14], html: '<div class="me-wrap"><div class="me-ping"></div><div class="me-halo"><div class="me-dot"></div></div><div class="me-cone" style="display:none"></div></div>' }), interactive: false, zIndexOffset: 1000 }).addTo(this.map);
      this.meCircle = L.circle(ll, { radius: fix.acc, color: '#0284C7', weight: 1, opacity: 0.5, fillColor: '#0284C7', fillOpacity: 0.1, interactive: false }).addTo(this.map);
    } else {
      this.meMarker.setLatLng(ll);
      this.meCircle!.setLatLng(ll).setRadius(fix.acc);
    }
    const cone = this.meMarker.getElement()?.querySelector('.me-cone') as HTMLElement | null;
    if (cone) {
      const h = fix.heading != null && !Number.isNaN(fix.heading) && (fix.speed ?? 0) > 0.5 ? fix.heading : null;
      cone.style.display = h == null ? 'none' : 'block';
      if (h != null) cone.style.transform = `rotate(${h}deg)`;
    }
  }

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
        ? `background:#DC2626;color:#fff;padding:2px 6px;border-radius:6px;box-shadow:0 1px 4px rgba(15,23,42,.5)`
        : `color:#fff;text-shadow:0 0 3px rgba(15,23,42,.95),0 0 6px rgba(15,23,42,.7)`;
      L.marker([la, lo], { interactive: false, keyboard: false, zIndexOffset: hot ? 400 : 0, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div style="position:absolute;left:0;top:0;transform:translate(-50%,-50%);font:700 ${size}px/1.1 -apple-system,system-ui,sans-serif;letter-spacing:.02em;white-space:nowrap;${style}">${esc(c.code)}</div>` }) }).addTo(g);
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
        L.geoJSON(c.geojson as any, { style: { color: '#DC2626', weight: lv === 'high' ? 3 : 4.5, opacity: 0.95, fillColor: '#EF4444', fillOpacity: lv === 'high' ? 0.12 : 0.22, dashArray: lv === 'high' ? '6 5' : undefined }, interactive: false } as any).addTo(g);
      }
      if (sp.ellipse) L.polygon(sp.ellipse, { renderer: this.canvas, color: '#EF4444', weight: 2, dashArray: '4 6', fillColor: '#EF4444', fillOpacity: 0.1, interactive: false }).addTo(g);
      if (sp.windFrom != null) {
        const down = (sp.windFrom + 180) % 360;
        L.marker([sp.fire.lat, sp.fire.lon], { interactive: false, zIndexOffset: -10, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div style="position:absolute;left:0;top:0;width:0;height:0;transform:rotate(${down}deg)"><svg width="26" height="90" viewBox="0 0 26 90" style="position:absolute;left:-13px;top:-90px;overflow:visible"><path d="M13 88 V18" stroke="#0F172A" stroke-width="7" stroke-linecap="round" opacity=".55"/><path d="M13 88 V18" stroke="#fff" stroke-width="3.5" stroke-linecap="round"/><path d="M2 22 L13 2 L24 22 Z" fill="#fff" stroke="#0F172A" stroke-width="1.5" stroke-linejoin="round"/></svg></div>` }) }).addTo(g);
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
      const st = CREW_STYLE[p.status] ?? CREW_STYLE.standby;
      const age = now - Date.parse(p.fix_at);
      const stale = age > 5 * 60_000;
      const crew = s.crews.find((c) => c.id === p.crew_id);
      const short = (crew?.name ?? p.name).replace(/^Block /, '').replace(' — ', ' ');
      const tag = z >= 14 ? `<div class="crew-tag">${esc(short)}${stale ? ` · ${Math.round(age / 60_000)} min` : ''}</div>` : '';
      const m = L.marker([p.lat, p.lon], {
        zIndexOffset: 700,
        icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15], html: `<div class="crew${stale ? ' stale' : ''}"><div class="crew-in" style="background:${st.c}">${SVG(st.p, 13)}</div>${tag}</div>` }),
      });
      const inc = p.incident_id ? s.incidents.find((i) => i.id === p.incident_id) : null;
      m.bindPopup(`<b>${esc(p.name)}</b>${crew ? `<div style="font-size:12px;color:#475569">${esc(crew.name)}</div>` : ''}<div style="margin-top:4px;font-size:12px"><b style="color:${st.c}">${st.label}</b>${inc ? ` → ${esc(inc.code ?? inc.label)}` : ''} · ${age < 60_000 ? 'just now' : Math.round(age / 60_000) + ' min ago'}${p.acc != null ? ` · ±${Math.round(p.acc)} m` : ''}</div>`);
      m.addTo(g);
    }
  }

  /** Cobalt routes: the primary one (mine) cased and solid, others (crews en route) thin dashed. */
  setRoutes(routes: RouteLine[]) {
    const g = this.g.routes;
    g.clearLayers();
    for (const r of routes.filter((x) => !x.primary)) {
      L.polyline(r.coords, { renderer: this.canvas, color: '#0284C7', weight: 2.5, opacity: 0.8, dashArray: '2 6', lineCap: 'round', interactive: false }).addTo(g);
    }
    for (const r of routes.filter((x) => x.primary)) {
      // route = [you, onto the network, ...roads..., off the network, fire]: the first and last legs are on foot (dashed)
      const c = r.coords;
      const road = c.length > 3 ? c.slice(1, -1) : c;
      if (c.length > 3) for (const leg of [[c[0], c[1]], [c[c.length - 2], c[c.length - 1]]] as [number, number][][]) {
        L.polyline(leg, { renderer: this.canvas, color: '#FFFFFF', weight: 7, opacity: 0.9, lineCap: 'round', interactive: false }).addTo(g);
        L.polyline(leg, { renderer: this.canvas, color: '#0284C7', weight: 4, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(g);
      }
      L.polyline(road, { renderer: this.canvas, color: '#FFFFFF', weight: 9, opacity: 0.95, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(g);
      L.polyline(road, { renderer: this.canvas, color: '#0284C7', weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(g);
      // make the start obvious: the route always begins at the user's own GPS position
      const [la, lo] = r.coords[0];
      L.marker([la, lo], { interactive: false, zIndexOffset: 1100, icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div style="position:absolute;left:0;top:0;transform:translate(-50%,calc(-100% - 16px));background:#0284C7;color:#fff;font:700 11px/1 -apple-system,system-ui,sans-serif;padding:4px 7px;border-radius:9999px;white-space:nowrap;box-shadow:0 2px 6px rgba(15,23,42,.35)">You</div>` }) }).addTo(g);
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
    if (ch('mapLayers', 'layers')) this.renderOverlays(s);
    if (ch('compartments', 'layers')) { this.renderCompartments(s); this.renderCompLabels(s); }
    if (ch('roads', 'layers')) this.renderRoads(s);
    if (ch('crewPositions', 'crews', 'layers', 'me', 'incidents')) this.renderCrews(s);
    if (ch('assets', 'layers', 'incidents')) this.renderAssets(s, o);
    if (ch('detections', 'layers') || po?.onDetection !== o.onDetection) this.renderDetections(s, o);
    if (ch('hazards', 'layers')) this.renderHazards(s);
    if (ch('perimeters', 'incidents')) this.renderPerimeters(s);
    if (ch('incidents') || po?.selectedId !== o.selectedId || po?.onIncident !== o.onIncident) this.renderIncidents(s, o);
  }

  private renderOverlays(s: MapData) {
    const on = s.layers;
    this.g.overlayPoly.clearLayers();
    this.g.overlayLine.clearLayers();
    for (const l of s.mapLayers ?? []) {
      if (!on[l.layer]) continue;
      const st = OVERLAY_STYLE[l.layer] ?? { color: '#F8FAFC', weight: 1.5 };
      const rows = Object.entries(l.props ?? {}).filter(([k]) => k !== 'source').slice(0, 8).map(([k, v]) => fmtProp(k, v)).join('');
      if (CASED.has(l.layer)) L.geoJSON(l.geojson as any, { style: { color: CASING, weight: (st.weight ?? 2) + 2.5, opacity: 0.55 }, interactive: false } as any).addTo(this.g.overlayLine);
      L.geoJSON(l.geojson as any, { style: st })
        .bindTooltip(esc(l.name + (l.props?.area_ha != null ? ` · ${l.props.area_ha} ha` : '')), { sticky: true })
        .bindPopup(`<b>${esc(l.name)}</b><table style="margin-top:4px;font-size:12px">${rows}</table>`)
        .addTo(POLY_LAYERS.includes(l.layer) ? this.g.overlayPoly : this.g.overlayLine);
    }
  }

  private renderCompartments(s: MapData) {
    this.g.compartments.clearLayers();
    if (!s.layers.compartments) return;
    for (const c of s.compartments) {
      const r = RISK[c.risk_class] ?? RISK.moderate;
      L.geoJSON(c.geojson as any, { style: { color: CASING, weight: r.w + 2.6, opacity: 0.6, fill: false }, interactive: false } as any).addTo(this.g.compartments);
      L.geoJSON(c.geojson as any, { style: { color: r.c, weight: r.w, opacity: 1, fillColor: r.c, fillOpacity: r.f } })
        .bindTooltip(esc(`${c.code} · ${r.label} risk`), { permanent: false, direction: 'center' })
        .bindPopup(() => {
          const p = (c.props ?? {}) as Record<string, unknown>;
          const rows = [
            p.area_ha != null && fmtProp('area', `${p.area_ha} ha`),
            p.yop_youngest != null && fmtProp('planted', `${p.yop_youngest}${p.yop_oldest != null && p.yop_oldest !== p.yop_youngest ? ` (oldest ${p.yop_oldest})` : ''}`),
            fmtProp('risk', `${r.label}${c.risk_score != null ? ` (${c.risk_score})` : ''}`),
            p.hrz_overlap_pct != null && fmtProp('in FMP high-risk zone', `${p.hrz_overlap_pct}%`),
            p.burnt_2024_field_ha != null && fmtProp('burnt 2024 (field)', `${p.burnt_2024_field_ha} ha`),
            p.burnt_2023_24_s2_ha != null && fmtProp('burnt 2023/24 (Sentinel-2)', `${p.burnt_2023_24_s2_ha} ha`),
            p.burnt_2025_26_s2_ha != null && fmtProp('burnt 2025/26 (Sentinel-2)', `${p.burnt_2025_26_s2_ha} ha`),
            c.treatment_status && fmtProp('treatment', c.treatment_status),
          ].filter(Boolean).join('');
          return `<b>${esc(c.code)}</b> · ${esc(c.block)}<table style="margin-top:4px;font-size:12px">${rows}</table>${p.risk_basis ? `<div style="margin-top:4px;font-size:11px;color:#475569">Risk basis: ${esc(String(p.risk_basis))}</div>` : ''}`;
        })
        .addTo(this.g.compartments);
    }
  }

  private renderRoads(s: MapData) {
    this.g.roads.clearLayers();
    if (!s.layers.roads) return;
    for (const r of s.roads) {
      L.geoJSON(r.geojson as any, { style: { color: CASING, weight: 5.5, opacity: 0.5 }, interactive: false } as any).addTo(this.g.roads);
      L.geoJSON(r.geojson as any, { style: { color: r.passable ? '#F8FAFC' : '#EF4444', weight: 2.8, dashArray: r.passable ? undefined : '4 6', opacity: 0.95 } })
        .bindTooltip(esc(r.name + (r.props?.Status ? ` · ${r.props.Status}` : '') + (r.passable ? '' : ' — NOT PASSABLE'))).addTo(this.g.roads);
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
        .bindTooltip(esc(`Satellite hotspot (unverified) · ${d.source} · ${d.confidence}`));
      m.on('click', () => o.onDetection?.(d.id));
      m.addTo(this.g.detections);
    }
  }

  private renderHazards(s: MapData) {
    this.g.hazards.clearLayers();
    if (!s.layers.hazards) return;
    for (const h of s.hazards)
      if (!h.resolved_at) L.marker([h.lat, h.lon], { icon: pin('#DC2626', ICON.alert, 26) }).bindTooltip(esc(`Hazard: ${h.kind.replace('_', ' ')}${h.note ? ' — ' + h.note : ''}`)).addTo(this.g.hazards);
  }

  private renderPerimeters(s: MapData) {
    this.g.perimeters.clearLayers();
    for (const p of s.perimeters) {
      const ll = p.vertices.map((v: Vertex) => [v.lat, v.lon] as [number, number]);
      const st = s.incidents.find((i) => i.id === p.incident_id)?.status;
      // green once the fire is contained or better, red while it is still active
      const col = st === 'contained' || st === 'controlled' || st === 'out' ? '#16A34A' : '#EF4444';
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
      if (sel) setTimeout(() => (m.getElement()?.querySelector('.callout-body') as HTMLElement | null)?.style.setProperty('outline', '2px solid #0F172A'));
      m.on('click', () => o.onIncident?.(i.id));
      m.addTo(this.g.incidents);
    }
  }

  extra(): L.LayerGroup {
    return this.g.extra;
  }
  fit(pts: [number, number][], pad = 60) {
    if (!pts.length) return;
    this.map.fitBounds(L.latLngBounds(pts), { padding: [pad, pad], maxZoom: 17 });
  }
  destroy() {
    this.map.remove();
  }
}
