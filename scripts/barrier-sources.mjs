#!/usr/bin/env node
// Convert the extra fire-barrier sources into map_layers rows (supabase/seed/barrier_sources.json).
//   node scripts/barrier-sources.mjs "C:/Users/Gladwell/Documents/BandaiHills_MRV/01_raw_data"
// Then upload with `npm run load:layers` (it loads this file too when present).
//
// Sources (only files whose coordinate system is known are used):
//   - Ghana_Plantain/Ghana_Plantain.shp   → layer 'plantain_farm'   (.prj: GCS WGS 1984)
// Checked and NOT loaded (13 Nov 2026):
//   - fire/External firebreaks.kml: every vertex is within 20 m of the existing 'firebreak' layer (firebreaks_all,
//     already in Supabase), so loading it would double-count the outer breaks;
//   - fire/Outer_Firebreak.shp: no .prj (coordinate system unknown) and no .dbf.
// Ids are uuid5-style hashes of layer + file + index, so re-running updates instead of duplicating.
// No dependencies: a minimal shapefile (.shp/.dbf, polyline/polygon) reader.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const root = process.argv[2];
if (!root) { console.error('usage: node scripts/barrier-sources.mjs <01_raw_data folder>'); process.exit(1); }

const sid = (...p) => {
  const h = crypto.createHash('sha1').update('6f1b6f0e-3c1e-4c1a-9f7a-0e5b2f8a1d00|' + p.join('|')).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};
const r7 = (c) => [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7];
const inGhana = (c) => c[0] > -3.5 && c[0] < 1.5 && c[1] > 4.5 && c[1] < 11.5;

// ---------- shapefile (.shp polyline=3 / polygon=5) + .dbf ----------
function readDbf(file) {
  const d = fs.readFileSync(file);
  const n = d.readUInt32LE(4), hl = d.readUInt16LE(8), rl = d.readUInt16LE(10);
  const fields = [];
  for (let o = 32; d[o] !== 0x0d; o += 32) fields.push({ name: d.toString('latin1', o, o + 11).replace(/\0.*$/, ''), type: String.fromCharCode(d[o + 11]), len: d[o + 16] });
  const rows = [];
  for (let r = 0, o = hl; r < n; r++, o += rl) {
    let p = o + 1; const row = {};
    for (const f of fields) { const v = d.toString('latin1', p, p + f.len).trim(); row[f.name] = f.type === 'N' || f.type === 'F' ? (v === '' ? null : Number(v)) : v || null; p += f.len; }
    rows.push(row);
  }
  return rows;
}
function readShp(file) {
  const b = fs.readFileSync(file);
  const out = [];
  let o = 100;
  while (o < b.length) {
    const len = b.readInt32BE(o + 4) * 2; const c = o + 8;
    const type = b.readInt32LE(c);
    if (type === 3 || type === 5) {
      const np = b.readInt32LE(c + 36), nPts = b.readInt32LE(c + 40);
      const parts = []; for (let k = 0; k < np; k++) parts.push(b.readInt32LE(c + 44 + 4 * k));
      const p0 = c + 44 + 4 * np;
      const pts = []; for (let k = 0; k < nPts; k++) pts.push(r7([b.readDoubleLE(p0 + 16 * k), b.readDoubleLE(p0 + 16 * k + 8)]));
      const rings = parts.map((s, k) => pts.slice(s, k + 1 < np ? parts[k + 1] : nPts));
      out.push({ type, rings });
    } else out.push(null);
    o = c + len;
  }
  return out;
}
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2; }; // >0 = clockwise
function shpGeometry(rec) {
  if (rec.type === 3) return rec.rings.length === 1 ? { type: 'LineString', coordinates: rec.rings[0] } : { type: 'MultiLineString', coordinates: rec.rings };
  // shapefile polygons: clockwise rings are outer, counter-clockwise are holes of the preceding outer
  const polys = [];
  for (const r of rec.rings) { if (ringArea(r) > 0 || !polys.length) polys.push([[...r].reverse()]); else polys[polys.length - 1].push([...r].reverse()); }
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}
const allCoords = (g) => JSON.stringify(g.coordinates).match(/-?\d+\.?\d*,-?\d+\.?\d*/g).map((s) => s.split(',').map(Number));

const rows = [];
const shp = path.join(root, 'Ghana_Plantain', 'Ghana_Plantain.shp');
const prj = fs.readFileSync(shp.replace(/\.shp$/, '.prj'), 'utf8');
if (!/GCS_WGS_1984|WGS 84/.test(prj)) throw new Error(`Ghana_Plantain.prj is not WGS84: ${prj}`);
const attrs = readDbf(shp.replace(/\.shp$/, '.dbf'));
readShp(shp).forEach((rec, i) => {
  if (!rec) return;
  const a = attrs[i] ?? {};
  rows.push({ id: sid('plantain_farm', 'Ghana_Plantain.shp', i), layer: 'plantain_farm', name: `Plantain farm ${i + 1}`, geojson: shpGeometry(rec),
    props: { class: a.Class ?? null, compartment: a.Compartmen ?? null, area_ha: a.Area != null ? Math.round(a.Area * 100) / 100 : null, source: 'Ghana_Plantain.shp' } });
});
const bad = rows.filter((r) => !allCoords(r.geojson).every(inGhana));
if (bad.length) throw new Error(`${bad.length} features fall outside Ghana: check the coordinate system`);

const dest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'seed', 'barrier_sources.json');
fs.writeFileSync(dest, JSON.stringify({ _meta: { generated: new Date().toISOString().slice(0, 19), source: root, counts: { plantain_farm: rows.filter((r) => r.layer === 'plantain_farm').length } }, map_layers: rows }));
console.log(`wrote ${dest}: ${rows.length} rows`);
