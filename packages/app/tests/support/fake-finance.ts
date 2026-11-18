/**
 * A stand-in for the Finance API (F1–F4) and the two Customers reads the Finance Zone uses, for tests
 * only. Every request body goes through the shared contract (strict: an unknown field fails the test),
 * every response is shaped by the contract types, versions are checked, idempotency keys are honoured
 * and each business's records are kept apart. Amounts are exact (integer cents), as on the server.
 */
import {
  AllocatePaymentRequest, ApplyCreditRequest, ConvertQuoteRequest, CreateCreditNoteRequest, CreateExpenseRequest, CreateInvoiceRequest, CreateQuoteRequest, CreateTaxRateRequest,
  DiscardDraftRequest, IssueDocumentRequest, QuoteTransitionRequest, RecordExpensePaymentRequest, RecordPaymentRequest, ReverseAllocationRequest, ReversePaymentRequest, UpdateCreditNoteRequest,
  UpdateExpenseRequest, UpdateFinanceSettingsRequest, UpdateInvoiceRequest, UpdateNumberSeriesRequest, UpdatePaymentRequest, UpdateQuoteRequest, UpdateTaxRateRequest, VoidDocumentRequest,
  type CatalogItem, type CreditApplication, type Customer, type ExpenseCategory, type ExpensePayment, type FinanceExpense, type FinanceDocument, type FinanceDocumentKind, type FinancePayment, type PaymentAllocation,
} from '@business-os/contracts';
import { randomUUID } from 'node:crypto';
import { fromUnits, toUnits } from '../../src/zones/finance/decimal';
import { customer } from './fake-api';

export const NOW = '2026-11-14T03:00:00.000Z';
export const TODAY = '2026-11-15';
const S = 2;
const u = (v: string) => toUnits(v, S) ?? 0n;
const f = (v: bigint) => fromUnits(v, S);

export interface Series { kind: FinanceDocumentKind; prefix: string; minDigits: number; startingValue: number; nextValue: number; version: number }
export interface FinanceData {
  customers: Customer[];
  documents: FinanceDocument[];
  payments: FinancePayment[];
  applications: CreditApplication[];
  rates: { id: string; name: string; ratePercent: string; createdAt: string; updatedAt: string; archivedAt: string | null }[];
  series: Series[];
  settings: Record<string, unknown> & { version: number };
  expenses: FinanceExpense[];
  expensePayments: ExpensePayment[];
  payables: { currencyCode: string; currencyScale: number; outstanding: string; overdue: string; openCount: number; overdueCount: number }[];
  /** F7-B: the products and services catalog, for the line picker (optional; empty when absent). */
  catalog?: CatalogItem[];
  /** LC-2: the Sales and Projects records a document or expense may link to. When present the fake enforces the server's customer rules. */
  links?: { opportunities: { id: string; customerId: string | null }[]; projects: { id: string; customerId: string | null }[] };
  categories?: ExpenseCategory[];
}
export interface FinanceCall { method: string; slug: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }

export function financeData(over: Partial<FinanceData> = {}): FinanceData {
  return {
    customers: [], documents: [], payments: [], applications: [], payables: [], expenses: [], expensePayments: [],
    rates: [{ id: randomUUID(), name: 'GST', ratePercent: '10', createdAt: NOW, updatedAt: NOW, archivedAt: null }],
    series: (['QUOTE', 'INVOICE', 'CREDIT_NOTE'] as const).map((kind) => ({ kind, prefix: { QUOTE: 'QUO-', INVOICE: 'INV-', CREDIT_NOTE: 'CN-' }[kind], minDigits: 4, startingValue: 1, nextValue: 1, version: 0 })),
    settings: {
      sellerLegalName: 'Alpha Plumbing Pty Ltd', sellerAddress: null, sellerEmail: null, sellerPhone: null, sellerIdentifiers: [], paymentInstructions: null,
      defaultPaymentTermsDays: 14, defaultQuoteValidityDays: 30, defaultTaxRateId: null, defaultCurrency: 'AUD', retentionYears: 7, legalHold: false,
      hasRetainedRecords: false, version: 0, updatedAt: null,
    },
    ...over,
  };
}

/** An issued or draft document with consistent totals (one line, no tax unless `tax`). */
export function doc(kind: FinanceDocumentKind, over: Partial<FinanceDocument> & { amount?: string } = {}): FinanceDocument {
  const { amount = '100.00', ...rest } = over;
  const id = randomUUID();
  const customerId = rest.customerId ?? randomUUID();
  return {
    id, kind, status: 'DRAFT', number: null, customerId, contactId: null, opportunityId: null, projectId: null, sourceQuoteId: null, creditedInvoiceId: null,
    currencyCode: 'AUD', currencyScale: 2, taxMode: 'EXCLUSIVE', issueDate: null, dueDate: null, validUntil: null, subtotal: amount, taxTotal: '0.00', total: amount,
    allocatedTotal: '0.00', creditAppliedTotal: '0.00', settlementState: null, notes: null, sellerSnapshot: null, billToSnapshot: null, contentSha256: null,
    issuedAt: null, statusChangedAt: null, voidedAt: null, voidReason: null, version: 1, createdById: null, updatedById: null, issuedById: null,
    statusChangedById: null, voidedById: null, createdAt: NOW, updatedAt: NOW,
    lines: [{ id: randomUUID(), position: 1, description: 'Work', quantity: '1', unitPrice: amount, discountAmount: '0.00', taxRateId: null, taxName: null, taxRatePercent: '0', lineNet: amount, lineTax: '0.00' }],
    ...rest,
  };
}
export const billTo = (c: Customer) => ({
  customerId: c.id, name: c.displayName, legalName: null, email: null, phone: null, addressLine1: null, addressLine2: null, city: null, region: null, postalCode: null,
  countryCode: null, taxNumber: null, taxNumberType: null, contact: null,
});
export function issued(kind: FinanceDocumentKind, c: Customer, number: string, over: Partial<FinanceDocument> & { amount?: string } = {}) {
  return doc(kind, {
    status: 'ISSUED', number, customerId: c.id, billToSnapshot: billTo(c), issueDate: '2026-11-01', issuedAt: NOW, version: 2,
    settlementState: kind === 'INVOICE' ? 'UNPAID' : null, dueDate: kind === 'INVOICE' ? '2026-11-30' : null,
    sellerSnapshot: { legalName: 'Alpha Plumbing Pty Ltd', address: null, email: null, phone: null, countryCode: 'AU', identifiers: [], paymentInstructions: null },
    contentSha256: 'a'.repeat(64), ...over,
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const listItem = (d: FinanceDocument) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'lines'));
const PATHS: Record<string, FinanceDocumentKind> = { quotes: 'QUOTE', invoices: 'INVOICE', 'credit-notes': 'CREDIT_NOTE' };

export function createFakeFinance(businesses: Record<string, FinanceData>) {
  const calls: FinanceCall[] = [];
  const once: ((c: FinanceCall) => Response | 'network' | undefined)[] = [];
  const keys = new Map<string, { body: string; result: unknown }>();
  const lose: { method: string; path: string }[] = [];

  function settle(b: FinanceData, inv: FinanceDocument) {
    const done = u(inv.allocatedTotal) + u(inv.creditAppliedTotal);
    inv.settlementState = inv.status !== 'ISSUED' || inv.kind !== 'INVOICE' ? null : done === 0n ? 'UNPAID' : done >= u(inv.total) ? 'PAID' : 'PARTIALLY_PAID';
    void b;
  }
  const paymentOut = (p: FinancePayment): FinancePayment => {
    const live = p.allocations.filter((a) => !a.reversedAt).reduce((s, a) => s + u(a.amount), 0n);
    return { ...p, allocatedTotal: f(live), unallocatedAmount: p.status === 'RECORDED' ? f(u(p.amount) - live) : '0.00' };
  };
  const totals = (lines: { description: string; quantity: string; unitPrice: string; discountAmount?: string; taxRateId?: string | null }[], b: FinanceData) => {
    let sub = 0n;
    let tax = 0n;
    const out = lines.map((l, i) => {
      const net = (u(l.unitPrice) * (toUnits(l.quantity, 6) ?? 0n)) / 1_000_000n - u(l.discountAmount ?? '0');
      const rate = b.rates.find((r) => r.id === l.taxRateId);
      const t = rate ? (net * (toUnits(rate.ratePercent, 4) ?? 0n)) / 1_000_000n : 0n;
      sub += net;
      tax += t;
      return { id: randomUUID(), position: i + 1, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice,
        discountAmount: l.discountAmount ?? '0.00', taxRateId: l.taxRateId ?? null, taxName: rate?.name ?? null, taxRatePercent: rate?.ratePercent ?? '0', lineNet: f(net), lineTax: f(t) };
    });
    return { lines: out, subtotal: f(sub), taxTotal: f(tax), total: f(sub + tax) };
  };

  type DraftLine = { catalogItemId?: string; description?: string; quantity?: string; unitPrice?: string; discountAmount?: string; taxRateId?: string | null };
  type PlainLine = { description: string; quantity: string; unitPrice: string; discountAmount?: string; taxRateId?: string | null };
  /** F7-B, as the server: a line naming a catalog item is checked and filled from it, then is a plain line. */
  const resolveLines = (lines: DraftLine[], b: FinanceData, currency: string): PlainLine[] | Response => {
    const out: PlainLine[] = [];
    for (const l of lines) {
      if (!l.catalogItemId) { out.push(l as PlainLine); continue; }
      const item = (b.catalog ?? []).find((i) => i.id === l.catalogItemId);
      if (!item) return json(400, { error: 'invalid_catalog_item', message: 'Choose a product or service of this business.' });
      if (item.archivedAt) return json(409, { error: 'archived_reference' });
      if (item.status !== 'ACTIVE') return json(409, { error: 'catalog_item_inactive' });
      const price = l.unitPrice ?? (item.currencyCode === currency ? item.unitPrice : null);
      if (price === null) return json(400, { error: 'catalog_currency_mismatch', message: `The price of “${item.name}” is in ${item.currencyCode}. Enter a price in ${currency}.` });
      out.push({ ...(l.discountAmount !== undefined ? { discountAmount: l.discountAmount } : {}), description: l.description ?? item.name, quantity: l.quantity ?? '1', unitPrice: price, taxRateId: l.taxRateId !== undefined ? l.taxRateId : item.taxRateId });
    }
    return out;
  };

  /** The server's rules (documents.ts checkLinks, expenses.ts checkProject), as 400s with the same codes. */
  const linkRules = (b: FinanceData, next: { customerId: string | null; opportunityId?: string | null; projectId?: string | null }, nullProjectFits = false): Response | null => {
    if (!b.links) return null;
    if (next.opportunityId) {
      const o = b.links.opportunities.find((x) => x.id === next.opportunityId);
      if (!o) return json(400, { error: 'invalid_opportunity', message: 'Choose an opportunity of this business.' });
      if (o.customerId !== null && o.customerId !== next.customerId) return json(400, { error: 'opportunity_customer_mismatch', message: 'This opportunity is for a different customer.' });
    }
    if (next.projectId) {
      const pr = b.links.projects.find((x) => x.id === next.projectId);
      if (!pr) return json(400, { error: 'invalid_project', message: 'Choose a project of this business.' });
      if (next.customerId !== null && pr.customerId !== next.customerId && !(nullProjectFits && pr.customerId === null)) {
        return json(400, { error: 'project_customer_mismatch', message: "This project is for a different customer. Choose one of this customer's projects or clear the project." });
      }
    }
    return null;
  };
  const expenseOut = (over: Partial<FinanceExpense>): FinanceExpense => ({
    id: randomUUID(), status: 'DRAFT', categoryId: randomUUID(), categoryName: null, projectId: null, customerId: null, description: 'Expense', supplierName: null,
    referenceNumber: null, notes: null, incurredOn: '2026-11-02', dueDate: null, currencyCode: 'AUD', currencyScale: 2, subtotal: '0.00', taxAmount: '0.00',
    total: '0.00', taxTreatment: 'NO_TAX', taxRateId: null, taxName: null, taxRatePercent: '0', paidTotal: '0.00', outstanding: '0.00', paymentState: null,
    overdue: false, recordedAt: null, voidedAt: null, voidReason: null, version: 1, createdById: null, updatedById: null, recordedById: null, voidedById: null,
    createdAt: NOW, updatedAt: NOW, allocations: [], ...over,
  });

  function handle(b: FinanceData, call: FinanceCall): Response {
    const { method, path, body, query } = call;
    let m: RegExpExecArray | null;
    // ---- F7-B: catalog reads for the line picker ----
    if (path === '/finance/catalog-items' && method === 'GET') {
      const q = (query.q ?? '').toLowerCase();
      const items = (b.catalog ?? []).filter((i) => (query.status === 'active' ? i.status === 'ACTIVE' && !i.archivedAt : true)
        && (!q || i.name.toLowerCase().includes(q) || (i.code ?? '').toLowerCase().includes(q)));
      return json(200, { items: items.slice(0, Number(query.limit ?? 25)), nextCursor: null });
    }
    // ---- customers (read only) ----
    if (path === '/customers' && method === 'GET') {
      const q = (query.q ?? '').toLowerCase();
      return json(200, { customers: b.customers.filter((c) => !c.archivedAt && c.displayName.toLowerCase().includes(q)), nextCursor: null });
    }
    if ((m = /^\/customers\/([^/]+)$/.exec(path))) {
      const c = b.customers.find((x) => x.id === m![1]);
      return c ? json(200, { customer: c }) : json(404, { error: 'not_found' });
    }
    if (!path.startsWith('/finance')) return json(404, { error: 'not_found' });
    const p = path.slice('/finance'.length);

    // ---- read models ----
    if (p === '/receivables') {
      const by = new Map<string, { outstanding: bigint; overdue: bigint; openCount: number; overdueCount: number; unallocated: bigint; unapplied: bigint }>();
      const row = (c: string) => by.get(c) ?? by.set(c, { outstanding: 0n, overdue: 0n, openCount: 0, overdueCount: 0, unallocated: 0n, unapplied: 0n }).get(c)!;
      for (const d of b.documents.filter((x) => x.status === 'ISSUED')) {
        const open = u(d.total) - u(d.allocatedTotal) - u(d.creditAppliedTotal);
        if (d.kind === 'INVOICE' && open > 0n) {
          const r = row(d.currencyCode);
          r.outstanding += open;
          r.openCount++;
          if (d.dueDate && d.dueDate < TODAY) { r.overdue += open; r.overdueCount++; }
        }
        if (d.kind === 'CREDIT_NOTE') row(d.currencyCode).unapplied += u(d.total) - u(d.creditAppliedTotal);
      }
      for (const x of b.payments.map(paymentOut).filter((y) => y.status === 'RECORDED')) row(x.currencyCode).unallocated += u(x.unallocatedAmount);
      return json(200, { receivables: { asOf: TODAY, currencies: [...by].sort().filter(([, r]) => r.outstanding || r.unallocated || r.unapplied).map(([c, r]) => ({
        currencyCode: c, currencyScale: 2, outstanding: f(r.outstanding), overdue: f(r.overdue), openCount: r.openCount, overdueCount: r.overdueCount,
        unallocatedPayments: f(r.unallocated), unappliedCredit: f(r.unapplied),
      })) } });
    }
    if (p === '/customer-balances') {
      const ids = query.customerId ? [query.customerId] : [...new Set(b.documents.map((d) => d.customerId))];
      const balances = ids.flatMap((cid) => {
        const cur = [...new Set(b.documents.filter((d) => d.customerId === cid).map((d) => d.currencyCode))];
        return cur.map((c) => {
          const inv = b.documents.filter((d) => d.customerId === cid && d.currencyCode === c && d.status === 'ISSUED' && d.kind === 'INVOICE');
          const receivable = inv.reduce((s, d) => s + u(d.total) - u(d.allocatedTotal) - u(d.creditAppliedTotal), 0n);
          const overdue = inv.filter((d) => d.dueDate && d.dueDate < TODAY).reduce((s, d) => s + u(d.total) - u(d.allocatedTotal) - u(d.creditAppliedTotal), 0n);
          const unalloc = b.payments.map(paymentOut).filter((x) => x.customerId === cid && x.currencyCode === c && x.status === 'RECORDED').reduce((s, x) => s + u(x.unallocatedAmount), 0n);
          return { customerId: cid, currencyCode: c, currencyScale: 2, receivable: f(receivable), overdue: f(overdue), unallocatedPayments: f(unalloc), unappliedCredit: '0.00', creditAvailable: f(unalloc) };
        });
      }).filter((x) => x.receivable !== '0.00' || x.creditAvailable !== '0.00');
      return json(200, { balances, asOf: TODAY, nextCursor: null });
    }
    if (p === '/expense-payables') return json(200, { payables: { asOf: TODAY, currencies: b.payables } });
    const expenseItem = (e: FinanceExpense) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'allocations'));
    if (p === '/expenses' && method === 'GET') {
      let list = b.expenses;
      if (query.status && query.status !== 'all') list = list.filter((e) => e.status === query.status!.toUpperCase());
      if (query.payment === 'open') list = list.filter((e) => e.status === 'RECORDED' && e.paymentState !== 'PAID');
      if (query.payment === 'overdue') list = list.filter((e) => e.overdue);
      const limit = Number(query.limit ?? 25);
      return json(200, { expenses: list.slice(0, limit).map(expenseItem), nextCursor: list.length > limit ? 'next' : null });
    }
    if ((m = /^\/expenses\/([^/]+)$/.exec(p)) && method === 'GET') {
      const e = b.expenses.find((x) => x.id === m![1]);
      return e ? json(200, { expense: e }) : json(404, { error: 'not_found' });
    }
    if (p === '/expense-payments' && method === 'POST') {
      const key = call.headers['idempotency-key'];
      if (!key) return json(400, { error: 'idempotency_key_required', message: 'An Idempotency-Key header is required.' });
      const input = RecordExpensePaymentRequest.parse(body);
      if (keys.has(key)) return keys.get(key)!.body === JSON.stringify(input) ? json(200, keys.get(key)!.result) : json(409, { error: 'idempotency_conflict' });
      const id = randomUUID();
      const allocations = (input.allocations ?? []).map((a) => {
        const e = b.expenses.find((x) => x.id === a.expenseId)!;
        e.paidTotal = f(u(e.paidTotal) + u(a.amount));
        e.outstanding = f(u(e.total) - u(e.paidTotal));
        e.paymentState = e.outstanding === '0.00' ? 'PAID' : 'PARTIALLY_PAID';
        return { id: randomUUID(), paymentId: id, expenseId: e.id, currencyCode: e.currencyCode, amount: f(u(a.amount)), paidOn: input.paidOn, method: input.method,
          createdAt: NOW, createdById: null, reversedAt: null, reversedById: null };
      });
      const allocated = allocations.reduce((t, a) => t + u(a.amount), 0n);
      const pay: ExpensePayment = { id, payeeName: input.payeeName ?? null, currencyCode: input.currencyCode ?? 'AUD', currencyScale: 2, amount: f(u(input.amount)),
        allocatedTotal: f(allocated), unallocatedAmount: f(u(input.amount) - allocated), paidOn: input.paidOn, method: input.method, reference: input.reference ?? null,
        status: 'RECORDED', reversedAt: null, reversalReason: null, version: 1, recordedById: null, reversedById: null, createdAt: NOW, updatedAt: NOW, allocations };
      b.expensePayments.unshift(pay);
      keys.set(key, { body: JSON.stringify(input), result: { payment: pay } });
      return json(201, { payment: pay });
    }
    if ((m = /^\/expense-payments\/([^/]+)$/.exec(p)) && method === 'GET') {
      const x = b.expensePayments.find((y) => y.id === m![1]);
      return x ? json(200, { payment: x }) : json(404, { error: 'not_found' });
    }
    if (p === '/expense-categories') return json(200, { categories: b.categories ?? [] });
    if (p === '/expenses' && method === 'POST') {
      const input = CreateExpenseRequest.parse(body);
      const bad = linkRules(b, { customerId: input.customerId ?? null, projectId: input.projectId ?? null }, true);
      if (bad) return bad;
      const e = expenseOut({ categoryId: input.categoryId, description: input.description, incurredOn: input.incurredOn, customerId: input.customerId ?? null,
        projectId: input.projectId ?? null, subtotal: input.amount, total: input.amount, currencyCode: input.currencyCode ?? 'AUD' });
      b.expenses.unshift(e);
      return json(201, { expense: e });
    }
    if ((m = /^\/expenses\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      const input = UpdateExpenseRequest.parse(body);
      const e = b.expenses.find((x) => x.id === m![1]);
      if (!e) return json(404, { error: 'not_found' });
      if (input.version !== e.version) return json(409, { error: 'stale' });
      const next = { customerId: input.customerId !== undefined ? input.customerId : e.customerId, projectId: input.projectId !== undefined ? input.projectId : e.projectId };
      const bad = linkRules(b, next, true);
      if (bad) return bad;
      Object.assign(e, next, { description: input.description ?? e.description, version: e.version + 1 });
      return json(200, { expense: e });
    }
    if (p === '/settings' && method === 'GET') return json(200, { settings: b.settings });
    if (p === '/settings' && method === 'PATCH') {
      const input = UpdateFinanceSettingsRequest.parse(body);
      if (input.version !== b.settings.version) return json(409, { error: 'stale' });
      Object.assign(b.settings, input, { version: b.settings.version + 1, updatedAt: NOW });
      return json(200, { settings: b.settings });
    }
    const seriesOut = (s: Series) => ({ ...s, nextNumber: `${s.prefix}${String(s.nextValue).padStart(s.minDigits, '0')}`, used: s.nextValue > s.startingValue, updatedAt: s.version ? NOW : null });
    if (p === '/number-series') return json(200, { series: b.series.map(seriesOut) });
    if ((m = /^\/number-series\/([A-Z_]+)$/.exec(p)) && method === 'PATCH') {
      const input = UpdateNumberSeriesRequest.parse(body);
      const s = b.series.find((x) => x.kind === m![1])!;
      if (input.version !== s.version) return json(409, { error: 'stale' });
      if (input.startingValue !== undefined && s.nextValue > s.startingValue) return json(409, { error: 'series_in_use' });
      Object.assign(s, { prefix: input.prefix ?? s.prefix, minDigits: input.minDigits ?? s.minDigits, version: s.version + 1 });
      if (input.startingValue !== undefined) Object.assign(s, { startingValue: input.startingValue, nextValue: input.startingValue });
      return json(200, { series: seriesOut(s) });
    }
    if (p === '/tax-rates' && method === 'GET') return json(200, { taxRates: b.rates });
    if (p === '/tax-rates' && method === 'POST') {
      const input = CreateTaxRateRequest.parse(body);
      const r = { id: randomUUID(), name: input.name, ratePercent: input.ratePercent, createdAt: NOW, updatedAt: NOW, archivedAt: null };
      b.rates.push(r);
      return json(201, { taxRate: r });
    }
    if ((m = /^\/tax-rates\/([^/]+)$/.exec(p)) && method === 'PATCH') {
      const input = UpdateTaxRateRequest.parse(body);
      const r = b.rates.find((x) => x.id === m![1])!;
      if (input.name) r.name = input.name;
      if (input.archived !== undefined) r.archivedAt = input.archived ? NOW : null;
      return json(200, { taxRate: r });
    }

    // ---- documents ----
    if ((m = /^\/(quotes|invoices|credit-notes)$/.exec(p))) {
      const kind = PATHS[m[1]!]!;
      if (method === 'GET') {
        let list = b.documents.filter((d) => d.kind === kind);
        if (query.status && query.status !== 'all') list = list.filter((d) => d.status === query.status!.toUpperCase());
        if (query.customerId) list = list.filter((d) => d.customerId === query.customerId);
        if (query.opportunityId) list = list.filter((d) => d.opportunityId === query.opportunityId);
        if (query.projectId) list = list.filter((d) => d.projectId === query.projectId);
        if (query.invoiceId) list = list.filter((d) => d.creditedInvoiceId === query.invoiceId);
        if (query.settlement) {
          list = list.filter((d) => d.status === 'ISSUED');
          list = query.settlement === 'open' ? list.filter((d) => d.settlementState !== 'PAID') : list.filter((d) => d.settlementState === query.settlement!.toUpperCase());
        }
        if (query.overdue === 'true') list = list.filter((d) => d.status === 'ISSUED' && d.settlementState !== 'PAID' && d.dueDate !== null && d.dueDate < TODAY);
        // As the server: oldest due first, undated last, ties by id.
        if (kind === 'INVOICE' && query.sort === 'due_asc') {
          list = [...list].sort((a, b) => (a.dueDate ?? '\uffff').localeCompare(b.dueDate ?? '\uffff') || a.id.localeCompare(b.id));
        }
        const limit = Number(query.limit ?? 25);
        return json(200, { documents: list.slice(0, limit).map(listItem), nextCursor: list.length > limit ? 'next' : null });
      }
      const schema = kind === 'QUOTE' ? CreateQuoteRequest : CreateInvoiceRequest;
      const input = schema.parse(body);
      const key = call.headers['idempotency-key'];
      if (key && keys.has(key)) return keys.get(key)!.body === JSON.stringify(input) ? json(200, keys.get(key)!.result) : json(409, { error: 'idempotency_conflict' });
      const badLink = linkRules(b, { customerId: input.customerId, opportunityId: input.opportunityId, projectId: input.projectId });
      if (badLink) return badLink;
      const resolved = resolveLines(input.lines ?? [], b, input.currencyCode ?? 'AUD');
      if (resolved instanceof Response) return resolved;
      const t = totals(resolved, b);
      const d = doc(kind, { customerId: input.customerId, contactId: input.contactId ?? null, opportunityId: input.opportunityId ?? null, projectId: input.projectId ?? null,
        currencyCode: input.currencyCode ?? 'AUD', notes: input.notes ?? null, ...t,
        validUntil: 'validUntil' in input ? input.validUntil ?? null : null, dueDate: 'dueDate' in input ? input.dueDate ?? null : null });
      b.documents.unshift(d);
      if (key) keys.set(key, { body: JSON.stringify(input), result: { document: d } });
      return json(201, { document: d });
    }
    if ((m = /^\/(quotes|invoices|credit-notes)\/([^/]+)(?:\/([a-z-]+))?$/.exec(p))) {
      const kind = PATHS[m[1]!]!;
      const d = b.documents.find((x) => x.id === m![2] && x.kind === kind);
      if (!d) return json(404, { error: 'not_found' });
      const action = m[3];
      if (!action && method === 'GET') return json(200, { document: d });
      if (action === 'settlement') {
        const allocations = b.payments.flatMap((x) => x.allocations).filter((a) => a.invoiceId === d.id);
        const outstanding = d.status === 'ISSUED' ? f(u(d.total) - u(d.allocatedTotal) - u(d.creditAppliedTotal)) : '0.00';
        return json(200, { settlement: {
          invoiceId: d.id, number: d.number, status: d.status, customerId: d.customerId, currencyCode: d.currencyCode, total: d.total, allocatedTotal: d.allocatedTotal,
          creditAppliedTotal: d.creditAppliedTotal, outstanding, settlementState: d.settlementState, dueDate: d.dueDate,
          overdue: d.status === 'ISSUED' && outstanding !== '0.00' && d.dueDate !== null && d.dueDate < TODAY, asOf: TODAY, allocations,
          creditApplications: b.applications.filter((a) => a.invoiceId === d.id),
        } });
      }
      const credit = () => ({ credit: {
        creditNoteId: d.id, number: d.number, status: d.status, customerId: d.customerId, currencyCode: d.currencyCode, total: d.total, appliedTotal: d.creditAppliedTotal,
        available: d.status === 'ISSUED' ? f(u(d.total) - u(d.creditAppliedTotal)) : '0.00', applications: b.applications.filter((a) => a.creditNoteId === d.id),
      } });
      if (action === 'applications' && method === 'GET') return json(200, credit());
      if (action === 'applications' && method === 'POST') {
        const input = ApplyCreditRequest.parse(body);
        const sum = input.applications.reduce((s, a) => s + u(a.amount), 0n);
        if (sum > u(d.total) - u(d.creditAppliedTotal)) return json(409, { error: 'over_application' });
        for (const a of input.applications) {
          const inv = b.documents.find((x) => x.id === a.invoiceId)!;
          inv.creditAppliedTotal = f(u(inv.creditAppliedTotal) + u(a.amount));
          settle(b, inv);
          b.applications.push({ id: randomUUID(), creditNoteId: d.id, creditNoteNumber: d.number, invoiceId: inv.id, invoiceNumber: inv.number, currencyCode: d.currencyCode,
            amount: f(u(a.amount)), createdAt: NOW, createdById: null, reversedAt: null, reversedById: null });
        }
        d.creditAppliedTotal = f(u(d.creditAppliedTotal) + sum);
        return json(200, credit());
      }
      if (!action && method === 'PATCH') {
        const schema = { QUOTE: UpdateQuoteRequest, INVOICE: UpdateInvoiceRequest, CREDIT_NOTE: UpdateCreditNoteRequest }[kind];
        const input = schema.parse(body) as { version: number; lines?: DraftLine[]; notes?: string | null; customerId?: string; contactId?: string | null; opportunityId?: string | null; projectId?: string | null };
        if (d.status !== 'DRAFT') return json(409, { error: 'immutable' });
        if (input.version !== d.version) return json(409, { error: 'stale' });
        const resolved = input.lines ? resolveLines(input.lines, b, d.currencyCode) : null;
        if (resolved instanceof Response) return resolved;
        const next = {
          customerId: input.customerId ?? d.customerId, contactId: input.contactId !== undefined ? input.contactId : d.contactId,
          opportunityId: input.opportunityId !== undefined ? input.opportunityId : d.opportunityId, projectId: input.projectId !== undefined ? input.projectId : d.projectId,
        };
        const badLink = linkRules(b, next);
        if (badLink) return badLink;
        Object.assign(d, resolved ? totals(resolved, b) : {}, next, { notes: input.notes ?? d.notes, version: d.version + 1 });
        return json(200, { document: d });
      }
      if (action === 'issue') {
        const input = IssueDocumentRequest.parse(body);
        if (input.version !== d.version) return json(409, { error: 'stale' });
        if (d.status !== 'DRAFT') return json(409, { error: 'invalid_state' });
        const s = b.series.find((x) => x.kind === kind)!;
        const c = b.customers.find((x) => x.id === d.customerId) ?? customer({ id: d.customerId, displayName: 'Customer' });
        Object.assign(d, { status: 'ISSUED', number: `${s.prefix}${String(s.nextValue).padStart(s.minDigits, '0')}`, issueDate: input.issueDate ?? TODAY, issuedAt: NOW,
          dueDate: kind === 'INVOICE' ? input.dueDate ?? d.dueDate ?? '2026-11-29' : null, validUntil: kind === 'QUOTE' ? input.validUntil ?? d.validUntil : null,
          billToSnapshot: billTo(c), version: d.version + 1 });
        s.nextValue++;
        settle(b, d);
        return json(200, { document: d });
      }
      if (['accept', 'decline', 'expire'].includes(action ?? '')) {
        const input = QuoteTransitionRequest.parse(body);
        if (input.version !== d.version) return json(409, { error: 'stale' });
        Object.assign(d, { status: { accept: 'ACCEPTED', decline: 'DECLINED', expire: 'EXPIRED' }[action as 'accept'], version: d.version + 1 });
        return json(200, { document: d });
      }
      if (action === 'void') {
        const input = VoidDocumentRequest.parse(body);
        if (input.version !== d.version) return json(409, { error: 'stale' });
        if (u(d.allocatedTotal) > 0n) return json(409, { error: 'invoice_has_payments' });
        Object.assign(d, { status: 'VOID', voidReason: input.reason, voidedAt: NOW, version: d.version + 1, settlementState: null });
        return json(200, { document: d });
      }
      if (action === 'discard') {
        const input = DiscardDraftRequest.parse(body);
        if (input.version !== d.version) return json(409, { error: 'stale' });
        Object.assign(d, { status: 'VOID', voidReason: input.reason ?? null, version: d.version + 1 });
        return json(200, { document: d });
      }
      if (action === 'convert') {
        const input = ConvertQuoteRequest.parse(body);
        const inv = doc('INVOICE', { customerId: d.customerId, currencyCode: d.currencyCode, sourceQuoteId: d.id, dueDate: input.dueDate ?? null, lines: d.lines, subtotal: d.subtotal, taxTotal: d.taxTotal, total: d.total });
        b.documents.unshift(inv);
        return json(201, { document: inv });
      }
      if (action === 'credit-notes') {
        const input = CreateCreditNoteRequest.parse(body);
        const cn = doc('CREDIT_NOTE', { customerId: d.customerId, currencyCode: d.currencyCode, creditedInvoiceId: d.id, ...(input.copyInvoiceLines ? { lines: d.lines, subtotal: d.subtotal, total: d.total } : { lines: [], subtotal: '0.00', total: '0.00' }) });
        b.documents.unshift(cn);
        return json(201, { document: cn });
      }
    }

    // ---- payments ----
    if (p === '/payments' && method === 'GET') {
      let list = b.payments.map(paymentOut);
      if (query.status && query.status !== 'all') list = list.filter((x) => x.status === query.status!.toUpperCase());
      if (query.customerId) list = list.filter((x) => x.customerId === query.customerId);
      if (query.unallocated === 'true') list = list.filter((x) => x.status === 'RECORDED' && x.unallocatedAmount !== '0.00');
      return json(200, { payments: list.slice(0, Number(query.limit ?? 25)).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'allocations'))), nextCursor: null });
    }
    if (p === '/payments' && method === 'POST') {
      const key = call.headers['idempotency-key'];
      if (!key) return json(400, { error: 'idempotency_key_required', message: 'An Idempotency-Key header is required.' });
      const input = RecordPaymentRequest.parse(body);
      if (keys.has(key)) return keys.get(key)!.body === JSON.stringify(input) ? json(200, keys.get(key)!.result) : json(409, { error: 'idempotency_conflict' });
      const pay: FinancePayment = {
        id: randomUUID(), customerId: input.customerId, currencyCode: input.currencyCode ?? 'AUD', currencyScale: 2, amount: f(u(input.amount)), allocatedTotal: '0.00',
        unallocatedAmount: '0.00', receivedOn: input.receivedOn, method: input.method, reference: input.reference ?? null, status: 'RECORDED', reversedAt: null,
        reversalReason: null, version: 1, recordedById: null, reversedById: null, createdAt: NOW, updatedAt: NOW, allocations: [],
      };
      const bad = allocate(b, pay, input.allocations ?? []);
      if (bad) return bad;
      b.payments.unshift(pay);
      const result = { payment: paymentOut(pay) };
      keys.set(key, { body: JSON.stringify(input), result });
      return json(201, result);
    }
    if ((m = /^\/payments\/([^/]+)(?:\/(allocations|reverse))?(?:\/([^/]+)\/reverse)?$/.exec(p))) {
      const pay = b.payments.find((x) => x.id === m![1]);
      if (!pay) return json(404, { error: 'not_found' });
      if (!m[2] && method === 'GET') return json(200, { payment: paymentOut(pay) });
      if (!m[2] && method === 'PATCH') {
        const input = UpdatePaymentRequest.parse(body);
        if (input.version !== pay.version) return json(409, { error: 'stale' });
        Object.assign(pay, { reference: input.reference ?? null, version: pay.version + 1 });
        return json(200, { payment: paymentOut(pay) });
      }
      if (m[2] === 'allocations' && m[3]) {
        ReverseAllocationRequest.parse(body);
        const a = pay.allocations.find((x) => x.id === m![3])!;
        if (a.reversedAt) return json(409, { error: 'already_reversed' });
        unallocate(b, a);
        return json(200, { payment: paymentOut(pay) });
      }
      if (m[2] === 'allocations') {
        const input = AllocatePaymentRequest.parse(body);
        const live = paymentOut(pay);
        if (input.allocations.reduce((s, a) => s + u(a.amount), 0n) > u(live.unallocatedAmount)) return json(409, { error: 'over_allocation' });
        return allocate(b, pay, input.allocations) ?? json(200, { payment: paymentOut(pay) });
      }
      if (m[2] === 'reverse') {
        const input = ReversePaymentRequest.parse(body);
        if (input.version !== pay.version) return json(409, { error: 'stale' });
        for (const a of pay.allocations.filter((x) => !x.reversedAt)) unallocate(b, a);
        Object.assign(pay, { status: 'REVERSED', reversalReason: input.reason, reversedAt: NOW, version: pay.version + 1 });
        return json(200, { payment: paymentOut(pay) });
      }
    }
    return json(404, { error: 'not_found' });
  }

  function allocate(b: FinanceData, pay: FinancePayment, items: { invoiceId: string; amount: string }[]): Response | null {
    for (const item of items) {
      const inv = b.documents.find((x) => x.id === item.invoiceId && x.kind === 'INVOICE');
      if (!inv || inv.status !== 'ISSUED') return json(409, { error: 'invoice_not_open' });
      if (u(inv.allocatedTotal) + u(inv.creditAppliedTotal) + u(item.amount) > u(inv.total)) return json(409, { error: 'over_settlement' });
    }
    for (const item of items) {
      const inv = b.documents.find((x) => x.id === item.invoiceId)!;
      inv.allocatedTotal = f(u(inv.allocatedTotal) + u(item.amount));
      inv.version++;
      settle(b, inv);
      const a: PaymentAllocation = { id: randomUUID(), paymentId: pay.id, invoiceId: inv.id, invoiceNumber: inv.number, currencyCode: pay.currencyCode, amount: f(u(item.amount)),
        createdAt: NOW, createdById: null, reversedAt: null, reversedById: null };
      pay.allocations.push(a);
    }
    return null;
  }
  function unallocate(b: FinanceData, a: PaymentAllocation) {
    a.reversedAt = NOW;
    const inv = b.documents.find((x) => x.id === a.invoiceId)!;
    inv.allocatedTotal = f(u(inv.allocatedTotal) - u(a.amount));
    settle(b, inv);
  }

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const m = /^\/api\/v1\/b\/([^/]+)(\/.*)$/.exec(url.pathname);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: FinanceCall = { method: init?.method ?? 'GET', slug: m?.[1] ?? '', path: m?.[2] ?? url.pathname, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined, headers };
    calls.push(call);
    for (let i = 0; i < once.length; i++) {
      const r = once[i]!(call);
      if (r) {
        once.splice(i, 1);
        if (r === 'network') throw new TypeError('Failed to fetch');
        return r;
      }
    }
    const b = m ? businesses[m[1]!] : undefined;
    if (!b) return json(404, { error: 'not_found' });
    const response = handle(b, call);
    const lost = lose.findIndex((l) => l.method === call.method && l.path === call.path);
    if (lost >= 0) {
      lose.splice(lost, 1);
      throw new TypeError('Failed to fetch'); // the server committed, but the answer never arrived
    }
    return response;
  }) as typeof globalThis.fetch;

  return {
    fetch, calls, businesses,
    /** Answer the next matching request yourself ('network' = no response at all). */
    next: (h: (c: FinanceCall) => Response | 'network' | undefined) => once.push(h),
    /** The next request to METHOD path is carried out, but its response is lost on the way back. */
    loseNextResponse: (method: string, path: string) => lose.push({ method, path }),
  };
}
