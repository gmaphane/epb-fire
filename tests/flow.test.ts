import { describe, expect, it } from 'vitest';
import { afterOut, allowedNext, CATEGORY, sizeFromCategory, STATUS_LABEL } from '../src/core/flow';

describe('SOP 4.1 alignment', () => {
  it('labels controlled as Mop-up; only coordinators close as Out', () => {
    expect(STATUS_LABEL.controlled).toBe('Mop-up');
    expect(allowedNext('contained', 'responder')).not.toContain('out');
    expect(allowedNext('controlled', 'coordinator')).toContain('out');
  });
  it('patrol length follows the category; report deadlines 12/24/48 h after Out', () => {
    const out = '2026-10-29T10:00:00Z', t = Date.parse(out), h = 3600_000;
    const a = afterOut(out, 3);
    expect(a.patrolUntil).toBe(t + 24 * h);
    expect([a.draftDue, a.finalDue, a.submitDue, a.monitorUntil]).toEqual([t + 12 * h, t + 24 * h, t + 48 * h, t + 48 * h]);
    expect(afterOut(out, null).patrolUntil).toBeNull();
    expect(CATEGORY[5].patrolH).toBe(72);
  });
  it('keeps the old size field in step', () => {
    expect([null, 1, 2, 3, 4, 5].map((c) => sizeFromCategory(c as any))).toEqual(['unknown', 'small', 'small', 'medium', 'large', 'large']);
  });
});
