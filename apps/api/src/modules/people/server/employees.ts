import 'server-only';
// Employees (docs/people-data-model.md §2.1). Runs inside a tenant unit of work: the scoped client adds
// business_id, forced RLS checks it again, and composite foreign keys make a link to another business's
// location, department, employee or member impossible. Every change is a conditional UPDATE on the
// version the caller saw. Employees are never deleted; this file never reads personal details.
import { randomUUID } from 'node:crypto';
import type { Employee as EmployeeDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { BUMP, changedFields, dateOf, dayOf, displayName, effectiveDateOf, lockReportingLines, UUID } from './shared';

export type Status = 'PENDING' | 'ACTIVE' | 'ON_LEAVE' | 'TERMINATED';
type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACTOR' | 'TEMPORARY' | 'OTHER';
type Named = { id: string; givenName: string; familyName: string; preferredName: string | null; status: Status };

export type EmployeeRow = {
  id: string; employeeNumber: string | null; givenName: string; familyName: string; preferredName: string | null; jobTitle: string | null;
  employmentType: EmploymentType | null; workEmail: string | null; workPhone: string | null; status: Status; startDate: Date | null;
  endDate: Date | null; locationId: string | null; userId: string | null; version: number; createdAt: Date; updatedAt: Date;
  location: { id: string; name: string; archivedAt: Date | null } | null;
  departmentAssignments: { department: { id: string; name: string; archivedAt: Date | null } }[];
  managerAssignments: { manager: Named }[];
};

export const namedSelect = { id: true, givenName: true, familyName: true, preferredName: true, status: true } as const;

/** Work fields plus the current (open) department and manager, in one query. Never personal details. */
export const employeeSelect = {
  id: true, employeeNumber: true, givenName: true, familyName: true, preferredName: true, jobTitle: true, employmentType: true, workEmail: true,
  workPhone: true, status: true, startDate: true, endDate: true, locationId: true, userId: true, version: true, createdAt: true, updatedAt: true,
  location: { select: { id: true, name: true, archivedAt: true } },
  departmentAssignments: { where: { endsOn: null }, select: { department: { select: { id: true, name: true, archivedAt: true } } }, take: 1 },
  managerAssignments: { where: { endsOn: null }, select: { manager: { select: namedSelect } }, take: 1 },
} as const;

const ref = (r: { id: string; name: string; archivedAt: Date | null }) => ({ id: r.id, name: r.name, archived: r.archivedAt !== null });
export const managerRef = (m: Named) => ({ id: m.id, name: displayName(m), status: m.status });

export const toEmployee = (r: EmployeeRow): EmployeeDto => {
  const department = r.departmentAssignments[0]?.department;
  const manager = r.managerAssignments[0]?.manager;
  return {
    id: r.id, employeeNumber: r.employeeNumber, givenName: r.givenName, familyName: r.familyName, preferredName: r.preferredName,
    displayName: displayName(r), jobTitle: r.jobTitle, employmentType: r.employmentType, workEmail: r.workEmail, workPhone: r.workPhone,
    status: r.status, startDate: dayOf(r.startDate), endDate: dayOf(r.endDate),
    department: department ? ref(department) : null, manager: manager ? managerRef(manager) : null, location: r.location ? ref(r.location) : null,
    userId: r.userId, version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
};

export async function loadEmployee(db: AppTenantDb, id: string): Promise<EmployeeRow> {
  const row = (await db.peopleEmployee.findFirst({ where: { id }, select: employeeSelect } as never)) as EmployeeRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}
export const presentEmployee = async (db: AppTenantDb, id: string) => toEmployee(await loadEmployee(db, id));

// ---- checks shared with lifecycle.ts ----------------------------------------------------------

/** A newly chosen location must exist here and be active. Existing links stay if it is archived later (it cannot be while in use). */
export async function checkLocation(db: AppTenantDb, locationId: string) {
  const location = await db.peopleLocation.findFirst({ where: { id: locationId }, select: { archivedAt: true } });
  if (!location) throw new RuleViolationError('invalid_location', 'Choose a workplace location of this business.');
  if (location.archivedAt) throw new StateConflictError('archived_reference');
}

export async function checkDepartment(db: AppTenantDb, departmentId: string) {
  const department = await db.peopleDepartment.findFirst({ where: { id: departmentId }, select: { archivedAt: true } });
  if (!department) throw new RuleViolationError('invalid_department', 'Choose a department of this business.');
  if (department.archivedAt) throw new StateConflictError('archived_reference');
}

/** The manager must be another, non-terminated employee of this business. */
export async function checkManager(db: AppTenantDb, employeeId: string, managerId: string) {
  if (managerId === employeeId) throw new RuleViolationError('invalid_manager', 'An employee cannot be their own manager.');
  const manager = await db.peopleEmployee.findFirst({ where: { id: managerId }, select: { status: true } });
  if (!manager || manager.status === 'TERMINATED') {
    throw new RuleViolationError('invalid_manager', 'The manager must be a current employee of this business.');
  }
}

/** A linked user must be an ACTIVE member of this business and not linked to another employee. Linking grants nothing. */
async function checkUser(db: AppTenantDb, userId: string, exceptEmployeeId?: string) {
  const member = await db.membership.findFirst({ where: { userId, status: 'ACTIVE' }, select: { id: true } });
  if (!member) throw new RuleViolationError('invalid_user', 'Only an active member of this business can be linked to an employee.');
  const other = await db.peopleEmployee.findFirst({ where: { userId, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) }, select: { id: true } });
  if (other) throw new StateConflictError('user_already_linked');
}

/** Unique per business ignoring case, across every employee ever (the partial index is the backstop). */
async function checkNumber(db: AppTenantDb, employeeNumber: string, exceptEmployeeId?: string) {
  const clash = await db.peopleEmployee.findFirst({
    where: { employeeNumber: { equals: employeeNumber, mode: 'insensitive' }, ...(exceptEmployeeId ? { id: { not: exceptEmployeeId } } : {}) },
    select: { id: true },
  } as never);
  if (clash) throw new StateConflictError('duplicate_employee_number');
}

// ---- create / update ----------------------------------------------------------------------------

type DetailInput = {
  employeeNumber?: string | null; givenName?: string; familyName?: string; preferredName?: string | null; jobTitle?: string | null;
  employmentType?: EmploymentType | null; workEmail?: string | null; workPhone?: string | null; locationId?: string | null; userId?: string | null;
};
export type CreateEmployeeInput = DetailInput & {
  givenName: string; familyName: string; status?: 'PENDING' | 'ACTIVE'; startDate?: string | null; departmentId?: string | null; managerEmployeeId?: string | null;
};

const DETAIL_KEYS = ['employeeNumber', 'givenName', 'familyName', 'preferredName', 'jobTitle', 'employmentType', 'workEmail', 'workPhone'] as const;

export async function createEmployee(db: AppTenantDb, actorUserId: string, input: CreateEmployeeInput) {
  const status = input.status ?? 'PENDING';
  // A reporting line is part of the employee's creation, so the reporting lock comes first (lock order).
  if (input.managerEmployeeId) await lockReportingLines(db);
  if (input.employeeNumber) await checkNumber(db, input.employeeNumber);
  if (input.locationId) await checkLocation(db, input.locationId);
  if (input.departmentId) await checkDepartment(db, input.departmentId);
  if (input.userId) await checkUser(db, input.userId);
  const id = randomUUID();
  if (input.managerEmployeeId) await checkManager(db, id, input.managerEmployeeId);

  // ACTIVE starts on a date that is not in the future (today by default). PENDING may carry a planned start.
  let startDate: string | null = input.startDate ?? null;
  if (status === 'ACTIVE') startDate = await effectiveDateOf(db, input.startDate ?? undefined);
  const since = status === 'ACTIVE' ? startDate! : await effectiveDateOf(db, undefined);

  const data: Record<string, unknown> = { id, status, startDate: startDate ? dateOf(startDate) : null, createdById: actorUserId, updatedById: actorUserId };
  for (const key of DETAIL_KEYS) if (input[key] !== undefined) data[key] = input[key];
  if (input.locationId) data.locationId = input.locationId;
  if (input.userId) data.userId = input.userId;
  await db.peopleEmployee.create({ data } as never);
  await db.peopleEmploymentStatusHistory.create({
    data: { id: randomUUID(), employeeId: id, fromStatus: null, toStatus: status, effectiveDate: dateOf(since), recordedById: actorUserId },
  } as never);
  if (input.departmentId) {
    await db.peopleDepartmentAssignment.create({ data: { id: randomUUID(), employeeId: id, departmentId: input.departmentId, startsOn: dateOf(since), createdById: actorUserId } } as never);
  }
  if (input.managerEmployeeId) {
    await db.peopleManagerAssignment.create({
      data: { id: randomUUID(), employeeId: id, managerEmployeeId: input.managerEmployeeId, startsOn: dateOf(since), createdById: actorUserId },
    } as never);
  }
  // Structured facts only: no names, contact details or numbers.
  await recordAudit(db, actorUserId, 'people.employee.created', { type: 'people_employee', id }, {
    status, departmentId: input.departmentId ?? null, managerEmployeeId: input.managerEmployeeId ?? null, locationId: input.locationId ?? null,
    userId: input.userId ?? null,
  });
  return presentEmployee(db, id);
}

export async function getEmployee(db: AppTenantDb, id: string) {
  return presentEmployee(db, id);
}

/**
 * Edits work details, location and the user link. Status, department and manager go through
 * lifecycle.ts because they write history. Terminated employees can still be corrected, but cannot be
 * linked to a user or given a location.
 */
export async function updateEmployee(db: AppTenantDb, actorUserId: string, id: string, patch: DetailInput & { startDate?: string | null; version: number }) {
  const before = await loadEmployee(db, id);
  if (before.version !== patch.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) if (patch[key] !== undefined) data[key] = patch[key];
  if (patch.locationId !== undefined) data.locationId = patch.locationId;
  if (patch.userId !== undefined) data.userId = patch.userId;
  if (patch.startDate !== undefined) data.startDate = patch.startDate ? dateOf(patch.startDate) : null;

  const { location: _l, departmentAssignments: _d, managerAssignments: _m, ...comparable } = before;
  void _l; void _d; void _m;
  const fields = changedFields(comparable as unknown as Record<string, unknown>, data);
  if (fields.length === 0) return toEmployee(before);

  // The start date of an employment that has begun is history: it changes only through the lifecycle.
  if (fields.includes('startDate') && before.status !== 'PENDING') throw new StateConflictError('start_date_locked');
  if (fields.includes('employeeNumber') && data.employeeNumber) await checkNumber(db, data.employeeNumber as string, id);
  if (fields.includes('locationId') && data.locationId) {
    if (before.status === 'TERMINATED') throw new StateConflictError('terminated');
    await checkLocation(db, data.locationId as string);
  }
  if (fields.includes('userId') && data.userId) {
    if (before.status === 'TERMINATED') throw new StateConflictError('terminated');
    await checkUser(db, data.userId as string, id);
  }

  const result = await db.peopleEmployee.updateMany({ where: { id, version: patch.version }, data: { ...data, ...BUMP, updatedById: actorUserId } } as never);
  if (result.count === 0) throw new StateConflictError('stale');
  const target = { type: 'people_employee', id };
  await recordAudit(db, actorUserId, 'people.employee.updated', target, { fields });
  if (fields.includes('employeeNumber')) {
    await recordAudit(db, actorUserId, 'people.employee.number_changed', target, { from: before.employeeNumber, to: (data.employeeNumber as string | null) ?? null });
  }
  if (fields.includes('locationId')) {
    await recordAudit(db, actorUserId, 'people.employee.location_changed', target, { from: before.locationId, to: (data.locationId as string | null) ?? null });
  }
  if (fields.includes('userId')) {
    if (before.userId) await recordAudit(db, actorUserId, 'people.employee.user_unlinked', target, { userId: before.userId });
    if (data.userId) await recordAudit(db, actorUserId, 'people.employee.user_linked', target, { userId: data.userId as string });
  }
  return presentEmployee(db, id);
}

// ---- list ---------------------------------------------------------------------------------------

export type EmployeeQuery = {
  q?: string; status: Status | 'current' | 'all'; departmentId?: string; locationId?: string; managerEmployeeId?: string;
  sort: 'name' | 'number' | 'newest'; cursor?: string; limit: number;
};

/** Keyset-paginated; every order ends with the id, so no row is skipped or repeated between pages. */
export async function listEmployees(db: AppTenantDb, query: EmployeeQuery) {
  const where: Record<string, unknown>[] = [];
  if (query.status === 'current') where.push({ status: { not: 'TERMINATED' } });
  else if (query.status !== 'all') where.push({ status: query.status });
  if (query.locationId) where.push({ locationId: query.locationId });
  if (query.departmentId) where.push({ departmentAssignments: { some: { departmentId: query.departmentId, endsOn: null } } });
  if (query.managerEmployeeId) where.push({ managerAssignments: { some: { managerEmployeeId: query.managerEmployeeId, endsOn: null } } });
  const term = query.q?.trim();
  if (term) {
    const contains = { contains: term, mode: 'insensitive' };
    where.push({ OR: [{ givenName: contains }, { familyName: contains }, { preferredName: contains }, { employeeNumber: contains }, { workEmail: contains }] });
  }

  const list = `people:employees:${query.sort}`;
  let orderBy: Record<string, unknown>[];
  let cursorOf: (r: EmployeeRow) => Record<string, string>;
  if (query.sort === 'number') {
    // Numbered employees first (A to Z), then those without a number. '-' cannot start a number.
    const after = decodeCursor(query.cursor, list, ['n', 'i'] as const);
    if (after) {
      if (!UUID.test(after.i)) invalidCursor();
      if (after.n === '-') where.push({ employeeNumber: null, id: { gt: after.i } });
      else where.push({ OR: [{ employeeNumber: { gt: after.n } }, { employeeNumber: after.n, id: { gt: after.i } }, { employeeNumber: null }] });
    }
    orderBy = [{ employeeNumber: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
    cursorOf = (r) => ({ n: r.employeeNumber ?? '-', i: r.id });
  } else if (query.sort === 'newest') {
    const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
    if (after) {
      const t = new Date(after.t);
      if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
      where.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
    }
    orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    cursorOf = (r) => ({ t: r.createdAt.toISOString(), i: r.id });
  } else {
    const after = decodeCursor(query.cursor, list, ['f', 'g', 'i'] as const);
    if (after) {
      if (!UUID.test(after.i)) invalidCursor();
      where.push({
        OR: [
          { familyName: { gt: after.f } }, { familyName: after.f, givenName: { gt: after.g } }, { familyName: after.f, givenName: after.g, id: { gt: after.i } },
        ],
      });
    }
    orderBy = [{ familyName: 'asc' }, { givenName: 'asc' }, { id: 'asc' }];
    cursorOf = (r) => ({ f: r.familyName, g: r.givenName, i: r.id });
  }

  const rows = (await db.peopleEmployee.findMany({ where: { AND: where }, select: employeeSelect, orderBy, take: query.limit + 1 } as never)) as unknown as EmployeeRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { employees: page.map(toEmployee), nextCursor: rows.length > query.limit && last ? encodeCursor(list, cursorOf(last)) : null };
}

