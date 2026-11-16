import 'server-only';
// Membership and invitation services (data-model §4.3–4.4, architecture §7.2, docs/administration-a2.md
// §3.5–3.11 and §6). Every function runs inside a tenant unit of work (AppTenantDb) and never sees or
// sets a business id: the scoped client adds it, and Row-Level Security enforces it again.
//
// A2-B rules that hold for every membership-changing function here:
//  1. The acting member is re-read and locked FOR SHARE inside the transaction (lockActor) and every
//     rank rule uses that fresh role, never the one resolved before the transaction opened (§3.11).
//  2. The target membership is locked FOR UPDATE before its role or status is read, so a concurrent
//     change to the target (a promotion, a suspension) either commits first and is seen, or waits.
//  3. The database backs the rules: actor rules and self rules (memberships_no_self_role_change), and
//     the last-owner check at commit under a per-business lock (memberships_keep_an_owner, §6.1).
//  4. A member who loses mailbox-holder authority (removal, suspension, leaving, demotion) has their held
//     mailbox credentials revoked in the same transaction (Communications revokeHeldConnections, §3.10).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { canAssignRole, canManageMember, ForbiddenError, type Role } from '@/modules/access';
import type { AppTenantDb } from '@/core/db';
import { RateLimitedError, sqlState, StateConflictError } from '@/core/http/errors';
import { recordMailboxAccessEnded, revokeHeldConnections, type HolderCutoffCause } from '@/modules/communications';
import { unlinkRemovedMember } from '@/modules/people';
import { lockActor, type Actor } from './actor';

export type { Actor } from './actor';

export class NotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Not found');
    this.name = 'NotFoundError';
  }
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_INVITATIONS = 50;
/** D-A2-13: at most one resend per invitation per 60 seconds. */
const RESEND_INTERVAL_SECONDS = 60;

async function audit(db: AppTenantDb, actor: Actor, action: string, targetType: string, targetId: string, metadata: Record<string, string | boolean | string[]> = {}) {
  await db.auditEvent.create({ data: { id: randomUUID(), actorUserId: actor.userId, action, targetType, targetId, metadata } as never });
}

export async function getBusiness(db: AppTenantDb) {
  const business = await db.business.findFirst({ select: { slug: true, name: true, countryCode: true, timeZone: true, locale: true, currency: true } });
  if (!business) throw new NotFoundError();
  return business;
}

// ---- Members -----------------------------------------------------------------------------------

type Status = 'ACTIVE' | 'SUSPENDED';
const memberSelect = { id: true, userId: true, role: true, status: true, createdAt: true, suspendedAt: true, user: { select: { name: true } } } as const;
type MemberRow = { id: string; userId: string; role: Role; status: Status; createdAt: Date; suspendedAt: Date | null; user: { name: string | null } | null };

export interface MemberDto {
  id: string; userId: string; name: string | null; role: Role; status: Status; createdAt: string; suspendedAt: string | null;
  /** Present only for holders of members:invite (D-A2-11). */
  email?: string | null;
}

const toMember = (m: MemberRow, emails?: Map<string, string>): MemberDto => ({
  id: m.id, userId: m.userId, name: m.user?.name ?? null, role: m.role, status: m.status, createdAt: m.createdAt.toISOString(),
  suspendedAt: m.suspendedAt?.toISOString() ?? null,
  ...(emails ? { email: emails.get(m.userId) ?? null } : {}),
});

/**
 * Emails of this business's members, through app_private.member_emails() (privileged SQL 005): the
 * function reads the business and the session user from the unit of work and answers only when that
 * user is an active OWNER, ADMIN or MANAGER. bos_app itself still cannot read users.email.
 */
async function memberEmails(db: AppTenantDb): Promise<Map<string, string>> {
  const rows = await db.$queryRaw<{ user_id: string; email: string }[]>`SELECT user_id::text AS user_id, email FROM app_private.member_emails()`;
  return new Map(rows.map((r) => [r.user_id, r.email]));
}

export async function listMembers(db: AppTenantDb, actor?: Actor) {
  const rows = (await db.membership.findMany({ select: memberSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) as MemberRow[];
  const emails = actor?.permissions.has('members:invite') ? await memberEmails(db) : undefined;
  return rows.map((m) => toMember(m, emails));
}

async function readMember(db: AppTenantDb, membershipId: string): Promise<MemberRow> {
  const row = (await db.membership.findFirst({ where: { id: membershipId }, select: memberSelect })) as MemberRow | null;
  if (!row) throw new NotFoundError();
  return row;
}

type Locked = { id: string; userId: string; role: Role; status: Status };

/**
 * Locks a membership of this business FOR UPDATE and returns its CURRENT role and status (read after
 * the lock, so a change that committed while this waited is seen). 404 for another business's id.
 */
async function lockMember(db: AppTenantDb, membershipId: string): Promise<Locked> {
  const rows = await db.$queryRaw<{ id: string; user_id: string; role: Role; status: Status }[]>`
    SELECT id::text AS id, user_id::text AS user_id, role::text AS role, status::text AS status FROM memberships
     WHERE id = ${membershipId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
     FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new NotFoundError();
  return { id: row.id, userId: row.user_id, role: row.role, status: row.status };
}

/** Another ACTIVE owner exists (the self step-down and leave pre-check; the commit trigger is the guarantee). */
async function hasAnotherActiveOwner(db: AppTenantDb, userId: string): Promise<boolean> {
  return (await db.membership.count({ where: { role: 'OWNER', status: 'ACTIVE', NOT: { userId } } })) > 0;
}

/**
 * Changes a member's role. Rules (modules/access): only roles below the actor's own (owners may act on
 * anyone and make owners), never one's own membership. Making an OWNER needs an ACTIVE target. A
 * demotion that drops mailbox-holder authority revokes the member's held mailbox credentials.
 */
export async function changeRole(db: AppTenantDb, actor: Actor, membershipId: string, role: Role) {
  const me = await lockActor(db, actor, 'members:manage');
  const target = await lockMember(db, membershipId);
  if (!canManageMember(me, target.role, target.userId === me.userId)) throw new ForbiddenError();
  if (!canAssignRole(me, role, 'change')) throw new ForbiddenError();
  if (target.role === role) return toMember(await readMember(db, membershipId));
  if (role === 'OWNER' && target.status !== 'ACTIVE') throw new StateConflictError('member_not_active');
  await db.membership.update({ where: { id: membershipId }, data: { role } });
  await audit(db, me, 'membership.role_changed', 'membership', membershipId, { from: target.role, to: role });
  if (target.status === 'ACTIVE') await revokeHeldConnections(db, me.userId, target.userId, 'member_demoted', role);
  return toMember(await readMember(db, membershipId));
}

/**
 * Suspends or reactivates a member (§3.8). Same rank rules as a role change; nobody changes their own
 * status (also blocked in the database). Suspension ends access at the next request
 * (my_memberships ignores SUSPENDED), keeps assignments, history and mailbox access rows, and revokes
 * the member's held mailbox credentials now. Reactivation restores access but not credentials: the
 * member reconnects their mailboxes. Suspending the last active owner fails at commit (409 last_owner).
 */
export async function setMemberStatus(db: AppTenantDb, actor: Actor, membershipId: string, status: Status) {
  const me = await lockActor(db, actor, 'members:manage');
  const target = await lockMember(db, membershipId);
  if (!canManageMember(me, target.role, target.userId === me.userId)) throw new ForbiddenError();
  if (target.status === status) return toMember(await readMember(db, membershipId));
  if (status === 'SUSPENDED') {
    await db.membership.update({ where: { id: membershipId }, data: { status, suspendedAt: new Date(), suspendedBy: me.userId } as never });
    await audit(db, me, 'membership.suspended', 'membership', membershipId, { role: target.role });
    await revokeHeldConnections(db, me.userId, target.userId, 'member_suspended', null);
  } else {
    await db.membership.update({ where: { id: membershipId }, data: { status, suspendedAt: null, suspendedBy: null } as never });
    await audit(db, me, 'membership.reactivated', 'membership', membershipId, { role: target.role });
  }
  return toMember(await readMember(db, membershipId));
}

/**
 * Everything that must happen before a membership row is deleted (removal or leaving). The row is
 * already locked FOR UPDATE: an assignment to this person that is already in flight (its foreign-key
 * check holds a KEY SHARE lock on the row) committed before the lock was granted, so the clean-up sees
 * it; one that starts later waits for this transaction and then fails its foreign key.
 */
async function departMember(db: AppTenantDb, actorUserId: string, target: Locked, cause: Extract<HolderCutoffCause, 'member_removed' | 'member_left'>) {
  // Mailbox credentials first (connections → jobs → credentials, docs/administration-a2.md §3.10).
  const stopped = await revokeHeldConnections(db, actorUserId, target.userId, cause, null);
  // Customers they own keep existing but lose the owner: the (business_id, owner_user_id) FK to
  // memberships would otherwise block the removal.
  await db.customer.updateMany({ where: { ownerUserId: target.userId }, data: { ownerUserId: null } as never });
  await db.opportunity.updateMany({ where: { ownerUserId: target.userId }, data: { ownerUserId: null } as never });
  // Project owners and task assignees too (version bumped, so an edit prepared before is refused as stale).
  await db.project.updateMany({ where: { ownerUserId: target.userId }, data: { ownerUserId: null, version: { increment: 1 } } as never });
  // Task rows are locked in id order first, the same order as a board renumber
  // (projects/server/tasks.ts), so this multi-row update can never deadlock with one.
  await db.$queryRaw`SELECT id FROM project_tasks WHERE assignee_user_id = ${target.userId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid ORDER BY id FOR UPDATE`;
  await db.projectTask.updateMany({ where: { assigneeUserId: target.userId }, data: { assigneeUserId: null, version: { increment: 1 } } as never });
  // An employee record linked to this person stays; only the link goes (people_employees_user_fkey).
  await unlinkRemovedMember(db, actorUserId, target.userId);
  // Their access to shared business mailboxes cascades with the membership; record it first (C2 Q3).
  await recordMailboxAccessEnded(db, actorUserId, target.userId, cause);
  return stopped;
}

/** Removes a member (same rules as changeRole). Access ends on their next request. */
export async function removeMember(db: AppTenantDb, actor: Actor, membershipId: string) {
  const me = await lockActor(db, actor, 'members:manage');
  const target = await lockMember(db, membershipId);
  if (!canManageMember(me, target.role, target.userId === me.userId)) throw new ForbiddenError();
  const stopped = await departMember(db, me.userId, target, 'member_removed');
  await db.membership.delete({ where: { id: membershipId } });
  await audit(db, me, 'membership.removed', 'membership', membershipId, { role: target.role, userId: target.userId, mailboxesStopped: stopped });
}

/**
 * The caller leaves this business (D-A2-10). Any member may, except the last active owner (409
 * last_owner; also enforced at commit). Same clean-up as a removal, attributed to the leaver.
 */
export async function leaveBusiness(db: AppTenantDb, actor: Actor) {
  const me = await lockActor(db, actor, 'business:read');
  const self = await lockMember(db, me.membershipId);
  if (self.role === 'OWNER' && !(await hasAnotherActiveOwner(db, me.userId))) throw new StateConflictError('last_owner');
  const stopped = await departMember(db, me.userId, self, 'member_left');
  await db.membership.delete({ where: { id: self.id } });
  await audit(db, me, 'membership.left', 'membership', self.id, { role: self.role, mailboxesStopped: stopped });
}

/**
 * Ownership transfer (§3.7, D-A2-8, requirement 2): one transaction, OWNER only (re-checked on the
 * locked actor row), explicitly confirmed (the contract requires `confirm: true`), audited. The target
 * must be another ACTIVE member who is not already an owner. With `stepDown`, the caller becomes
 * ADMIN in the same transaction; OWNER → ADMIN keeps mailbox-holder authority, so no credentials
 * change. Concurrent owner changes are serialised by the last-owner trigger at commit.
 */
export async function transferOwnership(db: AppTenantDb, actor: Actor, membershipId: string, opts: { stepDown: boolean }) {
  const me = await lockActor(db, actor, 'members:manage');
  if (me.role !== 'OWNER') throw new ForbiddenError();
  if (membershipId === me.membershipId) throw new ForbiddenError();
  const target = await lockMember(db, membershipId);
  if (target.userId === me.userId) throw new ForbiddenError();
  if (target.status !== 'ACTIVE') throw new StateConflictError('member_not_active');
  if (target.role === 'OWNER') throw new StateConflictError('already_owner');
  // Lock the caller's own row for the step-down (lockActor holds FOR SHARE; upgrade to FOR UPDATE).
  if (opts.stepDown) await lockMember(db, me.membershipId);
  await db.membership.update({ where: { id: target.id }, data: { role: 'OWNER' } });
  await audit(db, me, 'membership.ownership_transferred', 'membership', target.id, {
    from: target.role, to: 'OWNER', fromUserId: me.userId, toUserId: target.userId, stepDown: opts.stepDown,
  });
  if (opts.stepDown) {
    await db.membership.update({ where: { id: me.membershipId }, data: { role: 'ADMIN' } });
    await audit(db, me, 'membership.owner_stepped_down', 'membership', me.membershipId, { from: 'OWNER', to: 'ADMIN', via: 'transfer' });
    await revokeHeldConnections(db, me.userId, me.userId, 'member_demoted', 'ADMIN');
  }
  return toMember(await readMember(db, target.id));
}

/** An owner steps down to ADMIN while another ACTIVE owner remains (§3.7). */
export async function stepDown(db: AppTenantDb, actor: Actor) {
  const me = await lockActor(db, actor, 'business:read');
  if (me.role !== 'OWNER') throw new ForbiddenError();
  await lockMember(db, me.membershipId);
  if (!(await hasAnotherActiveOwner(db, me.userId))) throw new StateConflictError('last_owner');
  await db.membership.update({ where: { id: me.membershipId }, data: { role: 'ADMIN' } });
  await audit(db, me, 'membership.owner_stepped_down', 'membership', me.membershipId, { from: 'OWNER', to: 'ADMIN', via: 'step_down' });
  await revokeHeldConnections(db, me.userId, me.userId, 'member_demoted', 'ADMIN');
  return toMember(await readMember(db, me.membershipId));
}

// ---- Invitations -------------------------------------------------------------------------------

type InvitationRow = { id: string; email: string; role: Role; expiresAt: Date; createdAt: Date };
const toInvitation = (i: InvitationRow) => ({
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

/** Inserts a new open invitation; the raw token is returned ONCE, for the email link. Only its hash is stored. */
async function issueInvitation(db: AppTenantDb, actor: Actor, email: string, role: Exclude<Role, 'OWNER'>) {
  const token = randomBytes(32).toString('base64url');
  try {
    const invitation = (await db.invitation.create({
      data: {
        id: randomUUID(), email, role,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        invitedById: actor.userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      } as never,
      select: invitationSelect,
    })) as InvitationRow;
    return { invitation: toInvitation(invitation), token };
  } catch (error) {
    // invitations_open_email_key: a concurrent invitation to the same address won (D-A2-7). The token
    // hash is 256 random bits, so a unique violation here is never a token collision in practice.
    if (sqlState(error) === '23505' || (error as { code?: string } | null)?.code === 'P2002') throw new StateConflictError('invitation_exists');
    throw error;
  }
}

/**
 * Creates an invitation (D-A2-5..7). One open invitation per address: an expired open one is closed
 * first (revoked, audited as expired), a live one answers 409 invitation_exists, and an address that
 * already belongs to a member of THIS business answers 409 already_member (nothing is revealed about
 * other businesses or accounts). The raw token is returned once, for the email.
 */
export async function createInvitation(db: AppTenantDb, actor: Actor, rawEmail: string, role: Exclude<Role, 'OWNER'>) {
  const me = await lockActor(db, actor, 'members:invite');
  if (!canAssignRole(me, role, 'invite')) throw new ForbiddenError();
  const email = rawEmail.toLowerCase();
  if ([...(await memberEmails(db)).values()].some((e) => e.toLowerCase() === email)) throw new StateConflictError('already_member');
  const expired = await db.$queryRaw<{ id: string }[]>`
    UPDATE invitations SET revoked_at = now()
     WHERE business_id = nullif(current_setting('app.business_id', true), '')::uuid AND email = ${email}
       AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()
    RETURNING id::text AS id`;
  for (const row of expired) await audit(db, me, 'invitation.revoked', 'invitation', row.id, { reason: 'expired' });
  const open = await db.invitation.findFirst({ where: { email, acceptedAt: null, revokedAt: null }, select: { id: true } });
  if (open) throw new StateConflictError('invitation_exists');
  const count = await db.invitation.count({ where: { acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } });
  if (count >= MAX_OPEN_INVITATIONS) throw new ForbiddenError('Too many open invitations');
  const issued = await issueInvitation(db, me, email, role);
  await audit(db, me, 'invitation.created', 'invitation', issued.invitation.id, { role });
  return issued;
}

type OpenInvitation = { id: string; email: string; role: Exclude<Role, 'OWNER'>; recent: boolean };

/**
 * Locks an invitation that is still open (not accepted, not revoked; it may have expired) FOR UPDATE.
 * Acceptance (app_private.accept_invitation) locks the same row, so revoke/resend and accept are
 * mutually exclusive: if acceptance committed first, the re-checked row is no longer open and this
 * answers 409 invitation_closed; if this locked first, acceptance waits and then finds it revoked.
 */
async function lockOpenInvitation(db: AppTenantDb, invitationId: string): Promise<OpenInvitation> {
  const rows = await db.$queryRaw<{ id: string; email: string; role: Exclude<Role, 'OWNER'>; accepted: boolean; revoked: boolean; recent: boolean }[]>`
    SELECT id::text AS id, email, role::text AS role, accepted_at IS NOT NULL AS accepted, revoked_at IS NOT NULL AS revoked,
           created_at > now() - make_interval(secs => ${RESEND_INTERVAL_SECONDS}::int) AS recent
      FROM invitations
     WHERE id = ${invitationId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
     FOR UPDATE`;
  const row = rows[0];
  if (!row) throw new NotFoundError();
  if (row.accepted || row.revoked) throw new StateConflictError('invitation_closed');
  return { id: row.id, email: row.email, role: row.role, recent: row.recent };
}

/** Marks a locked open invitation revoked; conditional, so it can never overwrite an acceptance (G2). */
async function closeInvitation(db: AppTenantDb, invitationId: string): Promise<void> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    UPDATE invitations SET revoked_at = now()
     WHERE id = ${invitationId}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
       AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING id::text AS id`;
  if (rows.length !== 1) throw new StateConflictError('invitation_closed');
}

/** Revokes an open invitation. Managers may revoke only invitations they could have sent. */
export async function revokeInvitation(db: AppTenantDb, actor: Actor, invitationId: string) {
  const me = await lockActor(db, actor, 'members:invite');
  const invitation = await lockOpenInvitation(db, invitationId);
  if (!canAssignRole(me, invitation.role, 'invite')) throw new ForbiddenError();
  await closeInvitation(db, invitation.id);
  await audit(db, me, 'invitation.revoked', 'invitation', invitation.id);
}

/**
 * Resend = revoke and reissue (D-A2-6): the old link stops working at once, a new invitation with a
 * new token and a new 7-day expiry replaces it (same email and role), history stays append-only. At
 * most once per 60 seconds per invitation (429). Works for an expired open invitation too.
 */
export async function resendInvitation(db: AppTenantDb, actor: Actor, invitationId: string) {
  const me = await lockActor(db, actor, 'members:invite');
  const old = await lockOpenInvitation(db, invitationId);
  if (!canAssignRole(me, old.role, 'invite')) throw new ForbiddenError();
  if (old.recent) throw new RateLimitedError();
  await closeInvitation(db, old.id);
  await audit(db, me, 'invitation.revoked', 'invitation', old.id, { reason: 'resent' });
  const issued = await issueInvitation(db, me, old.email, old.role);
  await audit(db, me, 'invitation.resent', 'invitation', issued.invitation.id, { role: old.role, replaces: old.id });
  return issued;
}
