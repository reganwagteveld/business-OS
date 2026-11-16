import type { Contact } from '@business-os/contracts';
import { useEffect, type ReactNode } from 'react';
import type { CustomersClient } from '../../api/customers';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { StatusBadge } from './directory';
import { Breakable, linkClass, telHref } from './links';

/** Which contact a customer's page should mark, and whether it sits in the archived list. */
export interface ContactFocus { id: string; archived: boolean }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens one contact by id (the `contact:<id>` target, GS1 §10.6). The contact is read through the
 * tenant-scoped API, which checks the business and the role again. A contact with a customer hands
 * over to that customer's page with the contact marked; one without a customer gets a read-only page.
 * A missing, unreadable or malformed id shows the Zone's usual problem state and nothing else.
 */
export function ContactEntry({ client, slug, id, onCustomer, onBack, onSessionEnded }: {
  client: CustomersClient; slug: string; id: string;
  onCustomer: (customerId: string, contact: ContactFocus) => void; onBack: () => void; onSessionEnded: () => void;
}) {
  const valid = UUID.test(id);
  const contact = useLoad(`contact|${slug}|${id}`, (signal) => (valid ? client.getContact(slug, id, signal) : Promise.resolve({ kind: 'not_found' as const })));
  const found = contact.state.status === 'done' && contact.state.outcome.kind === 'ok' ? contact.state.outcome.data : null;
  const customerId = found?.customerId ?? null;
  const archived = found?.archivedAt != null;

  useEffect(() => {
    if (customerId) onCustomer(customerId, { id, archived });
  }, [customerId, id, archived, onCustomer]);

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-4 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <span aria-hidden="true">←</span> All customers
      </button>
      {contact.state.status === 'loading' || customerId ? <Skeleton rows={3} label="Loading contact…" /> : null}
      {contact.state.status === 'done' && contact.state.outcome.kind !== 'ok' ? (
        <Problem outcome={contact.state.outcome} what="This contact" onRetry={contact.reload} onSessionEnded={onSessionEnded} />
      ) : null}
      {found && !customerId ? <StandaloneContact contact={found} /> : null}
    </div>
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

const notSet = <span className="text-muted-foreground">Not set</span>;
const phoneLink = (value: string) => (telHref(value) ? <a className={linkClass} href={telHref(value)!}>{value}</a> : value);

/**
 * A contact that belongs to no customer. Read-only: the same fields the customer page lists for a
 * contact (job title, email, phone, mobile), nothing more. Editing stays with the customer's page.
 */
function StandaloneContact({ contact }: { contact: Contact }) {
  return (
    <>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">{contact.displayName}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Contact</span>
          <StatusBadge archived={contact.archivedAt !== null} />
        </div>
      </header>
      <p role="status" className="mb-6 rounded-xl border border-border bg-muted px-4 py-3 text-sm">This contact is not linked to a customer.</p>
      <section aria-label="Contact details" className="rounded-2xl border border-border bg-card p-6">
        <h2 className="mb-4 text-sm font-semibold tracking-tight">Details</h2>
        <dl className="divide-y divide-border">
          <Row label="Job title">{contact.jobTitle ?? notSet}</Row>
          <Row label="Email">{contact.email ? <a className={linkClass} href={`mailto:${contact.email}`}><Breakable text={contact.email} /></a> : notSet}</Row>
          <Row label="Phone">{contact.phone ? phoneLink(contact.phone) : notSet}</Row>
          <Row label="Mobile">{contact.mobile ? phoneLink(contact.mobile) : notSet}</Row>
        </dl>
      </section>
    </>
  );
}
