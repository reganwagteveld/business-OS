import 'server-only';
// Membership and invitation services (data-model §4.3–4.4, architecture §7.2). Every function runs
// inside a tenant unit of work (AppTenantDb) and never sees or sets a business id: the scoped client
// adds it, and Row-Level Security enforces it again in the database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canAssignRole, canManageMember, ForbiddenError, type Principal, type Role } from '@/modules/access';
import type { AppTenantDb } from '@/core/db';

/** Who is acting: the verified membership of the signed-in user in the current business. */
export interface Actor extends Principal {
  readonly userId: string;
  readonly membershipId: string;
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Not found');
    this.name = 'NotFoundError';
  }
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_INVITATIONS = 50;

async function audit(db: AppTenantDb, actor: Actor, action: string, targetType: string, targetId: string, metadata: Record<string, string> = {}) {
  await db.auditEvent.create({ data: { id: randomUUID(), actorUserId: actor.userId, action, targetType, targetId, metadata } as never });
}

export async function getBusiness(db: AppTenantDb) {
  const business = await db.business.findFirst({ select: { slug: true, name: true, countryCode: true, timeZone: true, locale: true, currency: true } });
  if (!business) throw new NotFoundError();
  return business;
}

const memberSelect = { id: true, userId: true, role: true, status: true, createdAt: true, user: { select: { name: true } } } as const;
type MemberRow = { id: string; userId: string; role: Role; status: 'ACTIVE' | 'SUSPENDED'; createdAt: Date; user: { name: string | null } | null };
const toMember = (m: MemberRow) => ({ id: m.id, userId: m.userId, name: m.user?.name ?? null, role: m.role, status: m.status, createdAt: m.createdAt.toISOString() });

export async function listMembers(db: AppTenantDb) {
  const rows = (await db.membership.findMany({ select: memberSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) as MemberRow[];
  return rows.map(toMember);
}

async function findMember(db: AppTenantDb, membershipId: string) {
  const target = (await db.membership.findFirst({ where: { id: membershipId }, select: memberSelect })) as MemberRow | null;
  if (!target) throw new NotFoundError();
  return target;
}

/**
 * Changes a member's role. Rules (modules/access): only roles below the actor's own (owners may
 * act on anyone and make owners), never one's own membership. The database also blocks self role
 * changes and losing the last owner.
 */
export async function changeRole(db: AppTenantDb, actor: Actor, membershipId: string, role: Role) {
  const target = await findMember(db, membershipId);
  if (!canManageMember(actor, target.role, target.userId === actor.userId)) throw new ForbiddenError();
  if (!canAssignRole(actor, role, 'change')) throw new ForbiddenError();
  if (target.role === role) return toMember(target);
  const updated = (await db.membership.update({ where: { id: membershipId }, data: { role }, select: memberSelect })) as MemberRow;
  await audit(db, actor, 'membership.role_changed', 'membership', membershipId, { from: target.role, to: role });
  return toMember(updated);
}

/** Removes a member (same rules as changeRole). Access ends on their next request. */
export async function removeMember(db: AppTenantDb, actor: Actor, membershipId: string) {
  const target = await findMember(db, membershipId);
  if (!canManageMember(actor, target.role, target.userId === actor.userId)) throw new ForbiddenError();
  await db.membership.delete({ where: { id: membershipId } });
  await audit(db, actor, 'membership.removed', 'membership', membershipId, { role: target.role });
}

const toInvitation = (i: { id: string; email: string; role: Role; expiresAt: Date; createdAt: Date }) => ({
  id: i.id, email: i.email, role: i.role as Exclude<Role, 'OWNER'>, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString(),
});
const invitationSelect = { id: true, email: true, role: true, expiresAt: true, createdAt: true } as const;

/** Open invitations only (not accepted, revoked or expired). */
export async function listInvitations(db: AppTenantDb) {
  const rows = await db.invitation.findMany({
    where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    select: invitationSelect,
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toInvitation);
}

/**
 * Creates an invitation and returns the raw token ONCE, for the email link. Only its hash is stored.
 * The response never reveals whether the address already has an account or membership.
 */
export async function createInvitation(db: AppTenantDb, actor: Actor, email: string, role: Exclude<Role, 'OWNER'>) {
  if (!canAssignRole(actor, role, 'invite')) throw new ForbiddenError();
  const open = await db.invitation.count({ where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
  if (open >= MAX_OPEN_INVITATIONS) throw new ForbiddenError('Too many open invitations');
  const token = randomBytes(32).toString('base64url');
  const invitation = await db.invitation.create({
    data: {
      id: randomUUID(),
      email: email.toLowerCase(),
      role,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      invitedById: actor.userId,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    } as never,
    select: invitationSelect,
  });
  await audit(db, actor, 'invitation.created', 'invitation', invitation.id, { role });
  return { invitation: toInvitation(invitation), token };
}

/** Revokes an open invitation. Managers may revoke only invitations they could have sent. */
export async function revokeInvitation(db: AppTenantDb, actor: Actor, invitationId: string) {
  const invitation = await db.invitation.findFirst({ where: { id: invitationId, acceptedAt: null, revokedAt: null }, select: { id: true, role: true } });
  if (!invitation) throw new NotFoundError();
  if (!canAssignRole(actor, invitation.role as Role, 'invite')) throw new ForbiddenError();
  await db.invitation.update({ where: { id: invitationId }, data: { revokedAt: new Date() } });
  await audit(db, actor, 'invitation.revoked', 'invitation', invitationId);
}
