import { it, expect } from 'vitest';
import { buildXlsx } from '../src/core/xlsx';

it('builds a valid xlsx zip', async () => {
  const b = buildXlsx([
    { name: 'Incidents', header: ['Code', 'Area ha', 'Notes'], rows: [['F-2026-0001', 12.5, 'Smoke near <C026> & road'], ['F-2026-0002', null, 'ok']] },
    { name: 'Timeline', header: ['A'], rows: [] },
  ]);
  const u = new Uint8Array(await b.arrayBuffer());
  expect(u[0]).toBe(0x50); expect(u[1]).toBe(0x4b);
  expect(u.length).toBeGreaterThan(1000);
});
