/**
 * Administration A2-C (docs/administration-a2.md §3.1, §5, §7). Two things:
 * 1. The whole role → key matrix is pinned here, so any grant change shows up as a failing test and a reviewable
 *    diff (D-A2-1: no role or grant changes in A2).
 * 2. The read-only description served by GET /b/{slug}/access/roles matches the contract and agrees with what the
 *    server enforces, because it is computed from the same grants and rank rules.
 */
import { describe, expect, it } from 'vitest';
import { AccessRolesResponse, endpoints } from '@business-os/contracts';
import {
  ALL_PERMISSIONS, canAssignRole, canManageMember, describeAccessModel, ROLE_PERMISSIONS, ROLES, ZONE_PERMISSIONS,
  type Permission, type Principal, type Role,
} from '@/modules/access';
import { PERMISSION_TEXT, ROLE_TEXT, ZONE_LABELS } from '@/modules/access/server/catalog';

const as = (role: Role): Principal => ({ role, permissions: ROLE_PERMISSIONS[role] });

/** What each role does NOT hold. Shorter than the grants, and every key outside it is granted. */
const WITHHELD: Record<Role, Permission[]> = {
  OWNER: [],
  ADMIN: ['business:delete'],
  MANAGER: [
    'business:manage', 'business:delete', 'audit:read', 'activity:read_restricted', 'sales:manage',
    'finance:issue', 'finance:payments', 'finance:manage', 'finance:documents_branding', 'finance:billing', 'finance:catalog',
    'people:read_sensitive', 'people:manage', 'people:configure', 'communications:manage_connections', 'reporting:manage',
  ],
  MEMBER: [
    'business:manage', 'business:delete', 'members:invite', 'members:manage', 'audit:read', 'customers:delete', 'activity:read_restricted',
    'sales:manage', 'projects:archive',
    'finance:read', 'finance:write', 'finance:issue', 'finance:payments', 'finance:expenses', 'finance:manage', 'finance:documents_preview',
    'finance:documents_generate', 'finance:documents_download', 'finance:documents_branding', 'finance:billing', 'finance:catalog',
    'people:read', 'people:read_sensitive', 'people:manage', 'people:configure',
    'scheduling:manage_calendars', 'scheduling:manage_resources', 'communications:connect', 'communications:manage_connections',
    'reporting:share', 'reporting:manage',
  ],
};

describe('role matrix is pinned (docs/administration-a2.md §5)', () => {
  it('the registry has exactly the 51 known keys', () => {
    expect(ALL_PERMISSIONS).toHaveLength(51);
  });

  it('each role holds exactly every key except the withheld ones', () => {
    for (const role of ROLES) {
      const expected = ALL_PERMISSIONS.filter((key) => !WITHHELD[role].includes(key));
      expect([...ROLE_PERMISSIONS[role]].sort(), role).toEqual([...expected].sort());
      for (const key of WITHHELD[role]) expect(ALL_PERMISSIONS, `${role} withholds unknown key ${key}`).toContain(key);
    }
  });

  it('every role can open the business and see the team (Roles & access is readable by all)', () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role].has('business:read')).toBe(true);
      expect(ROLE_PERMISSIONS[role].has('members:read')).toBe(true);
    }
  });
});

describe('access model description (GET /b/{slug}/access/roles)', () => {
  const model = describeAccessModel();

  it('is registered in the contracts and parses against its schema', () => {
    expect(endpoints.listAccessRoles).toMatchObject({ method: 'GET', path: '/api/v1/b/:slug/access/roles' });
    expect(() => AccessRolesResponse.parse(model)).not.toThrow();
  });

  it('declares fixed, non-editable roles only', () => {
    expect(model.model).toEqual({ customRoles: false, editable: false });
    expect(AccessRolesResponse.safeParse({ ...model, model: { customRoles: true, editable: false } }).success).toBe(false);
    expect(AccessRolesResponse.safeParse({ ...model, model: { customRoles: false, editable: true } }).success).toBe(false);
  });

  it('lists the four roles highest first, each with exactly the keys the server grants', () => {
    expect(model.roles.map((r) => r.role)).toEqual(['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']);
    for (const r of model.roles) {
      expect(r.permissions).toEqual(ALL_PERMISSIONS.filter((key) => ROLE_PERMISSIONS[r.role].has(key)));
      expect(r.label).toBe(ROLE_TEXT[r.role].label);
    }
  });

  it('states who each role may invite, assign and manage, matching the enforced rank rules', () => {
    const summary = Object.fromEntries(model.roles.map((r) => [r.role, { canInvite: r.canInvite, canAssign: r.canAssign, canManage: r.canManage }]));
    expect(summary).toEqual({
      OWNER: { canInvite: ['ADMIN', 'MANAGER', 'MEMBER'], canAssign: ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'], canManage: ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'] },
      ADMIN: { canInvite: ['MANAGER', 'MEMBER'], canAssign: ['MANAGER', 'MEMBER'], canManage: ['MANAGER', 'MEMBER'] },
      MANAGER: { canInvite: ['MEMBER'], canAssign: ['MEMBER'], canManage: ['MEMBER'] },
      MEMBER: { canInvite: [], canAssign: [], canManage: [] },
    });
    for (const r of model.roles) {
      for (const next of ROLES) {
        expect(r.canInvite.includes(next as never), `${r.role} invite ${next}`).toBe(canAssignRole(as(r.role), next, 'invite'));
        expect(r.canAssign.includes(next), `${r.role} assign ${next}`).toBe(canAssignRole(as(r.role), next, 'change'));
        expect(r.canManage.includes(next), `${r.role} manage ${next}`).toBe(canManageMember(as(r.role), next, false));
      }
    }
  });

  it('describes every Zone and every key once, in registry order, with text', () => {
    expect(model.zones.map((z) => z.zone)).toEqual(Object.keys(ZONE_PERMISSIONS));
    expect(model.zones.flatMap((z) => z.permissions.map((p) => p.key))).toEqual(ALL_PERMISSIONS);
    for (const z of model.zones) {
      expect(z.label).toBe(ZONE_LABELS[z.zone as keyof typeof ZONE_LABELS]);
      for (const p of z.permissions) {
        expect(p.label.length).toBeGreaterThan(0);
        expect(p.description).toBe(PERMISSION_TEXT[p.key as Permission].description);
      }
    }
  });

  it('lists the role-only rules: transfer, step-down and mailbox attestation are OWNER only; everyone may leave', () => {
    expect(Object.fromEntries(model.rules.map((r) => [r.id, r.roles]))).toEqual({
      transfer_ownership: ['OWNER'],
      step_down: ['OWNER'],
      attest_business_mailbox: ['OWNER'],
      leave_business: ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER'],
    });
  });

  it('is identical on every call and carries no tenant or user data', () => {
    expect(describeAccessModel()).toEqual(model);
    const text = JSON.stringify(model);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i); // no ids
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]/i); // no email addresses
  });
});
