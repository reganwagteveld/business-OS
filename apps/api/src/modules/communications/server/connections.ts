import 'server-only';
// Connected mailboxes (docs/communications-c2.md §4–7, §16). Two kinds, fixed at connection time:
//   PERSONAL: belongs to the member who consented at the provider (owner_user_id = credential holder).
//     - see: the owner; anyone with communications:read if shared BUSINESS-wide; manage_connections all
//     - reconnect and share BUSINESS-wide: the owner only (an admin never exposes a personal mailbox)
//     - restrict to OWNER_ONLY, pause/resume, disconnect, request a sync: the owner or manage_connections
//   BUSINESS: controlled by the business; a designated business address (business-mailboxes.ts).
//     - connect, reconnect (and so take over as credential holder), pause/resume, disconnect, request a
//       sync, manage members: manage_connections only
//     - see: manage_connections, and members on the mailbox's member list (READ or SEND)
// A connection the viewer may not see answers exactly like a missing one (404).
// Nothing here reads, stores or sends mail. Provider network calls never run inside a unit of work:
// the OAuth callback consumes the state in one, calls the provider, then completes in another.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { MailConnection as ConnectionDto, MailSyncJob as JobDto } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { recordAudit } from '@/core/audit';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { ForbiddenError } from '@/modules/access';
import { openVerifier, sealVerifier, storeCredentials } from './credentials';
import {
  MAIL_PROVIDERS, oauthRedirectUri, providerAdapter, type BusinessMailboxProof, type MailProvider, type ProviderAccount, type ScopePurpose, type TokenSet,
} from './providers';
import { enqueueSyncJob, toJob, jobSelect, type JobRow } from './sync-jobs';
import { retentionIsSet } from './retention';

export type MailboxKind = 'PERSONAL' | 'BUSINESS';
export const purposeOf = (kind: MailboxKind): ScopePurpose => (kind === 'BUSINESS' ? 'business_read' : 'read');

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Who is asking, from the verified actor only. */
export interface ConnectionViewer {
  userId: string;
  canRead: boolean;
  canConnect: boolean;
  canManage: boolean;
}

type Row = {
  id: string; businessId: string; provider: string; kind: string; ownerUserId: string; credentialHolderId: string; providerAccountId: string;
  principalAccountId: string; providerTenantId: string | null; businessAddressId: string | null; mailboxAddress: string; displayName: string | null;
  status: string; sharing: string; syncEnabled: boolean; lastSyncedAt: Date | null; lastErrorCode: string | null; connectedAt: Date;
  disconnectedAt: Date | null; version: number; createdAt: Date;
};
const select = {
  id: true, businessId: true, provider: true, kind: true, ownerUserId: true, credentialHolderId: true, providerAccountId: true, principalAccountId: true,
  providerTenantId: true, businessAddressId: true, mailboxAddress: true, displayName: true, status: true,
  sharing: true, syncEnabled: true, lastSyncedAt: true, lastErrorCode: true, connectedAt: true, disconnectedAt: true, version: true, createdAt: true,
} as const;

function toConnection(r: Row, viewer: ConnectionViewer): ConnectionDto {
  return {
    id: r.id, provider: r.provider as MailProvider, mailboxAddress: r.mailboxAddress, displayName: r.displayName, kind: r.kind as MailboxKind,
    ownerUserId: r.ownerUserId, isOwner: r.ownerUserId === viewer.userId, credentialHolderId: r.credentialHolderId, businessAddressId: r.businessAddressId,
    status: r.status as ConnectionDto['status'], sharing: r.sharing as ConnectionDto['sharing'],
    syncEnabled: r.syncEnabled, lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null, lastErrorCode: r.lastErrorCode,
    connectedAt: r.connectedAt.toISOString(), disconnectedAt: r.disconnectedAt?.toISOString() ?? null, version: r.version,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * The single visibility predicate for connection reads: manager of connections (all); a PERSONAL
 * mailbox's owner, or anyone with communications:read once its owner shared it BUSINESS-wide; a
 * BUSINESS mailbox's members (READ or SEND).
 */
export function visibleTo(viewer: ConnectionViewer): Record<string, unknown> {
  if (viewer.canManage) return {};
  const or: Record<string, unknown>[] = [{ kind: 'PERSONAL', ownerUserId: viewer.userId }];
  if (viewer.canRead) {
    or.push({ kind: 'PERSONAL', sharing: 'BUSINESS' });
    or.push({ kind: 'BUSINESS', members: { some: { userId: viewer.userId } } });
  }
  return { OR: or };
}

async function visibleRow(db: AppTenantDb, viewer: ConnectionViewer, id: string): Promise<Row> {
  const row = (await db.mailConnection.findFirst({ where: { id, AND: [visibleTo(viewer)] }, select })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

const isOwner = (row: Row, viewer: ConnectionViewer) => row.kind === 'PERSONAL' && row.ownerUserId === viewer.userId && viewer.canConnect;
/** PERSONAL: owner (with connect) or manage_connections. BUSINESS: manage_connections. Anyone else who can see it is forbidden. */
function requireOwnerOrManager(row: Row, viewer: ConnectionViewer): void {
  if (!isOwner(row, viewer) && !viewer.canManage) throw new ForbiddenError();
}

export function listProviders() {
  return MAIL_PROVIDERS.map((provider) => {
    const adapter = providerAdapter(provider);
    // C2A-03: no automatic provider revocation (a Google revocation is grant-wide, see disconnectConnection).
    return { provider, configured: Boolean(adapter), revokesOnDisconnect: false };
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
  input: { provider: MailProvider; connectionId?: string; businessAddressId?: string },
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  if (!viewer.canConnect) throw new ForbiddenError();
  const adapter = providerAdapter(input.provider);
  if (!adapter) throw new StateConflictError('provider_not_configured');
  let loginHint: string | undefined;
  let kind: MailboxKind = 'PERSONAL';
  if (input.connectionId) {
    const row = await visibleRow(db, viewer, input.connectionId);
    kind = row.kind as MailboxKind;
    // PERSONAL: only the owner can consent for their own mailbox. BUSINESS: any manage_connections
    // member, with their own sign-in (a handover if they are not the current credential holder).
    if (kind === 'PERSONAL' && row.ownerUserId !== viewer.userId) throw new ForbiddenError();
    if (kind === 'BUSINESS' && !viewer.canManage) throw new ForbiddenError();
    if (row.status === 'DISCONNECTED') throw new StateConflictError('disconnected');
    if (row.provider !== input.provider) throw new StateConflictError('account_mismatch');
    // Google opens only the signed-in account's mailbox, so the hint is the mailbox itself; a Microsoft
    // business mailbox is opened by the member's own account, which Business OS does not know.
    if (kind === 'PERSONAL' || input.provider === 'GOOGLE') loginHint = row.mailboxAddress;
  } else if (input.businessAddressId) {
    if (!viewer.canManage) throw new ForbiddenError();
    kind = 'BUSINESS';
    const address = (await db.mailBusinessAddress.findFirst({
      where: { id: input.businessAddressId, removedAt: null }, select: { address: true },
    })) as { address: string } | null;
    if (!address) throw new RecordNotFoundError();
    const live = await db.mailConnection.findFirst({ where: { businessAddressId: input.businessAddressId, status: { not: 'DISCONNECTED' } }, select: { id: true } });
    if (live) throw new StateConflictError('already_connected');
    if (input.provider === 'GOOGLE') loginHint = address.address;
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
      businessAddressId: input.businessAddressId ?? null, codeVerifierEnc: sealVerifier(businessId, id, verifier), expiresAt,
    } as never,
  });
  await recordAudit(db, viewer.userId, 'communications.connection.authorization_started', { type: 'mail_connection', id: input.connectionId ?? id }, {
    provider: input.provider, connectionId: input.connectionId ?? null, kind, businessAddressId: input.businessAddressId ?? null,
  });
  return {
    authorizationUrl: adapter.authorizationUrl({
      state: `${slug}.${nonce}`, codeChallenge: challenge, redirectUri: oauthRedirectUri(), loginHint, purpose: purposeOf(kind),
    }),
    expiresAt: expiresAt.toISOString(),
  };
}

export type CallbackFailure =
  | 'declined' | 'invalid_state' | 'insufficient_scope' | 'account_mismatch' | 'already_connected' | 'provider_error' | 'not_allowed' | 'unauthenticated'
  | 'disconnected'
  // C2-B1: a PERSONAL connection of a designated business address; a business address no longer designated;
  // the provider found no such mailbox, or the signed-in account cannot open it; the account's organisation
  // does not control the verified domain.
  | 'business_address' | 'not_designated' | 'mailbox_not_found' | 'mailbox_access_denied' | 'domain_mismatch';

export class AuthorizationFailure extends Error {
  constructor(readonly reason: CallbackFailure) {
    super(reason);
    this.name = 'AuthorizationFailure';
  }
}

export interface PendingAuthorization {
  stateId: string; provider: MailProvider; connectionId: string | null; businessAddressId: string | null; codeVerifier: string;
  kind: MailboxKind;
  /** BUSINESS: the designated address the provider must prove access to. */
  targetAddress: string | null;
}

/**
 * Consumes a pending authorization: same user, unexpired, unused (one conditional update, so a
 * replay or a concurrent second use loses). Returns null for anything else, with no detail.
 */
export async function consumeAuthorization(db: AppTenantDb, viewer: ConnectionViewer, nonce: string): Promise<PendingAuthorization | null> {
  const row = (await db.mailOAuthState.findFirst({
    where: { stateHash: sha256Hex(nonce), userId: viewer.userId, consumedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, provider: true, connectionId: true, businessAddressId: true, codeVerifierEnc: true },
  })) as { id: string; provider: string; connectionId: string | null; businessAddressId: string | null; codeVerifierEnc: string } | null;
  if (!row) return null;
  const used = await db.mailOAuthState.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
  if (used.count !== 1) return null;
  const businessId = await currentBusinessId(db);
  let kind: MailboxKind = row.businessAddressId ? 'BUSINESS' : 'PERSONAL';
  let targetAddress: string | null = null;
  if (row.connectionId) {
    const target = (await db.mailConnection.findFirst({ where: { id: row.connectionId }, select: { kind: true, mailboxAddress: true } })) as
      { kind: string; mailboxAddress: string } | null;
    if (target) {
      kind = target.kind as MailboxKind;
      if (kind === 'BUSINESS') targetAddress = target.mailboxAddress;
    }
  } else if (row.businessAddressId) {
    const address = (await db.mailBusinessAddress.findFirst({ where: { id: row.businessAddressId }, select: { address: true } })) as { address: string } | null;
    targetAddress = address?.address ?? null;
  }
  return {
    stateId: row.id, provider: row.provider as MailProvider, connectionId: row.connectionId, businessAddressId: row.businessAddressId,
    codeVerifier: openVerifier(businessId, row.id, row.codeVerifierEnc), kind, targetAddress,
  };
}

/** Audits a refused callback (the reason is a stable code, never provider text). */
export async function recordAuthorizationFailure(db: AppTenantDb, viewer: ConnectionViewer, target: string, provider: MailProvider, reason: CallbackFailure): Promise<void> {
  await recordAudit(db, viewer.userId, 'communications.connection.authorization_failed', { type: 'mail_connection', id: target }, { provider, reason });
}

/** Cancels a connection's queued or running sync jobs (reauthorisation, handover, disconnect). */
async function cancelJobs(db: AppTenantDb, connectionId: string, code: string): Promise<void> {
  await db.mailSyncJob.updateMany({
    where: { connectionId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', leaseId: null, leaseExpiresAt: null, finishedAt: new Date(), lastErrorCode: code },
  });
}

/** Queues a sync unless the mailbox may not sync yet (BUSINESS without a retention period). */
async function queueSyncIfAllowed(db: AppTenantDb, row: { id: string; kind: string; lastSyncedAt: Date | null }, userId: string): Promise<boolean> {
  if (row.kind === 'BUSINESS' && !(await retentionIsSet(db))) return false;
  await enqueueSyncJob(db, row.id, row.lastSyncedAt ? 'INCREMENTAL' : 'INITIAL', userId);
  return true;
}

/**
 * Finishes a consent after the provider exchange: creates the connection, or reactivates it, stores
 * the sealed tokens and queues the initial sync (BUSINESS: only once the retention period is set).
 * `proof` is required for BUSINESS mailboxes: what the provider proved with the new token.
 */
export async function completeAuthorization(
  db: AppTenantDb,
  viewer: ConnectionViewer,
  pending: PendingAuthorization,
  tokens: TokenSet,
  account: ProviderAccount,
  proof?: BusinessMailboxProof,
): Promise<{ connectionId: string; outcome: 'connected' | 'reconnected' }> {
  const scopes = tokens.scopes.length > 0 ? tokens.scopes : providerAdapter(pending.provider)?.requiredScopes(purposeOf(pending.kind)) ?? [];
  if (pending.kind === 'BUSINESS') {
    if (!proof) throw new AuthorizationFailure('mailbox_access_denied');
    return completeBusiness(db, viewer, pending, tokens, account, proof, scopes);
  }
  if (!viewer.canConnect) throw new AuthorizationFailure('not_allowed');
  // T-C2-2: a designated business address is never connected as someone's personal mailbox (the
  // database refuses it too, CM010).
  const designated = await db.mailBusinessAddress.findFirst({ where: { address: account.address, removedAt: null }, select: { id: true } });
  if (designated) throw new AuthorizationFailure('business_address');
  const live = (await db.mailConnection.findFirst({
    where: { provider: pending.provider, providerAccountId: account.providerAccountId, status: { not: 'DISCONNECTED' } }, select,
  })) as Row | null;
  let target: Row | null = live;
  if (pending.connectionId) {
    const wanted = (await db.mailConnection.findFirst({ where: { id: pending.connectionId, ownerUserId: viewer.userId, kind: 'PERSONAL' }, select })) as Row | null;
    if (!wanted) throw new AuthorizationFailure('invalid_state');
    if (wanted.status === 'DISCONNECTED') throw new AuthorizationFailure('disconnected');
    if (wanted.providerAccountId !== account.providerAccountId) throw new AuthorizationFailure('account_mismatch');
    target = wanted;
  }
  if (target && (target.ownerUserId !== viewer.userId || target.kind !== 'PERSONAL')) throw new AuthorizationFailure('already_connected');
  if (target) {
    if (target.providerTenantId && account.tenantId && target.providerTenantId !== account.tenantId) throw new AuthorizationFailure('account_mismatch');
    const changed = await db.mailConnection.updateMany({
      where: { id: target.id, version: target.version, status: { not: 'DISCONNECTED' } },
      data: {
        status: 'ACTIVE', mailboxAddress: account.address, displayName: account.displayName, grantedScopes: scopes, lastErrorCode: null,
        providerTenantId: target.providerTenantId ?? account.tenantId, connectedAt: new Date(), version: target.version + 1, updatedAt: new Date(),
      },
    });
    if (changed.count !== 1) throw new AuthorizationFailure('invalid_state');
    await storeCredentials(db, target, tokens);
    await queueSyncIfAllowed(db, target, viewer.userId);
    await recordAudit(db, viewer.userId, 'communications.connection.reconnected', { type: 'mail_connection', id: target.id }, { provider: pending.provider });
    return { connectionId: target.id, outcome: 'reconnected' };
  }
  const id = randomUUID();
  const created = (await db.mailConnection.create({
    data: {
      id, provider: pending.provider, kind: 'PERSONAL', ownerUserId: viewer.userId, credentialHolderId: viewer.userId,
      providerAccountId: account.providerAccountId, principalAccountId: account.providerAccountId, providerTenantId: account.tenantId,
      mailboxAddress: account.address, displayName: account.displayName, grantedScopes: scopes,
    } as never,
    select,
  })) as Row;
  await storeCredentials(db, created, tokens);
  await enqueueSyncJob(db, id, 'INITIAL', viewer.userId);
  await recordAudit(db, viewer.userId, 'communications.connection.connected', { type: 'mail_connection', id }, { provider: pending.provider, kind: 'PERSONAL' });
  return { connectionId: id, outcome: 'connected' };
}

type AddressRow = { id: string; address: string; domainId: string | null; attestedById: string | null; removedAt: Date | null; domain: { domain: string } | null };

/**
 * BUSINESS connect and reconnect (T-C2-1, T-C2-2). The provider must have proved, with the new token:
 * the target mailbox is the designated address; the principal can read it; and for a verified-domain
 * address, the principal's organisation controls that domain (Google hd, Microsoft verified domains).
 * A consumer address needs no domain proof (its OWNER attestation was recorded at designation).
 * Reconnecting by a different member (or a different provider account) is a handover: the old
 * holder's tokens are deleted first (ACTIVE -> NEEDS_REAUTH), then the mailbox becomes ACTIVE with
 * the new holder (guard CM008 allows nothing else). Tokens are never transferred.
 */
async function completeBusiness(
  db: AppTenantDb,
  viewer: ConnectionViewer,
  pending: PendingAuthorization,
  tokens: TokenSet,
  account: ProviderAccount,
  proof: BusinessMailboxProof,
  scopes: string[],
): Promise<{ connectionId: string; outcome: 'connected' | 'reconnected' }> {
  if (!viewer.canManage) throw new AuthorizationFailure('not_allowed');
  let row: Row | null = null;
  let addressId = pending.businessAddressId;
  if (pending.connectionId) {
    row = (await db.mailConnection.findFirst({ where: { id: pending.connectionId, kind: 'BUSINESS' }, select })) as Row | null;
    if (!row) throw new AuthorizationFailure('invalid_state');
    if (row.status === 'DISCONNECTED') throw new AuthorizationFailure('disconnected');
    addressId = row.businessAddressId;
  }
  const address = addressId
    ? ((await db.mailBusinessAddress.findFirst({
        where: { id: addressId }, select: { id: true, address: true, domainId: true, attestedById: true, removedAt: true, domain: { select: { domain: true } } },
      })) as AddressRow | null)
    : null;
  if (!address || address.removedAt) throw new AuthorizationFailure('not_designated');
  if (proof.mailboxAddress !== address.address) throw new AuthorizationFailure('account_mismatch');
  if (address.domainId && !(proof.organisationDomains ?? []).includes(address.domain?.domain ?? '')) throw new AuthorizationFailure('domain_mismatch');
  const audit = { provider: pending.provider, businessAddressId: address.id, basis: address.domainId ? 'VERIFIED_DOMAIN' : 'OWNER_ATTESTATION' };

  if (!row) {
    const live = await db.mailConnection.findFirst({
      where: { OR: [{ provider: pending.provider, providerAccountId: proof.mailboxAccountId }, { businessAddressId: address.id }], status: { not: 'DISCONNECTED' } },
      select: { id: true },
    });
    if (live) throw new AuthorizationFailure('already_connected');
    const id = randomUUID();
    const created = (await db.mailConnection.create({
      data: {
        id, provider: pending.provider, kind: 'BUSINESS', sharing: 'MEMBERS', ownerUserId: viewer.userId, credentialHolderId: viewer.userId,
        providerAccountId: proof.mailboxAccountId, principalAccountId: account.providerAccountId, providerTenantId: account.tenantId,
        businessAddressId: address.id, mailboxAddress: address.address, displayName: proof.displayName, grantedScopes: scopes,
      } as never,
      select,
    })) as Row;
    await storeCredentials(db, created, tokens);
    const queued = await queueSyncIfAllowed(db, created, viewer.userId);
    await recordAudit(db, viewer.userId, 'communications.connection.business_connected', { type: 'mail_connection', id }, { ...audit, syncQueued: String(queued) });
    return { connectionId: id, outcome: 'connected' };
  }

  // Reconnect: the same target mailbox, in the same tenant, or nothing changes.
  if (proof.mailboxAccountId !== row.providerAccountId) throw new AuthorizationFailure('account_mismatch');
  if (row.providerTenantId && row.providerTenantId !== account.tenantId) throw new AuthorizationFailure('account_mismatch');
  const previousHolder = row.credentialHolderId;
  const handover = previousHolder !== viewer.userId || row.principalAccountId !== account.providerAccountId;
  let version = row.version;
  if (handover && row.status === 'ACTIVE') {
    // Step 1 of a handover: the previous holder's tokens go with the status change (trigger), and their
    // pending work is cancelled, before any new credential exists.
    const stopped = await db.mailConnection.updateMany({
      where: { id: row.id, version, status: 'ACTIVE' }, data: { status: 'NEEDS_REAUTH', lastErrorCode: 'handover', version: version + 1, updatedAt: new Date() },
    });
    if (stopped.count !== 1) throw new AuthorizationFailure('invalid_state');
    version += 1;
  }
  await cancelJobs(db, row.id, handover ? 'handover' : 'reconnected');
  const changed = await db.mailConnection.updateMany({
    where: { id: row.id, version, status: { not: 'DISCONNECTED' } },
    data: {
      status: 'ACTIVE', credentialHolderId: viewer.userId, principalAccountId: account.providerAccountId, displayName: proof.displayName,
      grantedScopes: scopes, lastErrorCode: null, providerTenantId: row.providerTenantId ?? account.tenantId, connectedAt: new Date(),
      version: version + 1, updatedAt: new Date(),
    },
  });
  if (changed.count !== 1) throw new AuthorizationFailure('invalid_state');
  await storeCredentials(db, row, tokens);
  const queued = await queueSyncIfAllowed(db, row, viewer.userId);
  await recordAudit(db, viewer.userId, 'communications.connection.reconnected', { type: 'mail_connection', id: row.id }, { ...audit, syncQueued: String(queued) });
  if (handover) {
    await recordAudit(db, viewer.userId, 'communications.connection.holder_changed', { type: 'mail_connection', id: row.id }, {
      provider: pending.provider, previousHolderId: previousHolder, newHolderId: viewer.userId,
    });
  }
  return { connectionId: row.id, outcome: 'reconnected' };
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
  // BUSINESS mailboxes are shared through their member list only.
  if (input.sharing !== undefined && row.kind === 'BUSINESS') throw new StateConflictError('not_personal');
  if (input.sharing === 'BUSINESS' && input.sharing !== row.sharing && !isOwner(row, viewer)) throw new ForbiddenError();
  if (row.status === 'DISCONNECTED') throw new StateConflictError('disconnected');
  if (row.version !== input.version) throw new StateConflictError('stale');
  // Owner clarification (2026-11-15): personal mailbox content is shared with the business only once
  // the business has an explicit ordinary-communications retention period (database guard CM009 too).
  if (input.sharing === 'BUSINESS' && row.sharing !== 'BUSINESS' && !(await retentionIsSet(db))) throw new StateConflictError('retention_not_set');
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
 * same transaction, so Business OS can never use the grant again. The provider grant itself is NOT
 * revoked automatically (C2A-03): Google revokes per account and app, not per token, so revoking would
 * also cut off any other live connection of the same mailbox (another business, or a reconnect).
 * Microsoft has no per-app revocation at all. The user removes the app in their Google or Microsoft
 * account if they want the grant gone; the API tells them so (revokesOnDisconnect: false).
 */
export async function disconnectConnection(db: AppTenantDb, viewer: ConnectionViewer, id: string): Promise<ConnectionDto> {
  const row = await visibleRow(db, viewer, id);
  requireOwnerOrManager(row, viewer);
  if (row.status === 'DISCONNECTED') throw new StateConflictError('disconnected');
  const now = new Date();
  await cancelJobs(db, id, 'disconnected');
  const changed = await db.mailConnection.updateMany({
    where: { id, version: row.version, status: { not: 'DISCONNECTED' } },
    data: { status: 'DISCONNECTED', disconnectedAt: now, disconnectedById: viewer.userId, syncEnabled: false, version: row.version + 1, updatedAt: now },
  });
  if (changed.count !== 1) throw new StateConflictError('stale');
  await recordAudit(db, viewer.userId, 'communications.connection.disconnected', { type: 'mail_connection', id }, {
    provider: row.provider, revocation: 'not_requested', ...(row.kind === 'BUSINESS' ? { kind: 'BUSINESS' } : {}),
  });
  return toConnection({ ...row, status: 'DISCONNECTED', disconnectedAt: now, syncEnabled: false, version: row.version + 1 }, viewer);
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
  if (row.kind === 'BUSINESS' && !(await retentionIsSet(db))) throw new StateConflictError('retention_not_set');
  const { job, created } = await enqueueSyncJob(db, id, row.lastSyncedAt ? kind : 'INITIAL', viewer.userId);
  if (created) await recordAudit(db, viewer.userId, 'communications.sync.requested', { type: 'mail_connection', id }, { kind: job.kind });
  return { job, created };
}

/** For the C2-B1 member and lifecycle services: a connection the viewer may see, or 404. */
export async function visibleConnection(db: AppTenantDb, viewer: ConnectionViewer, id: string): Promise<{ id: string; kind: MailboxKind; status: string }> {
  const row = await visibleRow(db, viewer, id);
  return { id: row.id, kind: row.kind as MailboxKind, status: row.status };
}

export async function listSyncJobs(db: AppTenantDb, viewer: ConnectionViewer, id: string): Promise<JobDto[]> {
  const row = await visibleRow(db, viewer, id);
  requireOwnerOrManager(row, viewer);
  const rows = (await db.mailSyncJob.findMany({ where: { connectionId: id }, select: jobSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 })) as JobRow[];
  return rows.map(toJob);
}
