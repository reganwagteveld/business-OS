import 'server-only';
// Conversations and historical messages (docs/communications-c1.md §2–3). A message here is a
// record of something exchanged OUTSIDE Business OS, entered by a person (MANUAL) or imported from
// an export with its external id (IMPORT). Nothing is sent, there is no provider, and messages are
// read-only once recorded (no UPDATE/DELETE grant, trigger CM002).
//
// Every recorded message writes its one timeline entry through the activity module's public API,
// in the same unit of work, so the message, its participants, the timeline entry, the
// conversation's last_message_at and the audit event commit or roll back together.
import { createHash, randomUUID } from 'node:crypto';
import type { Conversation as ConversationDto, Message as MessageDto } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { recordAudit } from '@/core/audit';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { recordMessageActivity, resolveSubject } from '@/modules/activity';
import { erasedExternalIds } from './erasure';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A historical message may carry a timestamp slightly ahead (clock skew), never later (CM004 agrees). */
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000;
const ROLE_ORDER = { FROM: 0, TO: 1, CC: 2, BCC: 3 } as const;

type Channel = ConversationDto['channel'];
type Direction = MessageDto['direction'];
type Role = keyof typeof ROLE_ORDER;

export interface ParticipantInput { role: Role; displayName?: string | null; address?: string | null; contactId?: string; userId?: string }
export interface MessageInput {
  direction: Direction; occurredAt: string; subject?: string | null; body?: string | null; participants: ParticipantInput[];
}
export interface ImportInput extends MessageInput { external: { source: string; messageId: string } }

// ---- conversations ---------------------------------------------------------------------------------

type ConversationRow = {
  id: string; channel: string; subject: string | null; customerId: string | null; contactId: string | null; source: string;
  createdById: string; lastMessageAt: Date | null; createdAt: Date; erasedAt: Date | null;
};
const conversationSelect = {
  id: true, channel: true, subject: true, customerId: true, contactId: true, source: true, createdById: true, lastMessageAt: true, createdAt: true, erasedAt: true,
} as const;

function toConversation(r: ConversationRow): ConversationDto {
  return {
    id: r.id, channel: r.channel as Channel, subject: r.subject, customerId: r.customerId, contactId: r.contactId,
    source: r.source === 'IMPORT' ? 'IMPORT' : 'MANUAL', createdById: r.createdById,
    lastMessageAt: r.lastMessageAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), erasedAt: r.erasedAt?.toISOString() ?? null,
  };
}

/** A conversation is filed under a customer and/or contact by the same rules as an activity (resolveSubject). */
export async function createConversation(
  db: AppTenantDb,
  actorUserId: string,
  input: { channel: Channel; subject?: string | null; customerId?: string; contactId?: string },
): Promise<ConversationDto> {
  const { customerId, contactId } = await resolveSubject(db, input);
  const row = (await db.conversation.create({
    data: { id: randomUUID(), channel: input.channel, subject: input.subject ?? null, customerId, contactId, source: 'MANUAL', createdById: actorUserId } as never,
    select: conversationSelect,
  })) as ConversationRow;
  await recordAudit(db, actorUserId, 'conversation.created', { type: 'conversation', id: row.id }, { channel: input.channel, customerId, contactId });
  return toConversation(row);
}

async function conversationRow(db: AppTenantDb, id: string): Promise<ConversationRow> {
  const row = (await db.conversation.findFirst({ where: { id }, select: conversationSelect })) as ConversationRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export async function getConversation(db: AppTenantDb, id: string): Promise<ConversationDto> {
  return toConversation(await conversationRow(db, id));
}

/** Newest conversation first by creation (then id): a stable order, so keyset pages never shift. */
export async function listConversations(
  db: AppTenantDb,
  query: { customerId?: string; contactId?: string; cursor?: string; limit: number },
): Promise<{ conversations: ConversationDto[]; nextCursor: string | null }> {
  const after = decodeCursor(query.cursor, 'conversations', ['t', 'i'] as const);
  const and: Record<string, unknown>[] = [];
  if (query.customerId) and.push({ customerId: query.customerId });
  if (query.contactId) and.push({ contactId: query.contactId });
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    and.push({ OR: [{ createdAt: { lt: t } }, { createdAt: t, id: { lt: after.i } }] });
  }
  const rows = (await db.conversation.findMany({
    where: { AND: and }, select: conversationSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as ConversationRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    conversations: page.map(toConversation),
    nextCursor: rows.length > query.limit && last ? encodeCursor('conversations', { t: last.createdAt.toISOString(), i: last.id }) : null,
  };
}

// ---- messages ------------------------------------------------------------------------------------------

type ParticipantRow = { role: string; position: number; displayName: string | null; address: string | null; contactId: string | null; userId: string | null };
type MessageRow = {
  id: string; conversationId: string; direction: string; source: string; occurredAt: Date; recordedAt: Date; recordedById: string;
  subject: string | null; body: string | null; externalSource: string | null; externalMessageId: string | null; contentHash: string;
  erasedAt: Date | null; participants: ParticipantRow[];
};
const messageSelect = {
  id: true, conversationId: true, direction: true, source: true, occurredAt: true, recordedAt: true, recordedById: true, subject: true, body: true,
  externalSource: true, externalMessageId: true, contentHash: true, erasedAt: true,
  participants: { select: { role: true, position: true, displayName: true, address: true, contactId: true, userId: true } },
} as const;

function toMessage(r: MessageRow): MessageDto {
  const participants = [...r.participants].sort((a, b) => ROLE_ORDER[a.role as Role] - ROLE_ORDER[b.role as Role] || a.position - b.position);
  return {
    id: r.id, conversationId: r.conversationId, direction: r.direction as Direction, source: r.source === 'IMPORT' ? 'IMPORT' : 'MANUAL',
    occurredAt: r.occurredAt.toISOString(), recordedAt: r.recordedAt.toISOString(), recordedById: r.recordedById,
    subject: r.subject, body: r.body, externalSource: r.externalSource, externalMessageId: r.externalMessageId,
    participants: participants.map((p) => ({ role: p.role as Role, position: p.position, displayName: p.displayName, address: p.address, contactId: p.contactId, userId: p.userId })),
    erasedAt: r.erasedAt?.toISOString() ?? null,
  };
}

/** Participants in a stable order with per-role positions. */
function normaliseParticipants(list: ParticipantInput[]) {
  const counters: Record<Role, number> = { FROM: 0, TO: 0, CC: 0, BCC: 0 };
  return [...list]
    .map((p, i) => ({ p, i }))
    .sort((a, b) => ROLE_ORDER[a.p.role] - ROLE_ORDER[b.p.role] || a.i - b.i)
    .map(({ p }) => ({
      role: p.role, position: counters[p.role]++, displayName: p.displayName ?? null, address: p.address ?? null,
      contactId: p.contactId ?? null, userId: p.userId ?? null,
    }));
}

/** SHA-256 of the canonical message: what "the same message" means for an idempotent re-import. */
function contentHash(input: MessageInput, occurredAt: Date, participants: ReturnType<typeof normaliseParticipants>): string {
  const canonical = JSON.stringify([input.direction, occurredAt.toISOString(), input.subject ?? null, input.body ?? null,
    participants.map((p) => [p.role, p.position, p.displayName, p.address, p.contactId, p.userId])]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The customer/contact the timeline entry is filed under, by the activity rule (data-model §4.7):
 * with a contact, the contact's customer at the time of recording (so a contact who moved takes new
 * entries to the new customer, while earlier entries and the conversation record keep the old one);
 * without one, the conversation's customer. Archived customers and contacts take no new messages.
 */
async function timelineLink(db: AppTenantDb, conversation: ConversationRow): Promise<{ customerId: string | null; contactId: string | null }> {
  let customerId = conversation.customerId;
  if (conversation.contactId) {
    const contact = await db.contact.findFirst({ where: { id: conversation.contactId }, select: { customerId: true, archivedAt: true } });
    if (!contact) throw new RecordNotFoundError();
    if (contact.archivedAt) throw new StateConflictError('archived_reference');
    customerId = contact.customerId;
  }
  if (customerId) {
    const customer = await db.customer.findFirst({ where: { id: customerId }, select: { archivedAt: true } });
    if (!customer) throw new RecordNotFoundError();
    if (customer.archivedAt) throw new StateConflictError('archived_reference');
  }
  return { customerId, contactId: conversation.contactId };
}

/** Participants may name contacts of this business and members of this business only. */
async function checkParticipants(db: AppTenantDb, participants: ReturnType<typeof normaliseParticipants>) {
  const contactIds = [...new Set(participants.map((p) => p.contactId).filter((v): v is string => v !== null))];
  const userIds = [...new Set(participants.map((p) => p.userId).filter((v): v is string => v !== null))];
  if (contactIds.length > 0 && (await db.contact.count({ where: { id: { in: contactIds } } })) !== contactIds.length) {
    throw new RuleViolationError('invalid_participant', 'A participant is not a contact in this business.');
  }
  if (userIds.length > 0 && (await db.membership.count({ where: { userId: { in: userIds } } })) !== userIds.length) {
    throw new RuleViolationError('invalid_participant', 'A participant is not a member of this business.');
  }
}

async function insertMessage(
  db: AppTenantDb,
  actorUserId: string,
  conversation: ConversationRow,
  link: { customerId: string | null; contactId: string | null },
  input: MessageInput,
  occurredAt: Date,
  participants: ReturnType<typeof normaliseParticipants>,
  hash: string,
  external: { source: string; messageId: string } | null,
): Promise<string> {
  const id = randomUUID();
  const source = external ? 'IMPORT' : 'MANUAL';
  await db.message.create({
    data: {
      id, conversationId: conversation.id, direction: input.direction, source, occurredAt, recordedById: actorUserId,
      subject: input.subject ?? null, body: input.body ?? null, externalSource: external?.source ?? null, externalMessageId: external?.messageId ?? null,
      contentHash: hash,
    } as never,
  });
  await db.messageParticipant.createMany({ data: participants.map((p) => ({ id: randomUUID(), messageId: id, ...p })) as never });
  await recordMessageActivity(db, actorUserId, {
    conversationId: conversation.id, messageId: id, customerId: link.customerId, contactId: link.contactId, occurredAt,
    direction: input.direction, channel: conversation.channel, source,
  });
  return id;
}

/**
 * Advances the conversation's last_message_at to `latest`, never backwards. One conditional UPDATE:
 * PostgreSQL re-checks the WHERE clause against the row version it locks, so concurrent recordings
 * cannot move the value back whatever order they commit in (C1-01). The conversations_guard_update
 * trigger enforces the same for every writer.
 */
async function touchConversation(db: AppTenantDb, conversationId: string, latest: Date) {
  await db.conversation.updateMany({
    where: { id: conversationId, OR: [{ lastMessageAt: null }, { lastMessageAt: { lt: latest } }] },
    data: { lastMessageAt: latest },
  });
}

function occurredAtOf(input: MessageInput): Date {
  const occurredAt = new Date(input.occurredAt);
  if (occurredAt.getTime() > Date.now() + MAX_FUTURE_MS) throw new RuleViolationError('invalid_date', 'A recorded message cannot be dated in the future.');
  return occurredAt;
}

/** A person records one message exchanged outside Business OS (for example an email they sent from their mail app). */
export async function recordMessage(db: AppTenantDb, actorUserId: string, conversationId: string, input: MessageInput): Promise<MessageDto> {
  const conversation = await conversationRow(db, conversationId);
  if (conversation.erasedAt) throw new StateConflictError('erased');
  const link = await timelineLink(db, conversation);
  const occurredAt = occurredAtOf(input);
  const participants = normaliseParticipants(input.participants);
  await checkParticipants(db, participants);
  const id = await insertMessage(db, actorUserId, conversation, link, input, occurredAt, participants, contentHash(input, occurredAt, participants), null);
  await touchConversation(db, conversation.id, occurredAt);
  await recordAudit(db, actorUserId, 'message.recorded', { type: 'message', id }, { conversationId, direction: input.direction, source: 'MANUAL' });
  return toMessage((await db.message.findFirst({ where: { id }, select: messageSelect })) as MessageRow);
}

/**
 * Imports up to 100 historical messages into one conversation, idempotently: a message whose
 * external id was already imported into this conversation with the same content is reported as a
 * duplicate and not written again. The same external id with different content, or in another
 * conversation, refuses the whole batch (409 idempotency_conflict), so nothing is half-imported.
 * E1 (D-E1-2): an external id that was erased here (an unexpired keyed marker) refuses the whole batch
 * with 409 erased, so a re-import cannot bring erased content back; so does an erased conversation.
 */
export async function importMessages(
  db: AppTenantDb,
  actorUserId: string,
  conversationId: string,
  messages: ImportInput[],
): Promise<{ results: { externalMessageId: string; messageId: string; status: 'created' | 'duplicate' }[] }> {
  const conversation = await conversationRow(db, conversationId);
  if (conversation.erasedAt) throw new StateConflictError('erased');
  const bySource = new Map<string, string[]>();
  for (const m of messages) bySource.set(m.external.source, [...(bySource.get(m.external.source) ?? []), m.external.messageId]);
  for (const [source, ids] of bySource) if ((await erasedExternalIds(db, source, ids)).size > 0) throw new StateConflictError('erased');
  const link = await timelineLink(db, conversation);
  const results: { externalMessageId: string; messageId: string; status: 'created' | 'duplicate' }[] = [];
  let latest: Date | null = null;
  for (const input of messages) {
    const occurredAt = occurredAtOf(input);
    const participants = normaliseParticipants(input.participants);
    const hash = contentHash(input, occurredAt, participants);
    const existing = await db.message.findFirst({
      where: { externalSource: input.external.source, externalMessageId: input.external.messageId },
      select: { id: true, conversationId: true, contentHash: true },
    });
    if (existing) {
      if (existing.conversationId !== conversationId || existing.contentHash !== hash) throw new StateConflictError('idempotency_conflict');
      results.push({ externalMessageId: input.external.messageId, messageId: existing.id, status: 'duplicate' });
      continue;
    }
    await checkParticipants(db, participants);
    const id = await insertMessage(db, actorUserId, conversation, link, input, occurredAt, participants, hash, input.external);
    results.push({ externalMessageId: input.external.messageId, messageId: id, status: 'created' });
    if (!latest || occurredAt > latest) latest = occurredAt;
  }
  const created = results.filter((r) => r.status === 'created').length;
  if (latest) await touchConversation(db, conversation.id, latest);
  await recordAudit(db, actorUserId, 'messages.imported', { type: 'conversation', id: conversationId }, {
    created: String(created), duplicates: String(results.length - created),
  });
  return { results };
}

/** Oldest first by when it happened (then id): the conversation reads top to bottom, deterministically. */
export async function listMessages(
  db: AppTenantDb,
  conversationId: string,
  query: { cursor?: string; limit: number },
): Promise<{ messages: MessageDto[]; nextCursor: string | null }> {
  await conversationRow(db, conversationId);
  const after = decodeCursor(query.cursor, 'messages', ['t', 'i'] as const);
  const and: Record<string, unknown>[] = [{ conversationId }];
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    and.push({ OR: [{ occurredAt: { gt: t } }, { occurredAt: t, id: { gt: after.i } }] });
  }
  const rows = (await db.message.findMany({
    where: { AND: and }, select: messageSelect, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  })) as MessageRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    messages: page.map(toMessage),
    nextCursor: rows.length > query.limit && last ? encodeCursor('messages', { t: last.occurredAt.toISOString(), i: last.id }) : null,
  };
}
