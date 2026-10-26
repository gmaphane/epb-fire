import { defineConfig } from 'vitest/config';
// Runs the app's sync code against a real PostgREST + Postgres (see docs/06_SUPABASE_SETUP.md, part D).
export default defineConfig({ test: { environment: 'node', include: ['tests/integration/*.test.ts'], testTimeout: 30_000 } });
