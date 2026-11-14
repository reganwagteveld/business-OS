import type { Project, ProjectStatus, TaskStatus, WorkPriority } from '@business-os/contracts';
import { PRIORITY_LABEL, PROJECT_STATUS_LABEL, progressText, TASK_STATUS_LABEL } from './format';

// Status and priority are always written out in words; tone only reinforces them.

export function ProjectStatusBadge({ status, archived }: { status: ProjectStatus; archived?: boolean }) {
  const tone = status === 'ACTIVE' ? 'bg-primary text-primary-foreground'
    : status === 'COMPLETED' ? 'bg-primary/10 text-foreground'
    : status === 'CANCELLED' ? 'bg-muted text-muted-foreground line-through decoration-1'
    : 'bg-muted text-foreground';
  return (
    <span className="inline-flex flex-wrap gap-1">
      <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${tone}`}>{PROJECT_STATUS_LABEL[status]}</span>
      {archived ? <span className="inline-flex rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Archived</span> : null}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const tone = status === 'DONE' ? 'bg-primary/10 text-foreground' : status === 'BLOCKED' ? 'border border-destructive/40 text-destructive' : status === 'IN_PROGRESS' ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground';
  return <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${tone}`}>{TASK_STATUS_LABEL[status]}</span>;
}

export function PriorityLabel({ priority }: { priority: WorkPriority }) {
  const strong = priority === 'HIGH' || priority === 'URGENT';
  return <span className={`text-xs ${strong ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>{PRIORITY_LABEL[priority]}<span className="sr-only"> priority</span></span>;
}

/** Derived from real tasks. An empty project shows text only: no bar that would read as 0% or 100%. */
export function Progress({ counts, compact }: { counts: Project['taskCounts']; compact?: boolean }) {
  const text = progressText(counts);
  if (counts.total === 0) return <span className="text-xs text-muted-foreground">{text}</span>;
  const pct = Math.round((counts.done / counts.total) * 100);
  return (
    <span className={`flex items-center gap-2 ${compact ? '' : 'w-full'}`}>
      <span role="progressbar" aria-label={text} aria-valuemin={0} aria-valuemax={counts.total} aria-valuenow={counts.done}
        className={`h-1.5 overflow-hidden rounded-full bg-muted ${compact ? 'w-16' : 'flex-1'}`}>
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
      <span className="whitespace-nowrap text-xs text-muted-foreground" aria-hidden="true">{text}</span>
    </span>
  );
}
