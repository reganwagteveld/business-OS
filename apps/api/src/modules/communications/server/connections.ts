import 'server-only';
// Connected mailboxes (docs/communications-c2.md §4–7). A connection belongs to the member who
// consented at the provider (owner_user_id, fixed). Record rules on top of permission keys:
//   - see: the owner; anyone with communications:read if shared BUSINESS-wide; manage_connections all
//   - reconnect and share BUSINESS-wide: the owner only (an admin never exposes a personal mailbox)
//   - restrict to OWNER_ONLY, pause/resume, disconnect, request a sync: the owner or manage_connections
// A connection the viewer may not see answers exactly like a missing one (404).
// Nothing here reads, stores or sends mail. Provider network calls never run inside a unit of work:
// the OAuth callback consumes the state in one, calls the provider, then completes in another.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MailConnection as ConnectionDto, MailSyncJob as JobDto } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { recordAudit } from '@/core/audit';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { ForbiddenError } from '@/modules/access';
import { openVerifier, readRefreshToken, sealVerifier, storeCredentials } from './credentials';
import { MAIL_PROVIDERS, oauthRedirectUri, providerAdapter, type MailProvider, type ProviderAccount, type TokenSet } from './providers';
import { enqueueSyncJob, toJob, jobSelect, type JobRow } from './sync-jobs';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Who is asking, from the verified actor only. */
export interface ConnectionViewer {
  userId: string;
  canRead: boolean;
  canConnect: boolean;
  canManage: boolean;
}

type Row = {
  id: string; businessId: string; provider: string; ownerUserId: string; providerAccountId: string; mailboxAddress: string; displayName: string | null;
  status: string; sharing: string; syncEnabled: boolean; lastSyncedAt: Date | null; lastErrorCode: string | null; connectedAt: Date;
  disconnectedAt: Date | null; version: number; createdAt: Date;
};
const select = {
  id: true, businessId: true, provider: true, ownerUserId: true, providerAccountId: true, mailboxAddress: true, displayName: true, status: true,
  sharing: true, syncEnabled: true, lastSyncedAt: true, lastErrorCode: true, connectedAt: true, disconnectedAt: true, version: true, createdAt: true,
} as const;

function toConnection(r: Row, viewer: ConnectionViewer): ConnectionDto {
  return {
    id: r.id, provider: r.provider as MailProvider, mailboxAddress: r.mailboxAddress, displayName: r.displayName, ownerUserId: r.ownerUserId,
    isOwner: r.ownerUserId === viewer.userId, status: r.status as ConnectionDto['status'], sharing: r.sharing as ConnectionDto['sharing'],
    syncEnabled: r.syncEnabled, lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null, lastErrorCode: r.lastErrorCode,
    connectedAt: r.connectedAt.toISOString(), disconnectedAt: r.disconnectedAt?.toISOString() ?? null, version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The single visibility predicate for connection reads (owner, shared, or manager of connections). */
function visibleTo(viewer: ConnectionViewer): Record<string, unknown> {
  if (viewer.canManage) return {};
  const or: Record<string, unknown>[] = [{ ownerUserId: viewer.userId }];
  if (viewer.canRead) or.push({ sharing: 'BUSINESS' });
  return { OR: or };
}

async function visibleRow(db: AppTenantDb, viewer: ConnectionViewer, id: string): Promise<Row> {
  const row = (await db.mailConnection.findFirst({ where: { id, AND: [visibleTo(viewer)] }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

const isOwner = (row: Row, viewer: ConnectionViewer) => row.ownerUserId === viewer.userId && viewer.canConnect;
/** Owner (with connect) or manage_connections; anyone else who can see it is forbidden. */
function requireOwnerOrManager(row: Row, viewer: ConnectionViewer): void {
  if (!isOwner(row, viewer) && !viewer.canManage) throw new ForbiddenError();
}

export function listProviders() {
  return MAIL_PROVIDERS.map((provider) => {
    const adapter = providerAdapter(provider);
    return { provider, configured: Boolean(adapter), revokesOnDisconnect: provider === 'GOOGLE' };
  });
}

export async function listConnections(db: AppTenantDb, viewer: ConnectionViewer, query: { includeDisconnected: boolean }): Promise<ConnectionDto[]> {
  const and: Record<string, unknown>[] = [visibleTo(viewer)];
  if (!query.includeDisconnected) and.push({ status: { not: 'DISCONNECTED' } });
  const rows = (await db.mailConnection.findMany({ where: { AND: and }, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 })) as Row[];
  return rows.map((r) => toConnection(r, viewer));
}

export async function getConnection(db: AppTenantDb, viewer: ConnectionViewer, id: string): Promise<ConnectionDto> {
  return toConnection(await visibleRow(db, viewer, id), viewer);
}

// ---- authorization (OAuth start and callback) ------------------------------------------------------

const b64url = (bytes: Buffer) => bytes.toString('base64url');
const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const NONCE = /^[A-Za-z0-9_-]{43}$/;

/** state = "<slug>.<nonce>": the slug is resolved through the caller's memberships on the callback. */
export function parseState(state: unknown): { slug: string; nonce: string } | null {
  if (typeof state !== 'string' || state.length > 200) return null;
  const dot = state.lastIndexOf('.');
  const slug = state.slice(0, dot);
  const nonce = state.slice(dot + 1);
  if (dot <= 0 || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug) || !NONCE.test(nonce)) return null;
  return { slug, nonce };
}

async function currentBusinessId(db: AppTenantDb): Promise<string> {
  const business = (await db.business.findFirst({ select: { id: true } })) as { id: string } | null;
  if (!business) throw new RecordNotFoundError();
  return business.id;
}

/**
 * Starts a consent at the provider. The nonce and the PKCE verifier never leave the server except
 * as the provider URL's `state` and S256 challenge; only the nonce's hash is stored.
 */
export async function startAuthorization(
  db: AppTenantDb,
  viewer: ConnectionViewer,
  slug: string,
  input: { provider: MailProvider; connectionId?: string },
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  if (!viewer.canConnect) throw new ForbiddenError();
  const adapter = providerAdapter(input.provider);
  if (!adapter) throw new StateConflictError('provider_not_configured');
  let loginHint: string | undefined;
  if (input.connectionId) {
    // Reconnect: only the owner can consent for their own mailbox.
    const row = await visibleRow(db, viewer, input.connectionId);
    if (row.ownerUserId !== viewer.userId) throw new ForbiddenError();
    if (row.status === 'DISCONNECTED') throw new StateConflictError('disconnected');
    if (row.provider !== input.provider) throw new StateConflictError('account_mismatch');
    loginHint = row.mailboxAddress;
  }
  const businessId = await currentBusinessId(db);
  // Housekeeping: the caller's own expired or used authorizations.
  await db.mailOAuthState.deleteMany({ where: { userId: viewer.userId, OR: [{ expiresAt: { lt: new Date() } }, { consumedAt: { not: null } }] } });
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);
  await db.mailOAuthState.create({
    data: {
      id, stateHash: sha256Hex(nonce), userId: viewer.userId, provider: input.provider, connectionId: input.connectionId ?? null,
      codeVerifierEnc: sealVerifier(businessId, id, verifier), expiresAt,
    } as never,
  });
  await recordAudit(db, viewer.userId, 'communications.connection.authorization_started', { type: 'mail_connection', id: input.connectionId ?? id }, {
    provider: input.provider, connectionId: input.connectionId ?? null,
  });
  return {
    authorizationUrl: adapter.authorizationUrl({ state: `${slug}.${nonce}`, codeChallenge: challenge, redirectUri: oauthRedirectUri(), loginHint }),
    expiresAt: expiresAt.toISOString(),
  };
}

export type CallbackFailure =
  | 'declined' | 'invalid_state' | 'insufficient_scope' | 'account_mismatch' | 'already_connected' | 'provider_error' | 'not_allowed' | 'unauthenticated'
  | 'disconnected';

export class AuthorizationFailure extends Error {
  constructor(readonly reason: CallbackFailure) {
    super(reason);
    this.name = 'AuthorizationFailure';
  }
}

export interface PendingAuthorization { stateId: string; provider: MailProvider; connectionId: string | null; codeVerifier: string }

/**
 * Consumes a pending authorization: same user, unexpired, unused (one conditional update, so a
 * replay or a concurrent second use loses). Returns null for anything else, with no detail.
 */
export async function consumeAuthorization(db: AppTenantDb, viewer: ConnectionViewer, nonce: string): Promise<PendingAuthorization | null> {
  const row = (await db.mailOAuthState.findFirst({
    where: { stateHash: sha256Hex(nonce), userId: viewer.userId, consumedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, provider: true, connectionId: true, codeVerifierEnc: true },
  })) as { id: string; provider: string; connectionId: string | null; codeVerifierEnc: string } | null;
  if (!row) return null;
  const used = await db.mailOAuthState.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (used.count !== 1) return null;
  const businessId = await currentBusinessId(db);
  return { stateId: row.id, provider: row.provider as MailProvider, connectionId: row.connectionId, codeVerifier: openVerifier(businessId, row.id, row.codeVerifierEnc) };
}

/** Audits a refused callback (the reason is a stable code, never provider text). */
export async function recordAuthorizationFailure(db: AppTenantDb, viewer: ConnectionViewer, target: string, provider: MailProvider, reason: CallbackFailure): Promise<void> {
  await recordAudit(db, viewer.userId, 'communications.connection.authorization_failed', { type: 'mail_connection', id: target }, { provider, reason });
}

/**
 * Finishes a consent after the provider exchange: creates the connection, or reactivates the owner's
 * connection for the same account, stores the sealed tokens and queues the initial sync.
 */
export async function completeAuthorization(
  db: AppTenantDb,
  viewer: ConnectionViewer,
  pending: PendingAuthorization,
  tokens: TokenSet,
  account: ProviderAccount,
): Promise<{ connectionId: string; outcome: 'connected' | 'reconnected' }> {
  if (!viewer.canConnect) throw new AuthorizationFailure('not_allowed');
  const live = (await db.mailConnection.findFirst({
    where: { provider: pending.provider, providerAccountId: account.providerAccountId, status: { not: 'DISCONNECTED' } }, select,
  })) as Row | null;
  let target: Row | null = live;
  if (pending.connectionId) {
    const wanted = (await db.mailConnection.findFirst({ where: { id: pending.connectionId, ownerUserId: viewer.userId }, select })) as Row | null;
    if (!wanted) throw new AuthorizationFailure('invalid_state');
    if (wanted.status === 'DISCONNECTED') throw new AuthorizationFailure('disconnected');
    if (wanted.providerAccountId !== account.providerAccountId) throw new AuthorizationFailure('account_mismatch');
    target = wanted;
  }
  if (target && target.ownerUserId !== viewer.userId) throw new AuthorizationFailure('already_connected');
  const scopes = tokens.scopes.length > 0 ? tokens.scopes : providerAdapter(pending.provider)?.requiredScopes('read') ?? [];
  if (target) {
    const changed = await db.mailConnection.updateMany({
      where: { id: target.id, version: target.version, status: { not: 'DISCONNECTED' } },
      data: {
        status: 'ACTIVE', mailboxAddress: account.address, displayName: account.displayName, grantedScopes: scopes, lastErrorCode: null,
        connectedAt: new Date(), version: target.version + 1, updatedAt: new Date(),
      },
    });
    if (changed.count !== 1) throw new AuthorizationFailure('invalid_state');
    await storeCredentials(db, target, tokens);
    await enqueueSyncJob(db, target.id, target.lastSyncedAt ? 'INCREMENTAL' : 'INITIAL', viewer.userId);
    await recordAudit(db, viewer.userId, 'communications.connection.reconnected', { type: 'mail_connection', id: target.id }, { provider: pending.provider });
    return { connectionId: target.id, outcome: 'reconnected' };
  }
  const id = randomUUID();
  const created = (await db.mailConnection.create({
    data: {
      id, provider: pending.provider, ownerUserId: viewer.userId, providerAccountId: account.providerAccountId, mailboxAddress: account.address,
      displayName: account.displayName, grantedScopes: scopes,
    } as never,
    select,
  })) as Row;
  await storeCredentials(db, created, tokens);
  await enqueueSyncJob(db, id, 'INITIAL', viewer.userId);
  await recordAudit(db, viewer.userId, 'communications.connection.connected', { type: 'mail_connection', id }, { provider: pending.provider });
  return { connectionId: id, outcome: 'connected' };
}

// ---- management ----------------------------------------------------------------------------------------

export async function updateConnection(
  db: AppTenantDb,
  viewer: ConnectionViewer,
  id: string,
  input: { sharing?: 'OWNER_ONLY' | 'BUSINESS'; syncEnabled?: boolean; version: number },
): Promise<ConnectionDto> {
  const row = await visibleRow(db, viewer, id);
  requireOwnerOrManager(row, viewer);
  if (input.sharing === 'BUSINESS' && input.sharing !== row.sharing && !isOwner(row, viewer)) throw new ForbiddenError();
  if (row.status === 'DISCONNECTED') throw new StateConflictError('disconnected');
  if (row.version !== input.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = { version: row.version + 1, updatedAt: new Date() };
  const fields: string[] = [];
  if (input.sharing !== undefined && input.sharing !== row.sharing) { data.sharing = input.sharing; fields.push('sharing'); }
  if (input.syncEnabled !== undefined && input.syncEnabled !== row.syncEnabled) { data.syncEnabled = input.syncEnabled; fields.push('syncEnabled'); }
  if (fields.length === 0) return toConnection(row, viewer);
  const changed = await db.mailConnection.updateMany({ where: { id, version: row.version }, data });
  if (changed.count !== 1) throw new StateConflictError('stale');
  if (input.syncEnabled === false) {
    await db.mailSyncJob.updateMany({
      where: { connectionId: id, status: 'QUEUED' }, data: { status: 'CANCELLED', finishedAt: new Date(), lastErrorCode: 'sync_disabled' },
    });
  }
  await recordAudit(db, viewer.userId, 'communications.connection.updated', { type: 'mail_connection', id }, {
    fields, sharing: (data.sharing as string | undefined) ?? row.sharing, syncEnabled: String(input.syncEnabled ?? row.syncEnabled),
  });
  return toConnection(await visibleRow(db, viewer, id), viewer);
}

/**
 * Disconnects: final status, pending jobs cancelled, credentials deleted by the status trigger in the
 * same transaction. The returned `revoke` runs after commit (Google revokes the grant; Microsoft has
 * no per-app revocation, the stored tokens are simply gone).
 */
export async function disconnectConnection(
  db: AppTenantDb,
  viewer: ConnectionViewer,
  id: string,
): Promise<{ connection: ConnectionDto; revoke: () => Promise<void> }> {
  const row = await visibleRow(db, viewer, id);
  requireOwnerOrManager(row, viewer);
  if (row.status === 'DISCONNECTED') throw new StateConflictError('disconnected');
  const provider = row.provider as MailProvider;
  const adapter = providerAdapter(provider);
  // Read before the status change deletes it; held only in memory until the revocation call.
  const refreshToken = adapter?.capabilities.tokenRevocation && row.status === 'ACTIVE' ? await readRefreshToken(db, row) : null;
  const now = new Date();
  await db.mailSyncJob.updateMany({
    where: { connectionId: id, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', leaseId: null, leaseExpiresAt: null, finishedAt: now, lastErrorCode: 'disconnected' },
  });
  const changed = await db.mailConnection.updateMany({
    where: { id, version: row.version, status: { not: 'DISCONNECTED' } },
    data: { status: 'DISCONNECTED', disconnectedAt: now, disconnectedById: viewer.userId, syncEnabled: false, version: row.version + 1, updatedAt: now },
  });
  if (changed.count !== 1) throw new StateConflictError('stale');
  await recordAudit(db, viewer.userId, 'communications.connection.disconnected', { type: 'mail_connection', id }, {
    provider, revocation: refreshToken ? 'requested' : 'unsupported',
  });
  return {
    connection: toConnection({ ...row, status: 'DISCONNECTED', disconnectedAt: now, syncEnabled: false, version: row.version + 1 }, viewer),
    revoke: async () => {
      if (!refreshToken || !adapter) return;
      // Best effort: the grant is already unusable here (tokens deleted); a failure is not retried.
      await adapter.revoke(refreshToken).catch(() => undefined);
    },
  };
}

export async function requestSync(
  db: AppTenantDb,
  viewer: ConnectionViewer,
  id: string,
  kind: 'INCREMENTAL' | 'FULL_RESYNC' = 'INCREMENTAL',
): Promise<{ job: JobDto; created: boolean }> {
  const row = await visibleRow(db, viewer, id);
  requireOwnerOrManager(row, viewer);
  if (row.status === 'DISCONNECTED') throw new StateConflictError('disconnected');
  if (row.status !== 'ACTIVE') throw new StateConflictError('not_active');
  if (!row.syncEnabled) throw new StateConflictError('sync_disabled');
  const { job, created } = await enqueueSyncJob(db, id, row.lastSyncedAt ? kind : 'INITIAL', viewer.userId);
  if (created) await recordAudit(db, viewer.userId, 'communications.sync.requested', { type: 'mail_connection', id }, { kind: job.kind });
  return { job, created };
}

export async function listSyncJobs(db: AppTenantDb, viewer: ConnectionViewer, id: string): Promise<JobDto[]> {
  const row = await visibleRow(db, viewer, id);
  requireOwnerOrManager(row, viewer);
  const rows = (await db.mailSyncJob.findMany({ where: { connectionId: id }, select: jobSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 })) as JobRow[];
  return rows.map(toJob);
}
