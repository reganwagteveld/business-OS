import type { SchedulingConflict, SchedulingResourceStatus, SchedulingResourceType } from '@business-os/contracts';
import type { BadgeTone } from '@business-os/ui';

/** Industry-neutral labels for the resource kinds (docs/scheduling-s2.md §2.1). */
export const TYPE_LABEL: Record<SchedulingResourceType, string> = { PERSON: 'Person', ROOM: 'Room', EQUIPMENT: 'Equipment', OTHER: 'Other' };
export const TYPES = Object.keys(TYPE_LABEL) as SchedulingResourceType[];
export const STATUS_LABEL: Record<SchedulingResourceStatus, string> = { ACTIVE: 'Active', INACTIVE: 'Inactive', ARCHIVED: 'Archived' };
export const STATUS_TONE: Record<SchedulingResourceStatus, BadgeTone> = { ACTIVE: 'success', INACTIVE: 'warning', ARCHIVED: 'neutral' };

/** Calendar overlaps first, then each resource's, so a person reading a refused booking sees what caused it. */
export function splitConflicts(conflicts: SchedulingConflict[]) {
  const calendar = conflicts.filter((c) => c.kind === 'calendar');
  const byResource = new Map<string, { name: string; conflicts: SchedulingConflict[] }>();
  for (const c of conflicts) {
    if (c.kind !== 'resource' || !c.resource) continue;
    const entry = byResource.get(c.resource.id) ?? { name: c.resource.name, conflicts: [] };
    entry.conflicts.push(c);
    byResource.set(c.resource.id, entry);
  }
  return { calendar, resources: [...byResource.entries()].map(([id, v]) => ({ id, ...v })) };
}

/** The theme's accent as a hex colour (the colour input needs one), read from the design tokens; none if unavailable. */
export function themeAccent(): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--ring').trim();
    return /^#[0-9a-f]{6}$/i.test(value) ? value : '';
  } catch {
    return '';
  }
}
