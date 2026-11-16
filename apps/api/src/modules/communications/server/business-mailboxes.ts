import 'server-only';
// Business mailbox classification (T-C2-2, D-C2-3; docs/communications-c2.md §16). Business OS cannot
// prove who legally owns a mailbox; it requires the three things it can prove:
//   1. the business controls the domain (a DNS TXT record), or, for consumer domains such as gmail.com
//      that cannot be verified, an OWNER's recorded attestation (a claim, not proof of ownership);
//   2. an authorised person is acting (manage_connections; attestation: OWNER only);
//   3. the credential holder really has access (the live provider check in connections.ts).
// A designated address can never be connected as a PERSONAL mailbox, and an address someone has
// connected as their personal mailbox cannot be designated until that connection is disconnected
// (database guard CM010, under one advisory lock per address). There is no conversion either way.
//
// Members (D-C2-14): manage_connections grants READ or SEND on a BUSINESS mailbox. SEND includes READ;
// sending itself is C2-C and will also need communications:send.
//
// Domain verification calls DNS: like every network call, it runs between two units of work.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type {
  MailBusinessAddress as AddressDto, MailBusinessDomain as DomainDto, MailConnectionMember as MemberDto,
} from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { recordAudit } from '@/core/audit';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';
import { ForbiddenError } from '@/modules/access';
import { visibleConnection, type ConnectionViewer } from './connections';

/**
 * Consumer mail domains of the supported providers: addresses on them cannot pass DNS verification and
 * may be business mailboxes only by OWNER attestation. Mirrors mail_is_consumer_domain() in migration
 * 20261125000000 (an integration test compares the two).
 */
export const CONSUMER_MAIL_DOMAINS: readonly string[] = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'hotmail.co.uk', 'live.co.uk', 'outlook.com.au', 'hotmail.com.au', 'live.com.au',
];
export const isConsumerDomain = (domain: string) => CONSUMER_MAIL_DOMAINS.includes(domain);
export const ATTESTATION_VERSION = 'v1';

/** Who acts on business mailboxes, from the verified actor only. */
export interface BusinessMailboxActor extends ConnectionViewer {
  /** OWNER role: the only one who may attest to a consumer address (owner decision D-C2-3). */
  canAttest: boolean;
}

const requireManage = (actor: ConnectionViewer) => {
  if (!actor.canManage) throw new ForbiddenError();
};
const sha256Hex = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

// ---- DNS -----------------------------------------------------------------------------------------

export const DNS_RECORD_PREFIX = '_business-os-verification';
export const DNS_VALUE_PREFIX = 'business-os-verification=';
const DNS_TIMEOUT_MS = 5_000;

/** TXT records at a name, each joined from its strings. Throws only for real failures (not "no record"). */
export type TxtLookup = (name: string) => Promise<string[]>;

const systemLookup: TxtLookup = async (name) => {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  try {
    return (await resolver.resolveTxt(name)).map((chunks) => chunks.join(''));
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENONAME') return [];
    throw new StateConflictError('dns_unavailable');
  }
};
let lookup: TxtLookup = systemLookup;
/** Test seam: replace the DNS lookup (null restores the system resolver). */
export function setTxtLookupForTests(fn: TxtLookup | null): void {
  lookup = fn ?? systemLookup;
}

// ---- domains --------------------------------------------------------------------------------------

type DomainRow = { id: string; domain: string; verificationTokenHash: string; verifiedAt: Date | null; removedAt: Date | null; createdAt: Date; version: number };
const domainSelect = { id: true, domain: true, verificationTokenHash: true, verifiedAt: true, removedAt: true, createdAt: true, version: true } as const;

function toDomain(r: DomainRow, value?: string): DomainDto {
  return {
    id: r.id, domain: r.domain, status: r.removedAt ? 'REMOVED' : r.verifiedAt ? 'VERIFIED' : 'PENDING',
    dnsRecord: { type: 'TXT', name: `${DNS_RECORD_PREFIX}.${r.domain}`, ...(value ? { value } : {}) },
    verifiedAt: r.verifiedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), version: r.version,
  };
}

async function domainRow(db: AppTenantDb, id: string): Promise<DomainRow> {
  const row = (await db.mailBusinessDomain.findFirst({ where: { id }, select: domainSelect })) as DomainRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export async function listDomains(db: AppTenantDb, actor: ConnectionViewer): Promise<DomainDto[]> {
  requireManage(actor);
  const rows = (await db.mailBusinessDomain.findMany({ where: { removedAt: null }, select: domainSelect, orderBy: [{ domain: 'asc' }], take: 200 })) as DomainRow[];
  return rows.map((r) => toDomain(r));
}

/** Adds an unverified domain. The TXT value is returned once; only its hash is stored. */
export async function addDomain(db: AppTenantDb, actor: ConnectionViewer, input: { domain: string }): Promise<DomainDto> {
  requireManage(actor);
  if (isConsumerDomain(input.domain)) throw new StateConflictError('consumer_domain');
  const existing = await db.mailBusinessDomain.findFirst({ where: { domain: input.domain, removedAt: null }, select: { id: true } });
  if (existing) throw new StateConflictError('domain_exists');
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const row = (await db.mailBusinessDomain.create({
    data: { id, domain: input.domain, verificationTokenHash: sha256Hex(token), createdById: actor.userId } as never, select: domainSelect,
  })) as DomainRow;
  await recordAudit(db, actor.userId, 'communications.domain.added', { type: 'mail_business_domain', id }, {});
  return toDomain(row, `${DNS_VALUE_PREFIX}${token}`);
}

/** Unit of work 1 of verification: what to look up. */
export async function domainToVerify(db: AppTenantDb, actor: ConnectionViewer, id: string, version: number): Promise<{ name: string; hash: string }> {
  requireManage(actor);
  const row = await domainRow(db, id);
  if (row.removedAt) throw new StateConflictError('removed');
  if (row.version !== version) throw new StateConflictError('stale');
  if (row.verifiedAt) throw new StateConflictError('already_verified');
  return { name: `${DNS_RECORD_PREFIX}.${row.domain}`, hash: row.verificationTokenHash };
}

/** Between the units of work: does the TXT record carry the token whose hash is stored? */
export async function dnsHasToken(name: string, hash: string): Promise<boolean> {
  const records = await lookup(name);
  const expected = Buffer.from(hash, 'hex');
  return records.some((record) => {
    const value = record.trim();
    if (!value.startsWith(DNS_VALUE_PREFIX)) return false;
    const got = createHash('sha256').update(value.slice(DNS_VALUE_PREFIX.length), 'utf8').digest();
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/**
 * Unit of work 2: records the outcome (verified only if nothing changed meanwhile). Audited either
 * way. A failed lookup returns null so that its audit event commits; the caller then answers 409
 * dns_record_not_found (throwing here would roll the audit back).
 */
export async function recordDomainVerification(
  db: AppTenantDb, actor: ConnectionViewer, id: string, version: number, found: boolean,
): Promise<DomainDto | null> {
  requireManage(actor);
  if (!found) {
    await recordAudit(db, actor.userId, 'communications.domain.verification_failed', { type: 'mail_business_domain', id }, { reason: 'dns_record_not_found' });
    return null;
  }
  const changed = await db.mailBusinessDomain.updateMany({
    where: { id, version, verifiedAt: null, removedAt: null },
    data: { verifiedAt: new Date(), verifiedById: actor.userId, version: version + 1, updatedAt: new Date() },
  });
  if (changed.count !== 1) throw new StateConflictError('stale');
  await recordAudit(db, actor.userId, 'communications.domain.verified', { type: 'mail_business_domain', id }, { method: 'dns_txt' });
  return toDomain(await domainRow(db, id));
}

export async function removeDomain(db: AppTenantDb, actor: ConnectionViewer, id: string, version: number): Promise<DomainDto> {
  requireManage(actor);
  const row = await domainRow(db, id);
  if (row.removedAt) throw new StateConflictError('removed');
  if (row.version !== version) throw new StateConflictError('stale');
  const inUse = await db.mailBusinessAddress.findFirst({ where: { domainId: id, removedAt: null }, select: { id: true } });
  if (inUse) throw new StateConflictError('domain_in_use');
  const changed = await db.mailBusinessDomain.updateMany({
    where: { id, version, removedAt: null }, data: { removedAt: new Date(), removedById: actor.userId, version: version + 1, updatedAt: new Date() },
  });
  if (changed.count !== 1) throw new StateConflictError('stale');
  await recordAudit(db, actor.userId, 'communications.domain.removed', { type: 'mail_business_domain', id }, {});
  return toDomain(await domainRow(db, id));
}

// ---- designated business addresses -----------------------------------------------------------------

type AddressRow = {
  id: string; address: string; domainId: string | null; attestedById: string | null; attestedAt: Date | null; removedAt: Date | null; createdAt: Date;
  version: number; connections: { id: string }[];
};
const addressSelect = {
  id: true, address: true, domainId: true, attestedById: true, attestedAt: true, removedAt: true, createdAt: true, version: true,
  connections: { where: { status: { not: 'DISCONNECTED' } }, select: { id: true }, take: 1 },
} as const;

const toAddress = (r: AddressRow): AddressDto => ({
  id: r.id, address: r.address, basis: r.domainId ? 'VERIFIED_DOMAIN' : 'OWNER_ATTESTATION', domainId: r.domainId, attestedById: r.attestedById,
  attestedAt: r.attestedAt?.toISOString() ?? null, connectionId: r.connections[0]?.id ?? null, removedAt: r.removedAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(), version: r.version,
});

async function addressRow(db: AppTenantDb, id: string): Promise<AddressRow> {
  const row = (await db.mailBusinessAddress.findFirst({ where: { id }, select: addressSelect })) as AddressRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

export async function listAddresses(db: AppTenantDb, actor: ConnectionViewer, query: { includeRemoved: boolean }): Promise<AddressDto[]> {
  requireManage(actor);
  const rows = (await db.mailBusinessAddress.findMany({
    where: query.includeRemoved ? {} : { removedAt: null }, select: addressSelect, orderBy: [{ address: 'asc' }, { createdAt: 'desc' }], take: 200,
  })) as AddressRow[];
  return rows.map(toAddress);
}

/**
 * Designates an address as a business mailbox. On a verified domain of this business: no attestation
 * (one is refused, to keep the record honest). On a consumer domain: an OWNER must accept the v1
 * statement. Any other domain must be verified first.
 */
export async function designateAddress(
  db: AppTenantDb,
  actor: BusinessMailboxActor,
  input: { address: string; attestation?: { statement: 'v1'; accepted: true } },
): Promise<AddressDto> {
  requireManage(actor);
  const host = domainOf(input.address);
  let domainId: string | null = null;
  if (isConsumerDomain(host)) {
    if (!input.attestation) throw new StateConflictError('attestation_required');
    if (!actor.canAttest) throw new ForbiddenError();
  } else {
    if (input.attestation) throw new StateConflictError('attestation_not_applicable');
    const domain = (await db.mailBusinessDomain.findFirst({ where: { domain: host, removedAt: null }, select: { id: true, verifiedAt: true } })) as
      { id: string; verifiedAt: Date | null } | null;
    if (!domain?.verifiedAt) throw new StateConflictError('domain_not_verified');
    domainId = domain.id;
  }
  if (await db.mailBusinessAddress.findFirst({ where: { address: input.address, removedAt: null }, select: { id: true } })) {
    throw new StateConflictError('already_designated');
  }
  const personal = await db.mailConnection.findFirst({
    where: { mailboxAddress: input.address, kind: 'PERSONAL', status: { not: 'DISCONNECTED' } }, select: { id: true },
  });
  // Visible only to manage_connections callers, who already see every connection's metadata.
  if (personal) throw new StateConflictError('personal_connection_exists');
  const id = randomUUID();
  await db.mailBusinessAddress.create({
    data: {
      id, address: input.address, domainId, createdById: actor.userId,
      ...(domainId ? {} : { attestedById: actor.userId, attestedAt: new Date(), attestationVersion: ATTESTATION_VERSION }),
    } as never,
  });
  await recordAudit(db, actor.userId, 'communications.address.designated', { type: 'mail_business_address', id }, {
    basis: domainId ? 'VERIFIED_DOMAIN' : 'OWNER_ATTESTATION', domainId,
  });
  if (!domainId) {
    await recordAudit(db, actor.userId, 'communications.address.attested', { type: 'mail_business_address', id }, { statement: ATTESTATION_VERSION });
  }
  return toAddress(await addressRow(db, id));
}

/** Ends a designation. Its BUSINESS mailbox must be disconnected first. */
export async function removeAddress(db: AppTenantDb, actor: ConnectionViewer, id: string, version: number): Promise<AddressDto> {
  requireManage(actor);
  const row = await addressRow(db, id);
  if (row.removedAt) throw new StateConflictError('removed');
  if (row.version !== version) throw new StateConflictError('stale');
  if (row.connections.length > 0) throw new StateConflictError('address_in_use');
  const changed = await db.mailBusinessAddress.updateMany({
    where: { id, version, removedAt: null }, data: { removedAt: new Date(), removedById: actor.userId, version: version + 1, updatedAt: new Date() },
  });
  if (changed.count !== 1) throw new StateConflictError('stale');
  await recordAudit(db, actor.userId, 'communications.address.removed', { type: 'mail_business_address', id }, {});
  return toAddress(await addressRow(db, id));
}

// ---- members of a BUSINESS mailbox -------------------------------------------------------------------

type MemberRow = { userId: string; access: string; grantedById: string; grantedAt: Date; version: number };
const memberSelect = { userId: true, access: true, grantedById: true, grantedAt: true, version: true } as const;
const toMember = (r: MemberRow): MemberDto => ({
  userId: r.userId, access: r.access as MemberDto['access'], grantedById: r.grantedById, grantedAt: r.grantedAt.toISOString(), version: r.version,
});

async function businessConnection(db: AppTenantDb, actor: ConnectionViewer, connectionId: string): Promise<void> {
  const connection = await visibleConnection(db, actor, connectionId);
  requireManage(actor);
  if (connection.kind !== 'BUSINESS') throw new StateConflictError('not_business');
}

export async function listMembers(db: AppTenantDb, actor: ConnectionViewer, connectionId: string): Promise<MemberDto[]> {
  await businessConnection(db, actor, connectionId);
  const rows = (await db.mailConnectionMember.findMany({ where: { connectionId }, select: memberSelect, orderBy: [{ grantedAt: 'asc' }, { userId: 'asc' }] })) as MemberRow[];
  return rows.map(toMember);
}

/** Grants or changes READ/SEND for an active member of the business. Idempotent for the same access. */
export async function setMember(db: AppTenantDb, actor: ConnectionViewer, connectionId: string, userId: string, access: 'READ' | 'SEND'): Promise<MemberDto[]> {
  await businessConnection(db, actor, connectionId);
  const member = await db.membership.findFirst({ where: { userId, status: 'ACTIVE' }, select: { id: true } });
  if (!member) throw new RecordNotFoundError();
  const current = (await db.mailConnectionMember.findFirst({ where: { connectionId, userId }, select: memberSelect })) as MemberRow | null;
  if (current?.access === access) return listMembers(db, actor, connectionId);
  if (current) {
    const changed = await db.mailConnectionMember.updateMany({
      where: { connectionId, userId, version: current.version }, data: { access, grantedById: actor.userId, version: current.version + 1, updatedAt: new Date() },
    });
    if (changed.count !== 1) throw new StateConflictError('stale');
  } else {
    await db.mailConnectionMember.create({ data: { connectionId, userId, access, grantedById: actor.userId } as never });
  }
  await recordAudit(db, actor.userId, 'communications.member.granted', { type: 'mail_connection', id: connectionId }, {
    userId, access, previousAccess: current?.access ?? null,
  });
  return listMembers(db, actor, connectionId);
}

export async function removeMember(db: AppTenantDb, actor: ConnectionViewer, connectionId: string, userId: string): Promise<MemberDto[]> {
  await businessConnection(db, actor, connectionId);
  const removed = await db.mailConnectionMember.deleteMany({ where: { connectionId, userId } });
  if (removed.count === 0) throw new RecordNotFoundError();
  await recordAudit(db, actor.userId, 'communications.member.revoked', { type: 'mail_connection', id: connectionId }, { userId });
  return listMembers(db, actor, connectionId);
}

/**
 * Administration A2-B (C2 review Q3): a member is leaving the business, and their mail_connection_members
 * rows will cascade with the membership delete, which writes no audit. Records one
 * `communications.member.revoked` per grant first, as the acting member. Suspension keeps the rows (a
 * suspended member opens no tenant request, and reactivation restores access), so it does not call this.
 */
export async function recordMailboxAccessEnded(db: AppTenantDb, actorUserId: string, userId: string, cause: 'member_removed' | 'member_left'): Promise<number> {
  const rows = (await db.mailConnectionMember.findMany({ where: { userId }, select: { connectionId: true, access: true }, orderBy: { connectionId: 'asc' } })) as { connectionId: string; access: string }[];
  for (const r of rows) {
    await recordAudit(db, actorUserId, 'communications.member.revoked', { type: 'mail_connection', id: r.connectionId }, { userId, access: r.access, cause });
  }
  return rows.length;
}
