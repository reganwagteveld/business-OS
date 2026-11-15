// Public API of the people module (docs/people-data-model.md). Routes import only from here. No other
// domain module may use it, except tenancy for the member-removal clean-up (unlinkRemovedMember); this
// is enforced by tests/unit/people-boundaries.test.ts.
export { createEmployee, getEmployee, listEmployees, updateEmployee } from './server/employees';
export type { EmployeeQuery } from './server/employees';
export { changeDepartment, changeManager, changeStatus, employeeHistory } from './server/lifecycle';
export { getPersonalDetails, updatePersonalDetails } from './server/personal';
export { archiveOrgUnit, createOrgUnit, listOrgUnits, restoreOrgUnit, toDepartment, toLocation, updateOrgUnit } from './server/org-units';
export { unlinkRemovedMember } from './server/members';
export { viewerOf } from './server/shared';
export type { Viewer } from './server/shared';
