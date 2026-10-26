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
  controlled: 'Controlled',
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
