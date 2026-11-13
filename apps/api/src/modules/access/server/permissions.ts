// Permission model (architecture §7.2, §13.2). Code checks PERMISSION KEYS, never roles.
//
// Keys are `<zone>:<action>`. Each Zone declares the keys it owns here; the registry is their
// union, so a typo is a type error. Future Zone-level grants (e.g. "this member may use the
// Customers zone only") and custom roles replace ROLE_PERMISSIONS with a lookup that still returns
// a set of these keys, so call sites do not change.

export const ZONE_PERMISSIONS = {
  business: ['business:read', 'business:manage', 'business:delete'],
  members: ['members:read', 'members:invite', 'members:manage'],
  audit: ['audit:read'],
  customers: ['customers:read', 'customers:write', 'customers:delete'],
  activity: ['activity:read', 'activity:write'],
} as const;

export type Zone = keyof typeof ZONE_PERMISSIONS;
export type Permission = (typeof ZONE_PERMISSIONS)[Zone][number];
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(ZONE_PERMISSIONS).flat();

export const ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] as const;
export type Role = (typeof ROLES)[number];

/** Higher rank = more authority. Used only by the role-assignment rules below, never for access. */
const RANK: Record<Role, number> = { OWNER: 4, ADMIN: 3, MANAGER: 2, MEMBER: 1 };

const DATA: Permission[] = ['customers:read', 'customers:write', 'customers:delete', 'activity:read', 'activity:write'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  // Created the business; manages everything, including other owners; only owners may delete
  // (archive) the business or, later, manage billing.
  OWNER: new Set(ALL_PERMISSIONS),
  // Manages members below owner and the business settings; full data access.
  ADMIN: new Set<Permission>(['business:read', 'business:manage', 'members:read', 'members:invite', 'members:manage', 'audit:read', ...DATA]),
  // Runs day-to-day work; can invite and manage MEMBERs only; no settings or audit log.
  MANAGER: new Set<Permission>(['business:read', 'members:read', 'members:invite', 'members:manage', ...DATA]),
  // Reads and writes business data; no member or settings management.
  MEMBER: new Set<Permission>(['business:read', 'members:read', 'customers:read', 'customers:write', 'activity:read', 'activity:write']),
};

export function permissionsFor(role: Role): Permission[] {
  return ALL_PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].has(p));
}

/** What a check is about. Reserved for record- and Zone-scoped rules; Phase 1 ignores it. */
export interface ResourceScope {
  zone?: Zone;
  type?: string;
  id?: string;
}

export interface Principal {
  readonly role: Role;
  readonly permissions: ReadonlySet<Permission>;
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'Not allowed') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export function can(principal: Principal, permission: Permission, resource?: ResourceScope): boolean {
  // Phase 1: role-level grants only. Zone- and record-scoped rules will narrow by `resource` here.
  void resource;
  return principal.permissions.has(permission);
}

/** Throws ForbiddenError unless the principal holds the permission. */
export function authorize(principal: Principal, permission: Permission, resource?: ResourceScope): void {
  if (!can(principal, permission, resource)) throw new ForbiddenError();
}

/**
 * May `actor` change or remove a membership whose current role is `target`?
 * Owners act on anyone (other owners included); everyone else only on roles strictly below their own.
 * Nobody acts on their own membership through member management.
 */
export function canManageMember(actor: Principal, target: Role, isSelf: boolean): boolean {
  if (isSelf || !can(actor, 'members:manage')) return false;
  return actor.role === 'OWNER' || RANK[target] < RANK[actor.role];
}

/**
 * May `actor` give someone the role `next` (by invitation or role change)? No escalation: only
 * roles strictly below the actor's own, except that an owner may make another owner. Invitations
 * never grant OWNER (the database rejects it too).
 */
export function canAssignRole(actor: Principal, next: Role, via: 'invite' | 'change'): boolean {
  const needed: Permission = via === 'invite' ? 'members:invite' : 'members:manage';
  if (!can(actor, needed)) return false;
  if (next === 'OWNER') return via === 'change' && actor.role === 'OWNER';
  return actor.role === 'OWNER' || RANK[next] < RANK[actor.role];
}
