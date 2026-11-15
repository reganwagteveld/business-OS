import { z } from 'zod';

// Communications C2-A (docs/communications-c2.md §10): connected mailboxes and their sync jobs.
// Every path is under /api/v1/b/:slug. No response type has a field for a token, a client secret, a
// PKCE verifier, an authorization code or a provider sync cursor: provider authentication is
// server-side only. Bodies are strict (unknown fields are rejected, never ignored).

const Uuid = z.string().uuid();

export const MailProvider = z.enum(['GOOGLE', 'MICROSOFT']);
export const MailConnectionStatus = z.enum(['ACTIVE', 'NEEDS_REAUTH', 'DISCONNECTED']);
/** OWNER_ONLY: only the person who connected it. BUSINESS: everyone with communications:read. */
export const MailSharing = z.enum(['OWNER_ONLY', 'BUSINESS']);
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
    ownerUserId: Uuid,
    /** True when the signed-in user connected this mailbox. */
    isOwner: z.boolean(),
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

/** Starts a provider consent. With connectionId it reconnects that mailbox (owner only). */
export const AuthorizeMailConnectionRequest = z.object({ provider: MailProvider, connectionId: Uuid.optional() }).strict();
export const AuthorizeMailConnectionResponse = z
  .object({
    /** Open in the same browser where you are signed in to Business OS; it expires quickly and works once. */
    authorizationUrl: z.string().url(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const UpdateMailConnectionRequest = z
  .object({ sharing: MailSharing.optional(), syncEnabled: z.boolean().optional(), version: z.number().int().min(1) })
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
