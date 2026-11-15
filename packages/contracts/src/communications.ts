import { z } from 'zod';

// Communications C1 (docs/communications-c1.md): conversations and the historical messages recorded
// or imported into them. Every path is under /api/v1/b/:slug, so no request carries a business id;
// bodies are strict (an unknown field such as an author, a recorded time or a "sent" flag is
// rejected, never ignored). Nothing here sends a message: recording an OUTBOUND message records that
// it was sent elsewhere. Recorded messages are read-only.

const Uuid = z.string().uuid();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
/** A lowercase label for where imported records came from, for example "gmail-export". */
const ExternalSource = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'Use lowercase letters, digits, dot, dash or underscore');
const ExternalId = z.string().min(1).max(512);

export const ConversationChannel = z.enum(['EMAIL', 'PHONE', 'SMS', 'CHAT', 'SOCIAL', 'IN_PERSON', 'OTHER']);
export const MessageDirection = z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']);
/** MANUAL = a person recorded it; IMPORT = brought in from an export with its external id. */
export const MessageSource = z.enum(['MANUAL', 'IMPORT']);
export const ParticipantRole = z.enum(['FROM', 'TO', 'CC', 'BCC']);

export const CreateConversationRequest = z
  .object({
    channel: ConversationChannel,
    subject: optionalText(300),
    customerId: Uuid.optional(),
    contactId: Uuid.optional(),
  })
  .strict()
  .refine((v) => v.customerId !== undefined || v.contactId !== undefined, 'Link the conversation to a customer or a contact');

export const Conversation = z
  .object({
    id: Uuid,
    channel: ConversationChannel,
    subject: z.string().nullable(),
    customerId: Uuid.nullable(),
    contactId: Uuid.nullable(),
    source: MessageSource,
    createdById: Uuid,
    lastMessageAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Conversation = z.infer<typeof Conversation>;

export const ListConversationsQuery = z
  .object({ customerId: Uuid.optional(), contactId: Uuid.optional(), cursor: Cursor, limit: Limit })
  .strict()
  .refine((v) => !(v.customerId && v.contactId), 'Filter by a customer or a contact, not both');
export const ListConversationsResponse = z.object({ conversations: z.array(Conversation), nextCursor: z.string().nullable() }).strict();
export const ConversationResponse = z.object({ conversation: Conversation }).strict();

export const ParticipantInput = z
  .object({
    role: ParticipantRole,
    displayName: optionalText(200),
    address: optionalText(320),
    contactId: Uuid.optional(),
    userId: Uuid.optional(),
  })
  .strict()
  .refine((p) => Boolean(p.displayName) || Boolean(p.address) || p.contactId !== undefined || p.userId !== undefined, 'Name the participant');

const messageFields = {
  direction: MessageDirection,
  /** When it originally happened. Required: a historical record always says when. */
  occurredAt: z.string().datetime({ offset: true }),
  subject: optionalText(300),
  body: optionalText(100000),
  participants: z.array(ParticipantInput).min(1).max(100),
};
const messageRules = <T extends z.ZodType<{ subject?: string | null; body?: string | null; participants: { role: string }[] }>>(schema: T) =>
  schema
    .refine((v) => Boolean(v.subject) || Boolean(v.body), 'Add a subject or some text')
    .refine((v) => v.participants.filter((p) => p.role === 'FROM').length === 1, 'Name exactly one sender');

export const RecordMessageRequest = messageRules(z.object(messageFields).strict());

export const ImportMessageInput = messageRules(
  z.object({ ...messageFields, external: z.object({ source: ExternalSource, messageId: ExternalId }).strict() }).strict(),
);
export const ImportMessagesRequest = z.object({ messages: z.array(ImportMessageInput).min(1).max(100) }).strict();

export const MessageParticipant = z
  .object({
    role: ParticipantRole,
    position: z.number().int(),
    displayName: z.string().nullable(),
    address: z.string().nullable(),
    contactId: Uuid.nullable(),
    userId: Uuid.nullable(),
  })
  .strict();

export const Message = z
  .object({
    id: Uuid,
    conversationId: Uuid,
    direction: MessageDirection,
    source: MessageSource,
    occurredAt: z.string().datetime(),
    /** Database time when it was recorded in Business OS. */
    recordedAt: z.string().datetime(),
    recordedById: Uuid,
    subject: z.string().nullable(),
    body: z.string().nullable(),
    externalSource: z.string().nullable(),
    externalMessageId: z.string().nullable(),
    participants: z.array(MessageParticipant),
  })
  .strict();
export type Message = z.infer<typeof Message>;

export const ListMessagesQuery = z.object({ cursor: Cursor, limit: Limit }).strict();
export const ListMessagesResponse = z.object({ messages: z.array(Message), nextCursor: z.string().nullable() }).strict();
export const MessageResponse = z.object({ message: Message }).strict();
export const ImportMessagesResponse = z
  .object({
    results: z.array(z.object({ externalMessageId: z.string(), messageId: Uuid, status: z.enum(['created', 'duplicate']) }).strict()),
  })
  .strict();
