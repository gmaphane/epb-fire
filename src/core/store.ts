import { useEffect, useState } from 'preact/hooks';
import { getAll, metaGet, onDbChange } from './db';
import type {
  Asset, Assignment, Compartment, Crew, CrewPosition, FireDanger, Detection, Hazard, Incident, IncidentEvent, MapLayer, Me, Perimeter, PhotoRow, Readiness, Road, TableName,
} from './types';
import type { SyncState } from './sync';
import type { Presence } from './presence';

export interface AppState {
  booted: boolean;
  me: Me | null;
  incidents: Incident[];
  events: IncidentEvent[];
  assignments: Assignment[];
  perimeters: Perimeter[];
  photos: PhotoRow[];
  hazards: Hazard[];
  detections: Detection[];
  assets: Asset[];
  compartments: Compartment[];
  roads: Road[];
  crews: Crew[];
  crewPositions: CrewPosition[];
  fireDanger: FireDanger[];
  readiness: Readiness | null;
  mapLayers: MapLayer[];
  sync: SyncState | null;
  toast: { text: string; kind: 'ok' | 'warn' | 'err'; id: number } | null;
  theme: 'auto' | 'day' | 'night';
  basemap: 'street' | 'satellite';
  layers: Record<string, boolean>;
  updateReady: (() => void) | null;
  overlay: 'search' | 'info' | null;
  mapFocus: { lat: number; lon: number; zoom: number; t: number } | null;
  presence: Presence | null;
}

const initial: AppState = {
  booted: false,
  me: null,
  incidents: [], events: [], assignments: [], perimeters: [], photos: [], hazards: [], detections: [],
  assets: [], compartments: [], roads: [], crews: [], crewPositions: [], fireDanger: [], readiness: null, mapLayers: [],
  sync: null,
  toast: null,
  theme: 'auto',
  basemap: 'satellite',
  layers: {
    compartments: true, roads: true, firebreak: true, water: true, camp: true, crews: true, standby_post: true, detections: true,
    hazards: true, // always on (not a toggle)
    camera: false, tower: false, assembly: false, parking: false, high_risk_zone: false, camera_coverage: false, standby_route: false, burnt_area: false, waterway: false, community: false,
  },
  updateReady: null,
  overlay: null,
  mapFocus: null,
  presence: null,
};

let state: AppState = initial;
const subs = new Set<() => void>();
export const getState = () => state;
export function setState(p: Partial<AppState>) {
  state = { ...state, ...p };
  subs.forEach((s) => s());
}

/** Shallow equality: same value, or plain objects/arrays whose top-level entries are identical. */
function same(a: unknown, b: unknown) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is((a as any)[k], (b as any)[k])) return false;
  return true;
}

/** Subscribe to a slice of the store; re-renders only when that slice changes (shallow). */
export function useStore<T>(sel: (s: AppState) => T): T {
  const [v, setV] = useState(() => sel(state));
  useEffect(() => {
    let last = sel(state);
    const f = () => { const next = sel(state); if (!same(next, last)) { last = next; setV(() => next); } };
    setV(() => last);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return v;
}

const KEY: Record<TableName, keyof AppState> = {
  incidents: 'incidents', incident_events: 'events', assignments: 'assignments', perimeters: 'perimeters',
  photos: 'photos', hazards: 'hazards', detections: 'detections', assets: 'assets', compartments: 'compartments',
  roads: 'roads', crews: 'crews', readiness: 'readiness', map_layers: 'mapLayers', crew_positions: 'crewPositions', fire_danger: 'fireDanger',
};

async function load(t: TableName) {
  const rows = await getAll<any>(t);
  setState({ [KEY[t]]: t === 'readiness' ? (rows[0] ?? null) : rows } as Partial<AppState>);
}

const dirty = new Set<TableName>();
let scheduled = false;
export function startStoreSync() {
  return onDbChange((t) => {
    if (t === 'outbox' || t === 'meta') return;
    dirty.add(t);
    if (scheduled) return;
    scheduled = true;
    // short debounce: a sync batch of 50 rows reloads each table once, not 50 times
    setTimeout(async () => {
      scheduled = false;
      const ts = [...dirty];
      dirty.clear();
      await Promise.all(ts.map(load));
    }, 80);
  });
}

export async function hydrate() {
  const tables = Object.keys(KEY) as TableName[];
  await Promise.all(tables.map(load));
  const me = (await metaGet<Me>('me')) ?? null;
  const theme = ((await metaGet<AppState['theme']>('theme')) ?? 'auto') as AppState['theme'];
  const basemap = ((await metaGet<AppState['basemap']>('basemap')) ?? 'satellite') as AppState['basemap'];
  const layers = { ...initial.layers, ...((await metaGet<Record<string, boolean>>('layers')) ?? {}), hazards: true };
  setState({ me, theme, basemap, layers, booted: true });
}

let toastId = 0;
export function toast(text: string, kind: 'ok' | 'warn' | 'err' = 'ok') {
  const id = ++toastId;
  setState({ toast: { text, kind, id } });
  setTimeout(() => {
    if (getState().toast?.id === id) setState({ toast: null });
  }, 3500);
}
