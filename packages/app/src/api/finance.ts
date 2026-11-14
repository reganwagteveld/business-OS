import {
  CreateExpenseCategoryRequest, CreateExpenseRequest, endpointPath, endpoints, ExpenseCategoryResponse, ExpensePayablesResponse, FinanceExpenseResponse,
  ListExpenseCategoriesResponse, ListExpensesResponse, ListTaxRatesResponse, RecordExpenseRequest, UpdateExpenseCategoryRequest, UpdateExpenseRequest,
  VoidExpenseRequest,
  type ExpenseCategory, type FinanceExpense, type FinanceExpenseListItem,
} from '@business-os/contracts';
import type { z } from 'zod';
import type { AuthTransport } from './auth';
import { createRequester, type RawResult } from './http';
import { classify, type Outcome } from './tenancy';

export interface ExpenseQuery {
  q?: string; status: 'draft' | 'recorded' | 'void' | 'all'; payment?: 'unpaid' | 'partially_paid' | 'paid' | 'open' | 'overdue';
  categoryId?: string; from?: string; to?: string; supplier?: string; cursor?: string; limit?: number;
}
export interface ExpensePage { expenses: FinanceExpenseListItem[]; nextCursor: string | null }
export type TaxRateOption = { id: string; name: string; ratePercent: string; archivedAt: string | null };
export type Payables = z.infer<typeof ExpensePayablesResponse>['payables'];

/**
 * Finance Zone calls for expenses and categories (docs/finance-data-model.md §19). The business is only
 * the `:slug` in the path. Every body is checked against the shared contract before it is sent, and
 * every response is parsed with it. Amounts stay exact decimal strings end to end.
 */
export interface FinanceClient {
  expenses(slug: string, query: ExpenseQuery, signal?: AbortSignal): Promise<Outcome<ExpensePage>>;
  expense(slug: string, id: string, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  createExpense(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  /** `patch` must include the `version` the edit was based on; a stale one comes back as conflict `stale`. */
  updateExpense(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  recordExpense(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  voidExpense(slug: string, id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<FinanceExpense>>;
  payables(slug: string, signal?: AbortSignal): Promise<Outcome<Payables>>;
  categories(slug: string, archived: 'active' | 'archived' | 'all', signal?: AbortSignal): Promise<Outcome<ExpenseCategory[]>>;
  createCategory(slug: string, input: unknown, signal?: AbortSignal): Promise<Outcome<ExpenseCategory>>;
  updateCategory(slug: string, id: string, patch: unknown, signal?: AbortSignal): Promise<Outcome<ExpenseCategory>>;
  taxRates(slug: string, signal?: AbortSignal): Promise<Outcome<TaxRateOption[]>>;
}

function fieldErrors(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '');
    if (key && !(key in fields)) fields[key] = issue.message;
  }
  return fields;
}
const invalid = (error: z.ZodError): Outcome<never> => ({ kind: 'invalid_input', message: error.issues[0]?.message ?? 'Check the highlighted fields.', fields: fieldErrors(error) });

export function createFinanceClient(baseUrl: string, transport: AuthTransport, fetchImpl?: typeof fetch): FinanceClient {
  const http = createRequester(baseUrl, transport, fetchImpl);
  function settle<S extends z.ZodType, T>(raw: RawResult, schema: S, pick: (data: z.infer<S>) => T): Outcome<T> {
    if (raw.kind === 'network') return { kind: 'unreachable' };
    if (raw.status === 400) {
      const body = raw.json as { error?: string; message?: string } | undefined;
      return { kind: 'invalid_input', message: body?.message ?? (body?.error === 'invalid_cursor' ? 'That page is no longer valid. Start again from the first page.' : 'Please check the details and try again.') };
    }
    const bad = classify(raw.status, raw.json);
    if (bad) return bad;
    const parsed = schema.safeParse(raw.json);
    return parsed.success ? { kind: 'ok', data: pick(parsed.data) } : { kind: 'invalid' };
  }
  const p = (template: string, params: Record<string, string>) => endpointPath(template, params);
  const qs = (values: Record<string, string | number | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== '') params.set(k, String(v));
    const text = params.toString();
    return text ? `?${text}` : '';
  };
  const send = async <S extends z.ZodType>(method: 'POST' | 'PATCH', path: string, schema: z.ZodType, input: unknown, response: S, signal?: AbortSignal) => {
    const checked = schema.safeParse(input);
    if (!checked.success) return invalid(checked.error);
    return settle(await http.request(method, path, checked.data, signal), response, (d) => d);
  };
  const exp = (template: string, slug: string, expenseId: string) => p(template, { slug, expenseId });

  return {
    async expenses(slug, query, signal) {
      const raw = await http.request('GET', p(endpoints.listExpenses.path, { slug }) + qs({
        q: query.q?.trim(), status: query.status, payment: query.payment, categoryId: query.categoryId, from: query.from, to: query.to,
        supplier: query.supplier?.trim(), cursor: query.cursor, limit: query.limit,
      }), undefined, signal);
      return settle(raw, ListExpensesResponse, (d) => d);
    },
    async expense(slug, id, signal) {
      return settle(await http.request('GET', exp(endpoints.getExpense.path, slug, id), undefined, signal), FinanceExpenseResponse, (d) => d.expense);
    },
    async createExpense(slug, input, signal) {
      const out = await send('POST', p(endpoints.createExpense.path, { slug }), CreateExpenseRequest, input, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async updateExpense(slug, id, patch, signal) {
      const out = await send('PATCH', exp(endpoints.updateExpense.path, slug, id), UpdateExpenseRequest, patch, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async recordExpense(slug, id, input, signal) {
      const out = await send('POST', exp(endpoints.recordExpense.path, slug, id), RecordExpenseRequest, input, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async voidExpense(slug, id, input, signal) {
      const out = await send('POST', exp(endpoints.voidExpense.path, slug, id), VoidExpenseRequest, input, FinanceExpenseResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.expense } : out;
    },
    async payables(slug, signal) {
      return settle(await http.request('GET', p(endpoints.getExpensePayables.path, { slug }), undefined, signal), ExpensePayablesResponse, (d) => d.payables);
    },
    async categories(slug, archived, signal) {
      const raw = await http.request('GET', p(endpoints.listExpenseCategories.path, { slug }) + qs({ archived }), undefined, signal);
      return settle(raw, ListExpenseCategoriesResponse, (d) => d.categories);
    },
    async createCategory(slug, input, signal) {
      const out = await send('POST', p(endpoints.createExpenseCategory.path, { slug }), CreateExpenseCategoryRequest, input, ExpenseCategoryResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.category } : out;
    },
    async updateCategory(slug, id, patch, signal) {
      const out = await send('PATCH', p(endpoints.updateExpenseCategory.path, { slug, categoryId: id }), UpdateExpenseCategoryRequest, patch, ExpenseCategoryResponse, signal);
      return out.kind === 'ok' ? { kind: 'ok', data: out.data.category } : out;
    },
    async taxRates(slug, signal) {
      const raw = await http.request('GET', p(endpoints.listTaxRates.path, { slug }) + qs({ archived: 'all' }), undefined, signal);
      return settle(raw, ListTaxRatesResponse, (d) => d.taxRates);
    },
  };
}
