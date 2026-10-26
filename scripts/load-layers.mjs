#!/usr/bin/env node
// Upload supabase/seed/estate_layers.json (made by scripts/port_fire_layers.py) to Supabase.
//   npm run load:layers                 → asks for your admin email + password (not stored)
//   npm run load:layers -- --remove-demo   also deletes the DEMO placeholder compartments/roads/assets
//   npm run load:layers -- --skip-history  skip the 9 000 fire-history points
// Uses the project URL + publishable key from .env and your admin login, so row-level security applies:
// only an admin account can write these tables. No service_role key needed.
import fs from 'fs';
import readline from 'readline';
import { createClient } from '@supabase/supabase-js';

const args = new Set(process.argv.slice(2));
const env = Object.fromEntries(
  (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '')
    .split(/\r?\n/).filter((l) => /^\s*[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);
const url = process.env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_KEY || env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) { console.error('No Supabase URL/key: fill in .env first (see docs/06_SUPABASE_SETUP.md).'); process.exit(1); }
const data = JSON.parse(fs.readFileSync('supabase/seed/estate_layers.json', 'utf8'));

function ask(q, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); else rl.output.write('*'); };
    rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

let sb;
if (process.env.SUPABASE_ACCESS_TOKEN) {
  sb = createClient(url, key, { accessToken: async () => process.env.SUPABASE_ACCESS_TOKEN });
} else {
  sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = process.env.EPB_EMAIL || (await ask('Admin email: '));
  const password = process.env.EPB_PASSWORD || (await ask('Password: ', true));
  const { data: s, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { console.error('Sign-in failed:', error.message); process.exit(1); }
  const { data: p } = await sb.from('profiles').select('role').eq('id', s.user.id).single();
  if (p?.role !== 'admin') { console.error(`Signed in, but role is "${p?.role ?? 'none'}": an admin account is needed to load layers.`); process.exit(1); }
  console.log(`Signed in as ${email} (admin)`);
}

async function upsert(table, rows, size) {
  let done = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const { error } = await sb.from(table).upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`${table} rows ${i}-${i + chunk.length}: ${error.message}`);
    done += chunk.length;
    process.stdout.write(`\r  ${table.padEnd(14)} ${done}/${rows.length}`);
  }
  process.stdout.write('\n');
}

console.log(`Loading from ${data._meta.source} (generated ${data._meta.generated})`);
try {
  await upsert('compartments', data.compartments, 40);
  await upsert('roads', data.roads, 100);
  await upsert('assets', data.assets, 200);
  await upsert('map_layers', data.map_layers, 50);
  if (!args.has('--skip-history')) await upsert('fire_history', data.fire_history, 1000);
  if (args.has('--remove-demo')) {
    for (const [t, col, pat] of [['compartments', 'code', 'DEMO-%'], ['assets', 'id', null], ['roads', 'id', null]]) {
      const q = pat ? sb.from(t).delete().like(col, pat) : sb.from(t).delete().in('id', t === 'assets'
        ? ['101', '102', '103', '104', '105', '106', '107', '108'].map((n) => `00000000-0000-4000-8000-000000000${n}`)
        : ['201', '202', '203'].map((n) => `00000000-0000-4000-8000-000000000${n}`));
      const { error } = await q;
      if (error) throw new Error(`remove demo ${t}: ${error.message}`);
    }
    console.log('  DEMO placeholder layers removed');
  }
  console.log('Done. Open the app and tap Sync → Sync now to download the layers to this device.');
} catch (e) {
  console.error('\nFailed:', e.message);
  process.exit(1);
}
