import type { Contact, Customer, Opportunity } from '@business-os/contracts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { SalesClient } from '../../api/sales';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { useLoad } from '../use-load';
import { AMOUNT, currencyOptions } from './format';
import type { Names, SalesRef } from './types';

interface Values {
  title: string; customerId: string; contactId: string; pipelineId: string; stageId: string; amount: string; currencyCode: string;
  probability: string; expectedCloseDate: string; ownerUserId: string; description: string;
}
type Field = keyof Values;
const LABEL: Record<Field, string> = {
  title: 'Title', customerId: 'customer', contactId: 'contact', pipelineId: 'pipeline', stageId: 'stage', amount: 'amount', currencyCode: 'currency',
  probability: 'probability', expectedCloseDate: 'expected close date', ownerUserId: 'owner', description: 'description',
};

function valuesOf(o: Opportunity | undefined, refData: SalesRef, currency: string): Values {
  const first = refData.pipelines.find((p) => p.pipeline.isDefault) ?? refData.pipelines[0];
  return {
    title: o?.title ?? '', customerId: o?.customerId ?? '', contactId: o?.contactId ?? '',
    pipelineId: o?.pipelineId ?? first?.pipeline.id ?? '', stageId: o?.stageId ?? first?.stages[0]?.id ?? '',
    amount: o?.amount ?? '', currencyCode: o?.currencyCode ?? currency, probability: o?.probability === null || o?.probability === undefined ? '' : String(o.probability),
    expectedCloseDate: o?.expectedCloseDate ?? '', ownerUserId: o?.ownerUserId ?? '', description: o?.description ?? '',
  };
}

/** What goes on the wire for a field: never a float for money, null to clear, an integer for probability. */
function wire(field: Field, value: string): unknown {
  const v = value.trim();
  if (field === 'probability') return v === '' ? null : Number(v);
  if (field === 'title' || field === 'pipelineId' || field === 'stageId' || field === 'currencyCode') return v;
  if (field === 'description') return v; // the contract turns '' into null
  return v === '' ? null : v;
}

function Labelled({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint && !error ? <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Create or edit an opportunity through the PR 15 contract. Customers and contacts are picked from
 * the Customer Zone's own records. Amounts stay decimal strings end to end. An edit sends only what
 * changed plus the version it was based on; if someone else saved in between, the person's changes
 * are kept, the latest version is loaded underneath, and nothing is saved until they choose to.
 */
export function OpportunityForm({ sales, customers, slug, locale, businessCurrency, refData, names, opportunity, onSaved, onCancel, onDirtyChange, onSessionEnded }: {
  sales: SalesClient; customers: CustomersClient; slug: string; locale?: string; businessCurrency: string; refData: SalesRef; names: Names;
  opportunity?: Opportunity; onSaved: (o: Opportunity, customerName: string | null, contactName: string | null) => void; onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const [base, setBase] = useState<Opportunity | undefined>(opportunity);
  const initial = useMemo(() => valuesOf(opportunity, refData, businessCurrency), [opportunity, refData, businessCurrency]);
  const baseValues = useMemo(() => valuesOf(base, refData, businessCurrency), [base, refData, businessCurrency]);
  const [values, setValues] = useState<Values>(initial);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [staleFields, setStaleFields] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const [customerName, setCustomerName] = useState<string | null>(names.customer(initial.customerId || null));
  const [contactName, setContactName] = useState<string | null>(names.contact(initial.contactId || null));
  const currencies = useMemo(() => currencyOptions(initial.currencyCode, locale), [initial.currencyCode, locale]);
  const open = !base || base.status === 'OPEN';

  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const set = <K extends Field>(key: K, value: Values[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e));
  };
  const fail = (message: string, fields: Partial<Record<Field, string>> = {}) => {
    setErrors(fields);
    setFormError(message);
    queueMicrotask(() => summary.current?.focus());
  };
  const control = (key: Field, extra: Record<string, unknown> = {}) => ({
    id: `${uid}-${key}`,
    value: values[key],
    onChange: (e: { target: { value: string } }) => set(key, e.target.value),
    'aria-invalid': errors[key] ? (true as const) : undefined,
    'aria-describedby': errors[key] ? `${uid}-${key}-error` : extra.hint ? `${uid}-${key}-hint` : undefined,
    className: inputClass,
  });

  const stages = refData.pipelines.find((p) => p.pipeline.id === values.pipelineId)?.stages ?? [];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    const problems: Partial<Record<Field, string>> = {};
    if (!values.title.trim()) problems.title = 'A title is required';
    if (values.amount.trim() && !AMOUNT.test(values.amount.trim())) problems.amount = 'Enter an amount such as 1250 or 1250.50 (no currency symbol or commas)';
    if (values.probability.trim() && !/^(100|\d{1,2})$/.test(values.probability.trim())) problems.probability = 'Enter a whole number from 0 to 100';
    if (!values.stageId) problems.stageId = 'Choose a stage';
    if (Object.keys(problems).length) return fail('Check the highlighted fields.', problems);

    const send: Record<string, unknown> = {};
    for (const key of Object.keys(values) as Field[]) {
      if (base && values[key] === baseValues[key]) continue; // edits send only what changed
      if (!base && values[key].trim() === '' && key !== 'currencyCode') continue;
      send[key] = wire(key, values[key]);
    }
    if (base) {
      if (Object.keys(send).length === 0) return onCancel();
      if (send.pipelineId !== undefined && send.stageId === undefined) send.stageId = values.stageId; // a pipeline change needs its stage
      send.version = base.version;
    }

    inFlight.current = true;
    setBusy(true);
    setFormError(null);
    let outcome: Outcome<Opportunity>;
    try {
      outcome = base ? await sales.update(slug, base.id, send) : await sales.create(slug, send);
    } catch {
      outcome = { kind: 'unreachable' };
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (outcome.kind === 'ok') {
      onDirtyChange(false);
      return onSaved(outcome.data, customerName, contactName);
    }
    if (outcome.kind === 'unauthenticated') return onSessionEnded();
    if (outcome.kind === 'conflict' && outcome.code === 'stale' && base) {
      // Someone else saved first. Keep this person's edits, load theirs underneath, save nothing yet.
      const latest = await sales.get(slug, base.id);
      if (latest.kind === 'ok') {
        const theirs = valuesOf(latest.data, refData, businessCurrency);
        const changed = (Object.keys(theirs) as Field[]).filter((k) => theirs[k] !== baseValues[k]).map((k) => LABEL[k]);
        // Fields this person edited keep their value; every other field takes the latest value, so
        // saving again can only send what they actually changed, never stale copies of the rest.
        setValues((mine) => Object.fromEntries((Object.keys(theirs) as Field[]).map((k) => [k, mine[k] !== baseValues[k] ? mine[k] : theirs[k]])) as unknown as Values);
        setBase(latest.data);
        setStaleFields(changed);
        return fail('Someone else changed this opportunity while you were editing. Nothing was saved, and your changes are still here.');
      }
      return fail('Someone else changed this opportunity while you were editing. Nothing was saved. Reload it before trying again.');
    }
    switch (outcome.kind) {
      case 'invalid_input': return fail(outcome.message, outcome.fields as Partial<Record<Field, string>>);
      case 'conflict':
        return fail(outcome.code === 'archived' ? 'This opportunity is archived. Restore it before editing.'
          : outcome.code === 'not_open' ? 'This opportunity is closed, so its stage cannot change. Reopen it first.'
          : outcome.code === 'archived_reference' ? 'The chosen customer, contact, pipeline or stage has been archived. Choose another.'
          : 'This opportunity changed in a way that prevents saving. Reload it and try again.');
      case 'not_found': return fail('The chosen customer or contact no longer exists in this business, or this opportunity was removed.');
      case 'forbidden': return fail('Your role does not allow changing opportunities in this business.');
      case 'unreachable': return fail(base
        ? "Can't reach Business OS. Your changes are still here; save again when you're back online."
        : "Business OS didn't answer, so the opportunity may or may not have been added. Check the list before adding it again. Your details are still here.");
      case 'rate_limited': return fail('Too many requests. Wait a moment and try again.');
      default: return fail('Something went wrong and nothing was saved. Your changes are still here.');
    }
  };

  const owners = refData.members.filter((m) => m.status === 'ACTIVE');
  return (
    <form onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${uid}-title-h`} className="mx-auto max-w-3xl">
      <h1 id={`${uid}-title-h`} className="text-3xl font-semibold tracking-tight">{opportunity ? `Edit ${opportunity.title}` : 'Add opportunity'}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{opportunity ? 'Change what you need; everything else stays as it is.' : 'Only a title is required. Add the rest now or later.'}</p>

      {formError ? (
        <div ref={summary} tabIndex={-1} role="alert" className="mb-6 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive outline-none">
          <p>{formError}</p>
          {staleFields ? (
            <p className="mt-2 text-foreground">
              {staleFields.length ? `They changed: ${[...new Set(staleFields)].join(', ')}. ` : ''}
              Review the form, then choose <strong>Save changes</strong> to save your version on top of theirs, or <strong>Cancel</strong> to keep theirs.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-4">
        <fieldset className="grid gap-4 rounded-2xl border border-border p-5 sm:grid-cols-2">
          <legend className="px-2 text-sm font-semibold">Opportunity</legend>
          <div className="sm:col-span-2">
            <Labelled id={`${uid}-title`} label="Title" error={errors.title}>
              <input {...control('title')} maxLength={200} aria-required="true" autoComplete="off" />
            </Labelled>
          </div>
          {refData.pipelines.length > 1 ? (
            <Labelled id={`${uid}-pipelineId`} label="Pipeline" error={errors.pipelineId} hint={open ? undefined : 'Reopen to move it.'}>
              <select {...control('pipelineId')} disabled={!open} onChange={(e) => { const p = refData.pipelines.find((x) => x.pipeline.id === e.target.value); set('pipelineId', e.target.value); set('stageId', p?.stages[0]?.id ?? ''); }}>
                {refData.pipelines.map((p) => <option key={p.pipeline.id} value={p.pipeline.id}>{p.pipeline.name}</option>)}
              </select>
            </Labelled>
          ) : null}
          <Labelled id={`${uid}-stageId`} label="Stage" error={errors.stageId} hint={open ? undefined : 'Closed opportunities keep their stage. Reopen to move it.'}>
            <select {...control('stageId', { hint: !open })} disabled={!open}>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {!stages.some((s) => s.id === values.stageId) && values.stageId ? <option value={values.stageId}>Archived stage</option> : null}
            </select>
          </Labelled>
          <Labelled id={`${uid}-ownerUserId`} label="Owner" error={errors.ownerUserId}>
            <select {...control('ownerUserId')}>
              <option value="">No owner</option>
              {owners.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? 'Team member'}</option>)}
            </select>
          </Labelled>
        </fieldset>

        <fieldset className="grid gap-4 rounded-2xl border border-border p-5 sm:grid-cols-2">
          <legend className="px-2 text-sm font-semibold">Customer</legend>
          <CustomerPicker
            id={`${uid}-customer`} customers={customers} slug={slug} selectedId={values.customerId} selectedName={customerName} error={errors.customerId} onSessionEnded={onSessionEnded}
            onPick={(c) => { set('customerId', c?.id ?? ''); set('contactId', ''); setCustomerName(c?.displayName ?? null); setContactName(null); }}
          />
          <ContactPicker
            id={`${uid}-contactId`} customers={customers} slug={slug} customerId={values.customerId} value={values.contactId} error={errors.contactId} onSessionEnded={onSessionEnded}
            onChange={(c) => { set('contactId', c?.id ?? ''); setContactName(c?.displayName ?? null); }}
          />
        </fieldset>

        <fieldset className="grid gap-4 rounded-2xl border border-border p-5 sm:grid-cols-2">
          <legend className="px-2 text-sm font-semibold">Value and timing</legend>
          <Labelled id={`${uid}-amount`} label="Amount" error={errors.amount} hint="Numbers only, for example 1250.50">
            <input {...control('amount', { hint: true })} inputMode="decimal" autoComplete="off" maxLength={19} />
          </Labelled>
          <Labelled id={`${uid}-currencyCode`} label="Currency" error={errors.currencyCode}>
            <select {...control('currencyCode')}>{currencies.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
          </Labelled>
          <Labelled id={`${uid}-probability`} label="Probability (%)" error={errors.probability} hint="Optional, 0 to 100">
            <input {...control('probability', { hint: true })} inputMode="numeric" autoComplete="off" maxLength={3} />
          </Labelled>
          <Labelled id={`${uid}-expectedCloseDate`} label="Expected close date" error={errors.expectedCloseDate}>
            <input {...control('expectedCloseDate')} type="date" />
          </Labelled>
          <div className="sm:col-span-2">
            <Labelled id={`${uid}-description`} label="Description" error={errors.description} hint={`${values.description.length} / 5000`}>
              <textarea {...control('description', { hint: true })} rows={4} maxLength={5000} />
            </Labelled>
          </div>
        </fieldset>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button type="submit" className={actionClass} disabled={busy}>{busy ? 'Saving…' : opportunity ? 'Save changes' : 'Add opportunity'}</button>
        <button type="button" className={secondaryClass} onClick={onCancel} disabled={busy}>Cancel</button>
        {dirty && !busy ? <span role="status" className="text-xs text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </form>
  );
}

/** Search the Customer Zone's active customers and pick one; no customers are created here. */
function CustomerPicker({ id, customers, slug, selectedId, selectedName, error, onPick, onSessionEnded }: {
  id: string; customers: CustomersClient; slug: string; selectedId: string; selectedName: string | null; error?: string; onPick: (c: Customer | null) => void;
  onSessionEnded: () => void;
}) {
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250);
    return () => clearTimeout(timer);
  }, [text]);
  const results = useLoad(`pick-customer|${slug}|${q}`, (signal) => (q ? customers.list(slug, { q, status: 'active', limit: 8 }, signal) : Promise.resolve({ kind: 'ok' as const, data: { customers: [], nextCursor: null } })));
  if (selectedId) {
    return (
      <div className="sm:col-span-2">
        <p id={id} className="mb-1.5 text-sm font-medium">Customer</p>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border px-4 py-3" aria-labelledby={id}>
          <span className="text-sm font-medium">{selectedName ?? 'Selected customer'}</span>
          <button type="button" onClick={() => onPick(null)} className="rounded-md text-xs font-medium text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
            Change customer
          </button>
        </div>
        {error ? <p className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
      </div>
    );
  }
  const list = results.state.status === 'done' && results.state.outcome.kind === 'ok' ? results.state.outcome.data.customers : [];
  const failure = results.state.status === 'done' && results.state.outcome.kind !== 'ok' ? results.state.outcome : null;
  return (
    <div className="sm:col-span-2">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">Customer</label>
      <input id={id} type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search your customers by name, email or phone" className={inputClass}
        aria-describedby={`${id}-hint`} autoComplete="off" maxLength={100} />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">Optional. Customers come from the Customers Zone.</p>
      {q ? (
        <div aria-live="polite">
          {results.state.status === 'loading' ? <p className="mt-2 text-xs text-muted-foreground">Searching…</p> : failure ? (
            <SearchError outcome={failure} what="search customers" onRetry={results.reload} onSessionEnded={onSessionEnded} />
          ) : list.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No active customers match “{q}”.</p>
          ) : (
            <ul aria-label="Matching customers" className="mt-2 divide-y divide-border rounded-xl border border-border">
              {list.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => { setText(''); onPick(c); }} className="block w-full px-4 py-2 text-left text-sm hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                    {c.displayName}{c.email ? <span className="ml-2 text-xs text-muted-foreground">{c.email}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The chosen customer's active contacts only, so a contact always matches its customer. */
function ContactPicker({ id, customers, slug, customerId, value, error, onChange, onSessionEnded }: {
  id: string; customers: CustomersClient; slug: string; customerId: string; value: string; error?: string; onChange: (c: Contact | null) => void;
  onSessionEnded: () => void;
}) {
  const contacts = useLoad(`pick-contacts|${slug}|${customerId}`, (signal) => (customerId ? customers.contacts(slug, customerId, 'active', signal) : Promise.resolve({ kind: 'ok' as const, data: [] as Contact[] })));
  const list = contacts.state.status === 'done' && contacts.state.outcome.kind === 'ok' ? contacts.state.outcome.data : [];
  const failure = customerId && contacts.state.status === 'done' && contacts.state.outcome.kind !== 'ok' ? contacts.state.outcome : null;
  const hint = !customerId ? 'Choose a customer first.' : contacts.state.status === 'loading' ? 'Loading contacts…' : failure ? undefined : list.length === 0 ? 'This customer has no contacts yet.' : undefined;
  return (
    <div className="sm:col-span-2">
      <Labelled id={id} label="Contact" hint={hint} error={error}>
        <select id={id} value={value} disabled={!customerId} onChange={(e) => onChange(list.find((c) => c.id === e.target.value) ?? null)} className={inputClass}
          aria-describedby={hint ? `${id}-hint` : undefined}>
          <option value="">No contact</option>
          {list.map((c) => <option key={c.id} value={c.id}>{c.displayName}{c.jobTitle ? ` · ${c.jobTitle}` : ''}</option>)}
          {value && !list.some((c) => c.id === value) ? <option value={value}>Current contact</option> : null}
        </select>
      </Labelled>
      {failure ? <SearchError outcome={failure} what="load this customer's contacts" onRetry={contacts.reload} onSessionEnded={onSessionEnded} /> : null}
    </div>
  );
}

/**
 * A search or lookup that failed is never shown as "no results": say what went wrong and offer a retry.
 * An ended session is handed back to the app (as on every other Sales screen), never retried.
 */
function SearchError({ outcome, what, onRetry, onSessionEnded }: { outcome: Outcome<unknown>; what: string; onRetry: () => void; onSessionEnded: () => void }) {
  const ended = outcome.kind === 'unauthenticated';
  useEffect(() => {
    if (ended) onSessionEnded();
  }, [ended, onSessionEnded]);
  const text = ended ? 'Your session has ended. Please sign in again.'
    : outcome.kind === 'unreachable'
    ? (typeof navigator !== 'undefined' && navigator.onLine === false ? `You're offline, so we couldn't ${what}.` : `Can't reach Business OS, so we couldn't ${what}.`)
    : outcome.kind === 'forbidden' ? `Your role does not allow you to ${what}.`
    : outcome.kind === 'rate_limited' ? `Too many requests; we couldn't ${what} just now.`
    : `Something went wrong, so we couldn't ${what}.`;
  return (
    <div role="alert" className="mt-2 flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <span>{text}</span>
      {outcome.kind !== 'forbidden' && !ended ? (
        <button type="button" onClick={onRetry} className="rounded-md font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">Try again</button>
      ) : null}
    </div>
  );
}
