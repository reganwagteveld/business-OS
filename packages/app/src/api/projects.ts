import {
  CreateProjectRequest, CreateTaskRequest, endpointPath, endpoints, ListProjectsResponse, ListTasksResponse, ProjectResponse, ProjectSummaryResponse,
  TaskResponse, UpdateProjectRequest, UpdateTaskRequest,
  type Project, type ProjectStatus, type ProjectSummary, type ProjectTask, type TaskStatus,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

/** Task pages the project workspace follows (100 per page). Beyond this it reports an error rather than a partial list. */
export const MAX_TASK_PAGES = 10;

export interface ProjectQuery {
  q?: string; status: ProjectStatus | 'all'; archived: 'active' | 'archived' | 'all'; customerId?: string; ownerUserId?: string;
  sort?: 'newest' | 'name' | 'due'; cursor?: string; limit?: number;
}
export interface ProjectPage { projects: Project[]; nextCursor: string | null }

/**
 * Projects Zone calls (docs/projects-data-model.md). The business is only the `:slug` in the path.
 * Every body is checked against the shared contract before it is sent.
 */
export interface ProjectsClient {
  list(slug: string, query: ProjectQuery, signal?: AbortSignal): Promise<Outcome<ProjectPage>>;
  /** One customer's projects (needs Customer Zone read access as well). */
  forCustomer(slug: string, customerId: string, query: ProjectQuery, signal?: AbortSignal): Promise<Outcome<ProjectPage>>;
  summary(slug: string, signal?: AbortSignal): Promise<Outcome<ProjectSummary>>;
  get(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Project>>;
  create(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<Project>>;
  /** `patch` must include the `version` the edit was based on; a stale one comes back as conflict `stale`. */
  update(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<Project>>;
  archive(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Project>>;
  restore(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<Project>>;
  /** Every task of one project in the given state, in the project's order, following the server's cursors. */
  tasks(slug: string, projectId: string, query: { status?: TaskStatus | 'all'; archived?: 'active' | 'archived' | 'all' }, signal?: AbortSignal): Promise<Outcome<ProjectTask[]>>;
  createTask(slug: string, projectId: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ProjectTask>>;
  updateTask(slug: string, projectId: string, taskId: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<ProjectTask>>;
  archiveTask(slug: string, projectId: string, taskId: string, signal?: AbortSignal): Promise<Outcome<ProjectTask>>;
  restoreTask(slug: string, projectId: string, taskId: string, signal?: AbortSignal): Promise<Outcome<ProjectTask>>;
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

export function createProjectsClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): ProjectsClient {
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
  const listQs = (query: ProjectQuery) => qs({
    q: query.q?.trim(), status: query.status, archived: query.archived, customerId: query.customerId, ownerUserId: query.ownerUserId,
    sort: query.sort, cursor: query.cursor, limit: query.limit,
  });
  const proj = (template: string, slug: string, id: string) => p(template, { slug, projectId: id });
  const task = (template: string, slug: string, projectId: string, taskId: string) => p(template, { slug, projectId, taskId });

  return {
    async list(slug, query, signal) {
      return settle(await http.request('GET', p(endpoints.listProjects.path, { slug }) + listQs(query), undefined, signal), ListProjectsResponse, (d) => d);
    },
    async forCustomer(slug, customerId, query, signal) {
      const raw = await http.request('GET', p(endpoints.listCustomerProjects.path, { slug, customerId }) + listQs({ ...query, customerId: undefined }), undefined, signal);
      return settle(raw, ListProjectsResponse, (d) => d);
    },
    async summary(slug, signal) {
      return settle(await http.request('GET', p(endpoints.projectSummary.path, { slug }), undefined, signal), ProjectSummaryResponse, (d) => d.summary);
    },
    async get(slug, id, signal) {
      return settle(await http.request('GET', proj(endpoints.getProject.path, slug, id), undefined, signal), ProjectResponse, (d) => d.project);
    },
    async create(slug, input, signal) {
      const checked = CreateProjectRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', p(endpoints.createProject.path, { slug }), checked.data, signal), ProjectResponse, (d) => d.project);
    },
    async update(slug, id, patch, signal) {
      const checked = UpdateProjectRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', proj(endpoints.updateProject.path, slug, id), checked.data, signal), ProjectResponse, (d) => d.project);
    },
    async archive(slug, id, signal) {
      return settle(await http.request('POST', proj(endpoints.archiveProject.path, slug, id), undefined, signal), ProjectResponse, (d) => d.project);
    },
    async restore(slug, id, signal) {
      return settle(await http.request('POST', proj(endpoints.restoreProject.path, slug, id), undefined, signal), ProjectResponse, (d) => d.project);
    },
    async tasks(slug, projectId, query, signal) {
      const all: ProjectTask[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TASK_PAGES; page++) {
        const raw = await http.request('GET', proj(endpoints.listTasks.path, slug, projectId) + qs({ status: query.status, archived: query.archived, cursor, limit: 100 }), undefined, signal);
        const outcome = settle(raw, ListTasksResponse, (d) => d);
        if (outcome.kind !== 'ok') return outcome;
        all.push(...outcome.data.tasks);
        if (!outcome.data.nextCursor) return { kind: 'ok', data: all };
        cursor = outcome.data.nextCursor;
      }
      return { kind: 'incomplete', message: `This project has more than ${MAX_TASK_PAGES * 100} tasks, which is more than this screen can show at once.` };
    },
    async createTask(slug, projectId, input, signal) {
      const checked = CreateTaskRequest.safeParse(input);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('POST', proj(endpoints.createTask.path, slug, projectId), checked.data, signal), TaskResponse, (d) => d.task);
    },
    async updateTask(slug, projectId, taskId, patch, signal) {
      const checked = UpdateTaskRequest.safeParse(patch);
      if (!checked.success) return invalid(checked.error);
      return settle(await http.request('PATCH', task(endpoints.updateTask.path, slug, projectId, taskId), checked.data, signal), TaskResponse, (d) => d.task);
    },
    async archiveTask(slug, projectId, taskId, signal) {
      return settle(await http.request('POST', task(endpoints.archiveTask.path, slug, projectId, taskId), undefined, signal), TaskResponse, (d) => d.task);
    },
    async restoreTask(slug, projectId, taskId, signal) {
      return settle(await http.request('POST', task(endpoints.restoreTask.path, slug, projectId, taskId), undefined, signal), TaskResponse, (d) => d.task);
    },
  };
}
