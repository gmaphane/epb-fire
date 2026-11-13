import { describe, expect, it } from 'vitest';
import { barrierLabel, barrierSentence, barrierTag, type BarrierSummary } from '../supabase/functions/_shared/barriers';

const road = { kind: 'road', name: 'Existing Road', width_m: 8, width_basis: 'assumed_default', effective: false, rays: 7, why: ['not checked in the field', 'width assumed 8 m, not measured'] };
const overgrown = { kind: 'road', name: 'Existing Road', width_m: 6, width_basis: 'assumed_default', effective: false, rays: 3, why: ['not checked in the field', 'width assumed 6 m, not measured', 'road needs opening (overgrown)'] };
const checked = { kind: 'firebreak', name: 'Firebreak 12', width_m: 12, width_basis: 'field', effective: true, rays: 7, why: [] };

describe('barrier wording (never claims protection that is not verified)', () => {
  it('labels', () => {
    expect(barrierLabel(road)).toBe('road (width assumed 8 m, not checked)');
    expect(barrierLabel(overgrown)).toBe('road (needs opening (overgrown), width assumed 6 m, not checked)');
    expect(barrierLabel(checked)).toBe('firebreak (checked, 12 m)');
  });
  it('sentences per status', () => {
    expect(barrierSentence({ status: 'inside' }, 'B104')).toBe('Inside B104.');
    expect(barrierSentence({ status: 'gap', rays: 7, gap_rays: 7, barriers: [] }, 'B121')).toBe('No mapped barrier between it and B121.');
    expect(barrierSentence({ status: 'gap', rays: 7, gap_rays: 3, barriers: [overgrown] }, 'C008')).toBe(
      'Open approach to C008: 3 of 7 lines cross no mapped barrier (others cross: road (needs opening (overgrown), width assumed 6 m, not checked)).');
    expect(barrierSentence({ status: 'uncertain', rays: 7, barriers: [road] }, 'C008')).toMatch(/^Only unverified barriers .* Do not rely on them\.$/);
    expect(barrierSentence({ status: 'protected', rays: 7, barriers: [checked, road] }, 'C008')).toBe(
      'Checked barrier between it and C008: firebreak (checked, 12 m); road (width assumed 8 m, not checked).');
  });
  it('missing check says nothing (no false comfort)', () => {
    expect(barrierSentence(null, 'C008')).toBe('');
    expect(barrierTag(undefined)).toBeNull();
    expect(barrierTag({ status: 'gap' } as BarrierSummary)).toBe('No barrier');
  });
});
