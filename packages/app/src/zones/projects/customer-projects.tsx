import type { ProjectsClient } from '../../api/projects';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { Progress, ProjectStatusBadge } from './badges';

const SHOWN = 10;

/**
 * A customer's projects, on the customer's page. Read from the Projects API (which checks both
 * Projects and Customers read access); nothing about the projects is stored on the customer.
 */
export function CustomerProjects({ client, slug, customerId, onOpen, onSessionEnded }: {
  client: ProjectsClient; slug: string; customerId: string; onOpen: (projectId: string) => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`customer-projects|${slug}|${customerId}`, (signal) =>
    client.forCustomer(slug, customerId, { status: 'all', archived: 'active', sort: 'newest', limit: SHOWN }, signal));
  return (
    <section aria-label="Projects" className="rounded-2xl border border-border bg-card p-6">
      <h2 className="mb-4 text-sm font-semibold tracking-tight">Projects</h2>
      {state.status === 'loading' ? <Skeleton rows={2} label="Loading projects…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Projects" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'done' && state.outcome.kind === 'ok' ? (
        state.outcome.data.projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects for this customer.</p>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {state.outcome.data.projects.map((p) => (
                <li key={p.id} className="py-2.5">
                  <button type="button" onClick={() => onOpen(p.id)} className="w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium hover:underline [overflow-wrap:anywhere]">{p.name}</span>
                      <ProjectStatusBadge status={p.status} />
                    </span>
                    <span className="mt-1.5 block"><Progress counts={p.taskCounts} compact /></span>
                  </button>
                </li>
              ))}
            </ul>
            {state.outcome.data.nextCursor ? <p className="mt-3 text-xs text-muted-foreground">Showing the {SHOWN} most recent. See the Projects Zone for the rest.</p> : null}
          </>
        )
      ) : null}
    </section>
  );
}
