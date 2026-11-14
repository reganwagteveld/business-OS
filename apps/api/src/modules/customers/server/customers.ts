import 'server-only';
// Customers (data-model §4.5). Runs inside a tenant unit of work: the scoped client adds the
// business id, RLS enforces it again and composite foreign keys keep every link inside the business.
import { randomUUID } from 'node:crypto';
import type { Customer as CustomerDto } from '@business-os/contracts';
import { recordSystemActivity } from '@/modules/activity';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { afterName, changedFields, page, searchFilter, statusFilter, type Status } from './shared';

type Row = Omit<CustomerDto, 'createdAt' | 'updatedAt' | 'archivedAt'> & { createdAt: Date; updatedAt: Date; archivedAt: Date | null };
const select = {
  id: true, kind: true, displayName: true, legalName: true, email: true, phone: true, website: true, taxNumber: true,
  taxNumberType: true, addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true, countryCode: true,
  notes: true, ownerUserId: true, primaryContactId: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;
const toDto = (r: Row): CustomerDto => ({
  ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null,
});

type Input = Record<string, unknown> & { ownerUserId?: string | null; primaryContactId?: string | null };

async function load(db: AppTenantDb, id: string): Promise<Row> {
  const row = (await db.customer.findFirst({ where: { id }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** The owner must be an active member of this business (the composite FK guarantees membership; this also checks status). */
async function checkOwner(db: AppTenantDb, ownerUserId: string | null | undefined) {
  if (!ownerUserId) return;
  const member = await db.membership.findFirst({ where: { userId: ownerUserId, status: 'ACTIVE' }, select: { id: true } });
  if (!member) throw new RuleViolationError('invalid_owner', 'The owner must be a member of this business.');
}

export async function listCustomers(db: AppTenantDb, query: { q?: string; status: Status; cursor?: string; limit: number }) {
  const rows = (await db.customer.findMany({
    where: { AND: [statusFilter(query.status), searchFilter(query.q, ['displayName', 'legalName', 'email', 'phone']), afterName('customers', query.cursor)] },
    select,
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
  })) as Row[];
  const { items, nextCursor } = page('customers', rows, query.limit);
  return { customers: items.map(toDto), nextCursor };
}

/** Counts for the Zone home. The scoped client and RLS limit every count to the current business. */
export async function customerSummary(db: AppTenantDb) {
  // One after another: they share the unit of work's single connection.
  const active = await db.customer.count({ where: { archivedAt: null } });
  const archived = await db.customer.count({ where: { archivedAt: { not: null } } });
  const contacts = await db.contact.count({ where: { archivedAt: null } });
  return { customers: { active, archived }, contacts: { active: contacts } };
}

export async function getCustomer(db: AppTenantDb, id: string) {
  return toDto(await load(db, id));
}

export async function createCustomer(db: AppTenantDb, actorUserId: string, input: Input) {
  await checkOwner(db, input.ownerUserId);
  const id = randomUUID();
  const row = (await db.customer.create({
    data: { ...input, id, createdById: actorUserId, updatedById: actorUserId } as never,
    select,
  })) as Row;
  await recordSystemActivity(db, actorUserId, 'customer.created', { customerId: id });
  await recordAudit(db, actorUserId, 'customer.created', { type: 'customer', id });
  return toDto(row);
}

export async function updateCustomer(db: AppTenantDb, actorUserId: string, id: string, patch: Input) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (patch.ownerUserId !== undefined) await checkOwner(db, patch.ownerUserId);
  if (patch.primaryContactId) {
    // Friendly check first; the three-column FK enforces the same rule at commit.
    const contact = await db.contact.findFirst({ where: { id: patch.primaryContactId }, select: { customerId: true, archivedAt: true } });
    if (!contact || contact.customerId !== id) throw new RuleViolationError('invalid_primary_contact', "The primary contact must be one of this customer's contacts.");
    if (contact.archivedAt) throw new StateConflictError('archived_reference');
  }
  const fields = changedFields(before, patch);
  if (fields.length === 0) return toDto(before);
  const row = (await db.customer.update({ where: { id }, data: { ...patch, updatedById: actorUserId } as never, select })) as Row;
  if (fields.includes('primaryContactId')) {
    await recordSystemActivity(db, actorUserId, 'customer.primary_contact_changed', { customerId: id, contactId: patch.primaryContactId ?? null });
  }
  const other = fields.filter((f) => f !== 'primaryContactId');
  if (other.length > 0) await recordSystemActivity(db, actorUserId, 'customer.updated', { customerId: id }, { fields: other });
  await recordAudit(db, actorUserId, 'customer.updated', { type: 'customer', id }, { fields });
  return toDto(row);
}

/** Reversible. Contacts are not archived automatically (data-model §4.6). */
export async function archiveCustomer(db: AppTenantDb, actorUserId: string, id: string) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  const row = (await db.customer.update({ where: { id }, data: { archivedAt: new Date(), updatedById: actorUserId } as never, select })) as Row;
  await recordSystemActivity(db, actorUserId, 'customer.archived', { customerId: id });
  await recordAudit(db, actorUserId, 'customer.archived', { type: 'customer', id });
  return toDto(row);
}

export async function restoreCustomer(db: AppTenantDb, actorUserId: string, id: string) {
  const before = await load(db, id);
  if (!before.archivedAt) throw new StateConflictError('not_archived');
  const row = (await db.customer.update({ where: { id }, data: { archivedAt: null, updatedById: actorUserId } as never, select })) as Row;
  await recordSystemActivity(db, actorUserId, 'customer.restored', { customerId: id });
  await recordAudit(db, actorUserId, 'customer.restored', { type: 'customer', id });
  return toDto(row);
}
