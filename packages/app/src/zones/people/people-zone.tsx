import type { Employee } from '@business-os/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { PeopleClient } from '../../api/people';
import type { BusinessContext } from '../../api/tenancy';
import { useDraftGuard } from '../drafts';
import { useLoad, type Loaded } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { DEFAULT_FILTERS, Directory, type DirectoryFilters } from './directory';
import { EmployeeForm } from './employee-form';
import { OrgUnits } from './org-units';
import { Profile } from './profile';

type View = { name: 'list' } | { name: 'departments' } | { name: 'locations' } | { name: 'detail'; id: string } | { name: 'new' } | { name: 'edit'; employee: Employee };

/**
 * The People Zone (P2): employee directory, profile, create/edit and employment status changes, on the
 * People P1 API. Mount it with `key={slug}` so switching business discards all of its state; nothing is
 * persisted or cached outside the component and every request names the business only through the URL.
 * Leave, payroll, scheduling and attendance are not part of this Zone yet.
 */
export function PeopleZone({ client, customers, context, userLabel, initialEmployeeId, initialAction, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: PeopleClient;
  /** Only with members:read: names the optional team-member link. */
  customers?: CustomersClient;
  context: BusinessContext; userLabel: string;
  initialEmployeeId?: string; initialAction?: 'new';
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, timeZone, locale } = context.business;
  const can = (p: string) => context.membership.permissions.includes(p);
  const canManage = can('people:manage');
  const canConfigure = can('people:configure');
  const canReadSensitive = can('people:read_sensitive');
  const canListMembers = can('members:read') && Boolean(customers);
  const [view, setView] = useState<View>(initialEmployeeId ? { name: 'detail', id: initialEmployeeId } : initialAction === 'new' && canManage ? { name: 'new' } : { name: 'list' });
  const [filters, setFilters] = useState<DirectoryFilters>(DEFAULT_FILTERS);
  const [choices, setChoices] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const guard = useDraftGuard();
  const content = useRef<HTMLDivElement>(null);

  // Choices for filters and forms: active departments and locations, loaded once per visit.
  const departments = useLoad(`people-departments|${slug}|${choices}`, (signal) => client.departments(slug, signal));
  const locations = useLoad(`people-locations|${slug}|${choices}`, (signal) => client.locations(slug, signal));
  const team = useLoad(`people-team|${slug}|${canListMembers}`, async (signal) => (canListMembers && customers ? customers.members(slug, signal) : { kind: 'forbidden' as const }));
  const pick = <T,>(load: { state: Loaded<T> }): T | null => (load.state.status === 'done' && load.state.outcome.kind === 'ok' ? load.state.outcome.data : null);

  const tabs = [{ id: 'list', label: 'Employees' }, { id: 'departments', label: 'Departments' }, { id: 'locations', label: 'Locations' }] as const;
  const onTab = (id: string) => guard.leave(() => go({ name: id as 'list' | 'departments' | 'locations' }));
  const go = (next: View, message: string | null = null) => {
    guard.clearDrafts();
    setNotice(message);
    setView(next);
  };
  const { markDraft } = guard;
  const markForm = useCallback((dirty: boolean) => markDraft('form', dirty), [markDraft]);

  const viewKey = view.name === 'detail' ? `detail:${view.id}` : view.name === 'edit' ? `edit:${view.employee.id}` : view.name;
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [viewKey]);

  return (
    <ZoneFrame zone="People" business={name} user={userLabel} leave={guard.leave} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>
      <div ref={content}>
        {notice ? <p role="status" className="mb-5 rounded-xl border border-border bg-muted px-4 py-3 text-sm">{notice}</p> : null}
        {view.name === 'list' ? (
          <Directory
            client={client} slug={slug} locale={locale} departments={pick(departments)} locations={pick(locations)} filters={filters} onFilters={setFilters}
            canManage={canManage} tabs={tabs} onTab={onTab} onOpen={(id) => go({ name: 'detail', id })} onAdd={() => go({ name: 'new' })} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'departments' || view.name === 'locations' ? (
          <OrgUnits key={view.name} kind={view.name === 'departments' ? 'department' : 'location'} client={client} slug={slug} canConfigure={canConfigure}
            tabs={tabs} tab={view.name} onTab={onTab} onChanged={() => setChoices((n) => n + 1)} onSessionEnded={onSessionEnded} />
        ) : null}
        {view.name === 'detail' ? (
          <Profile
            key={view.id}
            client={client} slug={slug} id={view.id} locale={locale} timeZone={timeZone} members={pick(team)} canManage={canManage} canReadSensitive={canReadSensitive}
            onBack={() => guard.leave(() => go({ name: 'list' }))} onEdit={(employee) => go({ name: 'edit', employee })}
            onDirtyChange={markDraft.bind(null, 'personal')} onChanged={setNotice} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'new' || view.name === 'edit' ? (
          <EmployeeForm
            key={view.name === 'edit' ? view.employee.id : 'new'}
            client={client} slug={slug} employee={view.name === 'edit' ? view.employee : undefined}
            departments={pick(departments)} locations={pick(locations)} members={pick(team)} canLink={canManage && canListMembers}
            onDirtyChange={markForm} onSessionEnded={onSessionEnded}
            onCancel={() => guard.leave(() => go(view.name === 'edit' ? { name: 'detail', id: view.employee.id } : { name: 'list' }))}
            onSaved={(saved) => go({ name: 'detail', id: saved.id }, view.name === 'edit' ? 'Changes saved.' : `${saved.displayName} was added.`)}
          />
        ) : null}
      </div>
      {guard.dialog}
    </ZoneFrame>
  );
}
