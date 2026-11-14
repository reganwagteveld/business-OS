import type { Customer } from '@business-os/contracts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { Outcome } from '../../api/tenancy';
import { actionClass, inputClass, secondaryClass } from '../../shell/frame';
import { useLoad } from '../use-load';
import { countryOptions } from './format';

export interface CustomerValues {
  kind: 'COMPANY' | 'INDIVIDUAL'; displayName: string; legalName: string; email: string; phone: string; website: string;
  addressLine1: string; addressLine2: string; city: string; region: string; postalCode: string; countryCode: string; notes: string; ownerUserId: string;
}

const TEXT_KEYS = ['displayName', 'legalName', 'email', 'phone', 'website', 'addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'notes'] as const;
const ADDRESS_KEYS = ['addressLine1', 'addressLine2', 'city', 'region', 'postalCode', 'countryCode'] as const;

export function valuesOf(c?: Customer): CustomerValues {
  return {
    kind: c?.kind ?? 'COMPANY', displayName: c?.displayName ?? '', legalName: c?.legalName ?? '', email: c?.email ?? '', phone: c?.phone ?? '', website: c?.website ?? '',
    addressLine1: c?.addressLine1 ?? '', addressLine2: c?.addressLine2 ?? '', city: c?.city ?? '', region: c?.region ?? '', postalCode: c?.postalCode ?? '',
    countryCode: c?.countryCode ?? '', notes: c?.notes ?? '', ownerUserId: c?.ownerUserId ?? '',
  };
}

/** Checks the one thing the contract does not: a website must look like a web address. */
export function websiteProblem(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.') ? null : 'Enter a web address such as example.com';
  } catch {
    return 'Enter a web address such as example.com';
  }
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      {children}
      {hint && !error ? <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

function Disclosure({ open, onToggle, title, summary, children }: { open: boolean; onToggle: () => void; title: string; summary: string; children: ReactNode }) {
  const id = useId();
  return (
    <div className="rounded-2xl border border-border">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="flex w-full items-center justify-between rounded-2xl px-5 py-4 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring">
        <span><span className="block text-sm font-semibold">{title}</span><span className="block text-xs text-muted-foreground">{summary}</span></span>
        <span aria-hidden="true" className="text-muted-foreground">{open ? '−' : '+'}</span>
      </button>
      <div id={id} hidden={!open} className="grid gap-4 border-t border-border p-5 sm:grid-cols-2">{open ? children : null}</div>
    </div>
  );
}

/**
 * Create or edit a customer with the PR 11 contract. Optional fields sit behind disclosures. Edits
 * send only what changed. Submitting is locked while a request is in flight, and the parent is told
 * when there are unsaved changes so they are never dropped silently.
 */
export function CustomerForm({ client, slug, customer, locale, onSaved, onCancel, onDirtyChange, onSessionEnded }: {
  client: CustomersClient; slug: string; customer?: Customer; locale?: string; onSaved: (c: Customer) => void; onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void; onSessionEnded: () => void;
}) {
  const uid = useId();
  const initial = useMemo(() => valuesOf(customer), [customer]);
  const [values, setValues] = useState<CustomerValues>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const summary = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState({
    address: ADDRESS_KEYS.some((k) => initial[k] !== ''), notes: initial.notes !== '', owner: initial.ownerUserId !== '',
  });
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const members = useLoad(`members|${slug}`, (signal) => client.members(slug, signal));

  const dirty = JSON.stringify(values) !== JSON.stringify(initial);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const set = <K extends keyof CustomerValues>(key: K, value: CustomerValues[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (key in e ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== key)) : e));
  };
  const fieldProps = (key: keyof CustomerValues) => ({
    id: `${uid}-${key}`,
    value: values[key],
    'aria-invalid': errors[key] ? (true as const) : undefined,
    'aria-describedby': errors[key] ? `${uid}-${key}-error` : undefined,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as never),
    className: inputClass,
  });

  const fail = (message: string, fields: Record<string, string> = {}) => {
    setErrors(fields);
    setFormError(message);
    queueMicrotask(() => summary.current?.focus());
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return; // no duplicate submissions
    const problems: Record<string, string> = {};
    if (!values.displayName.trim()) problems.displayName = 'A name is required';
    const site = websiteProblem(values.website);
    if (site) problems.website = site;
    if (Object.keys(problems).length) return fail('Check the highlighted fields.', problems);

    const send: Record<string, unknown> = {};
    for (const key of Object.keys(values) as (keyof CustomerValues)[]) {
      if (customer && values[key] === initial[key]) continue; // edits send only what changed
      send[key] = key === 'ownerUserId' || key === 'countryCode' ? values[key] || null : TEXT_KEYS.includes(key as (typeof TEXT_KEYS)[number]) ? values[key].trim() : values[key];
    }
    if (customer && Object.keys(send).length === 0) return onCancel();

    inFlight.current = true;
    setBusy(true);
    setFormError(null);
    let outcome: Outcome<Customer>;
    try {
      outcome = customer ? await client.update(slug, customer.id, send) : await client.create(slug, send);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    switch (outcome.kind) {
      case 'ok': onDirtyChange(false); return onSaved(outcome.data);
      case 'unauthenticated': return onSessionEnded();
      case 'invalid_input': return fail(outcome.message, outcome.fields);
      case 'conflict': return fail('This customer is archived, so it cannot be edited. Restore it first.');
      case 'forbidden': return fail('Your role does not allow saving customers in this business.');
      case 'not_found': return fail('This customer no longer exists in this business.');
      case 'unreachable': return fail(navigator.onLine === false ? "You're offline. Your changes are still here; save again when you're back online." : "Can't reach Business OS. Your changes are still here; try saving again.");
      case 'rate_limited': return fail('Too many requests. Wait a moment and try again.');
      default: return fail('Something went wrong and nothing was saved. Your changes are still here.');
    }
  };

  const memberList = members.state.status === 'done' && members.state.outcome.kind === 'ok' ? members.state.outcome.data : null;
  const individual = values.kind === 'INDIVIDUAL';

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${uid}-title`} className="mx-auto max-w-3xl">
      <h1 id={`${uid}-title`} className="text-3xl font-semibold tracking-tight">{customer ? `Edit ${customer.displayName}` : 'Add customer'}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">{customer ? 'Change what you need; everything else stays as it is.' : 'Start with the basics. Add more detail whenever you like.'}</p>

      {formError ? (
        <div ref={summary} tabIndex={-1} role="alert" className="mb-6 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive outline-none">{formError}</div>
      ) : null}

      <div className="space-y-4">
        <fieldset className="rounded-2xl border border-border p-5">
          <legend className="px-2 text-sm font-semibold">Customer</legend>
          <div role="radiogroup" aria-label="Customer type" className="mb-5 inline-flex rounded-xl border border-border p-1">
            {(['COMPANY', 'INDIVIDUAL'] as const).map((kind) => (
              <label key={kind} className={`cursor-pointer rounded-lg px-4 py-1.5 text-sm font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${values.kind === kind ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
                <input type="radio" name={`${uid}-kind`} value={kind} checked={values.kind === kind} onChange={() => set('kind', kind)} className="sr-only" />
                {kind === 'COMPANY' ? 'Company' : 'Individual'}
              </label>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${uid}-displayName`} label={individual ? 'Full name' : 'Customer name'} error={errors.displayName}>
              <input {...fieldProps('displayName')} maxLength={200} required aria-required="true" autoComplete="off" />
            </Field>
            <Field id={`${uid}-legalName`} label="Legal name" hint={individual ? undefined : 'If different from the name above'} error={errors.legalName}>
              <input {...fieldProps('legalName')} maxLength={200} autoComplete="off" />
            </Field>
            <Field id={`${uid}-email`} label="Email" error={errors.email}>
              <input {...fieldProps('email')} type="email" maxLength={254} autoComplete="off" />
            </Field>
            <Field id={`${uid}-phone`} label="Phone" hint="Include the country code for international numbers" error={errors.phone}>
              <input {...fieldProps('phone')} type="tel" maxLength={50} autoComplete="off" />
            </Field>
            <div className="sm:col-span-2">
              <Field id={`${uid}-website`} label="Website" error={errors.website}>
                <input {...fieldProps('website')} inputMode="url" maxLength={300} autoComplete="off" />
              </Field>
            </div>
          </div>
        </fieldset>

        <Disclosure open={open.address} onToggle={() => setOpen((o) => ({ ...o, address: !o.address }))} title="Address" summary="Street, city and country">
          <div className="sm:col-span-2"><Field id={`${uid}-addressLine1`} label="Address line 1" error={errors.addressLine1}><input {...fieldProps('addressLine1')} maxLength={200} autoComplete="off" /></Field></div>
          <div className="sm:col-span-2"><Field id={`${uid}-addressLine2`} label="Address line 2" error={errors.addressLine2}><input {...fieldProps('addressLine2')} maxLength={200} autoComplete="off" /></Field></div>
          <Field id={`${uid}-city`} label="City or suburb" error={errors.city}><input {...fieldProps('city')} maxLength={100} autoComplete="off" /></Field>
          <Field id={`${uid}-region`} label="State, province or region" error={errors.region}><input {...fieldProps('region')} maxLength={100} autoComplete="off" /></Field>
          <Field id={`${uid}-postalCode`} label="Postal code" error={errors.postalCode}><input {...fieldProps('postalCode')} maxLength={20} autoComplete="off" /></Field>
          <Field id={`${uid}-countryCode`} label="Country" error={errors.countryCode}>
            <select {...fieldProps('countryCode')}>
              <option value="">Not set</option>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </Field>
        </Disclosure>

        <Disclosure open={open.notes} onToggle={() => setOpen((o) => ({ ...o, notes: !o.notes }))} title="Notes" summary="Anything your team should know">
          <div className="sm:col-span-2">
            <Field id={`${uid}-notes`} label="Notes" hint={`${values.notes.length} / 2000`} error={errors.notes}>
              <textarea {...fieldProps('notes')} rows={5} maxLength={2000} />
            </Field>
          </div>
        </Disclosure>

        <Disclosure open={open.owner} onToggle={() => setOpen((o) => ({ ...o, owner: !o.owner }))} title="Customer owner" summary="The team member responsible for this customer">
          <div className="sm:col-span-2">
            <Field id={`${uid}-ownerUserId`} label="Owner" hint={memberList ? undefined : members.state.status === 'loading' ? 'Loading your team…' : 'Your team list is unavailable right now.'} error={errors.ownerUserId}>
              <select {...fieldProps('ownerUserId')} disabled={!memberList}>
                <option value="">No owner</option>
                {memberList?.map((m) => <option key={m.userId} value={m.userId}>{m.name ?? 'Team member'}</option>)}
                {!memberList && values.ownerUserId ? <option value={values.ownerUserId}>Current owner</option> : null}
              </select>
            </Field>
          </div>
        </Disclosure>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button type="submit" className={actionClass} disabled={busy} aria-disabled={busy}>{busy ? 'Saving…' : customer ? 'Save changes' : 'Add customer'}</button>
        <button type="button" className={secondaryClass} onClick={onCancel} disabled={busy}>Cancel</button>
        {dirty && !busy ? <span role="status" className="text-xs text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </form>
  );
}
