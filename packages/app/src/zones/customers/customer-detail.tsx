import type { Activity, Customer } from '@business-os/contracts';
import { useRef, useState, type ReactNode } from 'react';
import type { CustomersClient } from '../../api/customers';
import { actionClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { KindBadge, StatusBadge } from './directory';
import { activityTitle, addressLines, formatWhen, isSystemActivity } from './format';
import { CallIcon, EmailIcon, MeetingIcon, NoteIcon } from './icons';
import { ManageContacts } from './manage-contacts';
import { ActivityComposer } from './activity-composer';

function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 py-2.5 text-sm sm:grid-cols-[7rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** A tel: link only for something that is plainly a phone number. */
const telHref = (phone: string) => {
  const digits = phone.replace(/[^\d+]/g, '');
  return /^\+?\d{3,}$/.test(digits) ? `tel:${digits}` : null;
};

/** Lets a long email break after the @ (a clean place) before it would ever break mid-word. */
function Breakable({ text }: { text: string }) {
  const at = text.indexOf('@');
  return at < 0 ? <>{text}</> : <>{text.slice(0, at + 1)}<wbr />{text.slice(at + 1)}</>;
}

const linkClass = 'underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring';

const safeHref = (site: string) => {
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(site) ? site : `https://${site}`;
  return /^https?:\/\//i.test(url) ? url : null;
};

/**
 * One customer's workspace. Everything shown is a real record from the API; contacts and activity
 * are managed through the existing tenant-scoped API. Archive asks first and restore is one click.
 */
export function CustomerDetail({ client, slug, id, locale, timeZone, canWrite, canLogActivity, onBack, onEdit, onSessionEnded }: {
  client: CustomersClient; slug: string; id: string; locale?: string; timeZone: string; canWrite: boolean; canLogActivity: boolean;
  onBack: () => void; onEdit: (c: Customer) => void; onSessionEnded: () => void;
}) {
  const customer = useLoad(`customer|${slug}|${id}`, (signal) => client.get(slug, id, signal));
  const members = useLoad(`members|${slug}`, (signal) => client.members(slug, signal));
  // null while the team list is loading, so a name never flashes from "a team member" to the real one.
  const names = members.state.status === 'loading' ? null : new Map(members.state.outcome.kind === 'ok' ? members.state.outcome.data.map((m) => [m.userId, m.name ?? 'Team member']) : []);

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-hidden="true">←</span> All customers
      </button>
      {customer.state.status === 'loading' ? <Skeleton rows={4} label="Loading customer…" /> : null}
      {customer.state.status === 'done' && customer.state.outcome.kind !== 'ok' ? (
        <Problem outcome={customer.state.outcome} what="This customer" onRetry={customer.reload} onSessionEnded={onSessionEnded} />
      ) : null}
      {customer.state.status === 'done' && customer.state.outcome.kind === 'ok' ? (
        <Loaded
          key={`${customer.state.outcome.data.id}:${customer.state.outcome.data.updatedAt}`}
          customer={customer.state.outcome.data} client={client} slug={slug} locale={locale} timeZone={timeZone} canWrite={canWrite} canLogActivity={canLogActivity}
          names={names} onEdit={onEdit} onChanged={customer.reload} onSessionEnded={onSessionEnded}
        />
      ) : null}
    </div>
  );
}

function Loaded({ customer, client, slug, locale, timeZone, canWrite, canLogActivity, names, onEdit, onChanged, onSessionEnded }: {
  customer: Customer; client: CustomersClient; slug: string; locale?: string; timeZone: string; canWrite: boolean; canLogActivity: boolean;
  names: Map<string, string> | null; onEdit: (c: Customer) => void; onChanged: () => void; onSessionEnded: () => void;
}) {
  const archived = customer.archivedAt !== null;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);

  const change = async (action: 'archive' | 'restore') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setProblem(null);
    const outcome = action === 'archive' ? await client.archive(slug, customer.id) : await client.restore(slug, customer.id);
    inFlight.current = false;
    setBusy(false);
    if (outcome.kind === 'ok') {
      setConfirming(false);
      return onChanged();
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    setProblem(
      outcome.kind === 'conflict' ? 'This customer was already changed by someone else. Refreshing.'
        : outcome.kind === 'forbidden' ? 'Your role does not allow this.'
        : outcome.kind === 'unreachable' ? "Can't reach Business OS. Nothing was changed; try again."
        : 'Something went wrong. Nothing was changed.',
    );
    if (outcome.kind === 'conflict') onChanged();
  };

  const address = addressLines(customer, locale);
  const href = customer.website ? safeHref(customer.website) : null;
  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{customer.displayName}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <KindBadge kind={customer.kind} />
            <StatusBadge archived={archived} />
            {customer.legalName && customer.legalName !== customer.displayName ? <span className="text-sm text-muted-foreground">{customer.legalName}</span> : null}
          </div>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {archived ? null : <button type="button" className={secondaryClass} onClick={() => onEdit(customer)}>Edit</button>}
            {archived
              ? <button type="button" className={actionClass} disabled={busy} onClick={() => void change('restore')}>{busy ? 'Restoring…' : 'Restore customer'}</button>
              : <button type="button" className={secondaryClass} disabled={busy} onClick={() => setConfirming(true)}>Archive</button>}
          </div>
        ) : null}
      </header>

      {archived ? <p role="status" className="mb-6 rounded-xl border border-border bg-muted px-4 py-3 text-sm">This customer is archived. It is hidden from the active list and cannot be edited until it is restored.</p> : null}
      {confirming ? (
        <div role="alertdialog" aria-labelledby="archive-title" aria-describedby="archive-body" className="mb-6 rounded-2xl border border-border bg-card p-5">
          <h2 id="archive-title" className="text-base font-semibold">Archive {customer.displayName}?</h2>
          <p id="archive-body" className="mt-1 text-sm text-muted-foreground">They will be hidden from the active list. Nothing is deleted, and you can restore them at any time.</p>
          <div className="mt-4 flex gap-3">
            <button type="button" className={actionClass} disabled={busy} onClick={() => void change('archive')}>{busy ? 'Archiving…' : 'Archive customer'}</button>
            <button type="button" className={secondaryClass} disabled={busy} onClick={() => setConfirming(false)} autoFocus>Keep active</button>
          </div>
        </div>
      ) : null}
      {problem ? <p role="alert" className="mb-6 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">{problem}</p> : null}

      {/* One column on small windows (details, contacts, notes, activity, then the placeholder); two on wide ones. */}
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2 lg:row-start-1">
          <Panel title="Details">
            <dl className="divide-y divide-border">
              <Row label="Email">{customer.email ? <a className={linkClass} href={`mailto:${customer.email}`}><Breakable text={customer.email} /></a> : <span className="text-muted-foreground">Not set</span>}</Row>
              <Row label="Phone">{customer.phone ? (telHref(customer.phone) ? <a className={linkClass} href={telHref(customer.phone)!}>{customer.phone}</a> : customer.phone) : <span className="text-muted-foreground">Not set</span>}</Row>
              <Row label="Website">{href && customer.website ? <a className={linkClass} href={href} target="_blank" rel="noopener noreferrer">{customer.website}</a> : <span className="text-muted-foreground">Not set</span>}</Row>
              <Row label="Address">{address.length ? address.map((line, i) => <span key={i} className="block">{line}</span>) : <span className="text-muted-foreground">Not set</span>}</Row>
              <Row label="Owner">{customer.ownerUserId ? names?.get(customer.ownerUserId) ?? 'Assigned' : <span className="text-muted-foreground">No owner</span>}</Row>
              <Row label="Added">{formatWhen(customer.createdAt, timeZone, locale)}</Row>
            </dl>
          </Panel>
        </div>
        <div className="self-start lg:col-start-3 lg:row-span-2 lg:row-start-1">
          <ManageContacts customer={customer} client={client} slug={slug} canWrite={canWrite && !archived} onCustomerChanged={onChanged} onSessionEnded={onSessionEnded} />
        </div>
        <div className="lg:col-span-2 lg:row-start-2">
          <Panel title="Notes">
            {customer.notes ? <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{customer.notes}</p> : <p className="text-sm text-muted-foreground">No notes yet.{canWrite && !archived ? ' Use Edit to add some.' : ''}</p>}
          </Panel>
        </div>
        <div className="lg:col-span-2 lg:row-start-3">
          <ActivityPanel customerId={customer.id} client={client} slug={slug} locale={locale} timeZone={timeZone} names={names} canWrite={canLogActivity && !archived} onSessionEnded={onSessionEnded} />
        </div>
        <section aria-label="Sales and Finance" className="self-start rounded-2xl border border-dashed border-border px-5 py-4 lg:col-start-3 lg:row-start-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xs font-medium text-muted-foreground">Sales and Finance</h2>
            <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">Coming soon</span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Quotes, invoices and payments for this customer will appear here when those Zones arrive.</p>
        </section>
      </div>
    </>
  );
}

function ActivityPanel({ customerId, client, slug, locale, timeZone, names, canWrite, onSessionEnded }: {
  customerId: string; client: CustomersClient; slug: string; locale?: string; timeZone: string; names: Map<string, string> | null; canWrite: boolean; onSessionEnded: () => void;
}) {
  const [stack, setStack] = useState<string[]>([]);
  const cursor = stack[stack.length - 1];
  const { state, reload } = useLoad(`activity|${slug}|${customerId}|${cursor ?? ''}`, (signal) => client.activities(slug, customerId, cursor, signal));
  return (
    <Panel title="Activity">
      {canWrite ? <ActivityComposer client={client} slug={slug} customerId={customerId} onSaved={() => { setStack([]); reload(); }} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'loading' ? <Skeleton rows={3} label="Loading activity…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Activity" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'done' && state.outcome.kind === 'ok' ? (
        <>
          {state.outcome.data.activities.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : (
            <ol className="space-y-3.5">
              {state.outcome.data.activities.map((a) => <ActivityItem key={a.id} a={a} locale={locale} timeZone={timeZone} who={a.actorUserId ? (names ? names.get(a.actorUserId) ?? 'A team member' : null) : 'System'} />)}
            </ol>
          )}
          {stack.length > 0 || state.outcome.data.nextCursor ? (
            <nav aria-label="Activity pages" className="mt-5 flex justify-between border-t border-border pt-4">
              <button type="button" className={secondaryClass} disabled={stack.length === 0} onClick={() => setStack(stack.slice(0, -1))}>Newer</button>
              <button type="button" className={secondaryClass} disabled={!state.outcome.data.nextCursor} onClick={() => state.outcome.kind === 'ok' && state.outcome.data.nextCursor && setStack([...stack, state.outcome.data.nextCursor])}>Older</button>
            </nav>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}

const USER_KIND: Record<string, { label: string; Icon: () => React.JSX.Element }> = {
  note: { label: 'Note', Icon: NoteIcon },
  call: { label: 'Call', Icon: CallIcon },
  meeting: { label: 'Meeting', Icon: MeetingIcon },
  email: { label: 'Email', Icon: EmailIcon },
};

/**
 * Things people logged (notes, calls, meetings, emails) get an icon and normal weight. Automated
 * changes are smaller and quieter, with no icon, so the human history reads first. Both keep who and when.
 */
function ActivityItem({ a, who, locale, timeZone }: { a: Activity; who: string | null; locale?: string; timeZone: string }) {
  const meta = (
    <p className="mt-0.5 text-xs text-muted-foreground">{who ? `${who} · ` : ''}<time dateTime={a.occurredAt}>{formatWhen(a.occurredAt, timeZone, locale)}</time></p>
  );
  if (isSystemActivity(a)) {
    return (
      <li data-kind="system" className="flex gap-3 pl-1.5">
        <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{activityTitle(a)}</p>
          {meta}
        </div>
      </li>
    );
  }
  const kind = USER_KIND[a.type] ?? USER_KIND.note!;
  return (
    <li data-kind="user" className="flex gap-3">
      <span role="img" aria-label={kind.label} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-foreground"><kind.Icon /></span>
      <div className="min-w-0">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{activityTitle(a)}</p>
        {a.body ? <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">{a.body}</p> : null}
        {meta}
      </div>
    </li>
  );
}
