import type { IncidentStatus, Role } from './types';

export const ORDER: IncidentStatus[] = ['reported', 'confirmed', 'responding', 'on_scene', 'contained', 'controlled', 'out'];
export const ACTIVE: IncidentStatus[] = ['reported', 'confirmed', 'responding', 'on_scene'];
export const isOpen = (s: IncidentStatus) => s !== 'out' && s !== 'dismissed';

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  reported: 'Reported',
  confirmed: 'Confirmed',
  responding: 'Responding',
  on_scene: 'On scene',
  contained: 'Contained',
  controlled: 'Mop-up', // stored as 'controlled'; SOP: secure perimeter, mop-up / cold-trail before Out
  out: 'Out (cold)',
  dismissed: 'False alarm',
};

const isCoord = (r: Role) => r === 'coordinator' || r === 'admin';

/** Allowed next statuses for a role (FR-INC-01). */
export function allowedNext(from: IncidentStatus, role: Role): IncidentStatus[] {
  const out: IncidentStatus[] = [];
  if (role === 'reporter' || role === 'manager') return out;
  if (from === 'dismissed') return isCoord(role) ? ['reported'] : out;
  const i = ORDER.indexOf(from);
  const maxIdx = isCoord(role) ? ORDER.length - 1 : ORDER.indexOf('contained'); // responders may go up to Contained
  for (let k = i + 1; k <= maxIdx; k++) out.push(ORDER[k]);
  // reopen
  if (from === 'contained' && role === 'responder') out.push('on_scene');
  if (isCoord(role) && (from === 'contained' || from === 'controlled' || from === 'out')) out.push('on_scene');
  // false alarm only before crews are on the fire, coordinators only
  if (isCoord(role) && (from === 'reported' || from === 'confirmed' || from === 'responding')) out.push('dismissed');
  return out;
}

export const CAUSES = ['Unknown', 'Land clearing / farming', 'Hunting / honey collection', 'Smoking / cooking fire', 'Lightning', 'Arson (suspected)', 'Escaped fire from neighbour', 'Machinery / vehicle', 'Other'];

export type Perm = 'report' | 'respond' | 'status' | 'dispatch' | 'perimeter' | 'admin' | 'readiness';
export function can(role: Role | undefined, p: Perm): boolean {
  if (!role) return false;
  switch (p) {
    case 'report':
      return true;
    case 'respond':
    case 'perimeter':
      return role === 'responder' || isCoord(role);
    case 'status':
      return role === 'responder' || isCoord(role);
    case 'dispatch':
    case 'readiness':
      return isCoord(role);
    case 'admin':
      return role === 'admin';
  }
}

/** SOP 4.1 fire categories: size, crew and time standards. Patrol hours = upper end of the SOP range. */
export type Category = 1 | 2 | 3 | 4 | 5;
export const CATEGORY: Record<Category, { name: string; size: string; signs: string; crew: string; control: string; patrol: string; patrolH: number }> = {
  1: { name: 'Smoke only', size: 'under 10 m²', signs: 'Thin white/grey smoke, no visible flames', crew: '2 (patrol)', control: 'under 30 min', patrol: '1–2 h', patrolH: 2 },
  2: { name: 'Small fire', size: 'under 0.5 ha', signs: 'Flames under 1 m, slow spread, light smoke', crew: '14', control: '30–60 min', patrol: '4–6 h', patrolH: 6 },
  3: { name: 'Moderate fire', size: '0.5–5 ha', signs: 'Flames 1–2 m, faster with wind, several smoke columns', crew: '24', control: '2–4 h', patrol: '12–24 h', patrolH: 24 },
  4: { name: 'Large fire', size: '5–50 ha', signs: 'Continuous fire front, heavy smoke, crown fire possible', crew: '48 + machinery', control: '12–48 h', patrol: '24–48 h', patrolH: 48 },
  5: { name: 'Major fire', size: 'over 50 ha', signs: 'Wide fronts, flames over 3 m, thick dark smoke', crew: 'All staff + external support', control: '12–48 h', patrol: '72 h+', patrolH: 72 },
};
export const CATEGORIES: Category[] = [1, 2, 3, 4, 5];
/** Old size field kept in step for older phones and exports. */
export const sizeFromCategory = (c: Category | null | undefined): 'unknown' | 'small' | 'medium' | 'large' => (!c ? 'unknown' : c <= 2 ? 'small' : c === 3 ? 'medium' : 'large');

/** What the SOP asks for after a fire is declared Out. Times in ms since epoch. */
export function afterOut(outAt: string, category: Category | null | undefined) {
  const t = Date.parse(outAt), h = 3600_000;
  return {
    patrolUntil: category ? t + CATEGORY[category].patrolH * h : null,
    monitorUntil: t + 48 * h, // "Monitor burn area for 48 hours post-suppression"
    draftDue: t + 12 * h,
    finalDue: t + 24 * h,
    submitDue: t + 48 * h,
  };
}
