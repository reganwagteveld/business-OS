import { z } from 'zod';
import { CalendarDate } from './sales.ts';

// Projects Zone (docs/projects-data-model.md). Every path is under /api/v1/b/:slug, so no request
// carries a business id, and bodies are strict: an unknown field (a business id, an author, a
// completion time) is rejected rather than ignored.

const Uuid = z.string().uuid();
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const ProjectStatus = z.enum(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;
/** One priority scale for projects and tasks. */
export const WorkPriority = z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']);
export type WorkPriority = z.infer<typeof WorkPriority>;
export const TaskStatus = z.enum(['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
export type TaskStatus = z.infer<typeof TaskStatus>;

const Count = z.number().int().min(0);

/**
 * The linked customer as the Customer Zone holds it right now (never a copy). Present only when the
 * viewer may read customers; otherwise null while `customerId` still says a customer is linked.
 */
export const ProjectCustomer = z.object({ id: Uuid, displayName: z.string(), archived: z.boolean() }).strict();
export type ProjectCustomer = z.infer<typeof ProjectCustomer>;

export const Project = z
  .object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    status: ProjectStatus,
    priority: WorkPriority,
    customerId: Uuid.nullable(),
    customer: ProjectCustomer.nullable(),
    ownerUserId: Uuid.nullable(),
    startDate: z.string().nullable(),
    dueDate: z.string().nullable(),
    completedAt: z.string().datetime().nullable(),
    /** Tasks that are not archived, and how many of those are done. Computed from real tasks. */
    taskCounts: z.object({ total: Count, done: Count }).strict(),
    /** Increases with every change. PATCH must send the version it was based on. */
    version: z.number().int().min(1),
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type Project = z.infer<typeof Project>;

const dateOrder = (v: { startDate?: string | null; dueDate?: string | null }) => !v.startDate || !v.dueDate || v.dueDate >= v.startDate;
const DATE_ORDER = { message: 'The due date cannot be before the start date', path: ['dueDate'] };

const projectFields = {
  name: z.string().trim().min(1, 'A project name is required').max(200),
  description: optionalText(5000),
  status: ProjectStatus.optional(),
  priority: WorkPriority.optional(),
  customerId: Uuid.nullable().optional(),
  ownerUserId: Uuid.nullable().optional(),
  startDate: CalendarDate.nullable().optional(),
  dueDate: CalendarDate.nullable().optional(),
};

/** Only a name is required. A new project is PLANNED and MEDIUM unless told otherwise. */
export const CreateProjectRequest = z.object(projectFields).strict().refine(dateOrder, DATE_ORDER);
/**
 * Edits details and status. The completion time follows the status (set on COMPLETED, cleared when
 * it leaves COMPLETED) and is never sent by a client. Archiving goes through /archive.
 */
export const UpdateProjectRequest = z
  .object(projectFields)
  .partial()
  .extend({
    /** Optimistic concurrency: the `version` the edit was based on; a stale one gets 409 stale. */
    version: z.number().int().min(1),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update')
  .refine(dateOrder, DATE_ORDER);

const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();

export const ProjectSort = z.enum(['newest', 'name', 'due']);
export const ListProjectsQuery = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.union([ProjectStatus, z.literal('all')]).default('all'),
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    customerId: Uuid.optional(),
    ownerUserId: Uuid.optional(),
    /** newest: created, newest first. name: A to Z. due: soonest due first, undated last. Ties by id. */
    sort: ProjectSort.default('newest'),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();
export const ListProjectsResponse = z.object({ projects: z.array(Project), nextCursor: z.string().nullable() }).strict();
export const ProjectResponse = z.object({ project: Project }).strict();

/** Real counts of the business's active (not archived) projects by status, for the Zone. */
export const ProjectSummary = z
  .object({ active: Count, byStatus: z.object({ PLANNED: Count, ACTIVE: Count, ON_HOLD: Count, COMPLETED: Count, CANCELLED: Count }).strict() })
  .strict();
export type ProjectSummary = z.infer<typeof ProjectSummary>;
export const ProjectSummaryResponse = z.object({ summary: ProjectSummary }).strict();

// ---- tasks -------------------------------------------------------------------------------------

export const ProjectTask = z
  .object({
    id: Uuid,
    projectId: Uuid,
    title: z.string(),
    description: z.string().nullable(),
    status: TaskStatus,
    priority: WorkPriority,
    assigneeUserId: Uuid.nullable(),
    dueDate: z.string().nullable(),
    position: z.number().int().min(0),
    completedAt: z.string().datetime().nullable(),
    version: z.number().int().min(1),
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().nullable(),
  })
  .strict();
export type ProjectTask = z.infer<typeof ProjectTask>;

const taskFields = {
  title: z.string().trim().min(1, 'A task title is required').max(200),
  description: optionalText(5000),
  status: TaskStatus.optional(),
  priority: WorkPriority.optional(),
  assigneeUserId: Uuid.nullable().optional(),
  dueDate: CalendarDate.nullable().optional(),
};
/** New tasks go to the end of the project's list. */
export const CreateTaskRequest = z.object(taskFields).strict();
/** Edits details, assignment, priority and status. Done sets the completion time; leaving Done clears it. */
export const UpdateTaskRequest = z
  .object(taskFields)
  .partial()
  .extend({ version: z.number().int().min(1) })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');

export const ListTasksQuery = z
  .object({
    status: z.union([TaskStatus, z.literal('all')]).default('all'),
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    cursor: Cursor,
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
/** In the project's order (position, then id). */
export const ListTasksResponse = z.object({ tasks: z.array(ProjectTask), nextCursor: z.string().nullable() }).strict();
export const TaskResponse = z.object({ task: ProjectTask }).strict();
