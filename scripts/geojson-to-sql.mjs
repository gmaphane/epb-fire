#!/usr/bin/env node
// Convert a GeoJSON export (e.g. from ArcGIS Pro, WGS84 / EPSG:4326) into SQL inserts for the app.
// Usage:
//   node scripts/geojson-to-sql.mjs compartments compartments.geojson > compartments.sql
//   node scripts/geojson-to-sql.mjs roads roads.geojson > roads.sql
//   node scripts/geojson-to-sql.mjs assets water_points.geojson --kind water > water.sql
// Field mapping (case-insensitive): compartments: CODE, BLOCK, RISK_CLASS, RISK_SCORE, TREATMENT
//                                   roads: NAME, PASSABLE   assets: NAME, plus all props kept in props jsonb
import fs from 'fs';
import crypto from 'crypto';

const [, , table, file, ...rest] = process.argv;
if (!table || !file) { console.error('usage: geojson-to-sql.mjs <compartments|roads|assets> <file.geojson> [--kind water|camera|tower|camp|assembly]'); process.exit(1); }
const kind = rest[rest.indexOf('--kind') + 1];
const fc = JSON.parse(fs.readFileSync(file, 'utf8'));
const q = (v) => (v == null || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const get = (p, k) => { const key = Object.keys(p ?? {}).find((x) => x.toLowerCase() === k.toLowerCase()); return key ? p[key] : null; };
const RISK = new Set(['low', 'moderate', 'high', 'very_high', 'extreme']);
const out = [];
for (const f of fc.features) {
  const p = f.properties ?? {};
  const id = get(p, 'id') && /^[0-9a-f-]{36}$/i.test(get(p, 'id')) ? get(p, 'id') : crypto.randomUUID();
  if (table === 'compartments') {
    let risk = String(get(p, 'risk_class') ?? 'moderate').toLowerCase().replace(/\s+/g, '_');
    if (!RISK.has(risk)) risk = 'moderate';
    out.push(`(${q(id)}, ${q(get(p, 'code'))}, ${q(get(p, 'block'))}, ${q(JSON.stringify(f.geometry))}::jsonb, ${q(risk)}, ${get(p, 'risk_score') ?? 'null'}, '${String(get(p, 'treatment') ?? '').replace(/'/g, "''")}')`);
  } else if (table === 'roads') {
    const pass = get(p, 'passable');
    out.push(`(${q(id)}, ${q(get(p, 'name') ?? 'Track')}, ${q(JSON.stringify(f.geometry))}::jsonb, ${pass === false || pass === 0 || pass === 'no' ? 'false' : 'true'})`);
  } else if (table === 'assets') {
    if (!kind) { console.error('--kind is required for assets'); process.exit(1); }
    const [lon, lat] = f.geometry.coordinates;
    out.push(`(${q(id)}, ${q(kind)}, ${q(get(p, 'name') ?? kind)}, ${lat}, ${lon}, ${q(JSON.stringify(p))}::jsonb)`);
  }
}
const cols = { compartments: '(id, code, block, geojson, risk_class, risk_score, treatment_status)', roads: '(id, name, geojson, passable)', assets: '(id, kind, name, lat, lon, props)' }[table];
const upd = { compartments: 'on conflict (code) do update set block = excluded.block, geojson = excluded.geojson, risk_class = excluded.risk_class, risk_score = excluded.risk_score, treatment_status = excluded.treatment_status', roads: 'on conflict (id) do nothing', assets: 'on conflict (id) do nothing' }[table];
console.log(`insert into public.${table} ${cols} values\n${out.join(',\n')}\n${upd};`);
