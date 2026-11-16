import type { Department, Employee, EmploymentStatus } from '@business-os/contracts';
import { Alert, AlertTitle, Badge, Button } from '@business-os/ui';
import { useState } from 'react';
import type { Member } from '../../api/customers';
import type { PeopleClient } from '../../api/people';
import { ZonePage } from '../../shell/zone-page';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { formatDate, formatWhen, STATUS_LABEL, STATUS_TONE, TRANSITIONS, TYPE_LABEL } from './format';
import { AssignmentDialog, type AssignmentKind } from './assignment-dialog';
import { PersonalSection } from './personal-section';
import { Facts, Section } from './profile-parts';
import { StatusDialog } from './status-dialog';

/**
 * One employee. Work information and history come from the People API for anyone with people:read;
 * personal details appear only for people who also hold people:read_sensitive. The buttons follow the
 * server's keys for presentation only: the API refuses every write again.
 */
export function Profile({ client, slug, id, locale, timeZone, members, departments, canManage, canReadSensitive, onBack, onEdit, onDirtyChange, onChanged, onSessionEnded }: {
  client: PeopleClient; slug: string; id: string; locale?: string; timeZone?: string; members: Member[] | null; departments: Department[] | null;
  canManage: boolean; canReadSensitive: boolean; onBack: () => void; onEdit: (e: Employee) => void;
  onDirtyChange: (dirty: boolean) => void; onChanged: (message: string) => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`employee|${slug}|${id}`, (signal) => client.get(slug, id, signal));
  const history = useLoad(`employee-history|${slug}|${id}`, (signal) => client.history(slug, id, signal));
  const [assign, setAssign] = useState<AssignmentKind | null>(null);
  const [change, setChange] = useState<{ to: EmploymentStatus; label: string } | null>(null);

  if (state.status === 'loading') return <div role="status" aria-busy="true" className="h-40 animate-pulse rounded-2xl bg-muted motion-reduce:animate-none"><span className="sr-only">Loading employee…</span></div>;
  if (state.outcome.kind !== 'ok') {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={onBack}>Back to employees</Button>
        <Problem outcome={state.outcome} what="This employee" onRetry={reload} onSessionEnded={onSessionEnded} />
      </div>
    );
  }
  const e = state.outcome.data;
  const linked = e.userId ? members?.find((m) => m.userId === e.userId) : undefined;
  const hist = history.state.status === 'done' && history.state.outcome.kind === 'ok' ? history.state.outcome.data : null;

  return (
    <ZonePage
      title={<>{e.displayName} <Badge tone={STATUS_TONE[e.status]} className="align-middle">{STATUS_LABEL[e.status]}</Badge></>}
      eyebrow="People"
      description={[e.jobTitle, e.department?.name].filter(Boolean).join(' · ') || undefined}
      secondaryActions={<Button variant="outline" onClick={onBack}>Back to employees</Button>}
      primaryActions={canManage ? (
        <>
          {e.status !== 'TERMINATED' ? <Button variant="secondary" onClick={() => onEdit(e)}>Edit</Button> : null}
          {TRANSITIONS[e.status].map((t) => (
            <Button key={t.to} variant={t.to === 'TERMINATED' ? 'outline' : 'secondary'} onClick={() => setChange({ to: t.to, label: t.label })}>{t.label}</Button>
          ))}
        </>
      ) : undefined}
    >
      {e.status === 'TERMINATED' ? <Alert tone="info"><AlertTitle>Employment ended {formatDate(e.endDate, locale)}. The record and its history are kept.</AlertTitle></Alert> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Contact">
          <Facts items={[['Name', `${e.givenName} ${e.familyName}`], ['Preferred name', e.preferredName], ['Work email', e.workEmail], ['Work phone', e.workPhone]]} />
        </Section>
        <Section title="Employment">
          <Facts items={[
            ['Status', STATUS_LABEL[e.status]], ['Job title', e.jobTitle], ['Employment type', e.employmentType ? TYPE_LABEL[e.employmentType] : null],
            ['Department', e.department ? `${e.department.name}${e.department.archived ? ' (archived)' : ''}` : null],
            ['Reports to', e.manager ? `${e.manager.name}${e.manager.status === 'TERMINATED' ? ' (terminated)' : ''}` : null],
            ['Location', e.location ? `${e.location.name}${e.location.archived ? ' (archived)' : ''}` : null],
            ['Start date', e.startDate ? formatDate(e.startDate, locale) : null], ...(e.endDate ? [['End date', formatDate(e.endDate, locale)] as const] : []),
          ]} />
          {canManage && e.status !== 'TERMINATED' ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setAssign('department')}>Change department</Button>
              <Button size="sm" variant="outline" onClick={() => setAssign('manager')}>Change manager</Button>
            </div>
          ) : null}
        </Section>
        <Section title="Administrative">
          <Facts items={[
            ['Employee number', e.employeeNumber],
            ['Linked team member', e.userId ? (linked?.name ?? 'A member of this business') : 'Not linked'],
            ['Created', formatWhen(e.createdAt, timeZone ?? 'UTC', locale)], ['Last updated', formatWhen(e.updatedAt, timeZone ?? 'UTC', locale)],
          ]} />
          <p className="mt-4 text-xs text-muted-foreground">An employee record is separate from a sign-in. Linking, or changing employment status, never changes someone's access.</p>
        </Section>
        {canReadSensitive ? (
          <Section title="Personal details">
            <PersonalSection client={client} slug={slug} employeeId={id} canEdit={canManage} onDirtyChange={onDirtyChange} onSessionEnded={onSessionEnded} />
          </Section>
        ) : null}
      </div>

      <Section title="Department and reporting history">
        {hist && hist.departments.length + hist.managers.length === 0 ? <p className="text-sm text-muted-foreground">No department or manager has been assigned.</p> : null}
        {hist ? (
          <ul className="space-y-2 text-sm">
            {[...hist.departments.map((d) => ({ id: d.id, text: `Department: ${d.department.name}`, startsOn: d.startsOn, endsOn: d.endsOn })),
              ...hist.managers.map((m) => ({ id: m.id, text: `Reports to: ${m.manager.name}`, startsOn: m.startsOn, endsOn: m.endsOn }))]
              .sort((a, b) => b.startsOn.localeCompare(a.startsOn)).map((r) => (
                <li key={r.id}><span className="font-medium">{r.text}</span> <span className="text-muted-foreground">{formatDate(r.startsOn, locale)} to {r.endsOn ? formatDate(r.endsOn, locale) : 'now'}</span></li>
              ))}
          </ul>
        ) : null}
      </Section>

      <Section title="Status history">
        {history.state.status === 'loading' ? <p role="status" className="text-sm text-muted-foreground">Loading history…</p> : null}
        {history.state.status === 'done' && history.state.outcome.kind !== 'ok'
          ? <Problem outcome={history.state.outcome} what="Status history" onRetry={history.reload} onSessionEnded={onSessionEnded} /> : null}
        {hist ? (
          <ol className="space-y-3">
            {[...hist.status].reverse().map((s) => (
              <li key={s.id} className="text-sm">
                <span className="font-medium">{STATUS_LABEL[s.toStatus]}</span> <span className="text-muted-foreground">from {formatDate(s.effectiveDate, locale)}{s.fromStatus ? ` (was ${STATUS_LABEL[s.fromStatus]})` : ''}</span>
                {s.reason ? <p className="text-muted-foreground [overflow-wrap:anywhere]">{s.reason}</p> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </Section>

      {assign ? (
        <AssignmentDialog kind={assign} client={client} slug={slug} employee={e} departments={departments} onClose={() => setAssign(null)} onSessionEnded={onSessionEnded}
          onChanged={(next) => { setAssign(null); reload(); history.reload(); onChanged(`${next.displayName}'s ${assign === 'department' ? 'department' : 'manager'} was updated.`); }} />
      ) : null}
      {change ? (
        <StatusDialog client={client} slug={slug} employee={e} to={change.to} label={change.label} onClose={() => setChange(null)} onSessionEnded={onSessionEnded}
          onChanged={(next) => { setChange(null); reload(); history.reload(); onChanged(`${next.displayName} is now ${STATUS_LABEL[next.status].toLowerCase()}.`); }} />
      ) : null}
    </ZonePage>
  );
}
