import type { Role } from '@business-os/contracts';

/**
 * PRESENTATION ONLY. These mirror the server's rank rules (apps/api modules/access `canManageMember`
 * and `canAssignRole`) so the screen offers what the server is likely to accept and nothing else. The
 * server re-checks every action inside its transaction and is the only authority: a stale role here
 * just produces a 403 the screen explains.
 */
const RANK: Record<Role, number> = { OWNER: 4, ADMIN: 3, MANAGER: 2, MEMBER: 1 };
export const ROLE_LABEL: Record<Role, string> = { OWNER: 'Owner', ADMIN: 'Admin', MANAGER: 'Manager', MEMBER: 'Member' };
export const ROLE_ORDER: readonly Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'];

export interface Actor { role: Role; permissions: readonly string[] }

export function canManageMember(actor: Actor, target: Role, isSelf: boolean): boolean {
  if (isSelf || !actor.permissions.includes('members:manage')) return false;
  return actor.role === 'OWNER' || RANK[target] < RANK[actor.role];
}

export function canAssignRole(actor: Actor, next: Role, via: 'invite' | 'change'): boolean {
  if (!actor.permissions.includes(via === 'invite' ? 'members:invite' : 'members:manage')) return false;
  if (next === 'OWNER') return via === 'change' && actor.role === 'OWNER';
  return actor.role === 'OWNER' || RANK[next] < RANK[actor.role];
}

export const assignableRoles = (actor: Actor, via: 'invite' | 'change'): Role[] => ROLE_ORDER.filter((role) => canAssignRole(actor, role, via));
