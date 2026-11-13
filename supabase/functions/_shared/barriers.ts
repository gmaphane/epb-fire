// Plain-language wording for the "barriers in between" check (public.barriers_between in the database).
// Shared by the FIRMS alert function (push text) and the app (alert card, detection card); no Deno or browser APIs.
//
// The rule it describes (never assume a barrier works):
//   inside    – the detection is inside the compartment;
//   gap       – at least one approach line reaches the compartment edge without crossing anything mapped;
//   uncertain – every line crosses something, but only barriers that are not checked/measured/wide enough;
//   protected – every line crosses a barrier that was checked in the field, is wide enough, continuous and in good order.

export interface BarrierHit {
  id?: string;
  kind: string;
  name: string;
  width_m: number | null;
  width_basis?: string | null;
  effective: boolean;
  rays: number;
  why?: string[] | null;
}
export interface BarrierSummary {
  status: 'inside' | 'gap' | 'uncertain' | 'protected';
  rays?: number;
  gap_rays?: number;
  uncertain_rays?: number;
  protected_rays?: number;
  barriers?: BarrierHit[];
  compartment?: string;
  checked_at?: string;
}

const KIND: Record<string, string> = { firebreak: 'firebreak', road: 'road', track: 'track', waterway: 'stream', plantain_farm: 'plantain farm' };

/** "road (width assumed 8 m, not checked)" */
export function barrierLabel(b: BarrierHit): string {
  const kind = KIND[b.kind] ?? b.kind;
  const named = b.name && !/^(Firebreak|Waterway|Plantain farm|Existing Road|Track)\b/i.test(b.name) ? `${kind} "${b.name}"` : kind;
  if (b.effective) return `${named} (checked${b.width_m != null ? `, ${Math.round(b.width_m)} m` : ''})`;
  const width = b.width_m == null ? '' : b.width_basis === 'assumed_default' ? `width assumed ${Math.round(b.width_m)} m` : `${Math.round(b.width_m)} m`;
  const checked = (b.why ?? []).some((w) => /not checked|last checked/.test(w)) ? 'not checked' : '';
  const poor = (b.why ?? []).find((w) => /overgrown|not passable|broken|poor/.test(w))?.replace(/^road /, '');
  return `${named} (${[poor, width, checked].filter(Boolean).join(', ') || 'uncertain'})`;
}

/** One sentence for alerts: what lies between the detection and the compartment. */
export function barrierSentence(s: BarrierSummary | null | undefined, code?: string | null): string {
  if (!s) return '';
  const to = code ?? s.compartment ?? 'the compartment';
  const list = (s.barriers ?? []).slice(0, 3).map(barrierLabel);
  const more = (s.barriers ?? []).length > 3 ? ` +${(s.barriers ?? []).length - 3} more` : '';
  switch (s.status) {
    case 'inside': return `Inside ${to}.`;
    case 'protected': return `Checked barrier between it and ${to}: ${list.join('; ')}${more}.`;
    case 'uncertain': return `Only unverified barriers between it and ${to}: ${list.join('; ')}${more}. Do not rely on them.`;
    case 'gap': return list.length
      ? `Open approach to ${to}: ${s.gap_rays} of ${s.rays} lines cross no mapped barrier (others cross: ${list.join('; ')}${more}).`
      : `No mapped barrier between it and ${to}.`;
  }
}

/** Short tag for chips: "No barrier" / "Unverified barrier" / "Checked barrier" / "Inside". */
export function barrierTag(s: BarrierSummary | null | undefined): string | null {
  if (!s) return null;
  return { inside: 'Inside', gap: 'No barrier', uncertain: 'Unverified barrier', protected: 'Checked barrier' }[s.status] ?? null;
}
