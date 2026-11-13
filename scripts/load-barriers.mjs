#!/usr/bin/env node
// Upload supabase/seed/barrier_sources.json (plantain farms, made by scripts/barrier-sources.mjs) to map_layers,
// then rebuild the estate edge, barrier list and edge gaps (public.refresh_fire_risk_layers).
//   npm run load:barriers        → asks for your admin email + password (not stored)
// Only touches map_layers rows of layer 'plantain_farm' (upsert by id); nothing else is overwritten.
import fs from 'fs';
import readline from 'readline';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '')
    .split(/\r?\n/).filter((l) => /^\s*[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const url = process.env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) { console.error('No Supabase URL/key: fill in .env first.'); process.exit(1); }
const data = JSON.parse(fs.readFileSync('supabase/seed/barrier_sources.json', 'utf8'));

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const email = process.env.EPB_EMAIL || (await ask('Admin email: '));
const password = process.env.EPB_PASSWORD || (await ask('Password: ', true));
const { data: s, error } = await sb.auth.signInWithPassword({ email, password });
if (error) { console.error('Sign-in failed:', error.message); process.exit(1); }
const { data: p } = await sb.from('profiles').select('role').eq('id', s.user.id).single();
if (p?.role !== 'admin') { console.error(`Signed in, but role is "${p?.role ?? 'none'}": an admin account is needed.`); process.exit(1); }

const rows = data.map_layers.filter((r) => r.layer === 'plantain_farm');
console.log(`Uploading ${rows.length} plantain farms (from ${data._meta.source}, ${data._meta.generated})`);
for (let i = 0; i < rows.length; i += 50) {
  const { error: e } = await sb.from('map_layers').upsert(rows.slice(i, i + 50), { onConflict: 'id' });
  if (e) { console.error(`\nFailed at rows ${i}-${i + 50}: ${e.message}`); process.exit(1); }
  process.stdout.write(`\r  map_layers ${Math.min(i + 50, rows.length)}/${rows.length}`);
}
process.stdout.write('\n');

console.log('Rebuilding estate edge, barriers and edge gaps…');
const { data: r, error: re } = await sb.rpc('refresh_fire_risk_layers');
if (re) {
  console.error(`Rebuild did not finish here (${re.message}).`);
  console.error('Run this once in the Supabase SQL Editor instead:  select public.refresh_fire_risk_layers();');
  process.exit(1);
}
console.log(JSON.stringify(r, null, 1));
console.log('Done. Phones get the new layers on their next sync.');
