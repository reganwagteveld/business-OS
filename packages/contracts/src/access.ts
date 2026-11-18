import { z } from 'zod';
import { InvitableRole, Role } from './tenancy.ts';

// Administration A2-C (docs/administration-a2.md §3.1, §5, §7): the roles and access model, read-only.
// Pixa OS has four fixed roles (owner decision D-A2-1). This describes them for the Settings "Roles & access"
// page; nothing here can be changed through the API, and there are no custom roles (`customRoles: false`).
// The server is the only authority: every route checks its own permission key on every request, whatever
// this description says.

/** A permission key, `<zone>:<action>` (apps/api modules/access). */
const PermissionKey = z.string().regex(/^[a-z]+:[a-z_]+$/);
const ZoneKey = z.string().regex(/^[a-z]+$/);
const Text = z.string().min(1).max(400);

export const AccessPermission = z.object({ key: PermissionKey, label: Text, description: Text }).strict();
export type AccessPermission = z.infer<typeof AccessPermission>;

/** One area of Pixa OS and the keys it owns, in the server's registry order. */
export const AccessZone = z.object({ zone: ZoneKey, label: Text, permissions: z.array(AccessPermission).min(1) }).strict();
export type AccessZone = z.infer<typeof AccessZone>;

export const AccessRole = z
  .object({
    role: Role,
    label: Text,
    description: Text,
    /** Every key the role holds, in registry order. */
    permissions: z.array(PermissionKey),
    /** Roles this role may give by invitation (never OWNER). */
    canInvite: z.array(InvitableRole),
    /** Roles this role may give by a role change. */
    canAssign: z.array(Role),
    /** Current roles of other members this role may change, suspend, reactivate or remove (never one's own membership). */
    canManage: z.array(Role),
  })
  .strict();
export type AccessRole = z.infer<typeof AccessRole>;

/** Rules that belong to a role itself rather than to a permission key. */
export const AccessRoleRuleId = z.enum(['transfer_ownership', 'step_down', 'attest_business_mailbox', 'leave_business']);
export const AccessRoleRule = z.object({ id: AccessRoleRuleId, roles: z.array(Role).min(1), description: Text }).strict();
export type AccessRoleRule = z.infer<typeof AccessRoleRule>;

export const AccessRolesResponse = z
  .object({
    /** Fixed roles only. A later custom-roles design would change these, under a new architecture decision. */
    model: z.object({ customRoles: z.literal(false), editable: z.literal(false) }).strict(),
    /** Highest authority first: OWNER, ADMIN, MANAGER, MEMBER. */
    roles: z.array(AccessRole).length(4),
    zones: z.array(AccessZone).min(1),
    rules: z.array(AccessRoleRule),
  })
  .strict();
export type AccessRolesResponse = z.infer<typeof AccessRolesResponse>;
