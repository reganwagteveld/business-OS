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
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
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
/** Changes need a project that is not archived. */
async function writableProject(db: AppTenantDb, projectId: string) {
  const project = await projectOf(db, projectId);
  if (project.archivedAt) throw new StateConflictError('project_archived');
  return project;
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
