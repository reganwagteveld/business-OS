import 'server-only';
// Contacts (data-model §4.6): optionally linked to one customer of the same business.
import { randomUUID } from 'node:crypto';
import type { Contact as ContactDto } from '@business-os/contracts';
import { recordSystemActivity } from '@/modules/activity';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { afterName, changedFields, page, searchFilter, statusFilter, type Status } from './shared';

type Row = Omit<ContactDto, 'createdAt' | 'updatedAt' | 'archivedAt'> & { createdAt: Date; updatedAt: Date; archivedAt: Date | null };
const select = {
  id: true, customerId: true, firstName: true, lastName: true, displayName: true, email: true, phone: true, mobile: true,
  jobTitle: true, notes: true, createdById: true, updatedById: true, createdAt: true, updatedAt: true, archivedAt: true,
} as const;
const toDto = (r: Row): ContactDto => ({
  ...r, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null,
});

type Input = {
  firstName?: string | null; lastName?: string | null; displayName?: string | null; email?: string | null;
  phone?: string | null; mobile?: string | null; jobTitle?: string | null; notes?: string | null; customerId?: string | null;
};

async function load(db: AppTenantDb, id: string): Promise<Row> {
  const row = (await db.contact.findFirst({ where: { id }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/** A contact may only be linked to an existing, active customer of this business. */
async function checkCustomer(db: AppTenantDb, customerId: string | null | undefined) {
  if (!customerId) return;
  const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
  if (!customer) throw new RecordNotFoundError();
  if (customer.archivedAt) throw new StateConflictError('archived_reference');
}

type NameParts = { firstName?: string | null; lastName?: string | null; email?: string | null };

/** The name a contact gets when nobody chose one: "Ada Lovelace", else the email, else nothing. */
function derivedName(p: NameParts): string | null {
  const joined = [p.firstName, p.lastName].filter(Boolean).join(' ').trim();
  return joined || p.email || null;
}

/**
 * The display name after a create or update. A name the person typed is kept until they change or
 * clear it; a derived name (from first/last name or the email fallback) follows the fields it came
 * from, so changing the email of an email-named contact renames it instead of leaving a stale name.
 */
function nameFor(input: Input, before?: Row): string | null {
  if (input.displayName) return input.displayName;
  const after: NameParts = {
    firstName: input.firstName !== undefined ? input.firstName : before?.firstName,
    lastName: input.lastName !== undefined ? input.lastName : before?.lastName,
    email: input.email !== undefined ? input.email : before?.email,
  };
  const custom = before && input.displayName === undefined && before.displayName !== derivedName(before);
  return custom ? before.displayName : derivedName(after);
}

/** If this contact is its customer's primary contact, clear that first (the FK would reject leaving it). */
async function releasePrimary(db: AppTenantDb, actorUserId: string, contact: Row) {
  if (!contact.customerId) return;
  const cleared = await db.customer.updateMany({ where: { id: contact.customerId, primaryContactId: contact.id }, data: { primaryContactId: null, updatedById: actorUserId } as never });
  if (cleared.count > 0) {
    await recordSystemActivity(db, actorUserId, 'customer.primary_contact_changed', { customerId: contact.customerId, contactId: null }, { previousContactId: contact.id });
  }
}

export async function listContacts(db: AppTenantDb, query: { q?: string; status: Status; customerId?: string; cursor?: string; limit: number }) {
  const rows = (await db.contact.findMany({
    where: {
      AND: [
        statusFilter(query.status),
        query.customerId ? { customerId: query.customerId } : {},
        searchFilter(query.q, ['displayName', 'email', 'phone', 'mobile']),
        afterName('contacts', query.cursor),
      ],
    },
    select,
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: query.limit + 1,
  })) as Row[];
  const { items, nextCursor } = page('contacts', rows, query.limit);
  return { contacts: items.map(toDto), nextCursor };
}

export async function getContact(db: AppTenantDb, id: string) {
  return toDto(await load(db, id));
}

export async function createContact(db: AppTenantDb, actorUserId: string, input: Input) {
  await checkCustomer(db, input.customerId);
  const displayName = nameFor(input);
  if (!displayName) throw new RuleViolationError('name_required', 'Enter a name or an email address.');
  const id = randomUUID();
  const row = (await db.contact.create({
    data: { ...input, displayName, id, createdById: actorUserId, updatedById: actorUserId } as never,
    select,
  })) as Row;
  await recordSystemActivity(db, actorUserId, 'contact.created', { contactId: id, customerId: input.customerId ?? null });
  await recordAudit(db, actorUserId, 'contact.created', { type: 'contact', id });
  return toDto(row);
}

/**
 * Updates details and/or the customer link. Moving or unlinking a contact keeps earlier activities
 * on the old customer (history is not rewritten) and writes system activities on both sides.
 */
export async function updateContact(db: AppTenantDb, actorUserId: string, id: string, patch: Input) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  const moving = patch.customerId !== undefined && patch.customerId !== before.customerId;
  if (moving) {
    await checkCustomer(db, patch.customerId);
    await releasePrimary(db, actorUserId, before);
  }
  const displayName = nameFor(patch, before);
  if (!displayName) throw new RuleViolationError('name_required', 'Enter a name or an email address.');
  const data: Record<string, unknown> = { ...patch, displayName, updatedById: actorUserId };
  const fields = changedFields(before, data).filter((f) => f !== 'updatedById');
  if (fields.length === 0) return toDto(before);
  const row = (await db.contact.update({ where: { id }, data: data as never, select })) as Row;

  if (moving) {
    const from = before.customerId;
    const to = patch.customerId ?? null;
    if (from) await recordSystemActivity(db, actorUserId, to ? 'contact.customer_changed' : 'contact.customer_removed', { customerId: from, contactId: id }, { from, to });
    if (to) await recordSystemActivity(db, actorUserId, 'contact.customer_changed', { customerId: to, contactId: id }, { from, to });
  }
  const other = fields.filter((f) => f !== 'customerId');
  if (other.length > 0) await recordSystemActivity(db, actorUserId, 'contact.updated', { contactId: id, customerId: row.customerId }, { fields: other });
  await recordAudit(db, actorUserId, 'contact.updated', { type: 'contact', id }, { fields });
  return toDto(row);
}

/** Reversible. A primary contact stops being primary in the same transaction. */
export async function archiveContact(db: AppTenantDb, actorUserId: string, id: string) {
  const before = await load(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  await releasePrimary(db, actorUserId, before);
  const row = (await db.contact.update({ where: { id }, data: { archivedAt: new Date(), updatedById: actorUserId } as never, select })) as Row;
  await recordSystemActivity(db, actorUserId, 'contact.archived', { contactId: id, customerId: before.customerId });
  await recordAudit(db, actorUserId, 'contact.archived', { type: 'contact', id });
  return toDto(row);
}

export async function restoreContact(db: AppTenantDb, actorUserId: string, id: string) {
  const before = await load(db, id);
  if (!before.archivedAt) throw new StateConflictError('not_archived');
  const row = (await db.contact.update({ where: { id }, data: { archivedAt: null, updatedById: actorUserId } as never, select })) as Row;
  await recordSystemActivity(db, actorUserId, 'contact.restored', { contactId: id, customerId: before.customerId });
  await recordAudit(db, actorUserId, 'contact.restored', { type: 'contact', id });
  return toDto(row);
}
