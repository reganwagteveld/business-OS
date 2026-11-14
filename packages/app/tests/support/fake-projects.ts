/**
 * A stand-in for the PR 18 Projects API, for tests only. It wraps the Customer Zone test API (one call
 * log, one set of customers and members) and follows the server's rules: strict bodies, versioned
 * edits, completion times that follow status, archived projects read-only, customer names joined only
 * for callers who may read customers. The app's real Projects client and contracts sit in front of it.
 */
import {
  CreateProjectRequest, CreateTaskRequest, ListProjectsQuery, UpdateProjectRequest, UpdateTaskRequest,
  type Project, type ProjectTask,
} from '@business-os/contracts';
import { randomUUID } from 'node:crypto';
import type { createFakeApi } from './fake-api';

export interface FakeProjects { projects: Project[]; tasks: ProjectTask[]; customersVisible: boolean }
export const emptyProjects = (customersVisible = true): FakeProjects => ({ projects: [], tasks: [], customersVisible });

const NOW = '2026-11-14T03:00:00.000Z';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const cursorOf = (offset: number) => Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
const offsetOf = (cursor: string | null) => (cursor ? (JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { o: number }).o : 0);

export function project(over: Partial<Project> = {}): Project {
  return {
    id: randomUUID(), name: 'Project', description: null, status: 'PLANNED', priority: 'MEDIUM', customerId: null, customer: null, ownerUserId: null,
    startDate: null, dueDate: null, completedAt: null, taskCounts: { total: 0, done: 0 }, version: 1, createdById: null, updatedById: null,
    createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  };
}
export function task(projectId: string, over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: randomUUID(), projectId, title: 'Task', description: null, status: 'TODO', priority: 'MEDIUM', assigneeUserId: null, dueDate: null, position: 1000,
    completedAt: null, version: 1, createdById: null, updatedById: null, createdAt: NOW, updatedAt: NOW, archivedAt: null, ...over,
  };
}

export function withProjects(api: ReturnType<typeof createFakeApi>, data: Record<string, FakeProjects>) {
  const base = api.fetch;
  let clock = Date.parse('2026-11-14T04:00:00.000Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const next: ((path: string, method: string) => Response | 'network' | undefined)[] = [];
  const out = Object.assign(api, {
    projects: data,
    /** Answer the next Projects request yourself (a 500, a network failure, a race). */
    projectsNext(handler: (path: string, method: string) => Response | 'network' | undefined) {
      next.push(handler);
    },
  });
  api.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/api\/v1\/b\/([^/]+)\/(?:projects(?:\/([^/]+))?(?:\/(archive|restore|tasks))?(?:\/([^/]+))?(?:\/(archive|restore))?|customers\/([^/]+)\/projects)$/.exec(url.pathname);
    if (!m) return base(input, init);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    api.calls.push({ method, slug: m[1]!, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: (init?.headers ?? {}) as Record<string, string> });
    // The first waiting handler that answers this request is used up; ones that pass stay for a later request.
    let rule: Response | 'network' | undefined;
    for (let i = 0; i < next.length && rule === undefined; i++) {
      rule = next[i]!(url.pathname, method);
      if (rule !== undefined) next.splice(i, 1);
    }
    if (rule === 'network') throw new TypeError('Failed to fetch');
    if (rule) return rule;
    const s = data[m[1]!];
    const biz = api.businesses[m[1]!];
    if (!s || !biz) return json(404, { error: 'not_found' });
    const [, , pid, sub, tid, taskAction, customerPath] = m;

    const counts = (p: Project) => {
      const live = s.tasks.filter((t) => t.projectId === p.id && !t.archivedAt);
      return { total: live.length, done: live.filter((t) => t.status === 'DONE').length };
    };
    const view = (p: Project): Project => {
      const c = p.customerId ? biz.customers.find((x) => x.id === p.customerId) : undefined;
      return { ...p, taskCounts: counts(p), customer: s.customersVisible && c ? { id: c.id, displayName: c.displayName, archived: c.archivedAt !== null } : null };
    };
    const checkLinks = (b: { customerId?: string | null; ownerUserId?: string | null }, changedCustomer: boolean) => {
      if (b.customerId && changedCustomer) {
        if (!s.customersVisible) return json(403, { error: 'forbidden' });
        const c = biz.customers.find((x) => x.id === b.customerId);
        if (!c) return json(404, { error: 'not_found' });
        if (c.archivedAt) return json(409, { error: 'archived_reference' });
      }
      if (b.ownerUserId && !biz.members.some((x) => x.userId === b.ownerUserId && x.status === 'ACTIVE')) {
        return json(400, { error: 'invalid_owner', message: 'The project owner must be an active member of this business.' });
      }
      return null;
    };
    const list = (query: Record<string, string>, customerId?: string) => {
      const parsed = ListProjectsQuery.safeParse(query);
      if (!parsed.success) return json(400, { error: 'invalid_query' });
      const q = parsed.data;
      let rows = s.projects.filter((p) => (q.archived === 'all' ? true : q.archived === 'active' ? !p.archivedAt : Boolean(p.archivedAt)));
      if (q.status !== 'all') rows = rows.filter((p) => p.status === q.status);
      if (q.q) rows = rows.filter((p) => p.name.toLowerCase().includes(q.q!.toLowerCase()));
      const cid = customerId ?? q.customerId;
      if (cid) rows = rows.filter((p) => p.customerId === cid);
      rows = [...rows].sort((a, b) => (q.sort === 'name' ? a.name.localeCompare(b.name) : b.createdAt.localeCompare(a.createdAt)) || a.id.localeCompare(b.id));
      const offset = offsetOf(url.searchParams.get('cursor'));
      const page = rows.slice(offset, offset + q.limit);
      return json(200, { projects: page.map(view), nextCursor: offset + q.limit < rows.length ? cursorOf(offset + q.limit) : null });
    };

    if (customerPath) {
      if (!s.customersVisible) return json(403, { error: 'forbidden' });
      if (!biz.customers.some((c) => c.id === customerPath)) return json(404, { error: 'not_found' });
      return list(Object.fromEntries(url.searchParams), customerPath);
    }
    if (!pid) {
      if (method === 'GET') return list(Object.fromEntries(url.searchParams));
      const parsed = CreateProjectRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      const bad = checkLinks(parsed.data, true);
      if (bad) return bad;
      const at = tick();
      const p = project({ ...parsed.data, description: parsed.data.description ?? null, customerId: parsed.data.customerId ?? null, ownerUserId: parsed.data.ownerUserId ?? null,
        startDate: parsed.data.startDate ?? null, dueDate: parsed.data.dueDate ?? null, status: parsed.data.status ?? 'PLANNED', priority: parsed.data.priority ?? 'MEDIUM',
        completedAt: parsed.data.status === 'COMPLETED' ? at : null, createdAt: at, updatedAt: at });
      s.projects.push(p);
      return json(201, { project: view(p) });
    }
    if (pid === 'summary') {
      const byStatus = { PLANNED: 0, ACTIVE: 0, ON_HOLD: 0, COMPLETED: 0, CANCELLED: 0 };
      for (const p of s.projects) if (!p.archivedAt) byStatus[p.status]++;
      return json(200, { summary: { active: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus } });
    }
    const p = s.projects.find((x) => x.id === pid);
    if (!p) return json(404, { error: 'not_found' });
    if (!sub) {
      if (method === 'GET') return json(200, { project: view(p) });
      const parsed = UpdateProjectRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (p.archivedAt) return json(409, { error: 'archived' });
      if (parsed.data.version !== p.version) return json(409, { error: 'stale' });
      const { version: _v, ...patch } = parsed.data;
      void _v;
      const bad = checkLinks(patch, patch.customerId !== undefined && patch.customerId !== p.customerId);
      if (bad) return bad;
      if (patch.status && patch.status !== p.status) p.completedAt = patch.status === 'COMPLETED' ? tick() : null;
      Object.assign(p, patch, { version: p.version + 1, updatedAt: tick() });
      return json(200, { project: view(p) });
    }
    if (sub === 'archive' || sub === 'restore') {
      if (sub === 'archive' && p.archivedAt) return json(409, { error: 'archived' });
      if (sub === 'restore' && !p.archivedAt) return json(409, { error: 'not_archived' });
      Object.assign(p, { archivedAt: sub === 'archive' ? tick() : null, version: p.version + 1 });
      return json(200, { project: view(p) });
    }
    // tasks
    if (!tid) {
      if (method === 'GET') {
        const archived = url.searchParams.get('archived') ?? 'active';
        const rows = s.tasks.filter((t) => t.projectId === p.id && (archived === 'all' ? true : archived === 'active' ? !t.archivedAt : Boolean(t.archivedAt)))
          .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const offset = offsetOf(url.searchParams.get('cursor'));
        return json(200, { tasks: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? cursorOf(offset + limit) : null });
      }
      const parsed = CreateTaskRequest.safeParse(body);
      if (!parsed.success) return json(400, { error: 'invalid_input' });
      if (p.archivedAt) return json(409, { error: 'project_archived' });
      if (parsed.data.assigneeUserId && !biz.members.some((x) => x.userId === parsed.data.assigneeUserId && x.status === 'ACTIVE')) return json(400, { error: 'invalid_assignee', message: 'The assignee must be an active member of this business.' });
      const at = tick();
      const position = Math.max(0, ...s.tasks.filter((t) => t.projectId === p.id).map((t) => t.position)) + 1000;
      const t = task(p.id, { ...parsed.data, description: parsed.data.description ?? null, assigneeUserId: parsed.data.assigneeUserId ?? null, dueDate: parsed.data.dueDate ?? null,
        status: parsed.data.status ?? 'TODO', priority: parsed.data.priority ?? 'MEDIUM', position, completedAt: parsed.data.status === 'DONE' ? at : null, createdAt: at, updatedAt: at });
      s.tasks.push(t);
      return json(201, { task: t });
    }
    const t = s.tasks.find((x) => x.id === tid && x.projectId === p.id);
    if (!t) return json(404, { error: 'not_found' });
    if (p.archivedAt) return json(409, { error: 'project_archived' });
    if (taskAction) {
      if (taskAction === 'archive' && t.archivedAt) return json(409, { error: 'archived' });
      if (taskAction === 'restore' && !t.archivedAt) return json(409, { error: 'not_archived' });
      Object.assign(t, { archivedAt: taskAction === 'archive' ? tick() : null, version: t.version + 1 });
      return json(200, { task: t });
    }
    const parsed = UpdateTaskRequest.safeParse(body);
    if (!parsed.success) return json(400, { error: 'invalid_input' });
    if (t.archivedAt) return json(409, { error: 'archived' });
    if (parsed.data.version !== t.version) return json(409, { error: 'stale' });
    const { version: _v, ...patch } = parsed.data;
    void _v;
    if (patch.status && patch.status !== t.status) t.completedAt = patch.status === 'DONE' ? tick() : null;
    Object.assign(t, patch, { version: t.version + 1, updatedAt: tick() });
    return json(200, { task: t });
  }) as typeof fetch;
  return out;
}
