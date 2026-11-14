import type { FinanceExpense } from '@business-os/contracts';
import { Alert, AlertDescription } from '@business-os/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FinanceClient } from '../../api/finance';
import type { BusinessContext } from '../../api/tenancy';
import { useDraftGuard } from '../drafts';
import { Problem } from '../problem';
import { useLoad } from '../use-load';
import { ZoneFrame } from '../zone-frame';
import { Categories } from './categories';
import { ExpenseDetail } from './expense-detail';
import { ExpenseForm } from './expense-form';
import { DEFAULT_FILTERS, ExpenseList, LoadingRows, type ListFilters } from './expense-list';

type View = { name: 'list' } | { name: 'categories' } | { name: 'detail'; id: string } | { name: 'new' } | { name: 'edit'; expense: FinanceExpense };
const TABS = [{ id: 'expenses', label: 'Expenses' }, { id: 'categories', label: 'Categories' }] as const;

function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The Finance Zone (F3: expenses and expense categories). Mount it with `key={slug}`: switching business
 * discards every bit of its state, nothing is cached or persisted, and every request names the business
 * only through the URL. Write controls follow the server's permission keys for presentation only; the
 * API enforces every rule again.
 */
export function FinanceZone({ client, context, userLabel, initialExpenseId, initialAction, onHome, onSwitch, onSignOut, onSessionEnded }: {
  client: FinanceClient; context: BusinessContext; userLabel: string; initialExpenseId?: string; initialAction?: 'new';
  onHome: () => void; onSwitch: () => void; onSignOut: () => void; onSessionEnded: () => void;
}) {
  const { slug, name, timeZone, locale, currency } = context.business;
  const can = (p: string) => context.membership.permissions.includes(p);
  const canWrite = can('finance:expenses');
  const canPay = can('finance:payments');
  const canManage = can('finance:manage');
  const [view, setView] = useState<View>(initialExpenseId ? { name: 'detail', id: initialExpenseId } : initialAction === 'new' && canWrite ? { name: 'new' } : { name: 'list' });
  const [filters, setFilters] = useState<ListFilters>(DEFAULT_FILTERS);
  const [notice, setNotice] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const guard = useDraftGuard();
  const content = useRef<HTMLDivElement>(null);
  const today = todayIn(timeZone);

  // Categories (all, including archived, for names) and tax rates, for the list, form and detail.
  const cats = useLoad(`finance-categories|${slug}|${generation}`, (signal) => client.categories(slug, 'all', signal));
  const rates = useLoad(`finance-rates|${slug}`, (signal) => client.taxRates(slug, signal));
  const categories = cats.state.status === 'done' && cats.state.outcome.kind === 'ok' ? cats.state.outcome.data : null;
  const taxRates = rates.state.status === 'done' && rates.state.outcome.kind === 'ok' ? rates.state.outcome.data : null;
  const categoryName = (id: string) => categories?.find((c) => c.id === id)?.name ?? 'Category';

  const go = (next: View, message: string | null = null) => {
    guard.clearDrafts();
    setNotice(message);
    setView(next);
  };
  const { markDraft } = guard;
  const markForm = useCallback((dirty: boolean) => markDraft('form', dirty), [markDraft]);
  const onTab = (id: string) => go(id === 'categories' ? { name: 'categories' } : { name: 'list' });

  const viewKey = view.name === 'detail' ? `detail:${view.id}` : view.name === 'edit' ? `edit:${view.expense.id}` : view.name;
  useEffect(() => {
    const heading = content.current?.querySelector('h1');
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [viewKey]);

  const formReady = categories !== null && taxRates !== null;
  const formFailure = cats.state.status === 'done' && cats.state.outcome.kind !== 'ok' ? { outcome: cats.state.outcome, reload: cats.reload }
    : rates.state.status === 'done' && rates.state.outcome.kind !== 'ok' ? { outcome: rates.state.outcome, reload: rates.reload } : null;

  return (
    <ZoneFrame zone="Finance" business={name} user={userLabel} leave={guard.leave} onHome={onHome} onSwitch={onSwitch} onSignOut={onSignOut}>
      <div ref={content} className="space-y-6">
        {notice ? <Alert tone="success" role="status"><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {view.name === 'list' ? (
          <ExpenseList
            client={client} slug={slug} locale={locale} categories={categories} filters={filters} onFilters={setFilters} tabs={TABS} onTab={onTab}
            canCreate={canWrite} onOpen={(id) => go({ name: 'detail', id })} onAdd={() => go({ name: 'new' })} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'categories' ? (
          <Categories client={client} slug={slug} canManage={canManage} tabs={TABS} onTab={onTab} onChanged={() => setGeneration((g) => g + 1)} onSessionEnded={onSessionEnded} />
        ) : null}
        {view.name === 'detail' ? (
          <ExpenseDetail
            client={client} slug={slug} id={view.id} locale={locale} timeZone={timeZone} today={today} categoryName={categoryName}
            canWrite={canWrite} canPay={canPay} onBack={() => go({ name: 'list' })} onEdit={(expense) => go({ name: 'edit', expense })}
            onChanged={setNotice} onSessionEnded={onSessionEnded}
          />
        ) : null}
        {view.name === 'new' || view.name === 'edit' ? (
          formFailure ? <Problem outcome={formFailure.outcome} what="Expense categories and tax rates" onRetry={formFailure.reload} onSessionEnded={onSessionEnded} />
          : !formReady ? <LoadingRows label="Loading the form…" />
          : (
            <ExpenseForm
              key={view.name === 'edit' ? view.expense.id : 'new'}
              client={client} slug={slug} today={today} currency={currency} categories={categories} taxRates={taxRates}
              expense={view.name === 'edit' ? view.expense : undefined} onDirtyChange={markForm} onSessionEnded={onSessionEnded}
              onCancel={() => guard.leave(() => go(view.name === 'edit' ? { name: 'detail', id: view.expense.id } : { name: 'list' }))}
              onSaved={(saved) => go({ name: 'detail', id: saved.id }, view.name === 'edit' ? 'Changes saved.' : 'Draft expense saved. Record it when the details are final.')}
            />
          )
        ) : null}
      </div>
      {guard.dialog}
    </ZoneFrame>
  );
}
