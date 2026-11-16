import 'server-only';
// Provider credentials (docs/communications-c2.md §7.2–7.3). The ONLY code that touches
// mail_connection_credentials (boundary rule credentials-only-in-credentials). Tokens are sealed with
// AES-256-GCM and associated data binding them to business + connection + field, so a ciphertext
// moved to another row or business does not open. Plaintext tokens live only in memory for one
// provider call: never logged, audited, returned or put in an error.
import { randomUUID } from 'node:crypto';
import { getEnv } from '@/core/config/env';
import { createSecretBox, type SecretBox } from '@/core/crypto/secret-box';
import type { AppTenantDb } from '@/core/db';
import { recordAudit, recordSystemAudit } from '@/core/audit';
import { permissionsFor, type Permission, type Role } from '@/modules/access';
import { StateConflictError } from '@/core/http/errors';
import { ProviderError, providerAdapter, type MailProvider, type MailProviderAdapter, type TokenSet } from './providers';

/** Refresh when less than this is left on the access token. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LEASE_MS = 30_000;
const WAIT_STEP_MS = 200;
const WAIT_STEPS = 15;

let box: SecretBox | undefined;
/** The configured secret box; throws provider_not_configured when no key is set. */
export function credentialBox(): SecretBox {
  if (!box) {
    const keys = getEnv().COMMUNICATIONS_CREDENTIAL_KEYS;
    if (keys.length === 0) throw new StateConflictError('provider_not_configured');
    box = createSecretBox(keys);
  }
  return box;
}
/** Test seam: forget the cached box after the environment changed. */
export function resetCredentialBoxForTests(): void {
  box = undefined;
}

type Field = 'refresh' | 'access' | 'verifier';
export const credentialAad = (businessId: string, recordId: string, field: Field) => `bos:mail-credential:v1:${businessId}:${recordId}:${field}`;

/** Seals the PKCE verifier of a pending authorization (bound to business + state id). */
export const sealVerifier = (businessId: string, stateId: string, verifier: string) =>
  credentialBox().seal(verifier, credentialAad(businessId, stateId, 'verifier'));
export const openVerifier = (businessId: string, stateId: string, envelope: string) =>
  credentialBox().open(envelope, credentialAad(businessId, stateId, 'verifier'));

/** Replaces the connection's credentials (connection must be ACTIVE: trigger CM006). */
export async function storeCredentials(db: AppTenantDb, connection: { businessId: string; id: string }, tokens: TokenSet): Promise<void> {
  if (!tokens.refreshToken) throw new ProviderError('invalid_response');
  const b = credentialBox();
  await db.mailConnectionCredential.deleteMany({ where: { connectionId: connection.id } });
  await db.mailConnectionCredential.create({
    data: {
      connectionId: connection.id,
      keyId: b.activeKeyId,
      credentialVersion: randomUUID(),
      refreshTokenEnc: b.seal(tokens.refreshToken, credentialAad(connection.businessId, connection.id, 'refresh')),
      accessTokenEnc: b.seal(tokens.accessToken, credentialAad(connection.businessId, connection.id, 'access')),
      accessTokenExpiresAt: tokens.expiresAt,
    } as never,
  });
}

/**
 * Runs one unit of work for the business that owns the connection. `system: true` runs it with no
 * session user (system audit events); otherwise it acts as the mailbox's credential holder.
 */
export type TenantRun = <T>(work: (db: AppTenantDb) => Promise<T>, opts?: { system?: boolean }) => Promise<T>;

type ConnectionRef = { businessId: string; id: string; provider: MailProvider; kind: 'PERSONAL' | 'BUSINESS' };

type Step =
  | { kind: 'token'; token: string }
  | { kind: 'lease'; lease: string; version: string; refreshToken: string; connection: ConnectionRef }
  | { kind: 'wait' };

async function step(db: AppTenantDb, connectionId: string, now: Date, tryLease: boolean): Promise<Step> {
  const connection = (await db.mailConnection.findFirst({
    where: { id: connectionId, status: 'ACTIVE' }, select: { businessId: true, id: true, provider: true, kind: true },
  })) as ConnectionRef | null;
  if (!connection) throw new StateConflictError('not_active');
  const row = (await db.mailConnectionCredential.findFirst({
    where: { connectionId }, select: { accessTokenEnc: true, accessTokenExpiresAt: true },
  })) as { accessTokenEnc: string | null; accessTokenExpiresAt: Date | null } | null;
  if (!row) throw new StateConflictError('not_active');
  const b = credentialBox();
  if (row.accessTokenEnc && row.accessTokenExpiresAt && row.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS) {
    return { kind: 'token', token: b.open(row.accessTokenEnc, credentialAad(connection.businessId, connection.id, 'access')) };
  }
  if (!tryLease) return { kind: 'wait' };
  // Take the single-flight lease on database time, and read the credential version and refresh
  // token in the same statement, so the version is exactly the one this refresh will use.
  const lease = randomUUID();
  const taken = await db.$queryRaw<{ credential_version: string; refresh_token_enc: string }[]>`
    UPDATE "mail_connection_credentials"
       SET "refresh_lease_id" = ${lease}::uuid, "refresh_lease_until" = now() + make_interval(secs => ${LEASE_MS / 1000}::int)
     WHERE "connection_id" = ${connectionId}::uuid AND ("refresh_lease_until" IS NULL OR "refresh_lease_until" < now())
    RETURNING "credential_version"::text, "refresh_token_enc"`;
  const got = taken[0];
  if (!got) return { kind: 'wait' };
  return {
    kind: 'lease', lease, version: got.credential_version, connection,
    refreshToken: b.open(got.refresh_token_enc, credentialAad(connection.businessId, connection.id, 'refresh')),
  };
}

/**
 * The permission a credential holder must keep for the grant to stay usable (D-C2-8): PERSONAL
 * mailboxes need communications:connect, BUSINESS mailboxes communications:manage_connections. The
 * one rule shared by the sync claim (holderActive) and membership changes (revokeHeldConnections).
 */
export function holderPermission(kind: string): Permission {
  return kind === 'BUSINESS' ? 'communications:manage_connections' : 'communications:connect';
}

/** Does a member with this role (null: no active membership) keep authority over a mailbox of this kind? */
export function holderKeepsAuthority(role: Role | null, kind: string): boolean {
  return role !== null && permissionsFor(role).includes(holderPermission(kind));
}

/**
 * Stops a connection: ACTIVE becomes NEEDS_REAUTH (trigger mail_connections_drop_credentials deletes
 * the credential row in the same transaction) and its QUEUED/RUNNING jobs are cancelled with their
 * lease cleared, so heartbeat, complete and fail all refuse afterwards. Returns whether the status
 * changed. No audit: the caller records the event it is allowed to write.
 */
async function stopConnection(db: AppTenantDb, connectionId: string, code: 'reauth_required' | 'owner_inactive' | 'holder_inactive'): Promise<boolean> {
  const changed = await db.mailConnection.updateMany({
    where: { id: connectionId, status: 'ACTIVE' },
    data: { status: 'NEEDS_REAUTH', lastErrorCode: code, updatedAt: new Date() },
  });
  await db.mailSyncJob.updateMany({
    where: { connectionId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: { status: 'CANCELLED', leaseId: null, leaseExpiresAt: null, finishedAt: new Date(), lastErrorCode: code },
  });
  return changed.count === 1;
}

/**
 * The provider refused the refresh token (revoked, expired, policy): the connection needs the owner
 * to reconnect. Credentials go with the status change (trigger), pending jobs are cancelled. Runs
 * with no session user (system audit event).
 */
export async function markReauthRequired(
  db: AppTenantDb, connectionId: string, provider: string, code: 'reauth_required' | 'owner_inactive' | 'holder_inactive',
): Promise<void> {
  if (await stopConnection(db, connectionId, code)) {
    await recordSystemAudit(db, `communications.system.${code}`, { type: 'mail_connection', id: connectionId }, { provider });
  }
}

export type HolderCutoffCause = 'member_removed' | 'member_suspended' | 'member_left' | 'member_demoted';

/**
 * Administration A2-B (docs/administration-a2.md §3.10, C2 review 2026-11-16): eager credential
 * cutoff when a member stops being able to hold a mailbox grant. Runs inside the membership
 * transaction, as the acting member (so the audit is actor-attributed and passes
 * audit_tenant_write; no policy change). `remainingRole` is the member's role after the change, or
 * null when they keep no active membership (removed, suspended, left). Every ACTIVE connection they
 * hold whose kind they no longer have authority for is stopped (credentials deleted, jobs
 * cancelled), and each stop is audited as `communications.connection.holder_departed`.
 *
 * Lock order: the connections FIRST, in id order, then their jobs and credentials (via the status
 * trigger). C2 paths take job → connection or credential → connection, so a deadlock with them is
 * possible; PostgreSQL aborts one side with 40P01 and the membership routes retry the whole unit of
 * work. The lazy holder check in claimSyncJob stays as the backstop.
 */
export async function revokeHeldConnections(
  db: AppTenantDb, actorUserId: string, holderUserId: string, cause: HolderCutoffCause, remainingRole: Role | null,
): Promise<string[]> {
  const held = await db.$queryRaw<{ id: string; provider: string; kind: 'PERSONAL' | 'BUSINESS' }[]>`
    SELECT id::text AS id, provider::text AS provider, kind::text AS kind FROM mail_connections
     WHERE credential_holder_id = ${holderUserId}::uuid AND status = 'ACTIVE'
       AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
     ORDER BY id FOR UPDATE`;
  const stopped: string[] = [];
  for (const c of held) {
    if (holderKeepsAuthority(remainingRole, c.kind)) continue;
    if (await stopConnection(db, c.id, c.kind === 'BUSINESS' ? 'holder_inactive' : 'owner_inactive')) {
      await recordAudit(db, actorUserId, 'communications.connection.holder_departed', { type: 'mail_connection', id: c.id }, {
        provider: c.provider, kind: c.kind, userId: holderUserId, cause,
      });
      stopped.push(c.id);
    }
  }
  return stopped;
}

/**
 * C2A-01 fence: a refused refresh token invalidates the connection only if this attempt still owns
 * the refresh: the credentials hold the version it read AND its exact lease id. The conditional
 * UPDATE locks the credential row and re-checks both after any concurrent writer committed, and the
 * status change happens in the same transaction. So neither a replacement refresh that already
 * stored new credentials (new version) nor one that has only taken over the lease (new lease id) can
 * be disrupted by a delayed invalid_grant. Returns false when the response was obsolete.
 *
 * An expired lease that nobody has taken over still authorises its holder (§7.3): the lease id is
 * replaced on takeover, so an unchanged id proves no other attempt started.
 */
export async function invalidateIfCurrent(db: AppTenantDb, connectionId: string, version: string, lease: string, provider: string): Promise<boolean> {
  const current = await db.$queryRaw<{ connection_id: string }[]>`
    UPDATE "mail_connection_credentials" SET "refresh_lease_id" = NULL, "refresh_lease_until" = NULL, "updated_at" = now()
     WHERE "connection_id" = ${connectionId}::uuid AND "credential_version" = ${version}::uuid AND "refresh_lease_id" = ${lease}::uuid
    RETURNING "connection_id"::text`;
  if (current.length !== 1) return false;
  await markReauthRequired(db, connectionId, provider, 'reauth_required');
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A valid access token for an ACTIVE connection (§7.3). Refresh is single-flight across processes:
 * one caller takes a short lease (database time) and refreshes over the network with no transaction
 * open. Every outcome is fenced by the credential version the refresh read AND its exact lease id:
 * new tokens are stored, and an invalid_grant invalidates the connection, only if no other attempt
 * has replaced the credentials or taken over the lease meanwhile. Others wait briefly.
 */
export async function obtainAccessToken(
  run: TenantRun,
  connectionId: string,
  opts: { adapter?: MailProviderAdapter; now?: () => Date } = {},
): Promise<string> {
  const now = opts.now ?? (() => new Date());
  for (let i = 0; i <= WAIT_STEPS; i++) {
    const s = await run((db) => step(db, connectionId, now(), i === 0 || i === WAIT_STEPS));
    if (s.kind === 'token') return s.token;
    if (s.kind === 'wait') {
      if (i < WAIT_STEPS) await sleep(WAIT_STEP_MS);
      continue;
    }
    const adapter = opts.adapter ?? providerAdapter(s.connection.provider);
    if (!adapter) throw new StateConflictError('provider_not_configured');
    let tokens: TokenSet;
    try {
      // Microsoft refreshes per scope set: a BUSINESS connection keeps its shared-mailbox scopes.
      tokens = await adapter.refresh(s.refreshToken, s.connection.kind === 'BUSINESS' ? 'business_read' : 'read');
    } catch (error) {
      if (error instanceof ProviderError && error.code === 'invalid_grant') {
        const current = await run((db) => invalidateIfCurrent(db, connectionId, s.version, s.lease, s.connection.provider), { system: true });
        // Obsolete: another attempt replaced the credentials or took over the lease. Not a revocation.
        if (!current) throw new ProviderError('busy');
      } else {
        await run((db) => db.mailConnectionCredential.updateMany({ where: { connectionId, refreshLeaseId: s.lease }, data: { refreshLeaseId: null, refreshLeaseUntil: null } }));
      }
      throw error;
    }
    const b = credentialBox();
    const { businessId, id } = s.connection;
    const stored = await run((db) => db.mailConnectionCredential.updateMany({
      // Fenced by version and lease: lost if another refresh, a reconnect or a disconnect replaced
      // the credentials, or another attempt took over the lease (even before it wrote anything).
      where: { connectionId, credentialVersion: s.version, refreshLeaseId: s.lease },
      data: {
        keyId: b.activeKeyId,
        credentialVersion: randomUUID(),
        accessTokenEnc: b.seal(tokens.accessToken, credentialAad(businessId, id, 'access')),
        accessTokenExpiresAt: tokens.expiresAt,
        // Google usually keeps the refresh token; Microsoft always sends a new one. Either way it is
        // re-sealed with the active key, so refreshing also completes a key rotation for the row.
        refreshTokenEnc: b.seal(tokens.refreshToken ?? s.refreshToken, credentialAad(businessId, id, 'refresh')),
        refreshLeaseId: null,
        refreshLeaseUntil: null,
        updatedAt: new Date(),
      },
    }));
    if (stored.count !== 1) throw new ProviderError('busy');
    return tokens.accessToken;
  }
  throw new ProviderError('busy');
}
