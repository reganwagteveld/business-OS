import type { Project, ProjectStatus, TaskStatus, WorkPriority } from '@business-os/contracts';
import type { Member } from '../../api/customers';

export { formatDate, formatWhen } from '../sales/format';

export const PROJECT_STATUSES: { value: ProjectStatus; label: string }[] = [
  { value: 'PLANNED', label: 'Planned' }, { value: 'ACTIVE', label: 'Active' }, { value: 'ON_HOLD', label: 'On hold' },
  { value: 'COMPLETED', label: 'Completed' }, { value: 'CANCELLED', label: 'Cancelled' },
];
export const PROJECT_STATUS_LABEL = Object.fromEntries(PROJECT_STATUSES.map((s) => [s.value, s.label])) as Record<ProjectStatus, string>;

export const TASK_STATUSES: { value: TaskStatus; label: string }[] = [
  { value: 'TODO', label: 'To do' }, { value: 'IN_PROGRESS', label: 'In progress' }, { value: 'BLOCKED', label: 'Blocked' }, { value: 'DONE', label: 'Done' },
];
export const TASK_STATUS_LABEL = Object.fromEntries(TASK_STATUSES.map((s) => [s.value, s.label])) as Record<TaskStatus, string>;

export const PRIORITIES: { value: WorkPriority; label: string }[] = [
  { value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }, { value: 'URGENT', label: 'Urgent' },
];
export const PRIORITY_LABEL = Object.fromEntries(PRIORITIES.map((p) => [p.value, p.label])) as Record<WorkPriority, string>;

/** "3 of 8 tasks done", or an honest "No tasks yet" (never a 0% or 100% bar for an empty project). */
export function progressText(counts: Project['taskCounts']): string {
  if (counts.total === 0) return 'No tasks yet';
  return `${counts.done} of ${counts.total} ${counts.total === 1 ? 'task' : 'tasks'} done`;
}

export const memberName = (members: Member[] | null, id: string | null) => (id ? members?.find((m) => m.userId === id)?.name ?? 'Team member' : null);

/** A real calendar date check, the same rule as the contract (YYYY-MM-DD that round-trips). */
export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
