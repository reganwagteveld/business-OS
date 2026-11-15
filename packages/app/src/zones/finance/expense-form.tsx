import type { ExpenseCategory, ExpenseTaxTreatment, FinanceExpense } from '@business-os/contracts';
import { Alert, AlertDescription, Button, Field, FormSection, Input, Select, Textarea } from '@business-os/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { FinanceClient, TaxRateOption } from '../../api/finance';
import { ZonePage } from '../../shell/zone-page';
import { conflictMessage, TREATMENT_LABEL } from './format';
import { uncertainMessage } from './shared';

type Values = {
  description: string; supplierName: string; referenceNumber: string; categoryId: string; incurredOn: string; dueDate: string; currencyCode: string;
  taxTreatment: ExpenseTaxTreatment; taxRateId: string; amount: string; notes: string;
};

const enteredOf = (e: FinanceExpense) => (e.taxTreatment === 'TAX_EXCLUSIVE' ? e.subtotal : e.total);

function initial(expense: FinanceExpense | undefined, today: string, currency: string, defaultCategory: string): Values {
  if (!expense) {
    return {
      description: '', supplierName: '', referenceNumber: '', categoryId: defaultCategory, incurredOn: today, dueDate: '', currencyCode: currency,
      taxTreatment: 'NO_TAX', taxRateId: '', amount: '', notes: '',
    };
  }
  return {
    description: expense.description, supplierName: expense.supplierName ?? '', referenceNumber: expense.referenceNumber ?? '', categoryId: expense.categoryId,
    incurredOn: expense.incurredOn, dueDate: expense.dueDate ?? '', currencyCode: expense.currencyCode, taxTreatment: expense.taxTreatment,
    taxRateId: expense.taxRateId ?? '', amount: enteredOf(expense), notes: expense.notes ?? '',
  };
}

/**
 * Create or edit a draft expense. Only the figure from the receipt is entered: the server splits it
 * into subtotal, tax and total with exact decimals (and the database checks the split), so the browser
 * never does money arithmetic. Every field is validated against the shared contract before sending,
 * and the server's own errors are shown as they come back.
 */
export function ExpenseForm({ client, slug, today, currency, categories, taxRates, expense, onDirtyChange, onCancel, onSaved, onSessionEnded }: {
  client: FinanceClient; slug: string; today: string; currency: string; categories: ExpenseCategory[]; taxRates: TaxRateOption[];
  expense?: FinanceExpense; onDirtyChange: (dirty: boolean) => void; onCancel: () => void; onSaved: (saved: FinanceExpense) => void; onSessionEnded: () => void;
}) {
  const active = categories.filter((c) => !c.archivedAt || c.id === expense?.categoryId);
  const start = useMemo(() => initial(expense, today, currency, active[0]?.id ?? ''), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [values, setValues] = useState<Values>(start);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(values) !== JSON.stringify(start);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const set = (patch: Partial<Values>) => setValues((v) => ({ ...v, ...patch }));
  const rates = taxRates.filter((r) => !r.archivedAt || r.id === expense?.taxRateId);
  const taxed = values.taxTreatment !== 'NO_TAX';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    setErrors({});
    const common = {
      categoryId: values.categoryId, description: values.description, supplierName: values.supplierName, referenceNumber: values.referenceNumber,
      notes: values.notes, incurredOn: values.incurredOn, dueDate: values.dueDate || null, taxTreatment: values.taxTreatment,
      taxRateId: taxed ? values.taxRateId || null : null, amount: values.amount.trim(),
    };
    let out: Awaited<ReturnType<typeof client.createExpense>>;
    try {
      out = expense
        ? await client.updateExpense(slug, expense.id, { version: expense.version, ...common })
        : await client.createExpense(slug, { ...common, currencyCode: values.currencyCode.trim().toUpperCase() });
    } catch {
      out = { kind: 'unreachable' }; // a rejected call is shown like a lost answer, never left unhandled
    }
    setBusy(false);
    if (out.kind === 'ok') {
      onDirtyChange(false);
      onSaved(out.data);
      return;
    }
    if (out.kind === 'unauthenticated') onSessionEnded();
    else if (out.kind === 'invalid_input') {
      setErrors(out.fields ?? {});
      setMessage(out.message);
    } else if (out.kind === 'conflict') setMessage(conflictMessage(out.code));
    else if (out.kind === 'forbidden') setMessage('Your role does not allow entering expenses.');
    else if (out.kind === 'unreachable') {
      setMessage(expense
        ? uncertainMessage('versioned')
        : 'The connection dropped before Business OS answered, so this draft may already have been saved. Check the expense list before saving it again.');
    } else setMessage('The expense could not be saved. Reload to see the current state before trying again.');
  }

  return (
    <ZonePage title={expense ? 'Edit draft expense' : 'New expense'} eyebrow="Finance" description="Drafts can be changed until they are recorded.">
      <form onSubmit={submit} noValidate className="space-y-8">
        {message ? <Alert tone="danger" role="alert"><AlertDescription>{message}</AlertDescription></Alert> : null}
        <FormSection title="What was it">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Description" error={errors.description} className="sm:col-span-2">
              {(c) => <Input {...c} required maxLength={500} value={values.description} onChange={(e) => set({ description: e.target.value })} />}
            </Field>
            <Field label="Supplier" error={errors.supplierName}>
              {(c) => <Input {...c} maxLength={200} value={values.supplierName} onChange={(e) => set({ supplierName: e.target.value })} />}
            </Field>
            <Field label="Reference" hint="The supplier's invoice or receipt number" error={errors.referenceNumber}>
              {(c) => <Input {...c} maxLength={100} value={values.referenceNumber} onChange={(e) => set({ referenceNumber: e.target.value })} />}
            </Field>
            <Field label="Category" error={errors.categoryId}>
              {(c) => (
                <Select {...c} required value={values.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
                  {active.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}{cat.archivedAt ? ' (archived)' : ''}</option>)}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date" error={errors.incurredOn}>
                {(c) => <Input {...c} type="date" required max={today} value={values.incurredOn} onChange={(e) => set({ incurredOn: e.target.value })} />}
              </Field>
              <Field label="Due date" hint="If it's paid later" error={errors.dueDate}>
                {(c) => <Input {...c} type="date" min={values.incurredOn} value={values.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />}
              </Field>
            </div>
          </div>
        </FormSection>
        <FormSection title="Amount and tax" description="Enter the figure on the receipt. Business OS works out the tax split when you save.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Tax" error={errors.taxTreatment}>
              {(c) => (
                <Select {...c} value={values.taxTreatment} onChange={(e) => set({ taxTreatment: e.target.value as ExpenseTaxTreatment })}>
                  {(Object.keys(TREATMENT_LABEL) as ExpenseTaxTreatment[]).map((t) => <option key={t} value={t}>{TREATMENT_LABEL[t]}</option>)}
                </Select>
              )}
            </Field>
            {taxed ? (
              <Field label="Tax rate" error={errors.taxRateId} hint={rates.length === 0 ? 'No tax rates yet. An owner or admin can add them in Finance settings.' : undefined}>
                {(c) => (
                  <Select {...c} required value={values.taxRateId} onChange={(e) => set({ taxRateId: e.target.value })}>
                    <option value="">Choose a rate</option>
                    {rates.map((r) => <option key={r.id} value={r.id}>{r.name} ({r.ratePercent}%){r.archivedAt ? ' (archived)' : ''}</option>)}
                  </Select>
                )}
              </Field>
            ) : <div className="hidden sm:block" />}
            <Field label={values.taxTreatment === 'TAX_EXCLUSIVE' ? 'Amount before tax' : 'Total paid'} error={errors.amount}>
              {(c) => <Input {...c} inputMode="decimal" required placeholder="0.00" value={values.amount} onChange={(e) => set({ amount: e.target.value })} />}
            </Field>
            <Field label="Currency" hint={expense ? 'Fixed once created' : undefined} error={errors.currencyCode}>
              {(c) => <Input {...c} maxLength={3} disabled={!!expense} value={values.currencyCode} onChange={(e) => set({ currencyCode: e.target.value.toUpperCase() })} />}
            </Field>
          </div>
        </FormSection>
        <FormSection title="Notes">
          <Field label="Notes" hint="Only people with Finance access can see these" error={errors.notes}>
            {(c) => <Textarea {...c} maxLength={5000} value={values.notes} onChange={(e) => set({ notes: e.target.value })} />}
          </Field>
        </FormSection>
        <div className="flex flex-wrap gap-3">
          <Button type="submit" loading={busy}>{expense ? 'Save changes' : 'Save draft'}</Button>
          <Button variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
      </form>
    </ZonePage>
  );
}
