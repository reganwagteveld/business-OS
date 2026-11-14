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

type View = { name: 'list' } | { name: 'detail'; id: string } | { name: 'new' } | { name: 'edit'; project: Project };

/**
 * The Projects Zone: project list, create/edit form and project workspace with its tasks. Mount it
 * with `key={slug}` so switching business discards every bit of this state; nothing is persisted or
 * cached outside the component, and every request names the business only through the URL. The same
 * component runs in the browser and in the desktop app.
 */
export function ProjectsZone({ client, customers, context, userLabel, initialProjectId, onHome, onSwitch, onSignOut, onSessionEnded, onOpenCustomer }: {
  client: ProjectsClient; customers: CustomersClient; context: BusinessContext; userLabel: string;
  /** Opens straight into one project (for example from a customer's page). */
  initialProjectId?: string;
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
  const [view, setView] = useState<View>(initialProjectId ? { name: 'detail', id: initialProjectId } : { name: 'list' });
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
    <ZoneFrame zone="Projects" business={name} user={userLabel} onHome={() => guard.leave(onHome)} onSwitch={() => guard.leave(onSwitch)} onSignOut={() => guard.leave(onSignOut)}>
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
            client={client} slug={slug} id={view.id} locale={locale} timeZone={timeZone} members={members}
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
