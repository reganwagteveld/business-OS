import type { Contact, Customer } from '@business-os/contracts';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';
import { Breakable, linkClass, telHref } from './links';

// Name fields first; the display name is an optional override (PR 11 name rules: left blank, the
// server derives it from the first and last name, or from the email).
const FIELDS = ['firstName', 'lastName', 'email', 'phone', 'mobile', 'jobTitle', 'notes', 'displayName'] as const;
type Field = (typeof FIELDS)[number];
type Values = Record<Field, string>;
const LABEL: Record<Field, string> = {
  firstName: 'First name', lastName: 'Last name', email: 'Email', phone: 'Phone', mobile: 'Mobile', jobTitle: 'Job title', notes: 'Notes',
  displayName: 'Display name (optional)',
};
const MAX: Record<Field, number> = { firstName: 100, lastName: 100, email: 254, phone: 50, mobile: 50, jobTitle: 100, notes: 2000, displayName: 200 };
const valuesOf = (c?: Contact): Values => Object.fromEntries(FIELDS.map((f) => [f, c?.[f] ?? ''])) as Values;

/** What a failed contact change means for the person, in plain words. */
function explain(outcome: Exclude<Outcome<unknown>, { kind: 'ok' }>): string {
  switch (outcome.kind) {
    case 'invalid_input': return outcome.message;
    case 'conflict': return 'This contact or customer was archived in the meantime. The list has been refreshed.';
    case 'forbidden': return 'Your role does not allow changing contacts in this business.';
    case 'not_found': return 'This contact no longer exists in this business. The list has been refreshed.';
    // The request may have reached the server: never claim it failed, and never retry by itself.
    case 'unreachable': return "Business OS didn't answer, so this may or may not have been saved. The list has been refreshed; check it before trying again.";
    case 'rate_limited': return 'Too many requests. Wait a moment and try again.';
    default: return 'Something went wrong. Nothing was changed.';
  }
}

/**
 * The customer's contacts: add, edit, make primary, archive and restore, through the PR 11 API.
 * Every contact is loaded (all pages), so the primary contact always shows first. An open form
 * reports unsaved changes to the Zone, which asks before anything would discard them.
 */
export function ManageContacts({ customer, client, slug, canWrite, onCustomerChanged, onDraftChange, confirmDiscard, onSessionEnded }: {
  customer: Customer; client: CustomersClient; slug: string; canWrite: boolean;
  onCustomerChanged: () => void; onDraftChange: (key: string, dirty: boolean) => void; confirmDiscard: (action: () => void) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const active = useLoad(`contacts|${slug}|${customer.id}|active`, (signal) => client.contacts(slug, customer.id, 'active', signal));
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<{ contact: Contact | null; initial: Values } | null>(null);
  const [values, setValues] = useState<Values>(valuesOf());
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Contact | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const archivedCustomer = customer.archivedAt !== null;
  const allowed = canWrite && !archivedCustomer;

  const dirty = editing !== null && JSON.stringify(values) !== JSON.stringify(editing.initial);
  useEffect(() => onDraftChange('contact', dirty), [dirty, onDraftChange]);
  useEffect(() => () => onDraftChange('contact', false), [onDraftChange]);

  const open = (contact: Contact | null) => {
    const initial = valuesOf(contact ?? undefined);
    setEditing({ contact, initial });
    setValues(initial);
    setFieldErrors({});
    setError(null);
    setMessage(null);
  };
  const close = () => {
    setEditing(null);
    setFieldErrors({});
    setError(null);
  };

  /** Runs one change at a time; a second click while one is in flight does nothing. */
  async function run<T>(request: () => Promise<Outcome<T>>, done: (data: T) => void) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setMessage(null);
    let outcome: Outcome<T>;
    try {
      outcome = await request();
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'ok') return done(outcome.data);
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    if (outcome.kind === 'invalid_input' && outcome.fields) setFieldErrors(outcome.fields as Partial<Record<Field, string>>);
    setError(explain(outcome));
    if (outcome.kind !== 'invalid_input' && outcome.kind !== 'forbidden' && outcome.kind !== 'rate_limited') {
      active.reload();
      onCustomerChanged();
    }
    queueMicrotask(() => errorRef.current?.focus());
  }

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const existing = editing.contact;
    if (![values.displayName, values.firstName, values.lastName, values.email].some((v) => v.trim())) {
      setFieldErrors({ firstName: 'Enter a name or an email address.' });
      setError('Enter a name or an email address.');
      queueMicrotask(() => errorRef.current?.focus());
      return;
    }
    const input: Record<string, unknown> = {};
    for (const f of FIELDS) {
      if (existing && values[f] === editing.initial[f]) continue; // edits send only what changed
      if (!existing && values[f].trim() === '') continue;
      input[f] = values[f].trim(); // '' clears the field; a cleared display name is derived again by the server
    }
    if (existing && Object.keys(input).length === 0) return close();
    if (!existing) input.customerId = customer.id;
    void run(
      () => (existing ? client.updateContact(slug, existing.id, input) : client.createContact(slug, input)),
      (saved) => {
        close();
        setMessage(existing ? `${saved.displayName} updated.` : `${saved.displayName} added.`);
        active.reload();
      },
    );
  };

  const cancel = () => (dirty ? confirmDiscard(close) : close());

  // The last good list is reused only while a refresh of the same list is in flight. Once a refresh
  // fails, no rows are shown (only the error), so nobody acts on a list that may be out of date.
  const contacts = active.state.status === 'done'
    ? (active.state.outcome.kind === 'ok' ? active.state.outcome.data : null)
    : (active.previous?.kind === 'ok' ? active.previous.data : null);
  const ordered = contacts ? [...contacts].sort((a, b) => Number(b.id === customer.primaryContactId) - Number(a.id === customer.primaryContactId)) : null;

  return (
    <section aria-label="Contacts" className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-tight">Contacts</h2>
        {allowed && !editing ? <button type="button" className={secondaryClass} onClick={() => open(null)}>Add contact</button> : null}
      </div>
      {message ? <p role="status" className="mb-3 text-sm">{message}</p> : null}
      {error ? <p ref={errorRef} tabIndex={-1} role="alert" className="mb-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive outline-none">{error}</p> : null}

      {editing ? (
        <form onSubmit={save} noValidate aria-labelledby={`${uid}-form`} className="space-y-3">
          <h3 id={`${uid}-form`} className="text-sm font-semibold">{editing.contact ? `Edit ${editing.contact.displayName}` : 'Add contact'}</h3>
          {FIELDS.map((f) => (
            <Labelled key={f} id={`${uid}-${f}`} label={LABEL[f]} error={fieldErrors[f]} hint={f === 'displayName' ? 'Leave blank to use the name or email.' : undefined}>
              {f === 'notes' ? (
                <textarea id={`${uid}-${f}`} rows={3} maxLength={MAX[f]} value={values[f]} onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                  aria-invalid={fieldErrors[f] ? true : undefined} aria-describedby={fieldErrors[f] ? `${uid}-${f}-error` : undefined} className={inputClass} />
              ) : (
                <input id={`${uid}-${f}`} type={f === 'email' ? 'email' : f === 'phone' || f === 'mobile' ? 'tel' : 'text'} autoComplete="off" maxLength={MAX[f]} value={values[f]}
                  onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                  aria-invalid={fieldErrors[f] ? true : undefined} aria-describedby={fieldErrors[f] ? `${uid}-${f}-error` : f === 'displayName' ? `${uid}-${f}-hint` : undefined} className={inputClass} />
              )}
            </Labelled>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button type="submit" className={actionClass} disabled={busy}>{busy ? 'Saving…' : 'Save contact'}</button>
            <button type="button" className={secondaryClass} disabled={busy} onClick={cancel}>Cancel</button>
            {dirty && !busy ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
          </div>
        </form>
      ) : null}

      {!editing && !ordered && active.state.status === 'loading' ? <Skeleton rows={2} label="Loading contacts…" /> : null}
      {!editing && active.state.status === 'done' && active.state.outcome.kind !== 'ok' ? <Problem outcome={active.state.outcome} what="Contacts" onRetry={active.reload} onSessionEnded={onSessionEnded} /> : null}
      {!editing && ordered ? (
        ordered.length === 0 ? (
          <p className="text-sm text-muted-foreground">No contacts are linked to this customer yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {ordered.map((c) => (
              <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {c.displayName}
                  {c.id === customer.primaryContactId ? <span aria-label="Primary contact" className="rounded-md bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">Primary</span> : null}
                </p>
                <ContactLines contact={c} />
                {allowed ? (
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    <TextButton onClick={() => open(c)} label={`Edit: ${c.displayName}`}>Edit</TextButton>
                    {c.id !== customer.primaryContactId ? (
                      <TextButton disabled={busy} label={`Make primary: ${c.displayName}`}
                        onClick={() => void run(() => client.update(slug, customer.id, { primaryContactId: c.id }), () => { setMessage(`${c.displayName} is now the primary contact.`); onCustomerChanged(); })}>
                        Make primary
                      </TextButton>
                    ) : null}
                    <TextButton disabled={busy} onClick={() => setConfirm(c)} label={`Archive: ${c.displayName}`}>Archive</TextButton>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}

      {confirm ? (
        <div role="alertdialog" aria-labelledby={`${uid}-archive-title`} aria-describedby={`${uid}-archive-body`} className="mt-4 rounded-xl border border-border p-4">
          <h3 id={`${uid}-archive-title`} className="text-sm font-semibold">Archive {confirm.displayName}?</h3>
          <p id={`${uid}-archive-body`} className="mt-1 text-sm text-muted-foreground">
            {confirm.id === customer.primaryContactId ? 'They are the primary contact, so this customer will have no primary contact. ' : ''}Nothing is deleted, and you can restore them from archived contacts.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={actionClass} disabled={busy}
              onClick={() => void run(() => client.archiveContact(slug, confirm.id), (c) => { setConfirm(null); setMessage(`${c.displayName} archived.`); active.reload(); onCustomerChanged(); })}>
              {busy ? 'Archiving…' : 'Archive contact'}
            </button>
            <button type="button" autoFocus className={secondaryClass} disabled={busy} onClick={() => setConfirm(null)}>Keep</button>
          </div>
        </div>
      ) : null}

      {!editing ? (
        <div className="mt-4 border-t border-border pt-3">
          <button type="button" aria-expanded={showArchived} onClick={() => setShowArchived((s) => !s)}
            className="rounded-md text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            {showArchived ? 'Hide archived contacts' : 'Show archived contacts'}
          </button>
          {showArchived ? (
            <ArchivedContacts client={client} slug={slug} customerId={customer.id} canRestore={allowed} busy={busy} onSessionEnded={onSessionEnded}
              onRestore={(c, done) => void run(() => client.restoreContact(slug, c.id), (restored) => { setMessage(`${restored.displayName} restored.`); active.reload(); done(); })} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ArchivedContacts({ client, slug, customerId, canRestore, busy, onRestore, onSessionEnded }: {
  client: CustomersClient; slug: string; customerId: string; canRestore: boolean; busy: boolean;
  onRestore: (c: Contact, done: () => void) => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`contacts|${slug}|${customerId}|archived`, (signal) => client.contacts(slug, customerId, 'archived', signal));
  if (state.status === 'loading') return <Skeleton rows={1} label="Loading archived contacts…" />;
  if (state.outcome.kind !== 'ok') return <div className="mt-3"><Problem outcome={state.outcome} what="Archived contacts" onRetry={reload} onSessionEnded={onSessionEnded} /></div>;
  if (state.outcome.data.length === 0) return <p className="mt-2 text-xs text-muted-foreground">No archived contacts.</p>;
  return (
    <ul aria-label="Archived contacts" className="mt-2 divide-y divide-border">
      {state.outcome.data.map((c) => (
        <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="text-sm text-muted-foreground">{c.displayName}</span>
          {canRestore ? <TextButton disabled={busy} label={`Restore: ${c.displayName}`} onClick={() => onRestore(c, reload)}>Restore</TextButton> : null}
        </li>
      ))}
    </ul>
  );
}

function ContactLines({ contact: c }: { contact: Contact }) {
  const phone = c.phone ?? c.mobile;
  return (
    <>
      {c.jobTitle ? <p className="text-xs text-muted-foreground">{c.jobTitle}</p> : null}
      {c.email ? <p className="text-xs [overflow-wrap:anywhere]"><a className={`text-muted-foreground ${linkClass}`} href={`mailto:${c.email}`}><Breakable text={c.email} /></a></p> : null}
      {phone ? <p className="text-xs">{telHref(phone) ? <a className={`text-muted-foreground ${linkClass}`} href={telHref(phone)!}>{phone}</a> : <span className="text-muted-foreground">{phone}</span>}</p> : null}
    </>
  );
}

function TextButton({ children, label, onClick, disabled }: { children: ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" aria-label={label} onClick={onClick} disabled={disabled}
      className="rounded-md text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50">
      {children}
    </button>
  );
}

function Labelled({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">{label}</label>
      {children}
      {hint && !error ? <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
