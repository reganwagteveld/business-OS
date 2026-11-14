import 'server-only';
// Project tasks (docs/projects-data-model.md §3–4). A task is always reached through its project: the
// route's project id must be the task's own, and the composite FK (business_id, project_id) makes a
// task in another business's project impossible. Tasks are archived, never deleted. An archived
// project is read-only, so none of its tasks can be added, changed, archived or restored.
import { randomUUID } from 'node:crypto';
import type { ProjectTask as TaskDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { BUMP, changedFields, checkMember, dateOf, dayOf, UUID } from './shared';

type Status = 'TODO' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE';
type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
type Row = {
  id: string; projectId: string; title: string; description: string | null; status: Status; priority: Priority; assigneeUserId: string | null;
  dueDate: Date | null; position: number; completedAt: Date | null; version: number; createdById: string | null; updatedById: string | null;
  createdAt: Date; updatedAt: Date; archivedAt: Date | null;
};
const select = {
  id: true, projectId: true, title: true, description: true, status: true, priority: true, assigneeUserId: true, dueDate: true, position: true,
  completedAt: true, version: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;

/** Spaced positions, so a later reorder can place a task between two others without renumbering. */
const STEP = 1000;

const toDto = (r: Row): TaskDto => ({
  ...r, dueDate: dayOf(r.dueDate), completedAt: r.completedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null,
});

/** The parent project in this business, or 404 (another business's project is indistinguishable from none). */
async function projectOf(db: AppTenantDb, projectId: string) {
  const project = await db.project.findFirst({ where: { id: projectId }, select: { id: true, archivedAt: true } });
  if (!project) throw new RecordNotFoundError();
  return project;
}
/**
 * Changes need a project that is not archived, and it must stay that way until this unit of work
 * commits. A plain read is not enough under READ COMMITTED: an archive could commit between the check
 * and the task write. So the project row is read with FOR SHARE:
 * - an archive already in flight (its UPDATE holds the row) makes this wait, and once it commits the
 *   locking read sees the archived row, so the task change is refused (409 project_archived);
 * - an archive that starts after this lock waits until the task change has committed.
 * Either way a task change never commits after its project was archived. Tagged $queryRaw is part of
 * the tenant client: it runs in the same transaction, as bos_app, under forced RLS; the explicit
 * business_id predicate repeats the tenant scope for defence in depth.
 */
async function writableProject(db: AppTenantDb, projectId: string) {
  const rows = await db.$queryRaw<{ archived: boolean }[]>`
    SELECT archived_at IS NOT NULL AS archived FROM projects
    WHERE id = ${projectId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    FOR SHARE`;
  const row = rows[0];
  if (!row) throw new RecordNotFoundError();
  if (row.archived) throw new StateConflictError('project_archived');
}
/**
 * Serialises changes to one project's task order (board moves and creates) for the rest of this
 * transaction. A transaction-level advisory lock keyed on the project id: moves in different
 * projects never wait for each other, and it is released at commit or rollback. It is taken after
 * writableProject's FOR SHARE, always in that order, so the archive guarantee is unchanged and two
 * moves cannot deadlock on the pair. Other tenants can only ever share a key by hash collision,
 * which costs a short wait, never data.
 */
async function lockOrder(db: AppTenantDb, projectId: string) {
  await db.$queryRaw<{ locked: number }[]>`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended('project_tasks.order:' || ${projectId}::text, 0))) AS l`;
}

async function load(db: AppTenantDb, projectId: string, id: string): Promise<Row> {
  const row = (await db.projectTask.findFirst({ where: { id, projectId }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export type TaskInput = {
  title?: string; description?: string | null; status?: Status; priority?: Priority; assigneeUserId?: string | null; dueDate?: string | null;
};

export async function createTask(db: AppTenantDb, actorUserId: string, projectId: string, input: TaskInput & { title: string }) {
  await writableProject(db, projectId);
  if (input.assigneeUserId) await checkMember(db, input.assigneeUserId, 'invalid_assignee');
  await lockOrder(db, projectId);
  const last = await db.projectTask.aggregate({ where: { projectId }, _max: { position: true } } as never) as unknown as { _max: { position: number | null } };
  const status = input.status ?? 'TODO';
  const id = randomUUID();
  const row = (await db.projectTask.create({
    data: {
      id, projectId, title: input.title, description: input.description ?? null, status, priority: input.priority ?? 'MEDIUM',
      assigneeUserId: input.assigneeUserId ?? null, dueDate: input.dueDate ? dateOf(input.dueDate) : null,
      position: (last._max.position ?? 0) + STEP, completedAt: status === 'DONE' ? new Date() : null, createdById: actorUserId, updatedById: actorUserId,
    } as never,
    select,
  })) as Row;
  await recordAudit(db, actorUserId, 'projects.task.created', { type: 'project_task', id }, { projectId, status, assigneeUserId: row.assigneeUserId });
  return toDto(row);
}

/**
 * Edits details, assignment, priority and status. Moving into DONE stamps the completion time;
 * moving out of DONE clears it; staying in DONE keeps the original time.
 */
export async function updateTask(db: AppTenantDb, actorUserId: string, projectId: string, id: string, patch: TaskInput & { version: number }) {
  const before = await load(db, projectId, id);
  await writableProject(db, projectId);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== patch.version) throw new StateConflictError('stale');

  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.priority !== undefined) data.priority = patch.priority;
  if (patch.dueDate !== undefined) data.dueDate = patch.dueDate ? dateOf(patch.dueDate) : null;
  if (patch.status !== undefined && patch.status !== before.status) {
    data.status = patch.status;
    data.completedAt = patch.status === 'DONE' ? new Date() : null;
  }
  if (patch.assigneeUserId !== undefined && patch.assigneeUserId !== before.assigneeUserId) {
    if (patch.assigneeUserId) await checkMember(db, patch.assigneeUserId, 'invalid_assignee');
    data.assigneeUserId = patch.assigneeUserId;
  }
  const fields = changedFields(before as unknown as Record<string, unknown>, data).filter((f) => f !== 'completedAt');
  if (fields.length === 0) return toDto(before);
  const result = await db.projectTask.updateMany({ where: { id, projectId, archivedAt: null, version: patch.version }, data: { ...data, ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) {
    const now = await load(db, projectId, id);
    throw new StateConflictError(now.archivedAt ? 'archived' : 'stale');
  }
  await recordAudit(db, actorUserId, 'projects.task.updated', { type: 'project_task', id }, { projectId, fields });
  if (fields.includes('status')) {
    await recordAudit(db, actorUserId, 'projects.task.status_changed', { type: 'project_task', id }, { projectId, from: before.status, to: patch.status! });
  }
  if (fields.includes('assigneeUserId')) {
    await recordAudit(db, actorUserId, 'projects.task.assigned', { type: 'project_task', id }, { projectId, from: before.assigneeUserId, to: (data.assigneeUserId as string | null) ?? null });
  }
  return toDto(await load(db, projectId, id));
}

/** Highest position the board writes before renumbering (int4 is 2,147,483,647). */
const MAX_POSITION = 2_000_000_000;

/**
 * Board move (docs/projects-data-model.md §4, "Ordering"). In one tenant transaction:
 * 1. the task is loaded and its version checked (stale → 409 stale);
 * 2. the project is read FOR SHARE (archived → 409 project_archived; an archive in flight waits);
 * 3. the project's order lock is taken, so concurrent moves in this project run one at a time and
 *    each one sees the order the previous one committed;
 * 4. the anchor must be an active task of this project (else 409 order_changed: the client's view
 *    is out of date). It may have any status: positions are ONE order over the whole project and a
 *    board column is just the tasks of its statuses in that order. So "directly after the anchor in
 *    the project's order" is "directly after it" in every column that shows both, whichever
 *    statuses a board puts in a column, and "no anchor" (first in the project) is first in any column;
 * 5. the task gets a position strictly between the anchor and the task after it. If there is no
 *    integer gap left, the project's tasks are renumbered (1000, 2000, …) in their current order first. Renumbering changes no task's version: position is not part of an edit,
 *    so it never makes someone else's pending edit stale.
 * The write is conditional on the version and on the task being active, like every other edit.
 */
export async function moveTask(db: AppTenantDb, actorUserId: string, projectId: string, id: string, move: { version: number; status: Status; afterTaskId: string | null }) {
  if (move.afterTaskId === id) throw new RuleViolationError('invalid_anchor', 'A task cannot be placed after itself.');
  const before = await load(db, projectId, id);
  await writableProject(db, projectId);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== move.version) throw new StateConflictError('stale');
  await lockOrder(db, projectId);

  const place = async () => {
    // Every other task of the project in the stored order, archived ones included, so positions stay
    // distinct and a restored task comes back where it was.
    const all = (await db.projectTask.findMany({
      where: { projectId, id: { not: id } },
      select: { id: true, position: true, archivedAt: true },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
    })) as { id: string; position: number; archivedAt: Date | null }[];
    const active = all.filter((t) => t.archivedAt === null);
    let at = 0;
    if (move.afterTaskId) {
      at = all.findIndex((t) => t.id === move.afterTaskId && t.archivedAt === null) + 1;
      if (at === 0) throw new StateConflictError('order_changed');
    }
    // Already exactly there (same status, and directly after the anchor among active tasks): no change.
    const mine = { id: before.id, position: before.position };
    const after = (a: { id: string; position: number }, b: { id: string; position: number }) => a.position > b.position || (a.position === b.position && a.id > b.id);
    const prevActive = move.afterTaskId ? active.find((t) => t.id === move.afterTaskId) : undefined;
    const nextActive = move.afterTaskId ? active[active.findIndex((t) => t.id === move.afterTaskId) + 1] : active[0];
    if (before.status === move.status && (!prevActive || after(mine, prevActive)) && (!nextActive || after(nextActive, mine))) return { position: before.position, noop: true };
    const prev = all[at - 1];
    const next = all[at];
    if (!prev && !next) return { position: before.position, noop: false };
    if (!prev) return next!.position >= 1 ? { position: next!.position - STEP >= 0 ? next!.position - STEP : Math.floor(next!.position / 2), noop: false } : null;
    if (!next) return prev.position + STEP <= MAX_POSITION ? { position: prev.position + STEP, noop: false } : null;
    return next.position - prev.position >= 2 ? { position: prev.position + Math.floor((next.position - prev.position) / 2), noop: false } : null;
  };

  let target = await place();
  let renumbered = false;
  if (target === null) {
    await renumber(db, projectId);
    renumbered = true;
    target = await place();
    if (target === null) throw new Error('No position available after renumbering');
  }
  if (target.noop) return toDto(before);

  const data: Record<string, unknown> = { position: target.position };
  if (move.status !== before.status) {
    data.status = move.status;
    data.completedAt = move.status === 'DONE' ? new Date() : null;
  }
  const result = await db.projectTask.updateMany({ where: { id, projectId, archivedAt: null, version: move.version }, data: { ...data, ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) {
    const now = await load(db, projectId, id);
    throw new StateConflictError(now.archivedAt ? 'archived' : 'stale');
  }
  await recordAudit(db, actorUserId, 'projects.task.moved', { type: 'project_task', id }, { projectId, from: before.status, to: move.status, ...(renumbered ? { order: 'renumbered' } : {}) });
  if (move.status !== before.status) {
    await recordAudit(db, actorUserId, 'projects.task.status_changed', { type: 'project_task', id }, { projectId, from: before.status, to: move.status });
  }
  return toDto(await load(db, projectId, id));
}

/**
 * Spreads the project's positions out again (1000, 2000, …) in their current order, archived tasks
 * included so a restored task comes back where it was. Runs only under the order lock. Tagged
 * $queryRaw on the tenant client: bos_app, forced RLS, plus the explicit business_id predicate.
 */
async function renumber(db: AppTenantDb, projectId: string) {
  await db.$queryRaw<{ id: string }[]>`
    UPDATE project_tasks AS t SET position = (r.n * ${STEP})::int
    FROM (
      SELECT id, row_number() OVER (ORDER BY position, id) AS n FROM project_tasks
      WHERE project_id = ${projectId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ) AS r
    WHERE t.id = r.id AND t.business_id = nullif(current_setting('app.business_id', true), '')::uuid
    RETURNING t.id`;
}

/** "Removing" a task archives it: it leaves the list and the progress count, and can be restored. */
export async function archiveTask(db: AppTenantDb, actorUserId: string, projectId: string, id: string) {
  await load(db, projectId, id);
  await writableProject(db, projectId);
  const result = await db.projectTask.updateMany({ where: { id, projectId, archivedAt: null }, data: { archivedAt: new Date(), ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('archived');
  await recordAudit(db, actorUserId, 'projects.task.archived', { type: 'project_task', id }, { projectId });
  return toDto(await load(db, projectId, id));
}

export async function restoreTask(db: AppTenantDb, actorUserId: string, projectId: string, id: string) {
  await load(db, projectId, id);
  await writableProject(db, projectId);
  const result = await db.projectTask.updateMany({ where: { id, projectId, archivedAt: { not: null } }, data: { archivedAt: null, ...BUMP, updatedById: actorUserId } as never });
  if (result.count === 0) throw new StateConflictError('not_archived');
  await recordAudit(db, actorUserId, 'projects.task.restored', { type: 'project_task', id }, { projectId });
  return toDto(await load(db, projectId, id));
}

export type TaskQuery = { status: Status | 'all'; archived: 'active' | 'archived' | 'all'; cursor?: string; limit: number };

/** In the project's order (position, then id), keyset-paginated. Archived projects stay readable. */
export async function listTasks(db: AppTenantDb, projectId: string, query: TaskQuery) {
  await projectOf(db, projectId);
  const after = decodeCursor(query.cursor, `tasks:${projectId}`, ['p', 'i'] as const);
  const where: Record<string, unknown>[] = [{ projectId }];
  if (query.status !== 'all') where.push({ status: query.status });
  if (query.archived === 'active') where.push({ archivedAt: null });
  if (query.archived === 'archived') where.push({ archivedAt: { not: null } });
  if (after) {
    const p = Number(after.p);
    if (!Number.isSafeInteger(p) || p < 0 || !UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ position: { gt: p } }, { position: p, id: { gt: after.i } }] });
  }
  const rows = (await db.projectTask.findMany({ where: { AND: where }, select, orderBy: [{ position: 'asc' }, { id: 'asc' }], take: query.limit + 1 })) as Row[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    tasks: page.map(toDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor(`tasks:${projectId}`, { p: String(last.position), i: last.id }) : null,
  };
}
