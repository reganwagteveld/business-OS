// Public API of the access module (architecture §7.2): permission keys, role → permission map and
// the checks every protected operation uses. No database access: roles come from the tenant context.
export {
  ALL_PERMISSIONS, ForbiddenError, ROLE_PERMISSIONS, ROLES, ZONE_PERMISSIONS,
  authorize, can, canAssignRole, canManageMember, permissionsFor,
} from './server/permissions';
export type { Permission, Principal, ResourceScope, Role, Zone } from './server/permissions';
