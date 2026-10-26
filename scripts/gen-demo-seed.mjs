#!/usr/bin/env node
// Writes supabase/seed/demo_reference.sql from src/data/demoSeed.ts (DEMO placeholder layers).
// Run: node --experimental-strip-types scripts/gen-demo-seed.mjs   (Node 22.6+)
import fs from 'fs';
const m = await import('../src/data/demoSeed.ts');
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const j = (v) => `${q(JSON.stringify(v))}::jsonb`;
const out = ['-- DEMO placeholder layers around the PSP area. Replace with real data before the pilot.', 'set search_path = public, extensions;'];
out.push(`insert into public.compartments (id, code, block, geojson, risk_class, risk_score, treatment_status) values\n${m.DEMO_COMPARTMENTS.map((c) => `(${q(c.id)}, ${q(c.code)}, ${q(c.block)}, ${j(c.geojson)}, ${q(c.risk_class)}, ${c.risk_score ?? 'null'}, ${q(c.treatment_status)})`).join(',\n')}\non conflict (id) do nothing;`);
out.push(`insert into public.assets (id, kind, name, lat, lon, props) values\n${m.DEMO_ASSETS.map((a) => `(${q(a.id)}, ${q(a.kind)}, ${q(a.name)}, ${a.lat}, ${a.lon}, ${j(a.props)})`).join(',\n')}\non conflict (id) do nothing;`);
out.push(`insert into public.roads (id, name, geojson, passable) values\n${m.DEMO_ROADS.map((r) => `(${q(r.id)}, ${q(r.name)}, ${j(r.geojson)}, ${r.passable})`).join(',\n')}\non conflict (id) do nothing;`);
out.push(`insert into public.detections (id, source, acq_time, confidence, frp, lat, lon) values\n${m.demoDetections().map((d) => `(${q(d.id)}, ${q(d.source)}, now() - interval '${Math.round((Date.now() - Date.parse(d.acq_time)) / 60000)} minutes', ${q(d.confidence)}, ${d.frp ?? 'null'}, ${d.lat}, ${d.lon})`).join(',\n')}\non conflict (id) do nothing;`);
fs.writeFileSync(new URL('../supabase/seed/demo_reference.sql', import.meta.url), out.join('\n\n') + '\n');
console.log('wrote supabase/seed/demo_reference.sql');
