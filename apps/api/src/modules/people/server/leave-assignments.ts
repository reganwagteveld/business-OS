import 'server-only';
// People P3-A (docs/people-leave-p3.md §4.4): which leave policy governs each employee's leave of one
// type. Effective-dated rows [starts_on, ends_on), at most one open per employee and leave type, closed
// once and never edited or deleted (as for department assignments in P1).
//
// Lock order (§4.5): the policy row FOR SHARE first, then employee rows FOR SHARE in ascending id order,
// then the assignment rows. An archive of the policy takes the policy row FOR UPDATE, a termination
// takes the employee row; neither then takes the other, so no cycle is possible. Two administrators
// assigning at once are resolved by the one-open-row index (the loser gets 409 stale, nothing written).
import { randomUUID } from 'node:crypto';
import type { EmploymentStatus, LeaveCategory, LeavePolicyAssignment as AssignmentDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { dateOf, dayOf, displayName, effectiveDateOf, orderViolation, UUID } from './shared';

type Row = {
  id: string; employeeId: string; leaveTypeId: string; policyId: string; startsOn: Date; endsOn: Date | null; createdAt: Date; endedAt: Date | null;
  employee: { id: string; givenName: string; familyName: string; preferredName: string | null; status: EmploymentStatus };
  leaveType: { id: string; name: string; category: LeaveCategory; archivedAt: Date | null };
  policy: { id: string; name: string; archivedAt: Date | null };
};
const select = {
  id: true, employeeId: true, leaveTypeId: true, policyId: true, startsOn: true, endsOn: true, createdAt: true, endedAt: true,
  employee: { select: { id: true, givenName: true, familyName: true, preferredName: true, status: true } },
  leaveType: { select: { id: true, name: true, category: true, archivedAt: true } },
  policy: { select: { id: true, name: true, archivedAt: true } },
} as const;

const dto = (r: Row): AssignmentDto => ({
  id: r.id,
  employee: { id: r.employee.id, name: displayName(r.employee), status: r.employee.status },
  leaveType: { id: r.leaveType.id, name: r.leaveType.name, category: r.leaveType.category, archived: r.leaveType.archivedAt !== null },
  policy: { id: r.policy.id, name: r.policy.name, archived: r.policy.archivedAt !== null },
  startsOn: dayOf(r.startsOn)!, endsOn: dayOf(r.endsOn), createdAt: r.createdAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null,
});

const lockPolicy = (db: AppTenantDb, id: string) =>
  db.$queryRaw`SELECT id FROM people_leave_policies WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR SHARE`;
const lockEmployee = (db: AppTenantDb, id: string) =>
  db.$queryRaw`SELECT id FROM people_employees WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR SHARE`;

/** Close an employee's open row for one leave type at `date` (never before it started). */
async function closeOpen(db: AppTenantDb, actorUserId: string, open: { id: string; startsOn: Date }, date: string) {
  if (date < dayOf(open.startsOn)!) throw orderViolation();
  const closed = await db.peopleLeavePolicyAssignment.updateMany({
    where: { id: open.id, endsOn: null }, data: { endsOn: dateOf(date), endedAt: new Date(), endedById: actorUserId } as never,
  });
  // Someone else closed or replaced it after it was read: nothing is written.
  if (closed.count === 0) throw new StateConflictError('stale');
}

/**
 * Assign one policy to up to 100 employees, all or nothing. Employees already on this policy are left
 * unchanged; another policy of the same leave type is closed on the effective date and this one starts
 * on it. The policy must be active and not archived; employees must exist and not be terminated.
 */
export async function assignLeavePolicy(db: AppTenantDb, actorUserId: string, policyId: string, input: { employeeIds: string[]; effectiveDate?: string }) {
  const policy = await db.peopleLeavePolicy.findFirst({ where: { id: policyId }, select: { id: true, leaveTypeId: true, status: true, archivedAt: true } });
  if (!policy) throw new RecordNotFoundError();
  const date = await effectiveDateOf(db, input.effectiveDate);
  await lockPolicy(db, policyId);
  // Re-read under the lock: an archive or deactivation that committed first is seen here.
  const locked = await db.peopleLeavePolicy.findFirst({ where: { id: policyId }, select: { status: true, archivedAt: true } });
  if (!locked || locked.archivedAt) throw new StateConflictError('archived_reference');
  if (locked.status !== 'ACTIVE') throw new StateConflictError('inactive_reference');

  const ids = [...new Set(input.employeeIds.map((i) => i.toLowerCase()))].sort();
  let assigned = 0;
  let unchanged = 0;
  for (const employeeId of ids) {
    await lockEmployee(db, employeeId);
    const employee = await db.peopleEmployee.findFirst({ where: { id: employeeId }, select: { status: true } });
    if (!employee) throw new RecordNotFoundError();
    if (employee.status === 'TERMINATED') throw new StateConflictError('terminated');
    const open = await db.peopleLeavePolicyAssignment.findFirst({
      where: { employeeId, leaveTypeId: policy.leaveTypeId, endsOn: null }, select: { id: true, policyId: true, startsOn: true },
    });
    if (open?.policyId === policyId) {
      unchanged++;
      continue;
    }
    if (open) await closeOpen(db, actorUserId, open, date);
    const id = randomUUID();
    await db.peopleLeavePolicyAssignment.create({
      data: { id, employeeId, leaveTypeId: policy.leaveTypeId, policyId, startsOn: dateOf(date), createdById: actorUserId } as never,
    });
    assigned++;
    // Ids and the date only: which policy applies to whom is People data, never copied into the log as text.
    await recordAudit(db, actorUserId, 'people.leave_policy.assigned', { type: 'people_employee', id: employeeId }, {
      policyId, leaveTypeId: policy.leaveTypeId, effectiveDate: date, replacedPolicyId: open?.policyId ?? null,
    });
  }
  const rows = (await db.peopleLeavePolicyAssignment.findMany({
    where: { employeeId: { in: ids }, leaveTypeId: policy.leaveTypeId, endsOn: null }, select, orderBy: [{ employeeId: 'asc' }],
  })) as Row[];
  return { assigned, unchanged, assignments: rows.map(dto) };
}

/** Stop applying any policy of one leave type to an employee from the effective date. */
export async function endLeavePolicyAssignment(db: AppTenantDb, actorUserId: string, employeeId: string, input: { leaveTypeId: string; effectiveDate?: string }) {
  const employee = await db.peopleEmployee.findFirst({ where: { id: employeeId }, select: { id: true } });
  if (!employee) throw new RecordNotFoundError();
  const date = await effectiveDateOf(db, input.effectiveDate);
  const open = await db.peopleLeavePolicyAssignment.findFirst({
    where: { employeeId, leaveTypeId: input.leaveTypeId, endsOn: null }, select: { id: true, policyId: true, startsOn: true },
  });
  if (!open) throw new StateConflictError('not_assigned');
  await closeOpen(db, actorUserId, open, date);
  await recordAudit(db, actorUserId, 'people.leave_policy.unassigned', { type: 'people_employee', id: employeeId }, {
    policyId: open.policyId, leaveTypeId: input.leaveTypeId, effectiveDate: date,
  });
  return employeeLeavePolicies(db, employeeId);
}

/** Every assignment of one employee: current ones first, then newest first. */
export async function employeeLeavePolicies(db: AppTenantDb, employeeId: string) {
  const employee = await db.peopleEmployee.findFirst({ where: { id: employeeId }, select: { id: true } });
  if (!employee) throw new RecordNotFoundError();
  const rows = (await db.peopleLeavePolicyAssignment.findMany({
    where: { employeeId }, select, orderBy: [{ startsOn: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
  })) as Row[];
  const current = rows.filter((r) => r.endsOn === null);
  const past = rows.filter((r) => r.endsOn !== null);
  return { assignments: [...current, ...past].map(dto) };
}

/** The assignments of one policy (current only by default), keyset-paged by id. */
export async function listPolicyAssignments(db: AppTenantDb, policyId: string, query: { include: 'current' | 'all'; cursor?: string; limit: number }) {
  const policy = await db.peopleLeavePolicy.findFirst({ where: { id: policyId }, select: { id: true } });
  if (!policy) throw new RecordNotFoundError();
  const where: Record<string, unknown>[] = [{ policyId }];
  if (query.include === 'current') where.push({ endsOn: null });
  const list = `people:leave-policy-assignments:${policyId}:${query.include}`;
  const after = decodeCursor(query.cursor, list, ['i'] as const);
  if (after) {
    if (!UUID.test(after.i)) invalidCursor();
    where.push({ id: { gt: after.i } });
  }
  const rows = (await db.peopleLeavePolicyAssignment.findMany({ where: { AND: where }, select, orderBy: { id: 'asc' }, take: query.limit + 1 })) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { assignments: page.map(dto), nextCursor: rows.length > query.limit && last ? encodeCursor(list, { i: last.id }) : null };
}
