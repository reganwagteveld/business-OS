import 'server-only';
// Projects (docs/projects-data-model.md §2–4). Runs inside a tenant unit of work: the scoped client
// adds business_id, forced RLS checks it again, and composite foreign keys make a link to another
// business's customer or member impossible. Every change is a conditional UPDATE on the version the
// caller saw, so two people editing at once cannot silently overwrite each other.
import { randomUUID } from 'node:crypto';
import type { Project as ProjectDto, ProjectSummary } from '@business-os/contracts';
import { can, ForbiddenError, type Principal } from '@/modules/access';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { BUMP, changedFields, checkMember, DAY, dateOf, dayOf, UUID } from './shared';

type Status = 'PLANNED' | 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'CANCELLED';
type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type Row = {
  id: string; name: string; description: string | null; status: Status; priority: Priority; customerId: string | null; ownerUserId: string | null;
  startDate: Date | null; dueDate: Date | null; completedAt: Date | null; version: number; createdById: string | null; updatedById: string | null;
  createdAt: Date; updatedAt: Date; archivedAt: Date | null;
  customer?: { id: string; displayName: string; archivedAt: Date | null } | null;
};

/** What the caller may see besides projects themselves. Decided by the route from the verified role. */
export interface Viewer {
  /** Customer names come from the Customer Zone, so they are shown only to people who may read customers. */
  canReadCustomers: boolean;
}

const base = {
  id: true, name: true, description: true, status: true, priority: true, customerId: true, ownerUserId: true, startDate: true, dueDate: true,
  completedAt: true, version: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;
/** The linked customer is read in the same query (a join, no per-row lookups), and only when allowed. */
const selectFor = (viewer: Viewer) => (viewer.canReadCustomers ? { ...base, customer: { select: { id: true, displayName: true, archivedAt: true } } } : base);

type Counts = Map<string, { total: number; done: number }>;

/** Task totals for a page of projects in one grouped query (archived tasks are not counted). */
async function countsFor(db: AppTenantDb, ids: string[]): Promise<Counts> {
  const counts: Counts = new Map(ids.map((id) => [id, { total: 0, done: 0 }]));
  if (ids.length === 0) return counts;
  const groups = (await db.projectTask.groupBy({
    by: ['projectId', 'status'], where: { projectId: { in: ids }, archivedAt: null }, _count: { _all: true },
  } as never)) as unknown as { projectId: string; status: string; _count: { _all: number } }[];
  for (const g of groups) {
    const c = counts.get(g.projectId);
    if (!c) continue;
    c.total += g._count._all;
    if (g.status === 'DONE') c.done += g._count._all;
  }
  return counts;
}

const toDto = (r: Row, counts: Counts): ProjectDto => ({
  id: r.id, name: r.name, description: r.description, status: r.status, priority: r.priority, customerId: r.customerId,
  customer: r.customer ? { id: r.customer.id, displayName: r.customer.displayName, archived: r.customer.archivedAt !== null } : null,
  ownerUserId: r.ownerUserId, startDate: dayOf(r.startDate), dueDate: dayOf(r.dueDate), completedAt: r.completedAt?.toISOString() ?? null,
  taskCounts: counts.get(r.id) ?? { total: 0, done: 0 }, version: r.version, createdById: r.createdById, updatedById: r.updatedById,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null,
});

async function load(db: AppTenantDb, viewer: Viewer, id: string): Promise<Row> {
  const row = (await db.project.findFirst({ where: { id }, select: selectFor(viewer) })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}
async function present(db: AppTenantDb, viewer: Viewer, id: string) {
  const row = await load(db, viewer, id);
  return toDto(row, await countsFor(db, [row.id]));
}

/**
 * A newly linked customer must be one this person may see, exist in this business and be active.
 * Existing links stay as they are when the customer is archived later (history is never orphaned).
 */
async function checkCustomer(db: AppTenantDb, viewer: Viewer, customerId: string) {
  if (!viewer.canReadCustomers) throw new ForbiddenError();
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
  if (!customer) throw new RecordNotFoundError();
  if (customer.archivedAt) throw new StateConflictError('archived_reference');
}

function checkDates(start: Date | null, due: Date | null) {
  if (start && due && due.getTime() < start.getTime()) throw new RuleViolationError('invalid_dates', 'The due date cannot be before the start date.');
}

export type ProjectInput = {
  name?: string; description?: string | null; status?: Status; priority?: Priority; customerId?: string | null; ownerUserId?: string | null;
  startDate?: string | null; dueDate?: string | null;
};

export async function createProject(db: AppTenantDb, viewer: Viewer, actorUserId: string, input: ProjectInput & { name: string }) {
  if (input.customerId) await checkCustomer(db, viewer, input.customerId);
  if (input.ownerUserId) await checkMember(db, input.ownerUserId, 'invalid_owner');
  const startDate = input.startDate ? dateOf(input.startDate) : null;
  const dueDate = input.dueDate ? dateOf(input.dueDate) : null;
  checkDates(startDate, dueDate);
  const status = input.status ?? 'PLANNED';
  const id = randomUUID();
  await db.project.create({
    data: {
      id, name: input.name, description: input.description ?? null, status, priority: input.priority ?? 'MEDIUM', customerId: input.customerId ?? null,
      ownerUserId: input.ownerUserId ?? null, startDate, dueDate, completedAt: status === 'COMPLETED' ? new Date() : null,
      createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  // Structured facts only: no name or description (they may hold customer details).
  await recordAudit(db, actorUserId, 'projects.project.created', { type: 'project', id }, {
    status, customerId: input.customerId ?? null, ownerUserId: input.ownerUserId ?? null,
  });
  return present(db, viewer, id);
}

export async function getProject(db: AppTenantDb, viewer: Viewer, id: string) {
  return present(db, viewer, id);
}

/** Edits details, status (completion time follows it), customer link and owner. Archived projects are read-only. */
export async function updateProject(db: AppTenantDb, viewer: Viewer, actorUserId: string, id: string, patch: ProjectInput & { version: number }) {
  const before = await load(db, viewer, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== patch.version) throw new StateConflictError('stale');

  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.priority !== undefined) data.priority = patch.priority;
  if (patch.startDate !== undefined) data.startDate = patch.startDate ? dateOf(patch.startDate) : null;
  if (patch.dueDate !== undefined) data.dueDate = patch.dueDate ? dateOf(patch.dueDate) : null;
  checkDates((data.startDate === undefined ? before.startDate : data.startDate) as Date | null, (data.dueDate === undefined ? before.dueDate : data.dueDate) as Date | null);
  if (patch.status !== undefined && patch.status !== before.status) {
    data.status = patch.status;
    data.completedAt = patch.status === 'COMPLETED' ? new Date() : null;
  }
  if (patch.ownerUserId !== undefined && patch.ownerUserId !== before.ownerUserId) {
    if (patch.ownerUserId) await checkMember(db, patch.ownerUserId, 'invalid_owner');
    data.ownerUserId = patch.ownerUserId;
  }
  if (patch.customerId !== undefined && patch.customerId !== before.customerId) {
    if (patch.customerId) await checkCustomer(db, viewer, patch.customerId);
    else if (!viewer.canReadCustomers) throw new ForbiddenError(); // unlinking is a customer decision too
    data.customerId = patch.customerId;
  }

  const { customer: _customer, ...comparable } = before;
  void _customer;
  const fields = changedFields(comparable as unknown as Record<string, unknown>, data).filter((f) => f !== 'completedAt');
  if (fields.length === 0) return toDto(before, await countsFor(db, [id]));
  const result = await db.project.updateMany({
    where: { id, archivedAt: null, version: patch.version },
    data: { ...data, ...BUMP, updatedById: actorUserId } as never,
  });
  if (result.count === 0) {
    const now = await load(db, viewer, id);
    throw new StateConflictError(now.archivedAt ? 'archived' : 'stale');
  }
  await recordAudit(db, actorUserId, 'projects.project.updated', { type: 'project', id }, { fields });
  if (fields.includes('status')) {
    await recordAudit(db, actorUserId, 'projects.project.status_changed', { type: 'project', id }, { from: before.status, to: patch.status! });
  }
  if (fields.includes('ownerUserId')) {
    await recordAudit(db, actorUserId, 'projects.project.assigned', { type: 'project', id }, { from: before.ownerUserId, to: (data.ownerUserId as string | null) ?? null });
  }
  return present(db, viewer, id);
}

/** Archiving hides the project and makes it (and its tasks) read-only. Tasks are kept untouched. */
export async function archiveProject(db: AppTenantDb, viewer: Viewer, actorUserId: string, id: string) {
  await load(db, viewer, id);
  const result = await db.project.updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date(), ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('archived');
  await recordAudit(db, actorUserId, 'projects.project.archived', { type: 'project', id });
  return present(db, viewer, id);
}

export async function restoreProject(db: AppTenantDb, viewer: Viewer, actorUserId: string, id: string) {
  await load(db, viewer, id);
  const result = await db.project.updateMany({ where: { id, archivedAt: { not: null } }, data: { archivedAt: null, ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('not_archived');
  await recordAudit(db, actorUserId, 'projects.project.restored', { type: 'project', id });
  return present(db, viewer, id);
}

export type ProjectQuery = {
  q?: string; status: Status | 'all'; archived: 'active' | 'archived' | 'all'; customerId?: string; ownerUserId?: string;
  sort: 'newest' | 'name' | 'due'; cursor?: string; limit: number;
};

/**
 * Keyset-paginated with an opaque cursor bound to this list and sort order. Every order ends with the
 * id, so it is total and stable: no row is skipped or repeated between pages.
 */
export async function listProjects(db: AppTenantDb, viewer: Viewer, query: ProjectQuery) {
  const where: Record<string, unknown>[] = [];
  if (query.status !== 'all') where.push({ status: query.status });
  if (query.archived === 'active') where.push({ archivedAt: null });
  if (query.archived === 'archived') where.push({ archivedAt: { not: null } });
  if (query.customerId) where.push({ customerId: query.customerId });
  if (query.ownerUserId) where.push({ ownerUserId: query.ownerUserId });
  const term = query.q?.trim();
  if (term) where.push({ name: { contains: term, mode: 'insensitive' } });

  const list = `projects:${query.sort}`;
  let orderBy: Record<string, unknown>[];
  let cursorOf: (r: Row) => Record<string, string>;
  if (query.sort === 'name') {
    const after = decodeCursor(query.cursor, list, ['n', 'i'] as const);
    if (after) {
      if (!UUID.test(after.i)) invalidCursor();
      where.push({ OR: [{ name: { gt: after.n } }, { name: after.n, id: { gt: after.i } }] });
    }
    orderBy = [{ name: 'asc' }, { id: 'asc' }];
    cursorOf = (r) => ({ n: r.name, i: r.id });
  } else if (query.sort === 'due') {
    // Soonest due first; projects without a due date come last.
    const after = decodeCursor(query.cursor, list, ['d', 'i'] as const);
    if (after) {
      if (!UUID.test(after.i) || (after.d !== 'none' && !DAY.test(after.d))) invalidCursor();
      if (after.d === 'none') where.push({ dueDate: null, id: { gt: after.i } });
      else {
        const d = dateOf(after.d);
        if (Number.isNaN(d.getTime())) invalidCursor();
        where.push({ OR: [{ dueDate: { gt: d } }, { dueDate: d, id: { gt: after.i } }, { dueDate: null }] });
      }
    }
    orderBy = [{ dueDate: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }];
    cursorOf = (r) => ({ d: dayOf(r.dueDate) ?? 'none', i: r.id });
  } else {
    const after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
    if (after) {
      const t = new Date(after.t);
      if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
      where.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
    }
    orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];
    cursorOf = (r) => ({ t: r.createdAt.toISOString(), i: r.id });
  }

  const rows = (await db.project.findMany({ where: { AND: where }, select: selectFor(viewer), orderBy, take: query.limit + 1 } as never)) as Row[];
  const page = rows.slice(0, query.limit);
  const counts = await countsFor(db, page.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    projects: page.map((r) => toDto(r, counts)),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, cursorOf(last)) : null,
  };
}

/** One customer's projects. The customer must exist in this business (archived customers keep their history). */
export async function listCustomerProjects(db: AppTenantDb, viewer: Viewer, customerId: string, query: ProjectQuery) {
  if (!viewer.canReadCustomers) throw new ForbiddenError();
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { id: true } });
  if (!customer) throw new RecordNotFoundError();
  return listProjects(db, viewer, { ...query, customerId });
}

/** Active (not archived) projects by status: real counts from one grouped query. */
export async function projectSummary(db: AppTenantDb): Promise<{ summary: ProjectSummary }> {
  const groups = (await db.project.groupBy({ by: ['status'], where: { archivedAt: null }, _count: { _all: true } } as never)) as unknown as {
    status: Status; _count: { _all: number };
  }[];
  const byStatus = { PLANNED: 0, ACTIVE: 0, ON_HOLD: 0, COMPLETED: 0, CANCELLED: 0 };
  for (const g of groups) byStatus[g.status] = g._count._all;
  return { summary: { active: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus } };
}

/** The viewer as the verified role allows: decided once per request from permission keys, never from assignments. */
export const viewerOf = (principal: Principal): Viewer => ({ canReadCustomers: can(principal, 'customers:read') });
