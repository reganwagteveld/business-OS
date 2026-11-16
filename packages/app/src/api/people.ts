import {
  ChangeEmploymentStatusRequest, CreateDepartmentRequest, CreateEmployeeRequest, CreateLocationRequest, DepartmentResponse, LocationResponse,
  UpdateDepartmentRequest, UpdateLocationRequest, EmployeeHistoryResponse, EmployeeResponse, endpointPath, endpoints, ListDepartmentsResponse,
  ListEmployeesResponse, ListLocationsResponse, PersonalDetailsResponse, UpdateEmployeeRequest, UpdatePersonalDetailsRequest,
  type Department, type Employee, type EmployeePersonalDetails, type EmploymentStatus, type Location,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export type EmployeeSortKey = 'name' | 'number' | 'newest';
export interface EmployeeQuery {
  q?: string;
  /** `current` = everyone not terminated. */
  status: EmploymentStatus | 'current' | 'all';
  departmentId?: string; locationId?: string; sort?: EmployeeSortKey; cursor?: string; limit?: number;
}
export interface EmployeePage { employees: Employee[]; nextCursor: string | null }
export type EmployeeHistory = z.infer<typeof EmployeeHistoryResponse>;

/** Org units the screens pick from. Only active ones are choices; the API refuses archived ones anyway. */
export const MAX_ORG_UNIT_PAGES = 5;
export type OrgUnitFilter = 'active' | 'archived' | 'all';

/**
 * People Zone calls (docs/people-data-model.md, docs/people-p2.md). The business is only the `:slug` in the
 * path. Bodies are checked against the shared contract before they are sent. Employees are never deleted.
 */
export interface PeopleClient {
  list(slug: string, query: EmployeeQuery, signal?: AbortSignal): Promise<Outcome<EmployeePage>>;
  get(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Employee>>;
  create(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Employee>>;
  /** `patch` must include the `version` the edit was based on; a stale one comes back as conflict `stale`. */
  update(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<Employee>>;
  changeStatus(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Employee>>;
  history(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<EmployeeHistory>>;
  /** Needs people:read_sensitive; without it the server answers forbidden. */
  personal(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<EmployeePersonalDetails>>;
  updatePersonal(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<EmployeePersonalDetails>>;
  /** Departments and locations (active by default), A to Z, following the server's cursors. */
  departments(slug: string, signal?: AbortSignal, archived?: OrgUnitFilter): Promise<Outcome<Department[]>>;
  locations(slug: string, signal?: AbortSignal, archived?: OrgUnitFilter): Promise<Outcome<Location[]>>;
  /** people:configure. Archiving is refused while anyone is assigned (conflict `in_use`). */
  createDepartment(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Department>>;
  updateDepartment(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<Department>>;
  archiveDepartment(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Department>>;
  restoreDepartment(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Department>>;
  createLocation(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Location>>;
  updateLocation(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<Location>>;
  archiveLocation(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Location>>;
  restoreLocation(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Location>>;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
const invalid = (error: z.ZodError): Outcome<never> => ({ kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the highlighted fields.', fields: fieldErrors(error) });

export function createPeopleClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): PeopleClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? (body?.error === 'invalid_cursor' ? 'That page is no longer valid. Start again from the first page.' : 'Please check the details and try again.') };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);
  const qs = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') params.set(k, String(v));
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const emp = (template: string, slug: string, id: string) => p(template, { slug, employeeId: id });

  async function orgUnits<T extends { archivedAt: string | null }>(
    template: string, slug: string, schema: z.ZodType, pick: (d: never) => { rows: T[]; nextCursor: string | null }, signal?: AbortSignal, archived: OrgUnitFilter = 'active',
  ): Promise<Outcome<T[]>> {
    const all: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_ORG_UNIT_PAGES; page++) {
      const raw = await http.request('GET', p(template, { slug }) + qs({ archived, cursor, limit: 100 }), undefined, signal);
      const outcome = settle(raw, schema, (d) => pick(d as never));
      if (outcome.kind !== 'ok') return outcome;
      all.push(...outcome.data.rows);
      if (!outcome.data.nextCursor) return { kind: 'ok', data: all };
      cursor = outcome.data.nextCursor;
    }
    return { kind: 'incomplete', message: 'There are more choices than this screen can list at once.' };
  }

  return {
    async list(slug, query, signal) {
      const raw = await http.request('GET', p(endpoints.listEmployees.path, { slug }) + qs({
        q: query.q?.trim(), status: query.status, departmentId: query.departmentId, locationId: query.locationId, sort: query.sort, cursor: query.cursor, limit: query.limit,
      }), undefined, signal);
      return settle(raw, ListEmployeesResponse, (d) => d);
    },
    async get(slug, id, signal) {
      return settle(await http.request('GET', emp(endpoints.getEmployee.path, slug, id), undefined, signal), EmployeeResponse, (d) => d.employee);
    },
    async create(slug, input, signal) {
      const checked = CreateEmployeeRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createEmployee.path, { slug }), checked.data, signal), EmployeeResponse, (d) => d.employee);
    },
    async update(slug, id, patch, signal) {
      const checked = UpdateEmployeeRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', emp(endpoints.updateEmployee.path, slug, id), checked.data, signal), EmployeeResponse, (d) => d.employee);
    },
    async changeStatus(slug, id, input, signal) {
      const checked = ChangeEmploymentStatusRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', emp(endpoints.changeEmploymentStatus.path, slug, id), checked.data, signal), EmployeeResponse, (d) => d.employee);
    },
    async history(slug, id, signal) {
      return settle(await http.request('GET', emp(endpoints.getEmployeeHistory.path, slug, id), undefined, signal), EmployeeHistoryResponse, (d) => d);
    },
    async personal(slug, id, signal) {
      return settle(await http.request('GET', emp(endpoints.getEmployeePersonalDetails.path, slug, id), undefined, signal), PersonalDetailsResponse, (d) => d.personalDetails);
    },
    async updatePersonal(slug, id, patch, signal) {
      const checked = UpdatePersonalDetailsRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', emp(endpoints.updateEmployeePersonalDetails.path, slug, id), checked.data, signal), PersonalDetailsResponse, (d) => d.personalDetails);
    },
    departments: (slug, signal, archived) => orgUnits<Department>(endpoints.listDepartments.path, slug, ListDepartmentsResponse, (d: z.infer<typeof ListDepartmentsResponse>) => ({ rows: d.departments, nextCursor: d.nextCursor }), signal, archived),
    locations: (slug, signal, archived) => orgUnits<Location>(endpoints.listLocations.path, slug, ListLocationsResponse, (d: z.infer<typeof ListLocationsResponse>) => ({ rows: d.locations, nextCursor: d.nextCursor }), signal, archived),
    async createDepartment(slug, input, signal) {
      const checked = CreateDepartmentRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createDepartment.path, { slug }), checked.data, signal), DepartmentResponse, (d) => d.department);
    },
    async updateDepartment(slug, id, patch, signal) {
      const checked = UpdateDepartmentRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', p(endpoints.updateDepartment.path, { slug, departmentId: id }), checked.data, signal), DepartmentResponse, (d) => d.department);
    },
    async archiveDepartment(slug, id, signal) {
      return settle(await http.request('POST', p(endpoints.archiveDepartment.path, { slug, departmentId: id }), undefined, signal), DepartmentResponse, (d) => d.department);
    },
    async restoreDepartment(slug, id, signal) {
      return settle(await http.request('POST', p(endpoints.restoreDepartment.path, { slug, departmentId: id }), undefined, signal), DepartmentResponse, (d) => d.department);
    },
    async createLocation(slug, input, signal) {
      const checked = CreateLocationRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createLocation.path, { slug }), checked.data, signal), LocationResponse, (d) => d.location);
    },
    async updateLocation(slug, id, patch, signal) {
      const checked = UpdateLocationRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', p(endpoints.updateLocation.path, { slug, locationId: id }), checked.data, signal), LocationResponse, (d) => d.location);
    },
    async archiveLocation(slug, id, signal) {
      return settle(await http.request('POST', p(endpoints.archiveLocation.path, { slug, locationId: id }), undefined, signal), LocationResponse, (d) => d.location);
    },
    async restoreLocation(slug, id, signal) {
      return settle(await http.request('POST', p(endpoints.restoreLocation.path, { slug, locationId: id }), undefined, signal), LocationResponse, (d) => d.location);
    },
  };
}
