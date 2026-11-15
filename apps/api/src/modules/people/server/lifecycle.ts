import 'server-only';
// Employment lifecycle, department and reporting-line changes, and history (docs/people-data-model.md
// §2.2, §3). Every change here:
//   1. takes the per-business reporting lock first when it touches reporting lines (lock order:
//      advisory lock, then rows), so concurrent changes cannot form a cycle or orphan reports;
//   2. bumps the employee's version with a conditional UPDATE on the version the caller saw (this also
//      locks the employee row, so two changes to one employee are serialised and the loser gets 409 stale);
//   3. closes the open assignment row (never edits or deletes it) and opens a new one;
//   4. writes history / audit in the same unit of work.
// The guard triggers in the migration re-check the same rules as a backstop.
import { randomUUID } from 'node:crypto';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { StateConflictError } from '@/core/http/errors';
import { checkDepartment, checkManager, loadEmployee, managerRef, namedSelect, presentEmployee, type Status } from './employees';
import { BUMP, dateOf, dayOf, effectiveDateOf, lockReportingLines, orderViolation, type Viewer } from './shared';

const TRANSITIONS: Record<Status, readonly Status[]> = {
  PENDING: ['ACTIVE', 'TERMINATED'],
  ACTIVE: ['ON_LEAVE', 'TERMINATED'],
  ON_LEAVE: ['ACTIVE', 'TERMINATED'],
  TERMINATED: ['PENDING', 'ACTIVE'],
};
export const canTransition = (from: Status, to: Status) => TRANSITIONS[from].includes(to);

async function bumpEmployee(db: AppTenantDb, id: string, version: number, actorUserId: string, data: Record<string, unknown> = {}, status?: Status) {
  const result = await db.peopleEmployee.updateMany({
    where: { id, version, ...(status ? { status } : {}) },
    data: { ...data, ...BUMP, updatedById: actorUserId },
  } as never);
  if (result.count === 0) throw new StateConflictError('stale');
}

type Open = { id: string; startsOn: Date };
const openDepartment = (db: AppTenantDb, employeeId: string) =>
  db.peopleDepartmentAssignment.findFirst({ where: { employeeId, endsOn: null }, select: { id: true, startsOn: true, departmentId: true } });
const openManager = (db: AppTenantDb, employeeId: string) =>
  db.peopleManagerAssignment.findFirst({ where: { employeeId, endsOn: null }, select: { id: true, startsOn: true, managerEmployeeId: true } });

/** Closes an open assignment at `on` (half-open ranges: the new one starts the same day). */
async function close(db: AppTenantDb, kind: 'department' | 'manager', open: Open, on: string, actorUserId: string) {
  if (on < dayOf(open.startsOn)!) throw orderViolation();
  const model = kind === 'department' ? db.peopleDepartmentAssignment : db.peopleManagerAssignment;
  const result = await (model as unknown as { updateMany(a: unknown): Promise<{ count: number }> }).updateMany({
    where: { id: open.id, endsOn: null },
    data: { endsOn: dateOf(on), endedAt: new Date(), endedById: actorUserId },
  });
  if (result.count === 0) throw new StateConflictError('stale');
}

// ---- status -------------------------------------------------------------------------------------

export async function changeStatus(
  db: AppTenantDb, actorUserId: string, id: string, input: { status: Status; effectiveDate?: string; reason?: string | null; version: number },
) {
  const terminating = input.status === 'TERMINATED';
  if (terminating) await lockReportingLines(db);
  const before = await loadEmployee(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (!canTransition(before.status, input.status)) throw new StateConflictError('invalid_transition');
  const on = await effectiveDateOf(db, input.effectiveDate);
  const last = await db.peopleEmploymentStatusHistory.findFirst({ where: { employeeId: id }, orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }], select: { effectiveDate: true } });
  if (last && on < dayOf(last.effectiveDate)!) throw orderViolation();

  const data: Record<string, unknown> = { status: input.status };
  // Starting (or restarting) employment sets the start of the current period.
  if (input.status === 'ACTIVE' && (before.status === 'PENDING' || before.status === 'TERMINATED')) data.startDate = dateOf(on);
  if (input.status === 'PENDING') data.startDate = null; // a rehire's planned start is set later (PATCH)
  if (before.status === 'TERMINATED') data.endDate = null;
  if (terminating && before.status === 'PENDING') {
    // Withdrawn before starting: there was no employment, so no planned start date is kept on the row
    // (the history still records the withdrawal).
    data.startDate = null;
  } else if (terminating && before.startDate && on < dayOf(before.startDate)!) {
    throw orderViolation();
  }
  if (terminating) {
    const reports = await db.peopleManagerAssignment.count({ where: { managerEmployeeId: id, endsOn: null } });
    if (reports > 0) throw new StateConflictError('has_direct_reports');
    data.endDate = dateOf(on);
  }

  // Conditional on the version and status the caller saw; the guard trigger re-checks the transition.
  await bumpEmployee(db, id, input.version, actorUserId, data, before.status);
  if (terminating) {
    // A terminated employee keeps their history but has no current department or manager.
    const department = await openDepartment(db, id);
    if (department) await close(db, 'department', department, on, actorUserId);
    const manager = await openManager(db, id);
    if (manager) await close(db, 'manager', manager, on, actorUserId);
  }
  await db.peopleEmploymentStatusHistory.create({
    data: {
      id: randomUUID(), employeeId: id, fromStatus: before.status, toStatus: input.status, effectiveDate: dateOf(on),
      reason: input.reason ?? null, recordedById: actorUserId,
    },
  } as never);
  // The reason is sensitive: it stays out of the audit log.
  await recordAudit(db, actorUserId, 'people.employee.status_changed', { type: 'people_employee', id }, { from: before.status, to: input.status, effectiveDate: on });
  return presentEmployee(db, id);
}

// ---- department ---------------------------------------------------------------------------------

export async function changeDepartment(
  db: AppTenantDb, actorUserId: string, id: string, input: { departmentId: string | null; effectiveDate?: string; version: number },
) {
  const before = await loadEmployee(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (before.status === 'TERMINATED') throw new StateConflictError('terminated');
  const current = await openDepartment(db, id);
  if ((current?.departmentId ?? null) === input.departmentId) return presentEmployee(db, id);
  if (input.departmentId) await checkDepartment(db, input.departmentId);
  const on = await effectiveDateOf(db, input.effectiveDate);

  await bumpEmployee(db, id, input.version, actorUserId);
  if (current) await close(db, 'department', current, on, actorUserId);
  if (input.departmentId) {
    await db.peopleDepartmentAssignment.create({ data: { id: randomUUID(), employeeId: id, departmentId: input.departmentId, startsOn: dateOf(on), createdById: actorUserId } } as never);
  }
  await recordAudit(db, actorUserId, 'people.employee.department_changed', { type: 'people_employee', id }, {
    from: current?.departmentId ?? null, to: input.departmentId, effectiveDate: on,
  });
  return presentEmployee(db, id);
}

// ---- reporting line -----------------------------------------------------------------------------

/** True if `employeeId` is `managerId` or anywhere above them in the open reporting lines. */
async function wouldCycle(db: AppTenantDb, employeeId: string, managerId: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ hit: boolean }[]>`
    WITH RECURSIVE chain(id) AS (
      SELECT ${managerId}::uuid
      UNION
      SELECT m.manager_employee_id FROM people_manager_assignments m JOIN chain c ON m.employee_id = c.id
      WHERE m.business_id = nullif(current_setting('app.business_id', true), '')::uuid AND m.ends_on IS NULL
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${employeeId}::uuid) AS hit`;
  return rows[0]?.hit === true;
}

export async function changeManager(
  db: AppTenantDb, actorUserId: string, id: string, input: { managerEmployeeId: string | null; effectiveDate?: string; version: number },
) {
  await lockReportingLines(db);
  const before = await loadEmployee(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (before.status === 'TERMINATED') throw new StateConflictError('terminated');
  const current = await openManager(db, id);
  if ((current?.managerEmployeeId ?? null) === input.managerEmployeeId) return presentEmployee(db, id);
  if (input.managerEmployeeId) {
    await checkManager(db, id, input.managerEmployeeId);
    if (await wouldCycle(db, id, input.managerEmployeeId)) throw new StateConflictError('manager_cycle');
  }
  const on = await effectiveDateOf(db, input.effectiveDate);

  await bumpEmployee(db, id, input.version, actorUserId);
  if (current) await close(db, 'manager', current, on, actorUserId);
  if (input.managerEmployeeId) {
    await db.peopleManagerAssignment.create({
      data: { id: randomUUID(), employeeId: id, managerEmployeeId: input.managerEmployeeId, startsOn: dateOf(on), createdById: actorUserId },
    } as never);
  }
  await recordAudit(db, actorUserId, 'people.employee.manager_changed', { type: 'people_employee', id }, {
    from: current?.managerEmployeeId ?? null, to: input.managerEmployeeId, effectiveDate: on,
  });
  return presentEmployee(db, id);
}

// ---- history ------------------------------------------------------------------------------------

/** Everything that happened, oldest first. Reasons only with people:read_sensitive. */
export async function employeeHistory(db: AppTenantDb, viewer: Viewer, id: string) {
  await loadEmployee(db, id);
  const [status, departments, managers] = await Promise.all([
    db.peopleEmploymentStatusHistory.findMany({
      where: { employeeId: id }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, fromStatus: true, toStatus: true, effectiveDate: true, reason: true, recordedById: true, recordedAt: true },
    }),
    db.peopleDepartmentAssignment.findMany({
      where: { employeeId: id }, orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, startsOn: true, endsOn: true, createdById: true, endedById: true, department: { select: { id: true, name: true, archivedAt: true } } },
    } as never) as unknown as Promise<{ id: string; startsOn: Date; endsOn: Date | null; createdById: string | null; endedById: string | null; department: { id: string; name: string; archivedAt: Date | null } }[]>,
    db.peopleManagerAssignment.findMany({
      where: { employeeId: id }, orderBy: [{ startsOn: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, startsOn: true, endsOn: true, createdById: true, endedById: true, manager: { select: namedSelect } },
    } as never) as unknown as Promise<{ id: string; startsOn: Date; endsOn: Date | null; createdById: string | null; endedById: string | null; manager: Parameters<typeof managerRef>[0] }[]>,
  ]);
  return {
    status: status.map((s) => ({
      id: s.id, fromStatus: s.fromStatus, toStatus: s.toStatus, effectiveDate: dayOf(s.effectiveDate)!,
      reason: viewer.canReadSensitive ? s.reason : null, recordedById: s.recordedById, recordedAt: s.recordedAt.toISOString(),
    })),
    departments: departments.map((d) => ({
      id: d.id, department: { id: d.department.id, name: d.department.name, archived: d.department.archivedAt !== null },
      startsOn: dayOf(d.startsOn)!, endsOn: dayOf(d.endsOn), createdById: d.createdById, endedById: d.endedById,
    })),
    managers: managers.map((m) => ({
      id: m.id, manager: managerRef(m.manager), startsOn: dayOf(m.startsOn)!, endsOn: dayOf(m.endsOn), createdById: m.createdById, endedById: m.endedById,
    })),
  };
}
