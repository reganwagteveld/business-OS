import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS, authorize, can, canAssignRole, canManageMember, ForbiddenError, permissionsFor, ROLE_PERMISSIONS, ROLES, ZONE_PERMISSIONS,
  type Principal, type Role,
} from '@/modules/access';

const as = (role: Role): Principal => ({ role, permissions: ROLE_PERMISSIONS[role] });

describe('permission registry', () => {
  it('namespaces every key by its zone and has no duplicates', () => {
    for (const [zone, keys] of Object.entries(ZONE_PERMISSIONS)) for (const k of keys) expect(k.startsWith(`${zone}:`)).toBe(true);
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('gives each role a strictly smaller set than the role above it', () => {
    const order: Role[] = ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'];
    for (let i = 1; i < order.length; i++) {
      const above = ROLE_PERMISSIONS[order[i - 1]!];
      const below = ROLE_PERMISSIONS[order[i]!];
      expect([...below].every((p) => above.has(p))).toBe(true);
      expect(below.size).toBeLessThan(above.size);
    }
  });

  it('matches the documented role table', () => {
    expect(permissionsFor('OWNER')).toEqual(ALL_PERMISSIONS);
    expect(can(as('ADMIN'), 'business:manage')).toBe(true);
    expect(can(as('MANAGER'), 'business:manage')).toBe(false);
    expect(can(as('MANAGER'), 'audit:read')).toBe(false);
    expect(can(as('MANAGER'), 'members:invite')).toBe(true);
    expect(can(as('MEMBER'), 'members:invite')).toBe(false);
    expect(can(as('MEMBER'), 'members:manage')).toBe(false);
    expect(can(as('MEMBER'), 'customers:delete')).toBe(false);
    expect(can(as('MEMBER'), 'customers:write')).toBe(true);
  });

  it('authorize throws ForbiddenError and accepts a reserved resource scope', () => {
    expect(() => authorize(as('MEMBER'), 'members:manage')).toThrow(ForbiddenError);
    expect(() => authorize(as('ADMIN'), 'customers:read', { zone: 'customers', id: 'x' })).not.toThrow();
  });
});

describe('no privilege escalation', () => {
  it('nobody manages their own membership', () => {
    for (const role of ROLES) expect(canManageMember(as(role), role, true)).toBe(false);
  });

  it('only owners act on owners; others act only below their own rank', () => {
    expect(canManageMember(as('OWNER'), 'OWNER', false)).toBe(true);
    expect(canManageMember(as('ADMIN'), 'OWNER', false)).toBe(false);
    expect(canManageMember(as('ADMIN'), 'ADMIN', false)).toBe(false);
    expect(canManageMember(as('ADMIN'), 'MANAGER', false)).toBe(true);
    expect(canManageMember(as('MANAGER'), 'MANAGER', false)).toBe(false);
    expect(canManageMember(as('MANAGER'), 'MEMBER', false)).toBe(true);
    expect(canManageMember(as('MEMBER'), 'MEMBER', false)).toBe(false);
  });

  it('roles can only be given below the giver, except owner → owner by role change', () => {
    const table: Array<[Role, Role, 'invite' | 'change', boolean]> = [
      ['OWNER', 'OWNER', 'change', true], ['OWNER', 'OWNER', 'invite', false], ['OWNER', 'ADMIN', 'invite', true],
      ['ADMIN', 'OWNER', 'change', false], ['ADMIN', 'ADMIN', 'invite', false], ['ADMIN', 'ADMIN', 'change', false],
      ['ADMIN', 'MANAGER', 'invite', true], ['ADMIN', 'MEMBER', 'change', true],
      ['MANAGER', 'MANAGER', 'invite', false], ['MANAGER', 'ADMIN', 'change', false], ['MANAGER', 'MEMBER', 'invite', true],
      ['MEMBER', 'MEMBER', 'invite', false], ['MEMBER', 'MEMBER', 'change', false],
    ];
    for (const [actor, next, via, expected] of table) expect(canAssignRole(as(actor), next, via), `${actor} → ${next} (${via})`).toBe(expected);
  });
});
