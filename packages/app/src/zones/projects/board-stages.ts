import type { TaskStatus } from '@business-os/contracts';

/**
 * How the Projects board groups tasks into columns. This is presentation only: the server knows
 * statuses and one task order per project, never column names. A column shows the tasks whose
 * status is in `statuses`, in the project's order; a task dropped into it from another column takes
 * `dropStatus`. A task reordered within its own column keeps its status (a Blocked task stays
 * Blocked inside In Progress). Another board layout, a per-business or per-industry one later, is
 * just another value of this shape; nothing else changes.
 */
export interface BoardStage {
  id: string;
  label: string;
  statuses: readonly TaskStatus[];
  dropStatus: TaskStatus;
}

/** The default board: To Do, In Progress (which also shows Blocked tasks, flagged), Done. */
export const DEFAULT_TASK_BOARD: readonly BoardStage[] = [
  { id: 'todo', label: 'To Do', statuses: ['TODO'], dropStatus: 'TODO' },
  { id: 'in-progress', label: 'In Progress', statuses: ['IN_PROGRESS', 'BLOCKED'], dropStatus: 'IN_PROGRESS' },
  { id: 'done', label: 'Done', statuses: ['DONE'], dropStatus: 'DONE' },
];

export const stageOf = (board: readonly BoardStage[], status: TaskStatus) => board.find((s) => s.statuses.includes(status));
