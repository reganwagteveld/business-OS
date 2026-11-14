import { Alert, AlertDescription, AlertTitle, Button, cn, EmptyState, PageHeader, Skeleton } from '@business-os/ui';
import type { ReactNode } from 'react';

export interface ZonePageTab {
  id: string;
  label: string;
}

/** What the page body shows instead of its content while it cannot show it. */
export type ZonePageState =
  | { kind: 'loading'; label: string }
  | { kind: 'error'; title: string; description?: ReactNode; onRetry?: () => void }
  | { kind: 'empty'; title: string; description?: ReactNode; action?: ReactNode };

/**
 * The page-layout contract every Zone screen follows inside the shell. The shell already shows the
 * breadcrumbs (from the route) and the active business; the page owns its heading (the only h1),
 * description, actions, optional tabs and body, and states loading, error and empty the same way.
 *
 * Primary actions are the one or two things the page is for ("Add customer"); secondary actions are
 * everything else. Both stay visible at every width (they wrap, never clip or hide behind hover).
 */
export function ZonePage({ title, description, eyebrow, primaryActions, secondaryActions, tabs, currentTab, onTab, state, children, className }: {
  title: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  primaryActions?: ReactNode;
  secondaryActions?: ReactNode;
  tabs?: readonly ZonePageTab[];
  currentTab?: string;
  onTab?: (id: string) => void;
  state?: ZonePageState;
  children?: ReactNode;
  className?: string;
}) {
  const actions = primaryActions || secondaryActions ? <>{secondaryActions}{primaryActions}</> : undefined;
  return (
    <div className={cn('space-y-8', className)}>
      <PageHeader title={title} description={description} eyebrow={eyebrow} actions={actions} />
      {tabs?.length ? (
        <nav aria-label="Page sections" className="-mt-2 overflow-x-auto border-b">
          <ul className="flex gap-1">
            {tabs.map((tab) => {
              const active = (currentTab ?? tabs[0]!.id) === tab.id;
              return (
                <li key={tab.id}>
                  <button type="button" aria-current={active ? 'page' : undefined} onClick={() => onTab?.(tab.id)}
                    className={cn('relative min-h-11 px-3 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                    {tab.label}
                    {active ? <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-ring" /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
      {state ? <ZonePageBody state={state} /> : children}
    </div>
  );
}

function ZonePageBody({ state }: { state: ZonePageState }) {
  if (state.kind === 'loading') {
    return (
      <div role="status" aria-busy="true" className="space-y-3">
        <span className="sr-only">{state.label}</span>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <Alert tone="danger" className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <AlertTitle>{state.title}</AlertTitle>
          {state.description ? <AlertDescription>{state.description}</AlertDescription> : null}
        </div>
        {state.onRetry ? <Button variant="outline" size="sm" onClick={state.onRetry}>Try again</Button> : null}
      </Alert>
    );
  }
  return <EmptyState title={state.title} description={state.description} action={state.action} />;
}
