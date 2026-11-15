import { z } from 'zod';

// Customer Zone (data-model §4.5–4.7). Every path is under /api/v1/b/:slug, so no request carries
// a business id. Bodies are strict: unknown fields (a business id, an author, a timestamp) are rejected.

const Uuid = z.string().uuid();
/** Optional free text: trimmed; an empty string clears the field (null). */
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const optionalEmail = z
  .string().trim().toLowerCase().max(254)
  .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address')
  .transform((v) => (v === '' ? null : v)).nullable().optional();
const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'Use a two-letter country code, for example AU');

export const CustomerKind = z.enum(['COMPANY', 'INDIVIDUAL']);
export const RecordStatus = z.enum(['active', 'archived', 'all']);

const customerFields = {
  kind: CustomerKind,
  displayName: z.string().trim().min(1, 'A name is required').max(200),
  legalName: optionalText(200),
  email: optionalEmail,
  phone: optionalText(50),
  website: optionalText(300),
  taxNumber: optionalText(64),
  taxNumberType: z.string().regex(/^[a-z0-9_]{1,32}$/).nullable().optional(),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  countryCode: CountryCode.nullable().optional(),
  notes: optionalText(2000),
  ownerUserId: Uuid.nullable().optional(),
};

export const CreateCustomerRequest = z.object({ ...customerFields, kind: CustomerKind.default('COMPANY') }).strict();
export const UpdateCustomerRequest = z
  .object({ ...customerFields, primaryContactId: Uuid.nullable() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const nullableString = z.string().nullable();
const isoOrNull = z.string().datetime().nullable();

export const Customer = z
  .object({
    id: Uuid,
    kind: CustomerKind,
    displayName: z.string(),
    legalName: nullableString,
    email: nullableString,
    phone: nullableString,
    website: nullableString,
    taxNumber: nullableString,
    taxNumberType: nullableString,
    addressLine1: nullableString,
    addressLine2: nullableString,
    city: nullableString,
    region: nullableString,
    postalCode: nullableString,
    countryCode: nullableString,
    notes: nullableString,
    ownerUserId: Uuid.nullable(),
    primaryContactId: Uuid.nullable(),
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: isoOrNull,
  })
  .strict();
export type Customer = z.infer<typeof Customer>;

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();
const Search = z.string().trim().max(100).optional();

export const ListCustomersQuery = z.object({ q: Search, status: RecordStatus.default('active'), cursor: Cursor, limit: Limit }).strict();
export const ListCustomersResponse = z.object({ customers: z.array(Customer), nextCursor: z.string().nullable() }).strict();
export const CustomerResponse = z.object({ customer: Customer }).strict();

/** Counts for the Zone home. Computed by the server inside the tenant unit of work (RLS applies). */
const Count = z.number().int().min(0);
export const CustomerSummary = z
  .object({ customers: z.object({ active: Count, archived: Count }).strict(), contacts: z.object({ active: Count }).strict() })
  .strict();
export type CustomerSummary = z.infer<typeof CustomerSummary>;
export const CustomerSummaryResponse = z.object({ summary: CustomerSummary }).strict();

const contactFields = {
  firstName: optionalText(100),
  lastName: optionalText(100),
  displayName: optionalText(200),
  email: optionalEmail,
  phone: optionalText(50),
  mobile: optionalText(50),
  jobTitle: optionalText(100),
  notes: optionalText(2000),
  customerId: Uuid.nullable().optional(),
};
export const CreateContactRequest = z.object(contactFields).strict();
export const UpdateContactRequest = z.object(contactFields).partial().strict().refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const Contact = z
  .object({
    id: Uuid,
    customerId: Uuid.nullable(),
    firstName: nullableString,
    lastName: nullableString,
    displayName: z.string(),
    email: nullableString,
    phone: nullableString,
    mobile: nullableString,
    jobTitle: nullableString,
    notes: nullableString,
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: isoOrNull,
  })
  .strict();
export type Contact = z.infer<typeof Contact>;

export const ListContactsQuery = z.object({ q: Search, status: RecordStatus.default('active'), customerId: Uuid.optional(), cursor: Cursor, limit: Limit }).strict();
export const ListContactsResponse = z.object({ contacts: z.array(Contact), nextCursor: z.string().nullable() }).strict();
export const ContactResponse = z.object({ contact: Contact }).strict();

/** Activity types a person can log. System types (customer.created, …) are written by the server only. */
export const UserActivityType = z.enum(['note', 'call', 'meeting', 'email', 'interaction']);
/** Who started a logged call, email or other interaction. Logging never means Business OS sent anything. */
export const InteractionDirection = z.enum(['INBOUND', 'OUTBOUND']);
/** Channels of an "interaction" (calls, meetings and emails have their own types). */
export const InteractionChannel = z.enum(['SMS', 'CHAT', 'SOCIAL', 'IN_PERSON', 'OTHER']);
/** RESTRICTED notes are visible to their author and to holders of activity:read_restricted only. */
export const ActivityVisibility = z.enum(['STANDARD', 'RESTRICTED']);
const DIRECTED: readonly string[] = ['call', 'email', 'interaction'];

export const CreateActivityRequest = z
  .object({
    type: UserActivityType,
    occurredAt: z.string().datetime({ offset: true }).optional(),
    customerId: Uuid.optional(),
    contactId: Uuid.optional(),
    subject: optionalText(200),
    body: optionalText(10000),
    visibility: ActivityVisibility.optional(),
    direction: InteractionDirection.optional(),
    channel: InteractionChannel.optional(),
  })
  .strict()
  .refine((v) => v.customerId !== undefined || v.contactId !== undefined, 'Link the activity to a customer or a contact')
  .refine((v) => Boolean(v.subject) || Boolean(v.body), 'Add a subject or some text')
  .refine((v) => v.visibility !== 'RESTRICTED' || v.type === 'note', 'Only notes can be restricted')
  .refine((v) => v.direction === undefined || DIRECTED.includes(v.type), 'Only calls, emails and interactions have a direction')
  .refine((v) => (v.type === 'interaction') === (v.channel !== undefined), 'An interaction needs a channel, and only interactions have one');

/** The author edits a note's subject or text. Type, links, visibility and authorship never change. */
export const UpdateNoteRequest = z
  .object({ subject: optionalText(200), body: optionalText(10000) })
  .strict()
  .refine((v) => v.subject !== undefined || v.body !== undefined, 'Nothing to update');

export const Activity = z
  .object({
    id: Uuid,
    type: z.string(),
    occurredAt: z.string().datetime(),
    actorType: z.enum(['USER', 'SYSTEM', 'AI']),
    actorUserId: Uuid.nullable(),
    customerId: Uuid.nullable(),
    contactId: Uuid.nullable(),
    subject: nullableString,
    body: nullableString,
    data: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
    visibility: ActivityVisibility,
    /** Set when the author edited the note. */
    editedAt: isoOrNull,
    /** Set only for message.recorded: the recorded message this timeline entry stands for. */
    conversationId: Uuid.nullable(),
    messageId: Uuid.nullable(),
  })
  .strict();
export type Activity = z.infer<typeof Activity>;

const ActivityTypeToken = z.string().regex(/^[a-z][a-z_]*(\.[a-z_]+)*$/).max(64);
export const ListActivitiesQuery = z
  .object({
    customerId: Uuid.optional(),
    contactId: Uuid.optional(),
    /** Comma-separated activity types, for example "note,call". Unknown types are a 400. */
    types: z.string().max(400).transform((v) => v.split(',').filter(Boolean)).pipe(z.array(ActivityTypeToken).min(1).max(20)).optional(),
    visibility: z.enum(['all', 'standard', 'restricted']).default('all'),
    cursor: Cursor,
    limit: Limit,
  })
  .strict()
  .refine((v) => !(v.customerId && v.contactId), 'Filter by a customer or a contact, not both');
export const ListActivitiesResponse = z.object({ activities: z.array(Activity), nextCursor: z.string().nullable() }).strict();
export const ActivityResponse = z.object({ activity: Activity }).strict();
