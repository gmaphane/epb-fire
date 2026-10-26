import L from 'leaflet';
import { CONFIG } from '../config';
import { countTiles, tileRange } from './geo';

const CACHE = 'epb-tiles-v1';

const fill = (url: string, z: number, x: number, y: number) =>
  url.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

/** Cache-first tile layer: tiles already on the phone are shown instantly with no network. */
export const OfflineTileLayer = L.TileLayer.extend({
  createTile(this: any, coords: L.Coords, done: L.DoneCallback) {
    const img = document.createElement('img');
    img.alt = '';
    img.setAttribute('role', 'presentation');
    const url = fill(this._url, coords.z, coords.x, coords.y);
    loadTile(url)
      .then((blobUrl) => {
        img.onload = () => done(undefined, img);
        img.onerror = () => done(undefined, img);
        img.src = blobUrl;
        img.dataset.blob = blobUrl;
      })
      .catch(() => done(undefined, img)); // missing tile = blank, never an error
    return img;
  },
});

async function loadTile(url: string): Promise<string> {
  const cache = await caches.open(CACHE);
  let res = await cache.match(url);
  if (!res) {
    res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`tile ${res.status}`);
    void cache.put(url, res.clone());
  }
  return URL.createObjectURL(await res.blob());
}

export function basemap(kind: 'street' | 'satellite') {
  const url = CONFIG.tiles[kind];
  const layer = new (OfflineTileLayer as any)(url, { maxZoom: 19, maxNativeZoom: 18, attribution: kind === 'street' ? '© OpenStreetMap' : 'Imagery © Esri' }) as L.TileLayer;
  layer.on('tileunload', (e: any) => {
    const b = e.tile?.dataset?.blob;
    if (b) URL.revokeObjectURL(b); // avoid leaking blob URLs in long sessions
  });
  return layer;
}

export interface PackPlan {
  tiles: number;
  allowed: boolean;
  estMb: number;
}
export function planPack(): PackPlan {
  const n = countTiles(CONFIG.packBBox, CONFIG.packZoom.min, CONFIG.packZoom.max);
  return { tiles: n, allowed: n <= CONFIG.packMaxTiles, estMb: Math.round((n * 18) / 1024) };
}

export async function packStatus(kind: 'street' | 'satellite'): Promise<{ have: number; total: number }> {
  const cache = await caches.open(CACHE);
  const url = CONFIG.tiles[kind];
  let have = 0;
  let total = 0;
  for (let z = CONFIG.packZoom.min; z <= CONFIG.packZoom.max; z++) {
    const r = tileRange(CONFIG.packBBox, z);
    // sample the centre row to keep this cheap
    const y = Math.floor((r.y0 + r.y1) / 2);
    for (let x = r.x0; x <= r.x1; x++) {
      total++;
      if (await cache.match(fill(url, z, x, y))) have++;
    }
  }
  return { have, total };
}

export async function downloadPack(
  kind: 'street' | 'satellite',
  onProgress: (done: number, total: number, failed: number) => void,
  signal?: AbortSignal,
): Promise<{ done: number; failed: number; total: number }> {
  const plan = planPack();
  if (!plan.allowed) throw new Error(`Pack of ${plan.tiles} tiles exceeds the ${CONFIG.packMaxTiles} development limit`);
  const url = CONFIG.tiles[kind];
  const cache = await caches.open(CACHE);
  const jobs: string[] = [];
  for (let z = CONFIG.packZoom.min; z <= CONFIG.packZoom.max; z++) {
    const r = tileRange(CONFIG.packBBox, z);
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) jobs.push(fill(url, z, x, y));
  }
  let done = 0;
  let failed = 0;
  let i = 0;
  const worker = async () => {
    while (i < jobs.length && !signal?.aborted) {
      const u = jobs[i++];
      try {
        if (!(await cache.match(u))) {
          const res = await fetch(u, { mode: 'cors' });
          if (!res.ok) throw new Error(String(res.status));
          await cache.put(u, res);
        }
      } catch {
        failed++;
      }
      done++;
      if (done % 10 === 0 || done === jobs.length) onProgress(done, jobs.length, failed);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  onProgress(done, jobs.length, failed);
  return { done, failed, total: jobs.length };
}

export async function clearTiles() {
  await caches.delete(CACHE);
}
