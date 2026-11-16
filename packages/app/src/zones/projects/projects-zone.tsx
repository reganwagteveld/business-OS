import type { Project } from '@business-os/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { ProjectsClient } from '../../api/projects';
import type { BusinessContext } from '../../api/tenancy';
import { useDraftGuard } from '../drafts';
import { useLoad } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { ProjectDetail } from './project-detail';
import { ProjectForm } from './project-form';
import { DEFAULT_QUERY, ProjectList, type ListQuery } from './project-list';

type View = { name: 'list' } | { name: 'detail'; id: string; taskId?: string } | { name: 'new' } | { name: 'edit'; project: Project };

/**
 * Reads a shell route target for this Zone. `<projectId>` opens the project; `<projectId>:task:<taskId>`
 * (GS2-A, the target a search result for a task uses) opens the project on its board with that task's
 * panel. Anything else is treated as a project id, so a malformed target lands on the project's own
 * not-found state, as a bad id always has. The ids are only ever sent to the Projects API, which checks
 * the permission, the business and that the task belongs to the project.
 */
export function parseProjectTarget(target: string): { projectId: string; taskId?: string } {
  const parts = target.split(':');
  if (parts.length === 3 && parts[1] === 'task' && parts[0] && parts[2]) return { projectId: parts[0], taskId: parts[2] };
  return { projectId: target };
}

function initialView(target: string | undefined, intent: 'new' | undefined, canCreate: boolean): View {
  if (target) {
    const { projectId, taskId } = parseProjectTarget(target);
    return taskId ? { name: 'detail', id: projectId, taskId } : { name: 'detail', id: projectId };
  }
  return intent === 'new' && canCreate ? { name: 'new' } : { name: 'list' };
}

/**
 * The Projects Zone: project list, create/edit form and project workspace with its tasks. Mount it
 * with `key={slug}` so switching business discards every bit of this state; nothing is persisted or
 * cached outside the component, and every request names the business only through the URL. The same
 * component runs in the browser and in the desktop app.
 */
export function ProjectsZone({ client, customers, context, userLabel, initialProjectId, initialAction, onHome, onSwitch, onSignOut, onSessionEnded, onOpenCustomer }: {
  client: ProjectsClient; customers: CustomersClient; context: BusinessContext; userLabel: string;
  /**
   * Opens straight into one project (for example from a customer's page), or with
   * `<projectId>:task:<taskId>` into that project's board with the task's panel open (a search result).
   */
  initialProjectId?: string;
  /** Opens straight into the new-project form (a Home shortcut); ignored without projects:create. */
  initialAction?: 'new';
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
  /** Opens a linked customer in the Customer Zone; omitted when the person cannot read customers. */
  onOpenCustomer?: (customerId: string) => void;
}) {
  const { slug, name, timeZone, locale } = context.business;
  const can = (p: string) => context.membership.permissions.includes(p);
  const canCreate = can('projects:create');
  const canUpdate = can('projects:update');
  const canArchive = can('projects:archive');
  const canManageTasks = can('projects:manage_tasks');
  const canReadCustomers = can('customers:read');
  const [view, setView] = useState<View>(() => initialView(initialProjectId, initialAction, canCreate));
  const [query, setQuery] = useState<ListQuery>(DEFAULT_QUERY);
  const [notice, setNotice] = useState<string | null>(null);
  const guard = useDraftGuard();
  const content = useRef<HTMLDivElement>(null);

  // The team, for owner and assignee names and choices. Active members only; loaded once per visit.
  const team = useLoad(`project-team|${slug}`, (signal) => customers.members(slug, signal));
  const members = team.state.status === 'done' ? (team.state.outcome.kind === 'ok' ? team.state.outcome.data : []) : null;

  const go = (next: View, message: string | null = null) => {
    guard.clearDrafts();
    setNotice(message);
    setView(next);
  };
  const { markDraft } = guard;
  const markForm = useCallback((dirty: boolean) => markDraft('form', dirty), [markDraft]);

  // Move focus to the new screen's heading so keyboard and screen-reader users land on the change.
  const viewKey = view.name === 'detail' ? `detail:${view.id}` : view.name === 'edit' ? `edit:${view.project.id}` : view.name;
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [viewKey]);

  return (
    <ZoneFrame zone="Projects" business={name} user={userLabel} leave={guard.leave} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>
      <div ref={content}>
        {notice ? <p role="status" className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-sm">{notice}</p> : null}
        {view.name === 'list' ? (
          <ProjectList
            client={client} slug={slug} locale={locale} members={members} query={query} onQuery={setQuery} canCreate={canCreate}
            onOpen={(id) => go({ name: 'detail', id })} onAdd={() => go({ name: 'new' })} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'detail' ? (
          <ProjectDetail
            client={client} slug={slug} id={view.id} initialTaskId={view.taskId} locale={locale} timeZone={timeZone} members={members}
            canUpdate={canUpdate} canArchive={canArchive} canManageTasks={canManageTasks}
            onBack={() => guard.leave(() => go({ name: 'list' }))} onEdit={(project) => go({ name: 'edit', project })}
            onOpenCustomer={canReadCustomers && onOpenCustomer ? onOpenCustomer : undefined}
            onDraftChange={guard.markDraft} confirmLeave={guard.leave} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'new' || view.name === 'edit' ? (
          <ProjectForm
            key={view.name === 'edit' ? view.project.id : 'new'}
            client={client} customers={customers} slug={slug} members={members} canReadCustomers={canReadCustomers}
            project={view.name === 'edit' ? view.project : undefined}
            onDirtyChange={markForm} onSessionEnded={onSessionEnded}
            onCancel={() => guard.leave(() => go(view.name === 'edit' ? { name: 'detail', id: view.project.id } : { name: 'list' }))}
            onSaved={(saved) => go({ name: 'detail', id: saved.id }, view.name === 'edit' ? 'Changes saved.' : `${saved.name} was created.`)}
          />
        ) : null}
      </div>
      {guard.dialog}
    </ZoneFrame>
  );
}
