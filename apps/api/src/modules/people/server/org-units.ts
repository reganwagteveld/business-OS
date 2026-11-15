import 'server-only';
// Departments and workplace locations (docs/people-data-model.md §2.3). Both are archived (inactive),
// never deleted. Archiving is refused while anyone is currently in the unit; the row is locked
// FOR UPDATE first so an assignment racing the archive (which takes FOR SHARE) cannot slip past.
import { randomUUID } from 'node:crypto';
import type { Department as DepartmentDto, Location as LocationDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { BUMP, changedFields, UUID } from './shared';

type Kind = 'department' | 'location';
type Row = {
  id: string; name: string; description?: string | null; address?: string | null; version: number;
  createdAt: Date; updatedAt: Date; archivedAt: Date | null;
};

const select = {
  department: { id: true, name: true, description: true, version: true, createdAt: true, updatedAt: true, archivedAt: true },
  location: { id: true, name: true, address: true, version: true, createdAt: true, updatedAt: true, archivedAt: true },
} as const;

/** The delegate for one kind. Both have the same shape for the operations used here. */
const delegate = (db: AppTenantDb, kind: Kind) =>
  (kind === 'department' ? db.peopleDepartment : db.peopleLocation) as unknown as {
    findFirst(args: unknown): Promise<Row | null>;
    findMany(args: unknown): Promise<Row[]>;
    create(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };

const common = (r: Row) => ({
  id: r.id, name: r.name, version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt?.toISOString() ?? null,
});
export const toDepartment = (r: Row): DepartmentDto => ({ ...common(r), description: r.description ?? null });
export const toLocation = (r: Row): LocationDto => ({ ...common(r), address: r.address ?? null });

async function load(db: AppTenantDb, kind: Kind, id: string): Promise<Row> {
  const row = await delegate(db, kind).findFirst({ where: { id }, select: select[kind] });
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** Active names are unique per business ignoring case and surrounding spaces (index is the backstop). */
async function checkName(db: AppTenantDb, kind: Kind, name: string, exceptId?: string) {
  const clash = await delegate(db, kind).findFirst({
    where: { name: { equals: name.trim(), mode: 'insensitive' }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  if (clash) throw new StateConflictError('duplicate_name');
}

type Fields = { name?: string; description?: string | null; address?: string | null };
const fieldsOf = (kind: Kind, input: Fields) => {
  const data: Record<string, unknown> = {};
  if (input.name !== undefined) data.name = input.name;
  if (kind === 'department' && input.description !== undefined) data.description = input.description;
  if (kind === 'location' && input.address !== undefined) data.address = input.address;
  return data;
};

export async function createOrgUnit(db: AppTenantDb, kind: Kind, actorUserId: string, input: Fields & { name: string }) {
  await checkName(db, kind, input.name);
  const id = randomUUID();
  await delegate(db, kind).create({ data: { id, ...fieldsOf(kind, input), createdById: actorUserId, updatedById: actorUserId } });
  await recordAudit(db, actorUserId, `people.${kind}.created`, { type: `people_${kind}`, id });
  return load(db, kind, id);
}

export async function updateOrgUnit(db: AppTenantDb, kind: Kind, actorUserId: string, id: string, patch: Fields & { version: number }) {
  const before = await load(db, kind, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== patch.version) throw new StateConflictError('stale');
  const data = fieldsOf(kind, patch);
  const fields = changedFields(before as unknown as Record<string, unknown>, data);
  if (fields.length === 0) return before;
  if (fields.includes('name')) await checkName(db, kind, data.name as string, id);
  const result = await delegate(db, kind).updateMany({ where: { id, archivedAt: null, version: patch.version }, data: { ...data, ...BUMP, updatedById: actorUserId } });
  if (result.count === 0) throw new StateConflictError((await load(db, kind, id)).archivedAt ? 'archived' : 'stale');
  await recordAudit(db, actorUserId, `people.${kind}.updated`, { type: `people_${kind}`, id }, { fields });
  return load(db, kind, id);
}

export async function archiveOrgUnit(db: AppTenantDb, kind: Kind, actorUserId: string, id: string) {
  await load(db, kind, id);
  // Lock first (conflicts with the FOR SHARE every new assignment takes), then count current members.
  if (kind === 'department') {
    await db.$queryRaw`SELECT id FROM people_departments WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
    const inUse = await db.peopleDepartmentAssignment.count({ where: { departmentId: id, endsOn: null } });
    if (inUse > 0) throw new StateConflictError('in_use');
  } else {
    await db.$queryRaw`SELECT id FROM people_locations WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
    const inUse = await db.peopleEmployee.count({ where: { locationId: id } });
    if (inUse > 0) throw new StateConflictError('in_use');
  }
  const result = await delegate(db, kind).updateMany({ where: { id, archivedAt: null }, data: { archivedAt: new Date(), ...BUMP, updatedById: actorUserId } });
  if (result.count === 0) throw new StateConflictError('archived');
  await recordAudit(db, actorUserId, `people.${kind}.archived`, { type: `people_${kind}`, id });
  return load(db, kind, id);
}

export async function restoreOrgUnit(db: AppTenantDb, kind: Kind, actorUserId: string, id: string) {
  const before = await load(db, kind, id);
  if (!before.archivedAt) throw new StateConflictError('not_archived');
  await checkName(db, kind, before.name, id);
  const result = await delegate(db, kind).updateMany({ where: { id, archivedAt: { not: null } }, data: { archivedAt: null, ...BUMP, updatedById: actorUserId } });
  if (result.count === 0) throw new StateConflictError('not_archived');
  await recordAudit(db, actorUserId, `people.${kind}.restored`, { type: `people_${kind}`, id });
  return load(db, kind, id);
}

export type OrgUnitQuery = { q?: string; archived: 'active' | 'archived' | 'all'; cursor?: string; limit: number };

/** A to Z by name, then id; keyset-paginated with a cursor bound to this list. */
export async function listOrgUnits(db: AppTenantDb, kind: Kind, query: OrgUnitQuery) {
  const where: Record<string, unknown>[] = [];
  if (query.archived === 'active') where.push({ archivedAt: null });
  if (query.archived === 'archived') where.push({ archivedAt: { not: null } });
  const term = query.q?.trim();
  if (term) where.push({ name: { contains: term, mode: 'insensitive' } });
  const list = `people:${kind}s`;
  const after = decodeCursor(query.cursor, list, ['n', 'i'] as const);
  if (after) {
    if (!UUID.test(after.i)) invalidCursor();
    where.push({ OR: [{ name: { gt: after.n } }, { name: after.n, id: { gt: after.i } }] });
  }
  const rows = await delegate(db, kind).findMany({ where: { AND: where }, select: select[kind], orderBy: [{ name: 'asc' }, { id: 'asc' }], take: query.limit + 1 });
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > query.limit && last ? encodeCursor(list, { n: last.name, i: last.id }) : null };
}
