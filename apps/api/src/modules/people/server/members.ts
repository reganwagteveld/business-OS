import 'server-only';
// Called by the tenancy module when a member is removed from the business (docs/people-data-model.md
// §2.1, decision PD-6). The employee record stays; only the link to the departing user is cleared, with
// the version bumped (an edit prepared before is refused as stale) and an audit event per employee.
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';

export async function unlinkRemovedMember(db: AppTenantDb, actorUserId: string, userId: string): Promise<void> {
  const linked = await db.peopleEmployee.findMany({ where: { userId }, select: { id: true } });
  if (linked.length === 0) return;
  await db.peopleEmployee.updateMany({ where: { userId }, data: { userId: null, version: { increment: 1 }, updatedById: actorUserId } } as never);
  for (const e of linked) {
    await recordAudit(db, actorUserId, 'people.employee.user_unlinked', { type: 'people_employee', id: e.id }, { userId, reason: 'member_removed' });
  }
}
