import { Alert, AlertDescription } from '@business-os/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CustomersClient } from '../../api/customers';
import type { ExpenseCategory } from '@business-os/contracts';
import type { FinanceClient, TaxRateOption } from '../../api/finance';
import type { BusinessContext } from '../../api/tenancy';
import { useDraftGuard } from '../drafts';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { CatalogItemPage, CatalogList, CatalogNew } from './catalog';
import { DocumentDetail } from './document-detail';
import { DocumentForm } from './document-form';
import { DocumentList } from './document-list';
import { FinanceEnvProvider, sectionOf, useCustomerNames, viewOfSection, type FinanceEnv, type FinanceSection, type FinanceView } from './env';
import { ExpenseDetail } from './expense-detail';
import { ExpenseForm } from './expense-form';
import { DEFAULT_FILTERS, ExpenseList, type ListFilters } from './expense-list';
import { ExpensePaymentDetail, ExpensePaymentForm, ExpensePaymentList } from './expense-payments';
import { FinanceOverview } from './overview';
import { PaymentDetail, PaymentForm, PaymentList } from './payments';
import { ReceivablesAgeingPage, StatementPage } from './receivables';
import { RecurringDetail, RecurringForm, RecurringList } from './recurring';
import { FinanceSettingsPage } from './settings';
import { LoadingRows, okData, todayIn } from './shared';

const EXPENSE_TABS = [{ id: 'expenses', label: 'Expenses' }, { id: 'payments-made', label: 'Payments made' }] as const;

/**
 * Where a shell route's `target` and `intent` land. A target is `kind:id` (invoice, quote, credit-note,
 * payment, expense); a bare id is an expense (F3). `new` opens the section's create form.
 */
export function initialView(section: string | undefined, target: string | undefined, intent: 'new' | undefined, can: FinanceEnv['can']): FinanceView {
  if (target) {
    // F6-2: `statement:<customerId>` or `statement:<customerId>:<currency>` from a customer's page.
    if (target.startsWith('statement:')) {
      const [, customerId, currencyCode] = target.split(':');
      return { name: 'statement', customerId: customerId || undefined, currencyCode: currencyCode || undefined };
    }
    const [kind, id] = target.includes(':') ? target.split(':', 2) as [string, string] : ['expense', target];
    if (kind === 'invoice') return { name: 'document', path: 'invoices', id };
    if (kind === 'quote') return { name: 'document', path: 'quotes', id };
    if (kind === 'credit-note') return { name: 'document', path: 'credit-notes', id };
    if (kind === 'payment') return { name: 'payment', id };
    return { name: 'expense', id };
  }
  if (intent === 'new') {
    if ((section === 'quotes' || section === 'invoices') && can.write) return { name: 'document-new', path: section };
    if (section === 'payments' && can.payments) return { name: 'payment-new' };
    if ((section === undefined || section === 'expenses') && can.expenses) return { name: 'expense-new' };
    if (section === 'catalog' && can.catalog) return { name: 'catalog-new' };
  }
  return viewOfSection(section ?? (intent === 'new' ? 'expenses' : undefined));
}

/**
 * The Finance Zone (F4): overview, quotes, invoices, credit notes, payments received, expenses and
 * payments made, and settings. Mount it with `key={slug}`: switching business discards every bit of its
 * state (lists, names, forms); nothing is cached or persisted, and every request names the business only
 * through the URL. Sections follow the shell's secondary navigation (`section`, `onSection`). Write
 * controls follow the server's permission keys for presentation only; the API enforces every rule again.
 */
export function FinanceZone({ client, customers, context, userLabel, section, navigation, initialTarget, initialExpenseId, initialAction, onSection, onOpenCustomer, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: FinanceClient;
  /** Only with customers:read: the customer picker and live names use it. */
  customers?: CustomersClient;
  context: BusinessContext; userLabel: string;
  /** The shell's secondary-navigation child (overview, quotes, invoices, …). */
  section?: string;
  /** The shell route object: a new one means the person navigated (compared by identity). */
  navigation?: object;
  initialTarget?: string;
  /** F3 name for a bare expense target. */
  initialExpenseId?: string;
  initialAction?: 'new';
  onSection?: (section: FinanceSection) => void;
  onOpenCustomer?: (customerId: string) => void;
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, timeZone, locale, currency } = context.business;
  const perms = context.membership.permissions;
  const can = useMemo(() => {
    const has = (p: string) => perms.includes(p);
    return {
      write: has('finance:write'), issue: has('finance:issue'), payments: has('finance:payments'), expenses: has('finance:expenses'),
      manage: has('finance:manage'), billing: has('finance:billing'), catalog: has('finance:catalog'), readCustomers: has('customers:read') && Boolean(customers),
      pdfPreview: has('finance:documents_preview'), pdfGenerate: has('finance:documents_generate'), pdfDownload: has('finance:documents_download'),
      branding: has('finance:documents_branding'),
    };
  }, [perms, customers]);
  const [view, setView] = useState<FinanceView>(() => initialView(section, initialTarget ?? initialExpenseId, initialAction, can));
  const [notice, setNotice] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [expenseFilters, setExpenseFilters] = useState<ListFilters>(DEFAULT_FILTERS);
  const guard = useDraftGuard();
  const content = useRef<HTMLDivElement>(null);
  const today = todayIn(timeZone);
  const names = useCustomerNames(can.readCustomers ? customers ?? null : null, slug);

  // The shell navigated (sidebar or secondary navigation, already guarded): show that section's list,
  // even when it is the section already open (from a record, its tab goes back to the list). A route
  // change the Zone asked for itself (moving between sections, `expected`) keeps the current screen.
  // Adjusted while rendering, so the old screen never renders against the new route.
  const [seenRoute, setSeenRoute] = useState(navigation);
  const [expected, setExpected] = useState<FinanceSection | null>(null);
  if (navigation !== seenRoute) {
    setSeenRoute(navigation);
    if (expected !== null && section === expected) setExpected(null);
    else {
      guard.clearDrafts();
      setNotice(null);
      setView(viewOfSection(section));
    }
  }
  const { clearDrafts, markDraft, leave } = guard;
  const go = useCallback((next: FinanceView, message: string | null = null) => {
    clearDrafts();
    setNotice(message);
    setView(next);
    const s = sectionOf(next);
    if (s !== section && onSection) {
      setExpected(s);
      onSection(s);
    }
  }, [clearDrafts, onSection, section]);

  // Categories (all, including archived, for names), tax rates and settings, shared by the forms.
  const cats = useLoad(`finance-categories|${slug}|${generation}`, (signal) => client.categories(slug, 'all', signal));
  const rates = useLoad(`finance-rates|${slug}|${generation}`, (signal) => client.taxRates(slug, signal));
  const settings = useLoad(`finance-settings|${slug}|${generation}`, (signal) => client.settings(slug, signal));
  const categories = okData(cats.state);
  const taxRates = okData(rates.state);
  const categoryName = (id: string) => categories?.find((c) => c.id === id)?.name ?? 'Category';

  const viewKey = JSON.stringify(view);
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [viewKey]);

  const env: FinanceEnv = {
    client, customers: can.readCustomers ? customers ?? null : null, slug, locale, timeZone, currency, today, can, go, leave,
    markDirty: markDraft, onSessionEnded, onOpenCustomer: can.readCustomers ? onOpenCustomer : undefined, names,
  };
  const markForm = useCallback((dirty: boolean) => markDraft('form', dirty), [markDraft]);
  const back = (to: FinanceView) => () => leave(() => go(to));
  const onExpenseTab = (id: string) => go(id === 'payments-made' ? { name: 'expense-payments' } : { name: 'expenses' });
  const formFailure = [cats, rates].find((x) => x.state.status === 'done' && x.state.outcome.kind !== 'ok');
  const needsLookups = (ok: boolean) => formFailure && formFailure.state.status === 'done'
    ? <Problem outcome={formFailure.state.outcome} what="Expense categories and tax rates" onRetry={formFailure.reload} onSessionEnded={onSessionEnded} />
    : !ok ? <LoadingRows label="Loading the form…" /> : null;

  let screen: ReactNode = null;
  switch (view.name) {
    case 'overview': screen = <FinanceOverview />; break;
    case 'documents': screen = <DocumentList key={view.path} path={view.path} />; break;
    case 'document': screen = <DocumentDetail key={`${view.path}:${view.id}`} path={view.path} id={view.id} />; break;
    case 'document-new':
      screen = needsLookups(taxRates !== null) ?? (
        <DocumentForm path={view.path} taxRates={taxRates!} defaultTaxRateId={okData(settings.state)?.defaultTaxRateId ?? null} customerId={view.customerId}
          onCancel={back({ name: 'documents', path: view.path })}
          onSaved={(d) => go({ name: 'document', path: view.path, id: d.id }, 'Draft saved. Issue it when it is final.')} />
      );
      break;
    case 'document-edit':
      screen = needsLookups(taxRates !== null) ?? <EditDocument key={view.id} view={view} env={env} taxRates={taxRates!} defaultTaxRateId={okData(settings.state)?.defaultTaxRateId ?? null} />;
      break;
    case 'recurring-list': screen = <RecurringList />; break;
    case 'recurring': screen = <RecurringDetail key={view.id} id={view.id} />; break;
    case 'recurring-new':
      screen = needsLookups(taxRates !== null) ?? (
        <RecurringForm taxRates={taxRates!} defaultTaxRateId={okData(settings.state)?.defaultTaxRateId ?? null}
          onCancel={back({ name: 'recurring-list' })}
          onSaved={(r) => go({ name: 'recurring', id: r.id }, 'Schedule saved. Drafts are generated on each billing date and are never issued or sent automatically.')} />
      );
      break;
    case 'recurring-edit':
      screen = needsLookups(taxRates !== null) ?? <EditRecurring key={view.id} id={view.id} env={env} taxRates={taxRates!} defaultTaxRateId={okData(settings.state)?.defaultTaxRateId ?? null} />;
      break;
    case 'payments': screen = <PaymentList />; break;
    case 'receivables': screen = <ReceivablesAgeingPage />; break;
    case 'statement': screen = <StatementPage key={`${view.customerId ?? ''}|${view.currencyCode ?? ''}`} customerId={view.customerId} currencyCode={view.currencyCode} />; break;
    case 'payment': screen = <PaymentDetail key={view.id} id={view.id} />; break;
    case 'payment-new':
      screen = (
        <PaymentForm prefill={view.prefill} onCancel={back(view.prefill?.invoiceId ? { name: 'document', path: 'invoices', id: view.prefill.invoiceId } : { name: 'payments' })}
          onDone={(p) => go({ name: 'payment', id: p.id }, 'Payment recorded.')} />
      );
      break;
    case 'expenses':
      screen = (
        <ExpenseList client={client} slug={slug} locale={locale} categories={categories} filters={expenseFilters} onFilters={setExpenseFilters} tabs={EXPENSE_TABS} onTab={onExpenseTab}
          canCreate={can.expenses} onOpen={(id) => go({ name: 'expense', id })} onAdd={() => go({ name: 'expense-new' })} onSessionEnded={onSessionEnded} />
      );
      break;
    case 'expense':
      screen = (
        <ExpenseDetail key={view.id} client={client} slug={slug} id={view.id} locale={locale} timeZone={timeZone} today={today} categoryName={categoryName}
          canWrite={can.expenses} canPay={can.payments} onBack={() => go({ name: 'expenses' })} onEdit={(e) => go({ name: 'expense-edit', id: e.id })}
          onPay={can.payments ? (e) => go({ name: 'expense-payment-new', expenseId: e.id }) : undefined}
          onOpenPayment={(paymentId) => go({ name: 'expense-payment', id: paymentId })} onChanged={setNotice} onSessionEnded={onSessionEnded} />
      );
      break;
    case 'expense-new':
    case 'expense-edit':
      screen = needsLookups(categories !== null && taxRates !== null) ?? (
        <ExpenseEditor key={view.name === 'expense-edit' ? view.id : 'new'} id={view.name === 'expense-edit' ? view.id : undefined} env={env} categories={categories!} taxRates={taxRates!} markForm={markForm} />
      );
      break;
    case 'expense-payments': screen = <ExpensePaymentList tabs={EXPENSE_TABS} onTab={onExpenseTab} />; break;
    case 'expense-payment': screen = <ExpensePaymentDetail key={view.id} id={view.id} />; break;
    case 'expense-payment-new':
      screen = (
        <ExpensePaymentForm expenseId={view.expenseId} onCancel={back(view.expenseId ? { name: 'expense', id: view.expenseId } : { name: 'expense-payments' })}
          onDone={(p) => go({ name: 'expense-payment', id: p.id }, 'Supplier payment recorded.')} />
      );
      break;
    case 'catalog': screen = <CatalogList />; break;
    case 'catalog-item':
      screen = needsLookups(taxRates !== null) ?? <CatalogItemPage key={view.id} id={view.id} taxRates={taxRates!} defaultTaxRateId={okData(settings.state)?.defaultTaxRateId ?? null} />;
      break;
    case 'catalog-new':
      screen = needsLookups(taxRates !== null) ?? <CatalogNew taxRates={taxRates!} defaultTaxRateId={okData(settings.state)?.defaultTaxRateId ?? null} />;
      break;
    case 'settings': screen = <FinanceSettingsPage key={view.tab ?? 'business'} tab={view.tab} onChanged={() => setGeneration((g) => g + 1)} />; break;
  }

  return (
    <ZoneFrame zone="Finance" business={name} user={userLabel} leave={guard.leave} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>
      <FinanceEnvProvider value={env}>
        <div ref={content} className="space-y-6">
          {notice ? <Alert tone="success" role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
          {screen}
        </div>
      </FinanceEnvProvider>
      {guard.dialog}
    </ZoneFrame>
  );
}

function EditDocument({ view, env, taxRates, defaultTaxRateId }: {
  view: Extract<FinanceView, { name: 'document-edit' }>; env: FinanceEnv; taxRates: TaxRateOption[]; defaultTaxRateId: string | null;
}) {
  const { state, reload } = useLoad(`doc-edit|${env.slug}|${view.path}|${view.id}`, (signal) => env.client.document(env.slug, view.path, view.id, signal));
  if (state.status === 'loading') return <LoadingRows label="Loading the draft…" />;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="This draft" onRetry={reload} onSessionEnded={env.onSessionEnded} />;
  const doc = state.outcome.data;
  const detail: FinanceView = { name: 'document', path: view.path, id: doc.id };
  if (doc.status !== 'DRAFT') {
    return <Alert tone="info"><AlertDescription>This document has been issued, so it can no longer be edited. <button type="button" className="font-medium underline" onClick={() => env.go(detail)}>Open it</button></AlertDescription></Alert>;
  }
  return (
    <DocumentForm path={view.path} doc={doc} taxRates={taxRates} defaultTaxRateId={defaultTaxRateId}
      onCancel={() => env.leave(() => env.go(detail))} onSaved={() => env.go(detail, 'Changes saved.')} />
  );
}

function EditRecurring({ id, env, taxRates, defaultTaxRateId }: { id: string; env: FinanceEnv; taxRates: TaxRateOption[]; defaultTaxRateId: string | null }) {
  const { state, reload } = useLoad(`recurring-edit|${env.slug}|${id}`, (signal) => env.client.recurringInvoice(env.slug, id, signal));
  if (state.status === 'loading') return <LoadingRows label="Loading the schedule…" />;
  if (state.outcome.kind !== 'ok') return <Problem outcome={state.outcome} what="This schedule" onRetry={reload} onSessionEnded={env.onSessionEnded} />;
  const recurring = state.outcome.data;
  const detail: FinanceView = { name: 'recurring', id: recurring.id };
  if (recurring.status === 'CANCELLED' || recurring.status === 'ENDED') {
    return <Alert tone="info"><AlertDescription>This schedule has finished, so it can no longer be edited. <button type="button" className="font-medium underline" onClick={() => env.go(detail)}>Open it</button></AlertDescription></Alert>;
  }
  return (
    <RecurringForm recurring={recurring} taxRates={taxRates} defaultTaxRateId={defaultTaxRateId}
      onCancel={() => env.leave(() => env.go(detail))} onSaved={() => env.go(detail, 'Changes saved. They apply to drafts generated from now on.')} />
  );
}

function ExpenseEditor({ id, env, categories, taxRates, markForm }: {
  id?: string; env: FinanceEnv; categories: ExpenseCategory[]; taxRates: TaxRateOption[]; markForm: (dirty: boolean) => void;
}) {
  const loaded = useLoad(`expense-edit|${env.slug}|${id ?? ''}`, (signal) => (id ? env.client.expense(env.slug, id, signal) : Promise.resolve({ kind: 'ok' as const, data: null })));
  if (loaded.state.status === 'loading') return <LoadingRows label="Loading the form…" />;
  if (loaded.state.outcome.kind !== 'ok') return <Problem outcome={loaded.state.outcome} what="This expense" onRetry={loaded.reload} onSessionEnded={env.onSessionEnded} />;
  const expense = loaded.state.outcome.data ?? undefined;
  return (
    <ExpenseForm
      client={env.client} slug={env.slug} today={env.today} currency={env.currency} categories={categories} taxRates={taxRates}
      expense={expense} onDirtyChange={markForm} onSessionEnded={env.onSessionEnded}
      onCancel={() => env.leave(() => env.go(expense ? { name: 'expense', id: expense.id } : { name: 'expenses' }))}
      onSaved={(saved) => env.go({ name: 'expense', id: saved.id }, expense ? 'Changes saved.' : 'Draft expense saved. Record it when the details are final.')}
    />
  );
}
