import type { Customer } from '@business-os/contracts';
import { useRef, useState, type ReactNode } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { ProjectsClient } from '../../api/projects';
import { actionClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useDialog } from '../dialog';
import { useLoad } from '../use-load';
import { KindBadge, StatusBadge } from './directory';
import { addressLines, formatWhen } from './format';
import { Breakable, linkClass, safeHref, telHref } from './links';
import { ManageContacts } from './manage-contacts';
import type { ContactFocus } from './contact-entry';
import { ActivityComposer } from './activity-composer';
import { ActivityTimeline } from '../activity/activity-timeline';
import { ConversationHistory } from '../activity/conversation-history';
import { NoteComposer } from '../activity/note-composer';
import { CustomerProjects } from '../projects/customer-projects';
import { CustomerFinance } from '../finance/customer-finance';
import type { FinanceClient } from '../../api/finance';
import type { SalesClient } from '../../api/sales';
import { CustomerOpportunities } from '../sales/customer-opportunities';

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


/**
 * One customer's workspace. Everything shown is a real record from the API; contacts and activity
 * are managed through the existing tenant-scoped API. Archive asks first and restore is one click.
 */
export function CustomerDetail({ client, slug, id, contact, locale, timeZone, canWrite, canLogActivity, canReadMessages = false, projects, finance, sales, userId, onBack, onEdit, onDraftChange, confirmDiscard, onSessionEnded }: {
  client: CustomersClient; slug: string; id: string; locale?: string; timeZone: string; canWrite: boolean; canLogActivity: boolean;
  /** A contact to mark in the contacts panel (the page was opened from a `contact:<id>` target). */
  contact?: ContactFocus;
  /** communications:read: show the conversation history panel. */
  canReadMessages?: boolean;
  /** The customer's projects, shown only to people who may read projects (the server checks again). */
  projects?: ProjectsLink;
  /** The customer's finance, shown only to people who may read finance (the server checks again). */
  finance?: FinanceLink;
  /** The customer's sales opportunities, shown only to people who may read sales (the server checks again). */
  sales?: SalesLink;
  /** The signed-in user, so they can edit or remove their own timeline entries. */
  userId?: string;
  onBack: () => void; onEdit: (c: Customer) => void;
  /** Open contact or activity drafts report here, so the Zone asks before anything would discard them. */
  onDraftChange: (key: string, dirty: boolean) => void; confirmDiscard: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const customer = useLoad(`customer|${slug}|${id}`, (signal) => client.get(slug, id, signal));
  // While a refresh is in flight, keep showing the record already on screen (same business, same id).
  const shown = customer.state.status === 'done'
    ? (customer.state.outcome.kind === 'ok' ? customer.state.outcome.data : null)
    : (customer.previous?.kind === 'ok' ? customer.previous.data : null);
  const members = useLoad(`members|${slug}`, (signal) => client.members(slug, signal));
  // null while the team list is loading, so a name never flashes from "a team member" to the real one.
  const names = members.state.status === 'loading' ? null : new Map(members.state.outcome.kind === 'ok' ? members.state.outcome.data.map((m) => [m.userId, m.name ?? 'Team member']) : []);

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-hidden="true">←</span> All customers
      </button>
      {shown === null && customer.state.status === 'loading' ? <Skeleton rows={4} label="Loading customer…" /> : null}
      {customer.state.status === 'done' && customer.state.outcome.kind !== 'ok' ? (
        <Problem outcome={customer.state.outcome} what="This customer" onRetry={customer.reload} onSessionEnded={onSessionEnded} />
      ) : null}
      {shown ? (
        // Keyed by id only: a refresh (after archiving, a primary-contact change, …) updates the page in
        // place instead of remounting it, so open drafts below are never thrown away.
        <Loaded
          key={shown.id}
          customer={shown} contact={contact} client={client} slug={slug} locale={locale} timeZone={timeZone} canWrite={canWrite} canLogActivity={canLogActivity} canReadMessages={canReadMessages}
          names={names} projects={projects} finance={finance} sales={sales} userId={userId} onEdit={onEdit} onChanged={customer.reload} onDraftChange={onDraftChange} confirmDiscard={confirmDiscard} onSessionEnded={onSessionEnded}
        />
      ) : null}
    </div>
  );
}

export interface ProjectsLink { client: ProjectsClient; onOpen: (projectId: string) => void }
/** The customer's opportunities panel, passed only to people who hold sales:read. */
export interface SalesLink { client: SalesClient; onOpen: (opportunityId: string) => void }
/** The customer's finance panel, passed only to people who hold finance:read. `onOpen` takes `invoice:<id>`, `quote:<id>` or `payment:<id>`. */
export interface FinanceLink { client: FinanceClient; onOpen: (target: string) => void }

function Loaded({ customer, contact, client, slug, locale, timeZone, canWrite, canLogActivity, canReadMessages, names, projects, finance, sales, userId, onEdit, onChanged, onDraftChange, confirmDiscard, onSessionEnded }: {
  customer: Customer; contact?: ContactFocus; client: CustomersClient; slug: string; locale?: string; timeZone: string; canWrite: boolean; canLogActivity: boolean; canReadMessages: boolean;
  names: Map<string, string> | null; projects?: ProjectsLink; finance?: FinanceLink; sales?: SalesLink; userId?: string; onEdit: (c: Customer) => void; onChanged: () => void;
  onDraftChange: (key: string, dirty: boolean) => void; confirmDiscard: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const archived = customer.archivedAt !== null;
  const [confirming, setConfirming] = useState(false);
  const { ref: archiveRef, onKeyDown: onArchiveKey } = useDialog(confirming, () => setConfirming(false));
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
            {archived ? null : <button type="button" className={secondaryClass} onClick={() => confirmDiscard(() => onEdit(customer))}>Edit</button>}
            {archived
              ? <button type="button" className={actionClass} disabled={busy} onClick={() => void change('restore')}>{busy ? 'Restoring…' : 'Restore customer'}</button>
              : <button type="button" className={secondaryClass} disabled={busy} onClick={() => setConfirming(true)}>Archive</button>}
          </div>
        ) : null}
      </header>

      {archived ? <p role="status" className="mb-6 rounded-xl border border-border bg-muted px-4 py-3 text-sm">This customer is archived. It is hidden from the active list and cannot be edited until it is restored.</p> : null}
      {confirming ? (
        <div ref={archiveRef} onKeyDown={onArchiveKey} role="alertdialog" aria-labelledby="archive-title" aria-describedby="archive-body" className="mb-6 rounded-2xl border border-border bg-card p-5">
          <h2 id="archive-title" className="text-base font-semibold">Archive {customer.displayName}?</h2>
          <p id="archive-body" className="mt-1 text-sm text-muted-foreground">They will be hidden from the active list. Nothing is deleted, and you can restore them at any time.</p>
          <div className="mt-4 flex gap-3">
            <button type="button" className={actionClass} disabled={busy} onClick={() => confirmDiscard(() => void change('archive'))}>{busy ? 'Archiving…' : 'Archive customer'}</button>
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
          <ManageContacts customer={customer} focus={contact} client={client} slug={slug} canWrite={canWrite} onCustomerChanged={onChanged} onDraftChange={onDraftChange} confirmDiscard={confirmDiscard} onSessionEnded={onSessionEnded} />
        </div>
        <div className="lg:col-span-2 lg:row-start-2">
          <Panel title="Notes">
            {customer.notes ? <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">{customer.notes}</p> : <p className="text-sm text-muted-foreground">No notes yet.{canWrite && !archived ? ' Use Edit to add some.' : ''}</p>}
          </Panel>
        </div>
        <div className="lg:col-span-2 lg:row-start-3">
          <ActivityPanel customerId={customer.id} userId={userId} client={client} slug={slug} locale={locale} timeZone={timeZone} names={names} canWrite={canLogActivity && !archived} onDraftChange={onDraftChange} confirmDiscard={confirmDiscard} onSessionEnded={onSessionEnded} />
          {canReadMessages ? (
            <div className="mt-5">
              <ConversationsPanel customerId={customer.id} client={client} slug={slug} locale={locale} timeZone={timeZone} names={names} onSessionEnded={onSessionEnded} />
            </div>
          ) : null}
        </div>
        <div className="space-y-5 self-start lg:col-start-3 lg:row-start-3">
          {sales ? (
            <CustomerOpportunities client={sales.client} slug={slug} customerId={customer.id} locale={locale} onOpen={(oid) => confirmDiscard(() => sales.onOpen(oid))} onSessionEnded={onSessionEnded} />
          ) : null}
          {projects ? (
            <CustomerProjects client={projects.client} slug={slug} customerId={customer.id} onOpen={(id) => confirmDiscard(() => projects.onOpen(id))} onSessionEnded={onSessionEnded} />
          ) : null}
          {finance ? (
            <CustomerFinance client={finance.client} slug={slug} customerId={customer.id} locale={locale} timeZone={timeZone}
              onOpen={(target) => confirmDiscard(() => finance.onOpen(target))} onSessionEnded={onSessionEnded} />
          ) : null}
        </div>
      </div>
    </>
  );
}

function ActivityPanel({ customerId, userId, client, slug, locale, timeZone, names, canWrite, onDraftChange, confirmDiscard, onSessionEnded }: {
  customerId: string; userId?: string; client: CustomersClient; slug: string; locale?: string; timeZone: string; names: Map<string, string> | null; canWrite: boolean;
  onDraftChange: (key: string, dirty: boolean) => void; confirmDiscard: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const [refresh, setRefresh] = useState(0);
  const saved = () => setRefresh((n) => n + 1);
  return (
    <Panel title="Activity">
      {canWrite ? (
        <div className="mb-5 space-y-3">
          <NoteComposer client={client} slug={slug} customerId={customerId} onSaved={saved} onDraftChange={onDraftChange} confirmDiscard={confirmDiscard} onSessionEnded={onSessionEnded} />
          <ActivityComposer client={client} slug={slug} customerId={customerId} onSaved={saved} onDraftChange={onDraftChange} confirmDiscard={confirmDiscard} onSessionEnded={onSessionEnded} />
        </div>
      ) : null}
      <ActivityTimeline load={(cursor, types, signal) => client.activities(slug, customerId, cursor, signal, types)} loadKey={`${slug}|${customerId}`} refreshKey={refresh}
        names={names} locale={locale} timeZone={timeZone} onSessionEnded={onSessionEnded}
        manage={userId && canWrite ? { userId, client, slug, onChanged: saved, onDraftChange, confirmDiscard, onSessionEnded } : undefined}
        emptyHint="Notes, logged calls, meetings and emails, recorded messages and changes to this customer appear here." />
    </Panel>
  );
}

function ConversationsPanel({ customerId, client, slug, locale, timeZone, names, onSessionEnded }: {
  customerId: string; client: CustomersClient; slug: string; locale?: string; timeZone: string; names: Map<string, string> | null; onSessionEnded: () => void;
}) {
  return (
    <Panel title="Conversations">
      <ConversationHistory loadConversations={(cursor, signal) => client.conversations(slug, customerId, cursor, signal)}
        loadMessages={(conversationId, cursor, signal) => client.messages(slug, conversationId, cursor, signal)}
        loadKey={`${slug}|${customerId}`} names={names} locale={locale} timeZone={timeZone} onSessionEnded={onSessionEnded} />
    </Panel>
  );
}
