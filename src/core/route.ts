import { CONFIG } from '../config';
import type { MapLayer, Road } from './types';

/**
 * On-device routing over the estate track network (passable roads + firebreaks).
 * Works offline: the graph is built from data already on the phone.
 *
 * Start and goal are snapped onto the nearest track segment; the bit between the
 * point and the track is walked (off-road leg). The route always follows the network.
 */

export type Mode = 'walk' | 'drive';
export interface Route {
  coords: [number, number][]; // [lat, lon]
  distM: number;
  onTrackM: number;
  offRoadM: number;
  etaMin: number;
  viaTracks: boolean;
}

type Edge = { to: number; m: number; kind: 'road' | 'firebreak' };
interface Graph {
  lat: Float64Array;
  lon: Float64Array;
  adj: Edge[][];
  segs: { a: number; b: number; kind: Edge['kind'] }[];
  comp: Int32Array; // connected-component id per node
}

const R = 6371008.8;
const RAD = Math.PI / 180;
// local equirectangular projection around the estate (metres); accurate to <0.1% over 30 km
const K_LAT = R * RAD;
const kLon = (lat: number) => R * RAD * Math.cos(lat * RAD);
const distM = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const kx = kLon((lat1 + lat2) / 2);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * K_LAT);
};

/** Track speeds in km/h. Off-road legs are always on foot. */
function speed(kind: Edge['kind'] | 'off', mode: Mode) {
  if (kind === 'off') return CONFIG.walkSpeedKmh;
  if (mode === 'walk') return CONFIG.walkSpeedKmh;
  return kind === 'road' ? CONFIG.driveSpeedKmh : Math.min(15, CONFIG.driveSpeedKmh);
}

const JOIN_M = 35; // dangling ends this close to another track are treated as connected

const caches = new Map<string, { roads: Road[]; layers: MapLayer[]; g: Graph }>();

/**
 * Track network. Vehicles use roads only (firebreaks are cleared strips, not driveable roads);
 * on foot, firebreaks are paths too.
 */
export function buildGraph(roads: Road[], layers: MapLayer[], withFirebreaks = true): Graph {
  const ck = withFirebreaks ? 'all' : 'roads';
  const cache = caches.get(ck);
  if (cache && cache.roads === roads && cache.layers === layers) return cache.g;
  const lat: number[] = [], lon: number[] = [];
  const key = new Map<string, number>();
  const node = (x: number, y: number) => {
    const k = `${y.toFixed(5)},${x.toFixed(5)}`; // ≈1 m grid merges shared vertices
    let i = key.get(k);
    if (i == null) { i = lat.length; lat.push(y); lon.push(x); key.set(k, i); }
    return i;
  };
  const segs: Graph['segs'] = [];
  const addLine = (cs: number[][], kind: Edge['kind']) => {
    let prev = -1;
    for (const c of cs) {
      const i = node(c[0], c[1]);
      if (prev >= 0 && prev !== i) segs.push({ a: prev, b: i, kind });
      prev = i;
    }
  };
  const lines = (g: GeoJSON.Geometry | null | undefined): number[][][] =>
    !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
  for (const r of roads) if (r.passable !== false) for (const l of lines(r.geojson)) addLine(l, 'road');
  if (withFirebreaks) for (const m of layers) if (m.layer === 'firebreak') for (const l of lines(m.geojson)) addLine(l, 'firebreak');

  const n = lat.length;
  const adj: Edge[][] = Array.from({ length: n }, () => []);
  const link = (a: number, b: number, kind: Edge['kind']) => {
    const m = distM(lat[a], lon[a], lat[b], lon[b]);
    adj[a].push({ to: b, m, kind });
    adj[b].push({ to: a, m, kind });
  };
  for (const s of segs) link(s.a, s.b, s.kind);

  // join dangling ends to the nearest other node within JOIN_M (grid index)
  const cell = 0.0005; // ≈ 55 m
  const grid = new Map<string, number[]>();
  const gk = (y: number, x: number) => `${Math.floor(y / cell)},${Math.floor(x / cell)}`;
  for (let i = 0; i < n; i++) {
    const k = gk(lat[i], lon[i]);
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
  }
  for (let i = 0; i < n; i++) {
    if (adj[i].length !== 1) continue;
    const cy = Math.floor(lat[i] / cell), cx = Math.floor(lon[i] / cell);
    let best = -1, bd = JOIN_M;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const j of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          if (j === i || adj[i].some((e) => e.to === j)) continue;
          const d = distM(lat[i], lon[i], lat[j], lon[j]);
          if (d < bd) { bd = d; best = j; }
        }
    if (best >= 0) link(i, best, adj[i][0].kind);
  }

  // connected components, so start and goal can be snapped onto the same track system
  const comp = new Int32Array(n).fill(-1);
  let cid = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] >= 0) continue;
    const stack = [i]; comp[i] = cid;
    while (stack.length) { const u = stack.pop()!; for (const e of adj[u]) if (comp[e.to] < 0) { comp[e.to] = cid; stack.push(e.to); } }
    cid++;
  }
  const g: Graph = { lat: Float64Array.from(lat), lon: Float64Array.from(lon), adj, segs, comp };
  caches.set(ck, { roads, layers, g });
  return g;
}

/** Nearest point on any segment: returns the segment and the projected point. */
function snap(g: Graph, y: number, x: number, onlyComp = -1) {
  const kx = kLon(y);
  let best = { d: Infinity, s: -1, t: 0, y: 0, x: 0 };
  g.segs.forEach((s, si) => {
    if (onlyComp >= 0 && g.comp[s.a] !== onlyComp) return;
    const ax = (g.lon[s.a] - x) * kx, ay = (g.lat[s.a] - y) * K_LAT;
    const bx = (g.lon[s.b] - x) * kx, by = (g.lat[s.b] - y) * K_LAT;
    const vx = bx - ax, vy = by - ay;
    const L2 = vx * vx + vy * vy;
    const t = L2 ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L2)) : 0;
    const px = ax + t * vx, py = ay + t * vy;
    const d = Math.hypot(px, py);
    if (d < best.d) best = { d, s: si, t, y: y + py / K_LAT, x: x + px / kx };
  });
  return best;
}

/** Min-heap keyed on cost. */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/** Shortest route over the track network from (lat1,lon1) to (lat2,lon2): roads by vehicle, roads + firebreaks on foot.
 *  The only off-network parts are the walk from the start to the nearest track and from the track to the goal. */
export function route(roads: Road[], layers: MapLayer[], from: { lat: number; lon: number }, to: { lat: number; lon: number }, mode: Mode = 'drive'): Route {
  const straightM = distM(from.lat, from.lon, to.lat, to.lon);
  const walkMin = (m: number) => (m / 1000 / CONFIG.walkSpeedKmh) * 60;
  const direct: Route = { coords: [[from.lat, from.lon], [to.lat, to.lon]], distM: straightM, onTrackM: 0, offRoadM: straightM, etaMin: walkMin(straightM), viaTracks: false };
  const g = buildGraph(roads, layers, mode === 'walk');
  if (!g.segs.length || straightM < 60) return direct;

  let sA = snap(g, from.lat, from.lon), sB = snap(g, to.lat, to.lon);
  if (sA.s < 0 || sB.s < 0) return direct;
  const cA = g.comp[g.segs[sA.s].a], cB = g.comp[g.segs[sB.s].a];
  if (cA !== cB) {
    // nearest tracks are on separate systems: put both ends on one system, whichever adds the least walking
    const b2 = snap(g, to.lat, to.lon, cA), a2 = snap(g, from.lat, from.lon, cB);
    if (b2.d - sB.d <= a2.d - sA.d) sB = b2; else sA = a2;
  }
  const n = g.lat.length;
  const S = n, T = n + 1; // virtual nodes on the snapped points
  const lat = (i: number) => (i === S ? sA.y : i === T ? sB.y : g.lat[i]);
  const lon = (i: number) => (i === S ? sA.x : i === T ? sB.x : g.lon[i]);
  const cost = (m: number, kind: Edge['kind']) => (m / 1000 / speed(kind, mode)) * 60;

  // edges out of the virtual nodes (split their segments)
  const extra = new Map<number, Edge[]>();
  const addExtra = (a: number, b: number, kind: Edge['kind']) => {
    const m = distM(lat(a), lon(a), lat(b), lon(b));
    (extra.get(a) ?? extra.set(a, []).get(a)!).push({ to: b, m, kind });
    (extra.get(b) ?? extra.set(b, []).get(b)!).push({ to: a, m, kind });
  };
  const segA = g.segs[sA.s], segB = g.segs[sB.s];
  addExtra(S, segA.a, segA.kind); addExtra(S, segA.b, segA.kind);
  addExtra(T, segB.a, segB.kind); addExtra(T, segB.b, segB.kind);
  if (sA.s === sB.s) addExtra(S, T, segA.kind);

  const dist = new Float64Array(n + 2).fill(Infinity);
  const prev = new Int32Array(n + 2).fill(-1);
  const pkind: (Edge['kind'] | undefined)[] = new Array(n + 2);
  dist[S] = 0;
  const h = new Heap();
  h.push(0, S);
  while (h.size) {
    const [d, u] = h.pop();
    if (d > dist[u]) continue;
    if (u === T) break;
    const out = u < n ? (extra.has(u) ? g.adj[u].concat(extra.get(u)!) : g.adj[u]) : extra.get(u) ?? [];
    for (const e of out) {
      const nd = d + cost(e.m, e.kind);
      if (nd < dist[e.to]) { dist[e.to] = nd; prev[e.to] = u; pkind[e.to] = e.kind; h.push(nd, e.to); }
    }
  }
  if (!Number.isFinite(dist[T])) return direct;

  const path: number[] = [];
  for (let v = T; v !== -1; v = prev[v]) path.push(v);
  path.reverse();
  let onTrackM = 0;
  for (let i = 1; i < path.length; i++) onTrackM += distM(lat(path[i - 1]), lon(path[i - 1]), lat(path[i]), lon(path[i]));
  const offRoadM = sA.d + sB.d;
  const etaMin = dist[T] + walkMin(offRoadM);
  // Always follow the network (crews must stay on roads / firebreaks). Only fall back to a straight line
  // when the network path is absurd, e.g. the two ends sit on separate, unconnected track systems.
  if (onTrackM > Math.max(20 * straightM, straightM + 15_000)) return direct;
  const coords: [number, number][] = [[from.lat, from.lon], ...path.map((i) => [lat(i), lon(i)] as [number, number]), [to.lat, to.lon]];
  return { coords, distM: onTrackM + offRoadM, onTrackM, offRoadM, etaMin, viaTracks: true };
}

export const fmtEta = (min: number) => (min < 1 ? '<1 min' : min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')}`);
