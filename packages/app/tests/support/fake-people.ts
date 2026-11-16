/**
 * A stand-in for the People API (docs/people-data-model.md), for tests only. It wraps the shared test API
 * (one call log) and follows the server's rules: strict contract bodies, versioned edits, the P1 status
 * transitions, unique employee numbers and department names, archive refused while in use, and the same
 * permission keys the server checks (so a write without people:manage is a 403 here exactly as there).
 * Each business's records are kept apart: an id from another business is a 404. The app's real client
 * and contracts sit in front of it.
 */
import {
  ChangeEmploymentStatusRequest, CreateDepartmentRequest, CreateEmployeeRequest, CreateLocationRequest, ListEmployeesQuery, UpdateDepartmentRequest,
  UpdateEmployeeRequest, UpdateLocationRequest, UpdatePersonalDetailsRequest,
  type Department, type Employee, type EmployeePersonalDetails, type EmploymentStatus, type Location,
} from '@business-os/contracts';
import { randomUUID } from 'node:crypto';
import type { createFakeApi } from './fake-api';

export interface FakePeople {
  employees: Employee[]; departments: Department[]; locations: Location[]; personal: Record<string, EmployeePersonalDetails>;
  history: Record<string, { fromStatus: EmploymentStatus | null; toStatus: EmploymentStatus; effectiveDate: string; reason: string | null }[]>;
  /** The caller's permission keys, as the server would see them. */
  permissions: string[];
  /** Employee ids that have direct reports (termination is refused). */
  withReports: string[];
}
export const emptyPeople = (permissions: string[] = ['people:read', 'people:manage', 'people:configure', 'people:read_sensitive']): FakePeople =>
  ({ employees: [], departments: [], locations: [], personal: {}, history: {}, permissions, withReports: [] });

const NOW = '2026-11-14T03:00:00.000Z';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cursorOf = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
const offsetOf = (cursor: string | null) => (cursor ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o: number }).o : 0);
const ALLOWED: Record<EmploymentStatus, EmploymentStatus[]> = { PENDING: ['ACTIVE', 'TERMINATED'], ACTIVE: ['ON_LEAVE', 'TERMINATED'], ON_LEAVE: ['ACTIVE', 'TERMINATED'], TERMINATED: ['PENDING', 'ACTIVE'] };

export function employee(over: Partial<Employee> = {}): Employee {
  const givenName = over.givenName ?? 'Ada';
  const familyName = over.familyName ?? 'Lovelace';
  return {
    id: randomUUID(), employeeNumber: null, givenName, familyName, preferredName: null, displayName: `${over.preferredName ?? givenName} ${familyName}`, jobTitle: null,
    employmentType: null, workEmail: null, workPhone: null, status: 'ACTIVE', startDate: '2026-01-05', endDate: null, department: null, manager: null, location: null,
    userId: null, version: 1, createdAt: NOW, updatedAt: NOW, ...over,
  };
}
export function department(over: Partial<Department> = {}): Department {
  return { id: randomUUID(), name: 'Operations', description: null, version: 1, createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over };
}
export function location(over: Partial<Location> = {}): Location {
  return { id: randomUUID(), name: 'Head office', address: null, version: 1, createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over };
}

export function withPeople(api: ReturnType<typeof createFakeApi>, data: Record<string, FakePeople>) {
  const base = api.fetch;
  let clock = Date.parse('2026-11-14T04:00:00.000Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const holds: { pattern: RegExp; gate: Promise<void> }[] = [];
  const next: ((path: string, method: string) => Response | 'network' | undefined)[] = [];
  const out = Object.assign(api, {
    people: data,
    /** Answer the next People request yourself (a 500, a network failure, a race). */
    peopleNext(handler: (path: string, method: string) => Response | 'network' | undefined) { next.push(handler); },
    /** Delays the next People request whose "METHOD /path" matches until the returned function is called. */
    peopleHold(pattern: RegExp): () => void {
      let release!: () => void;
      holds.push({ pattern, gate: new Promise<void>((resolve) => (release = resolve)) });
      return release;
    },
  });
  api.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/api\/v1\/b\/([^/]+)\/people\/(employees|departments|locations)(?:\/([^/]+))?(?:\/([a-z]+))?$/.exec(url.pathname);
    if (!m) return base(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    api.calls.push({ method, slug: m[1]!, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: (init?.headers ?? {}) as Record<string, string> });
    const held = holds.findIndex((h) => h.pattern.test(`${method} ${url.pathname}`));
    if (held >= 0) await holds.splice(held, 1)[0]!.gate;
    let rule: Response | 'network' | undefined;
    for (let i = 0; i < next.length && rule === undefined; i++) {
      rule = next[i]!(url.pathname, method);
      if (rule !== undefined) next.splice(i, 1);
    }
    if (rule === 'network') throw new TypeError('Failed to fetch');
    if (rule) return rule;
    const s = data[m[1]!];
    if (!s) return json(404, { error: 'not_found' });
    const has = (k: string) => s.permissions.includes(k);
    const [, , kind, id, sub] = m;
    if (!has('people:read')) return json(403, { error: 'forbidden' });

    if (kind !== 'employees') {
      const list = (kind === 'departments' ? s.departments : s.locations) as (Department & Location)[];
      const one = kind === 'departments' ? 'department' : 'location';
      const detail = kind === 'departments' ? 'description' : 'address';
      if (!id) {
        if (method === 'GET') {
          const a = url.searchParams.get('archived') ?? 'active';
          const rows = list.filter((r) => (a === 'all' ? true : a === 'active' ? !r.archivedAt : Boolean(r.archivedAt))).sort((x, y) => x.name.localeCompare(y.name));
          return json(200, { [kind as string]: rows, nextCursor: null });
        }
        if (!has('people:configure')) return json(403, { error: 'forbidden' });
        const parsed = (kind === 'departments' ? CreateDepartmentRequest : CreateLocationRequest).safeParse(body);
        if (!parsed.success) return json(400, { error: 'invalid_input' });
        if (list.some((r) => !r.archivedAt && r.name.toLowerCase() === parsed.data.name.toLowerCase())) return json(409, { error: 'duplicate_name' });
        const created = { id: randomUUID(), name: parsed.data.name, [detail]: (parsed.data as Record<string, unknown>)[detail] ?? null, version: 1, createdAt: tick(), updatedAt: NOW, archivedAt: null } as unknown as Department & Location;
        list.push(created);
        return json(201, { [one]: created });
      }
      const row = list.find((r) => r.id === id);
      if (!row) return json(404, { error: 'not_found' });
      if (!has('people:configure')) return json(403, { error: 'forbidden' });
      if (sub === 'archive') {
        if (row.archivedAt) return json(409, { error: 'archived' });
        const inUse = kind === 'departments' ? s.employees.some((e) => e.department?.id === id) : s.employees.some((e) => e.location?.id === id);
        if (inUse) return json(409, { error: 'in_use' });
        Object.assign(row, { archivedAt: tick(), version: row.version + 1 });
        return json(200, { [one]: row });
      }
      if (sub === 'restore') {
        if (!row.archivedAt) return json(409, { error: 'not_archived' });
        Object.assign(row, { archivedAt: null, version: row.version + 1 });
        return json(200, { [one]: row });
      }
      const parsed = (kind === 'departments' ? UpdateDepartmentRequest : UpdateLocationRequest).safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (row.archivedAt) return json(409, { error: 'archived' });
      if (parsed.data.version !== row.version) return json(409, { error: 'stale' });
      const { version: _v, ...patch } = parsed.data;
      void _v;
      if (patch.name && list.some((r) => r.id !== id && !r.archivedAt && r.name.toLowerCase() === patch.name!.toLowerCase())) return json(409, { error: 'duplicate_name' });
      Object.assign(row, patch, { version: row.version + 1, updatedAt: tick() });
      return json(200, { [one]: row });
    }

    // ---- employees
    const refresh = (e: Employee) => {
      e.displayName = `${e.preferredName ?? e.givenName} ${e.familyName}`;
    };
    if (!id) {
      if (method === 'GET') {
        const parsed = ListEmployeesQuery.safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) return json(400, { error: 'invalid_query' });
        const q = parsed.data;
        let rows = s.employees.filter((e) => (q.status === 'all' ? true : q.status === 'current' ? e.status !== 'TERMINATED' : e.status === q.status));
        if (q.q) rows = rows.filter((e) => [e.givenName, e.familyName, e.preferredName, e.employeeNumber, e.workEmail].some((v) => v?.toLowerCase().includes(q.q!.toLowerCase())));
        if (q.departmentId) rows = rows.filter((e) => e.department?.id === q.departmentId);
        if (q.locationId) rows = rows.filter((e) => e.location?.id === q.locationId);
        rows = [...rows].sort((a, b) => (q.sort === 'newest' ? b.createdAt.localeCompare(a.createdAt) : q.sort === 'number' ? (a.employeeNumber ?? '~').localeCompare(b.employeeNumber ?? '~') : a.familyName.localeCompare(b.familyName) || a.givenName.localeCompare(b.givenName)) || a.id.localeCompare(b.id));
        const offset = offsetOf(url.searchParams.get('cursor'));
        return json(200, { employees: rows.slice(offset, offset + q.limit), nextCursor: offset + q.limit < rows.length ? cursorOf(offset + q.limit) : null });
      }
      if (!has('people:manage')) return json(403, { error: 'forbidden' });
      const parsed = CreateEmployeeRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input', message: parsed.error.issues[0]?.message });
      const d = parsed.data;
      if (d.employeeNumber && s.employees.some((e) => e.employeeNumber?.toLowerCase() === d.employeeNumber!.toLowerCase())) return json(409, { error: 'duplicate_employee_number' });
      const dept = d.departmentId ? s.departments.find((x) => x.id === d.departmentId) : undefined;
      if (d.departmentId && !dept) return json(404, { error: 'not_found' });
      const loc = d.locationId ? s.locations.find((x) => x.id === d.locationId) : undefined;
      if (d.locationId && !loc) return json(404, { error: 'not_found' });
      const e = employee({
        givenName: d.givenName, familyName: d.familyName, preferredName: d.preferredName ?? null, employeeNumber: d.employeeNumber ?? null, jobTitle: d.jobTitle ?? null,
        employmentType: d.employmentType ?? null, workEmail: d.workEmail ?? null, workPhone: d.workPhone ?? null, status: d.status ?? 'PENDING', startDate: d.startDate ?? null,
        userId: d.userId ?? null, createdAt: tick(), updatedAt: NOW,
        department: dept ? { id: dept.id, name: dept.name, archived: false } : null, location: loc ? { id: loc.id, name: loc.name, archived: false } : null,
      });
      refresh(e);
      s.employees.push(e);
      s.history[e.id] = [{ fromStatus: null, toStatus: e.status, effectiveDate: e.startDate ?? '2026-11-14', reason: null }];
      return json(201, { employee: e });
    }
    const e = s.employees.find((x) => x.id === id);
    if (!e) return json(404, { error: 'not_found' });
    if (sub === 'history') {
      return json(200, { status: (s.history[id] ?? []).map((h) => ({ id: randomUUID(), ...h, reason: has('people:read_sensitive') ? h.reason : null, recordedById: null, recordedAt: NOW })), departments: [], managers: [] });
    }
    if (sub === 'personal') {
      if (!has('people:read_sensitive')) return json(403, { error: 'forbidden' });
      const cur = s.personal[id] ?? { personalEmail: null, personalPhone: null, homeAddress: null, emergencyContactName: null, emergencyContactRelationship: null, emergencyContactPhone: null, version: 0, updatedAt: null };
      if (method === 'GET') return json(200, { personalDetails: cur });
      if (!has('people:manage')) return json(403, { error: 'forbidden' });
      const parsed = UpdatePersonalDetailsRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (parsed.data.version !== cur.version) return json(409, { error: 'stale' });
      const { version: _v, ...patch } = parsed.data;
      void _v;
      s.personal[id] = { ...cur, ...patch, version: cur.version + 1, updatedAt: tick() } as EmployeePersonalDetails;
      return json(200, { personalDetails: s.personal[id] });
    }
    if (sub === 'status') {
      if (!has('people:manage')) return json(403, { error: 'forbidden' });
      const parsed = ChangeEmploymentStatusRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (parsed.data.version !== e.version) return json(409, { error: 'stale' });
      if (!ALLOWED[e.status].includes(parsed.data.status)) return json(409, { error: 'invalid_transition' });
      if (parsed.data.status === 'TERMINATED' && s.withReports.includes(id)) return json(409, { error: 'has_direct_reports' });
      const day = parsed.data.effectiveDate ?? '2026-11-16';
      s.history[id] = [...(s.history[id] ?? []), { fromStatus: e.status, toStatus: parsed.data.status, effectiveDate: day, reason: parsed.data.reason ?? null }];
      Object.assign(e, { status: parsed.data.status, endDate: parsed.data.status === 'TERMINATED' ? day : null, version: e.version + 1, updatedAt: tick() });
      return json(200, { employee: e });
    }
    if (method === 'GET') return json(200, { employee: e });
    if (!has('people:manage')) return json(403, { error: 'forbidden' });
    const parsed = UpdateEmployeeRequest.safeParse(body);
    if (!parsed.success) return json(400, { error: 'invalid_input' });
    if (parsed.data.version !== e.version) return json(409, { error: 'stale' });
    if (e.status === 'TERMINATED') return json(409, { error: 'terminated' });
    const { version: _v, locationId, userId, employeeNumber, ...patch } = parsed.data;
    void _v;
    if (employeeNumber && s.employees.some((x) => x.id !== id && x.employeeNumber?.toLowerCase() === employeeNumber.toLowerCase())) return json(409, { error: 'duplicate_employee_number' });
    if (employeeNumber !== undefined) e.employeeNumber = employeeNumber;
    if (userId !== undefined) e.userId = userId;
    if (locationId !== undefined) {
      const loc = locationId ? s.locations.find((x) => x.id === locationId) : undefined;
      if (locationId && !loc) return json(404, { error: 'not_found' });
      e.location = loc ? { id: loc.id, name: loc.name, archived: false } : null;
    }
    Object.assign(e, patch, { version: e.version + 1, updatedAt: tick() });
    refresh(e);
    return json(200, { employee: e });
  }) as typeof fetch;
  return out;
}
