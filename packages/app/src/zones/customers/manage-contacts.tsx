import type { Contact, Customer } from '@business-os/contracts';
import { useEffect, useState } from 'react';
import type { CustomersClient } from '../../api/customers';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { Problem, Skeleton } from '../problem';
import { useLoad } from '../use-load';

const fields = ['displayName', 'firstName', 'lastName', 'email', 'phone', 'mobile', 'jobTitle', 'notes'] as const;
type Field = typeof fields[number];
const labels: Record<Field, string> = {
  displayName: 'Display name', firstName: 'First name', lastName: 'Last name', email: 'Email',
  phone: 'Phone', mobile: 'Mobile', jobTitle: 'Job title', notes: 'Notes',
};
type Values = Record<Field, string>;
const valuesOf = (contact?: Contact): Values => Object.fromEntries(fields.map((key) => [key, contact?.[key] ?? ''])) as Values;

export function ManageContacts({ customer, client, slug, canWrite, onCustomerChanged, onSessionEnded }: {
  customer: Customer; client: CustomersClient; slug: string; canWrite: boolean;
  onCustomerChanged: () => void; onSessionEnded: () => void;
}) {
  const { state, reload } = useLoad(`contacts|${slug}|${customer.id}`, (signal) => client.contacts(slug, customer.id, signal));
  const [editing, setEditing] = useState<Contact | 'new' | null>(null);
  const [values, setValues] = useState<Values>(valuesOf());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Contact | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const archived = Boolean(customer.archivedAt);
  const start = (contact: Contact | 'new') => {
    setEditing(contact);
    setValues(valuesOf(contact === 'new' ? undefined : contact));
    setError(null);
    setMessage(null);
  };
  const fail = (kind: string, message?: string) => {
    if (kind === 'unauthenticated') return onSessionEnded();
    setError(kind === 'invalid_input' ? message ?? 'Check the contact details.'
      : kind === 'conflict' ? 'This record changed. Refresh the contacts and try again.'
      : kind === 'forbidden' ? 'Your role cannot change contacts.'
      : kind === 'unreachable' ? 'Connection lost. Your changes are still here.'
      : 'Could not save this change. Please try again.');
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!values.displayName.trim() && !values.firstName.trim() && !values.lastName.trim() && !values.email.trim()) {
      setError('Enter a name or email address.'); return;
    }
    const existing = editing !== 'new' ? editing : null;
    if (!editing) return;
    const input: Record<string, string | null> = {};
    for (const field of fields) {
      if (existing && values[field] === (existing[field] ?? '')) continue;
      input[field] = values[field].trim();
    }
    if (!existing) input.customerId = customer.id;
    if (existing && !Object.keys(input).length) { setEditing(null); return; }
    setBusy(true); setError(null);
    try {
      const result = existing ? await client.updateContact(slug, existing.id, input) : await client.createContact(slug, input);
      if (result.kind !== 'ok') return fail(result.kind, 'message' in result ? result.message : undefined);
      setEditing(null); setMessage(existing ? 'Contact updated.' : 'Contact added.'); reload();
    } catch { setError('Could not connect. Your changes are still here.'); }
    finally { setBusy(false); }
  };
  const archive = async () => {
    if (!confirm || busy) return;
    setBusy(true); setError(null);
    try {
      const result = await client.archiveContact(slug, confirm.id);
      if (result.kind !== 'ok') return fail(result.kind);
      setConfirm(null); setEditing(null); setMessage('Contact archived.'); reload(); onCustomerChanged();
    } catch { setError('Could not connect. Try again.'); }
    finally { setBusy(false); }
  };
  const primary = async (id: string) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const result = await client.update(slug, customer.id, { primaryContactId: id });
      if (result.kind !== 'ok') return fail(result.kind);
      setMessage('Primary contact changed.'); onCustomerChanged();
    } catch { setError('Could not connect. Try again.'); }
    finally { setBusy(false); }
  };
  // Do not silently discard edits when switching to a different customer.
  useEffect(() => { setEditing(null); setError(null); setMessage(null); }, [customer.id]);
  const contacts = state.status === 'done' && state.outcome.kind === 'ok' ? state.outcome.data : [];
  const ordered = [...contacts].sort((a, b) => Number(b.id === customer.primaryContactId) - Number(a.id === customer.primaryContactId));
  return (
    <section aria-label="Contacts" className="rounded-2xl border border-border bg-card p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Contacts</h2>
        {canWrite && !archived && !editing ? <button type="button" className={secondaryClass} onClick={() => start('new')}>Add contact</button> : null}
      </div>
      {message ? <p role="status" className="mb-3 text-sm">{message}</p> : null}
      {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
      {state.status === 'loading' ? <Skeleton rows={2} label="Loading contacts…" /> : null}
      {state.status === 'done' && state.outcome.kind !== 'ok' ? <Problem outcome={state.outcome} what="Contacts" onRetry={reload} onSessionEnded={onSessionEnded} /> : null}
      {state.status === 'done' && state.outcome.kind === 'ok' && !editing ? (
        ordered.length ? <ul className="divide-y divide-border">{ordered.map(contact => (
          <li key={contact.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap gap-2 items-center">
              <p className="text-sm font-semibold">{contact.displayName}</p>
              {contact.id === customer.primaryContactId ? <span aria-label="Primary contact" className="rounded bg-muted px-2 py-0.5 text-xs">Primary</span> : null}
            </div>
            {contact.jobTitle ? <p className="text-xs text-muted-foreground">{contact.jobTitle}</p> : null}
            {contact.email ? <a className="block break-all text-xs underline" href={`mailto:${contact.email}`}>{contact.email}</a> : null}
            {contact.phone || contact.mobile ? <p className="text-xs text-muted-foreground">{contact.phone ?? contact.mobile}</p> : null}
            {canWrite && !archived ? <div className="mt-2 flex flex-wrap gap-3">
              <button type="button" className="text-xs underline" onClick={() => start(contact)}>Edit</button>
              {contact.id !== customer.primaryContactId ? <button type="button" className="text-xs underline" disabled={busy} onClick={() => void primary(contact.id)}>Make primary</button> : null}
              <button type="button" className="text-xs underline" onClick={() => setConfirm(contact)}>Archive</button>
            </div> : null}
          </li>
        ))}</ul> : <p className="text-sm text-muted-foreground">No contacts are linked to this customer yet.</p>
      ) : null}
      {editing ? <form onSubmit={(event) => void save(event)} className="space-y-3">
        <h3 className="text-sm font-semibold">{editing === 'new' ? 'Add contact' : 'Edit contact'}</h3>
        {fields.map(field => <label key={field} className="block text-xs font-medium">
          {labels[field]}
          {field === 'notes'
            ? <textarea className={inputClass} rows={3} maxLength={2000} value={values[field]} onChange={e => setValues(v => ({ ...v, [field]: e.target.value }))} />
            : <input className={inputClass} type={field === 'email' ? 'email' : 'text'} maxLength={field === 'email' ? 254 : field === 'displayName' ? 200 : field === 'phone' || field === 'mobile' ? 50 : 100} value={values[field]} onChange={e => setValues(v => ({ ...v, [field]: e.target.value }))} />}
        </label>)}
        <div className="flex flex-wrap gap-2">
          <button className={actionClass} disabled={busy} type="submit">{busy ? 'Saving…' : 'Save contact'}</button>
          <button className={secondaryClass} type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
        </div>
      </form> : null}
      {confirm ? <div role="alertdialog" aria-label="Archive contact" className="mt-4 rounded-xl border border-border p-4">
        <p className="text-sm">Archive {confirm.displayName}? This can be restored later.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" className={actionClass} disabled={busy} onClick={() => void archive()}>Archive</button>
          <button type="button" className={secondaryClass} disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
        </div>
      </div> : null}
    </section>
  );
}
