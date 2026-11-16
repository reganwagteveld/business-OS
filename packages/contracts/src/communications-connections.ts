import { z } from 'zod';

// Communications C2-A (docs/communications-c2.md §10): connected mailboxes and their sync jobs.
// C2-B1 (§16): mailbox kind, credential holder, business domains and addresses, mailbox members and
// the ordinary-communications retention period. All C2-B1 changes to existing shapes are additive.
// Every path is under /api/v1/b/:slug. No response type has a field for a token, a client secret, a
// PKCE verifier, an authorization code or a provider sync cursor: provider authentication is
// server-side only. Bodies are strict (unknown fields are rejected, never ignored).

const Uuid = z.string().uuid();

export const MailProvider = z.enum(['GOOGLE', 'MICROSOFT']);
export const MailConnectionStatus = z.enum(['ACTIVE', 'NEEDS_REAUTH', 'DISCONNECTED']);
/**
 * PERSONAL mailboxes: OWNER_ONLY (only the person who connected it) or BUSINESS (everyone with
 * communications:read). BUSINESS mailboxes are always MEMBERS: the people on the mailbox's member list.
 */
export const MailSharing = z.enum(['OWNER_ONLY', 'BUSINESS', 'MEMBERS']);
/** PERSONAL: an employee's own mailbox. BUSINESS: a mailbox the business controls (info@, sales@). Fixed. */
export const MailboxKind = z.enum(['PERSONAL', 'BUSINESS']);
export const MailSyncKind = z.enum(['INITIAL', 'INCREMENTAL', 'FULL_RESYNC']);
export const MailSyncStatus = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']);
const ErrorCode = z.string().regex(/^[a-z][a-z_]{1,48}$/);

export const MailProviderInfo = z
  .object({
    provider: MailProvider,
    /** False when this deployment has no OAuth client for the provider (connecting is refused). */
    configured: z.boolean(),
    /**
     * Whether disconnecting also revokes the grant at the provider. Always false in C2-A: Business OS
     * deletes its tokens; the user removes the app in their Google or Microsoft account (C2A-03).
     */
    revokesOnDisconnect: z.boolean(),
  })
  .strict();
export const ListMailProvidersResponse = z.object({ providers: z.array(MailProviderInfo) }).strict();

export const MailConnection = z
  .object({
    id: Uuid,
    provider: MailProvider,
    mailboxAddress: z.string(),
    displayName: z.string().nullable(),
    kind: MailboxKind,
    /** PERSONAL: the employee it belongs to. BUSINESS: the member who first connected it (no special rights). */
    ownerUserId: Uuid,
    /** True when the signed-in user connected this mailbox. */
    isOwner: z.boolean(),
    /** The member whose provider sign-in Business OS uses. Always the owner for PERSONAL mailboxes. */
    credentialHolderId: Uuid,
    /** BUSINESS mailboxes: the designated business address it was connected for. */
    businessAddressId: Uuid.nullable(),
    status: MailConnectionStatus,
    sharing: MailSharing,
    syncEnabled: z.boolean(),
    lastSyncedAt: z.string().datetime().nullable(),
    /** A stable code such as reauth_required or owner_inactive, never provider text. */
    lastErrorCode: ErrorCode.nullable(),
    connectedAt: z.string().datetime(),
    disconnectedAt: z.string().datetime().nullable(),
    version: z.number().int().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MailConnection = z.infer<typeof MailConnection>;

export const ListMailConnectionsQuery = z
  .object({ includeDisconnected: z.enum(['true', 'false']).optional().transform((v) => v === 'true') })
  .strict();
export const ListMailConnectionsResponse = z.object({ connections: z.array(MailConnection) }).strict();
export const MailConnectionResponse = z.object({ connection: MailConnection }).strict();

/**
 * Starts a provider consent. Nothing else: connects the caller's own PERSONAL mailbox. connectionId:
 * reconnects that mailbox (PERSONAL: its owner only; BUSINESS: any manage_connections member, which
 * also hands the mailbox over to them). businessAddressId: connects that designated address as a new
 * BUSINESS mailbox (manage_connections).
 */
export const AuthorizeMailConnectionRequest = z
  .object({ provider: MailProvider, connectionId: Uuid.optional(), businessAddressId: Uuid.optional() })
  .strict()
  .refine((v) => !(v.connectionId && v.businessAddressId), 'Reconnect or connect a business address, not both');
export const AuthorizeMailConnectionResponse = z
  .object({
    /** Open in the same browser where you are signed in to Business OS; it expires quickly and works once. */
    authorizationUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();

/** Sharing applies to PERSONAL mailboxes only (BUSINESS mailboxes are shared through their members). */
export const UpdateMailConnectionRequest = z
  .object({ sharing: z.enum(['OWNER_ONLY', 'BUSINESS']).optional(), syncEnabled: z.boolean().optional(), version: z.number().int().min(1) })
  .strict()
  .refine((v) => v.sharing !== undefined || v.syncEnabled !== undefined, 'Change sharing or sync');

export const MailSyncJob = z
  .object({
    id: Uuid,
    connectionId: Uuid,
    kind: MailSyncKind,
    status: MailSyncStatus,
    attempts: z.number().int().min(0),
    runAfter: z.string().datetime(),
    startedAt: z.string().datetime().nullable(),
    finishedAt: z.string().datetime().nullable(),
    lastErrorCode: ErrorCode.nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MailSyncJob = z.infer<typeof MailSyncJob>;

export const RequestMailSyncRequest = z.object({ kind: z.enum(['INCREMENTAL', 'FULL_RESYNC']).optional() }).strict();
export const MailSyncJobResponse = z.object({ job: MailSyncJob }).strict();
export const ListMailSyncJobsResponse = z.object({ jobs: z.array(MailSyncJob) }).strict();

// ---- C2-B1: business domains, business addresses, mailbox members, retention ----------------------

const Version = z.number().int().min(1);
const Domain = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/, 'A domain such as example.com');
const Address = z.string().trim().toLowerCase().max(320).email();

/** The DNS record that proves the business controls a domain. */
export const MailDomainDnsRecord = z
  .object({
    type: z.literal('TXT'),
    /** Fully qualified record name, e.g. _business-os-verification.example.com */
    name: z.string(),
    /** Only returned when the domain is added: Business OS stores a hash and cannot show it again. */
    value: z.string().optional(),
  })
  .strict();

export const MailBusinessDomain = z
  .object({
    id: Uuid,
    domain: z.string(),
    status: z.enum(['PENDING', 'VERIFIED', 'REMOVED']),
    dnsRecord: MailDomainDnsRecord,
    verifiedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    version: Version,
  })
  .strict();
export type MailBusinessDomain = z.infer<typeof MailBusinessDomain>;
export const CreateMailBusinessDomainRequest = z.object({ domain: Domain }).strict();
export const MailBusinessDomainResponse = z.object({ domain: MailBusinessDomain }).strict();
export const ListMailBusinessDomainsResponse = z.object({ domains: z.array(MailBusinessDomain) }).strict();
export const VersionedRequest = z.object({ version: Version }).strict();

/** The statement an OWNER accepts for a consumer address (gmail.com, outlook.com, …). Recorded as v1. */
export const MAIL_BUSINESS_ATTESTATION_V1 =
  'I confirm that this business is authorised to use this mailbox for its business communications. '
  + 'I understand that Business OS records this confirmation and that it is not proof of legal ownership.';

export const MailBusinessAddress = z
  .object({
    id: Uuid,
    address: z.string(),
    /** VERIFIED_DOMAIN: on a domain this business verified. OWNER_ATTESTATION: a consumer address an OWNER attested to. */
    basis: z.enum(['VERIFIED_DOMAIN', 'OWNER_ATTESTATION']),
    domainId: Uuid.nullable(),
    attestedById: Uuid.nullable(),
    attestedAt: z.string().datetime().nullable(),
    /** The live BUSINESS mailbox connected for this address, if any. */
    connectionId: Uuid.nullable(),
    removedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    version: Version,
  })
  .strict();
export type MailBusinessAddress = z.infer<typeof MailBusinessAddress>;
export const CreateMailBusinessAddressRequest = z
  .object({
    address: Address,
    /** Required for consumer domains, OWNER only: the owner accepts MAIL_BUSINESS_ATTESTATION_V1. */
    attestation: z.object({ statement: z.literal('v1'), accepted: z.literal(true) }).strict().optional(),
  })
  .strict();
export const MailBusinessAddressResponse = z.object({ address: MailBusinessAddress }).strict();
export const ListMailBusinessAddressesQuery = z
  .object({ includeRemoved: z.enum(['true', 'false']).optional().transform((v) => v === 'true') })
  .strict();
export const ListMailBusinessAddressesResponse = z.object({ addresses: z.array(MailBusinessAddress) }).strict();

/** READ: see the mailbox (and, from C2-B2, its mail). SEND: also send from it (C2-C, with communications:send). */
export const MailboxAccess = z.enum(['READ', 'SEND']);
export const MailConnectionMember = z
  .object({ userId: Uuid, access: MailboxAccess, grantedById: Uuid, grantedAt: z.string().datetime(), version: Version })
  .strict();
export type MailConnectionMember = z.infer<typeof MailConnectionMember>;
export const SetMailConnectionMemberRequest = z.object({ access: MailboxAccess }).strict();
export const ListMailConnectionMembersResponse = z.object({ members: z.array(MailConnectionMember) }).strict();

export const MailRetention = z
  .object({
    /** Null until the business sets it: there is no product default (D-C2-9). */
    ordinaryRetentionDays: z.number().int().nullable(),
    updatedAt: z.string().datetime().nullable(),
    version: Version.nullable(),
    /**
     * E1 (D-E1-3): the period actually applied now. A shortened period takes effect 30 days after the change;
     * until then the longer previous one applies. Optional for older servers.
     */
    ordinaryRetentionDaysInForce: z.number().int().nullable().optional(),
    pendingReduction: z.object({ previousDays: z.number().int(), effectiveAt: z.string().datetime() }).strict().nullable().optional(),
  })
  .strict();
export type MailRetention = z.infer<typeof MailRetention>;
export const MailRetentionResponse = z.object({ retention: MailRetention }).strict();
/** version: null to set it the first time, else the current version. It can be changed, never unset. */
export const SetMailRetentionRequest = z
  .object({ ordinaryRetentionDays: z.number().int().min(1).max(36525), version: Version.nullable() })
  .strict();
