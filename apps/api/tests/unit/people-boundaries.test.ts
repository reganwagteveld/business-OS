/**
 * People data stays in the People Zone (docs/people-data-model.md §1). Source-level rules:
 *  - only People routes (and tenancy's member-removal clean-up) import the people module;
 *  - no code outside the people module touches People models or tables;
 *  - no non-People API contract can carry an employee or personal-details field.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../../src');
const SCHEMA = resolve(__dirname, '../../../../packages/contracts/schema/api-v1.json');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const sources = files(SRC).map((path) => [relative(SRC, path).split('\\').join('/'), readFileSync(path, 'utf8')] as const);

const PEOPLE_ROUTES = /^app\/api\/v1\/b\/\[slug\]\/people\//;
const PEOPLE_MODULE = /^modules\/people\//;

describe('people boundaries', () => {
  it('only People routes and the tenancy member clean-up import the people module', () => {
    const importers = sources.filter(([, text]) => /from ['"]@\/modules\/people['"/]/.test(text)).map(([name]) => name);
    const unexpected = importers.filter((n) => !PEOPLE_ROUTES.test(n) && !PEOPLE_MODULE.test(n) && n !== 'modules/tenancy/server/members.ts'
      && n !== 'modules/search/server/registry.ts');
    expect(unexpected).toEqual([]);
    const tenancy = sources.find(([n]) => n === 'modules/tenancy/server/members.ts')![1];
    expect(tenancy).toMatch(/import \{ unlinkRemovedMember \} from '@\/modules\/people';/);
    // Global search GS1-A (docs/global-search-gs1.md §6.4): the search registry takes only the People-owned
    // provider (work fields, written and reviewed in the people module) and its index declarations.
    const search = sources.find(([n]) => n === 'modules/search/server/registry.ts')![1];
    expect(search.match(/import [^;]+ from '@\/modules\/people';/g)).toEqual(["import { employeeSearchProvider, PEOPLE_SEARCH_INDEXES } from '@/modules/people';"]);
  });

  it('no code outside the people module reads People models or tables', () => {
    // P3-A adds the leave configuration tables (docs/people-leave-p3.md): the same rule applies to them.
    const touches = /\bpeople(Employee|Department|Location|EmployeePersonalDetails|DepartmentAssignment|ManagerAssignment|EmploymentStatusHistory|LeaveType|LeavePolicy|LeavePolicyRevision|LeavePolicyAssignment)\b|\bpeople_(employees|departments|locations|employee_personal_details|department_assignments|manager_assignments|employment_status_history|leave_types|leave_policies|leave_policy_revisions|leave_policy_assignments)\b/;
    const offenders = sources
      .filter(([name, text]) => !PEOPLE_MODULE.test(name) && name !== 'core/db/app-client.ts' && touches.test(text))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('personal details are read only by the personal details service', () => {
    const offenders = sources
      .filter(([name, text]) => name !== 'modules/people/server/personal.ts' && name !== 'core/db/app-client.ts' && /peopleEmployeePersonalDetails|personalDetails\s*:/.test(text))
      .filter(([name]) => !PEOPLE_ROUTES.test(name)) // routes pass the service's result through
      .map(([name]) => name);
    expect(offenders).toEqual([]);
    const directory = sources.find(([n]) => n === 'modules/people/server/employees.ts')![1];
    expect(directory).not.toMatch(/personal(Email|Phone)|homeAddress|emergencyContact/);
  });

  it('no API contract outside /people can carry employee fields', () => {
    const doc = JSON.parse(readFileSync(SCHEMA, 'utf8')) as { endpoints: Record<string, { path: string }> };
    const employeeKeys = /"(employeeNumber|employeeId|employeeIds|managerEmployeeId|personalEmail|personalPhone|homeAddress|emergencyContact\w*|employmentType|leaveTypeId|entitlementMethod)"/;
    const leaks = Object.entries(doc.endpoints)
      .filter(([, e]) => !e.path.startsWith('/api/v1/b/:slug/people/'))
      .filter(([, e]) => employeeKeys.test(JSON.stringify(e)))
      .map(([name]) => name);
    expect(leaks).toEqual([]);
  });
});
