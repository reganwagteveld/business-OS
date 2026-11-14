import 'server-only';
// Shared by projects and tasks (docs/projects-data-model.md).
import type { AppTenantDb } from '@/core/db';
import { RuleViolationError } from '@/core/http/errors';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Every change bumps the version, so an edit based on an older version can be detected. */
export const BUMP = { version: { increment: 1 } };

export const dateOf = (v: string) => new Date(`${v}T00:00:00Z`);
export const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Project owners and task assignees must be ACTIVE members of this business. The composite FK to
 * memberships guarantees membership of this business (never another one); this also checks status.
 * Assignment is work management only: it grants no permission.
 */
export async function checkMember(db: AppTenantDb, userId: string, code: 'invalid_owner' | 'invalid_assignee') {
  const member = await db.membership.findFirst({ where: { userId, status: 'ACTIVE' }, select: { id: true } });
  if (!member) {
    throw new RuleViolationError(code, code === 'invalid_owner'
      ? 'The project owner must be an active member of this business.'
      : 'The assignee must be an active member of this business.');
  }
}

/** Field names whose value differs between a row and the update about to be written (sorted). */
export const changedFields = (before: Record<string, unknown>, data: Record<string, unknown>) =>
  Object.keys(data).filter((k) => {
    const a = before[k];
    const b = data[k];
    if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime() !== (b as Date | null)?.getTime();
    return a !== b;
  }).sort();
