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

describe('Sales Zone permissions (docs/sales-data-model.md §5)', () => {
  it('every role reads and writes opportunities; only OWNER and ADMIN configure pipelines', () => {
    const matrix = Object.fromEntries(ROLES.map((role) => [role, ['sales:read', 'sales:write', 'sales:manage'].filter((p) => ROLE_PERMISSIONS[role].has(p as never))]));
    expect(matrix).toEqual({
      OWNER: ['sales:read', 'sales:write', 'sales:manage'],
      ADMIN: ['sales:read', 'sales:write', 'sales:manage'],
      MANAGER: ['sales:read', 'sales:write'],
      MEMBER: ['sales:read', 'sales:write'],
    });
    expect(ZONE_PERMISSIONS.sales).toEqual(['sales:read', 'sales:write', 'sales:manage']);
  });
});

describe('Projects Zone permissions (docs/projects-data-model.md §5)', () => {
  it('every role reads, creates, edits and manages tasks; only OWNER, ADMIN and MANAGER archive', () => {
    const keys = ZONE_PERMISSIONS.projects;
    expect(keys).toEqual(['projects:read', 'projects:create', 'projects:update', 'projects:archive', 'projects:manage_tasks']);
    const matrix = Object.fromEntries(ROLES.map((role) => [role, keys.filter((p) => ROLE_PERMISSIONS[role].has(p))]));
    expect(matrix).toEqual({
      OWNER: [...keys],
      ADMIN: [...keys],
      MANAGER: [...keys],
      MEMBER: ['projects:read', 'projects:create', 'projects:update', 'projects:manage_tasks'],
    });
  });

  it('checks are by permission key only: a principal without the key is refused whatever its role', () => {
    const readOnly: Principal = { role: 'OWNER', permissions: new Set(['projects:read']) };
    expect(can(readOnly, 'projects:read')).toBe(true);
    for (const p of ['projects:create', 'projects:update', 'projects:archive', 'projects:manage_tasks'] as const) {
      expect(() => authorize(readOnly, p)).toThrow(ForbiddenError);
    }
  });
});

describe('Finance Zone permissions (docs/finance-data-model.md §7.1, owner decision FD-P1)', () => {
  const FINANCE = ['finance:read', 'finance:write', 'finance:issue', 'finance:payments', 'finance:expenses', 'finance:manage'] as const;

  it('grants exactly the approved default matrix', () => {
    const matrix = Object.fromEntries(ROLES.map((role) => [role, FINANCE.filter((p) => ROLE_PERMISSIONS[role].has(p))]));
    expect(matrix).toEqual({
      OWNER: [...FINANCE],
      ADMIN: [...FINANCE],
      MANAGER: ['finance:read', 'finance:write', 'finance:expenses'],
      MEMBER: [],
    });
    expect(ZONE_PERMISSIONS.finance).toEqual([...FINANCE]);
  });

  it('is not implied by any other Zone: a role holding every customer, sales and project key may still have no finance key', () => {
    const member = ROLE_PERMISSIONS.MEMBER;
    for (const key of ['customers:read', 'customers:write', 'sales:read', 'sales:write', 'projects:read', 'projects:update'] as const) expect(member.has(key)).toBe(true);
    for (const key of FINANCE) expect(member.has(key)).toBe(false);
    // …and finance keys sit in their own namespace, so holding them implies nothing elsewhere.
    for (const key of FINANCE) expect(key.startsWith('finance:')).toBe(true);
  });
});

describe('People Zone permissions (docs/people-data-model.md §5, decision PD-1)', () => {
  const PEOPLE = ['people:read', 'people:read_sensitive', 'people:manage', 'people:configure'] as const;

  it('grants exactly the proposed default matrix: view and administer are separate keys', () => {
    const matrix = Object.fromEntries(ROLES.map((role) => [role, PEOPLE.filter((p) => ROLE_PERMISSIONS[role].has(p))]));
    expect(matrix).toEqual({ OWNER: [...PEOPLE], ADMIN: [...PEOPLE], MANAGER: ['people:read'], MEMBER: [] });
    expect(ZONE_PERMISSIONS.people).toEqual([...PEOPLE]);
  });

  it('is not implied by any other Zone and implies nothing elsewhere', () => {
    for (const key of PEOPLE) expect(ROLE_PERMISSIONS.MEMBER.has(key)).toBe(false);
    for (const key of PEOPLE) expect(key.startsWith('people:')).toBe(true);
    // Directory access never includes sensitive fields or administration.
    expect(ROLE_PERMISSIONS.MANAGER.has('people:read_sensitive')).toBe(false);
    expect(ROLE_PERMISSIONS.MANAGER.has('people:manage')).toBe(false);
  });
});

describe('Communications C1 permissions (docs/communications-c1.md §4)', () => {
  it('every role reads and records message history; only OWNER and ADMIN read restricted notes of others', () => {
    const keys = ['activity:read', 'activity:write', 'activity:read_restricted', 'communications:read', 'communications:record'] as const;
    const matrix = Object.fromEntries(ROLES.map((role) => [role, keys.filter((p) => ROLE_PERMISSIONS[role].has(p))]));
    expect(matrix).toEqual({
      OWNER: [...keys],
      ADMIN: [...keys],
      MANAGER: ['activity:read', 'activity:write', 'communications:read', 'communications:record'],
      MEMBER: ['activity:read', 'activity:write', 'communications:read', 'communications:record'],
    });
    expect(ZONE_PERMISSIONS.communications).toEqual(['communications:read', 'communications:record', 'communications:connect', 'communications:manage_connections']);
    expect(ZONE_PERMISSIONS.activity).toEqual(['activity:read', 'activity:write', 'activity:read_restricted']);
  });
});

describe('Communications C2-A permissions (docs/communications-c2.md §4, D-C2-2)', () => {
  it('OWNER, ADMIN and MANAGER connect their own mailbox; only OWNER and ADMIN manage every connection; MEMBER neither', () => {
    const keys = ['communications:connect', 'communications:manage_connections'] as const;
    const matrix = Object.fromEntries(ROLES.map((role) => [role, keys.filter((p) => ROLE_PERMISSIONS[role].has(p))]));
    expect(matrix).toEqual({
      OWNER: [...keys],
      ADMIN: [...keys],
      MANAGER: ['communications:connect'],
      MEMBER: [],
    });
  });
});
