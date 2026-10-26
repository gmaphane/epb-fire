#!/usr/bin/env node
// Create/refresh app users and their roles in Supabase.
// Usage (PowerShell):
//   $env:SUPABASE_URL="https://xxxx.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="eyJ..."; node scripts/setup-users.mjs supabase/seed/users.json
// The service-role key is an admin key: keep it on this PC only, never put it in .env for the app.
import fs from 'fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const file = process.argv[2] ?? 'supabase/seed/users.json';
if (!url || !key) { console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.'); process.exit(1); }
const users = JSON.parse(fs.readFileSync(file, 'utf8'));
const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: crews, error: ce } = await sb.from('crews').select('id,name');
if (ce) { console.error('Could not read crews — did you run the migration and crews.sql?', ce.message); process.exit(1); }

async function findUser(email) {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find((x) => x.email?.toLowerCase() === email.toLowerCase());
    if (u || data.users.length < 200) return u ?? null;
  }
  return null;
}

let ok = 0;
for (const u of users) {
  const crew = u.crew ? crews.find((c) => c.name === u.crew) : null;
  if (u.crew && !crew) { console.error(`✗ ${u.email}: crew "${u.crew}" not found (have: ${crews.map((c) => c.name).join(', ')})`); continue; }
  let id;
  const { data, error } = await sb.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true, user_metadata: { full_name: u.full_name } });
  if (error) {
    const existing = await findUser(u.email);
    if (!existing) { console.error(`✗ ${u.email}: ${error.message}`); continue; }
    id = existing.id;
    if (u.password) await sb.auth.admin.updateUserById(id, { password: u.password });
  } else id = data.user.id;
  const { error: pe } = await sb.from('profiles').upsert({ id, full_name: u.full_name, role: u.role, crew_id: crew?.id ?? null });
  if (pe) { console.error(`✗ ${u.email}: profile ${pe.message}`); continue; }
  console.log(`✓ ${u.email.padEnd(36)} ${u.role.padEnd(12)} ${crew?.name ?? ''}`);
  ok++;
}
console.log(`${ok}/${users.length} users ready.`);
