import 'server-only';
// Source bindings (docs/reporting-r1.md §4): each registry source calls the OWNING Zone's reporting read
// model through that Zone's public API. Reporting has no SQL of its own over another Zone's tables, so
// every amount has exactly one definition: Finance's for invoices, credit notes, payments and receivables;
// Sales' for won opportunities; Customers' for new customers.
import type { ReportingFilters, ReportingRange } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';
import { customerLabels, newCustomerCounts, newCustomerDetails } from '@/modules/customers';
import { invoiceReceivables, issuedDocumentDetails, issuedDocumentTotals, receivedPaymentDetails, receivedPaymentTotals } from '@/modules/finance';
import { wonOpportunityDetails, wonOpportunityTotals } from '@/modules/sales';
import type { SourceKey } from './registry';

/** One aggregated row from a source: a bucket, its currency and customer when relevant, and its sums. */
export interface SourceRow {
  bucket: string;
  currencyCode: string | null;
  customerId: string | null;
  /** Exact decimal string at the currency's decimals; null for count-only sources. */
  amount: string | null;
  count: number;
}

export interface PeriodArgs {
  range: ReportingRange;
  unit: 'day' | 'week' | 'month';
  byCustomer: boolean;
  filters: ReportingFilters;
  timeZone: string;
}

type PeriodSource = (db: AppTenantDb, args: PeriodArgs) => Promise<SourceRow[]>;
type SnapshotSource = (db: AppTenantDb) => Promise<{ asOf: string; rows: { currencyCode: string; amount: string; count: number }[] }>;

const finance = (kind: 'INVOICE' | 'CREDIT_NOTE'): PeriodSource => async (db, a) =>
  issuedDocumentTotals(db, kind, { from: a.range.from, to: a.range.to, unit: a.unit, byCustomer: a.byCustomer, ...a.filters });

export const PERIOD_SOURCES: Partial<Record<SourceKey, PeriodSource>> = {
  'finance.invoices': finance('INVOICE'),
  'finance.credit_notes': finance('CREDIT_NOTE'),
  'finance.payments_received': (db, a) => receivedPaymentTotals(db, { from: a.range.from, to: a.range.to, unit: a.unit, byCustomer: a.byCustomer, ...a.filters }),
  'sales.won': (db, a) => wonOpportunityTotals(db, { from: a.range.from, to: a.range.to, unit: a.unit, timeZone: a.timeZone, byCustomer: a.byCustomer, ...a.filters }),
  'customers.new': async (db, a) =>
    (await newCustomerCounts(db, { from: a.range.from, to: a.range.to, unit: a.unit, timeZone: a.timeZone })).map((r) => ({
      bucket: r.bucket, currencyCode: null, customerId: null, amount: null, count: r.count,
    })),
};

/** Snapshots reuse the Finance overview's own receivables calculation unchanged (one statement, one snapshot). */
const receivables = (pick: 'outstanding' | 'overdue'): SnapshotSource => async (db) => {
  const r = await invoiceReceivables(db);
  return {
    asOf: r.asOf,
    rows: r.currencies.map((c) => ({ currencyCode: c.currencyCode, amount: c[pick], count: pick === 'outstanding' ? c.openCount : c.overdueCount })),
  };
};
export const SNAPSHOT_SOURCES: Partial<Record<SourceKey, SnapshotSource>> = {
  'finance.receivables_outstanding': receivables('outstanding'),
  'finance.receivables_overdue': receivables('overdue'),
};

export { customerLabels };

// ---- drill-down ------------------------------------------------------------------------------------

export interface DetailArgs { range: ReportingRange; filters: ReportingFilters; timeZone: string; cursor?: string; limit: number }
export interface DetailColumn { key: string; label: string; type: 'text' | 'date' | 'datetime' | 'money' | 'status' }
export interface DetailPage {
  columns: DetailColumn[];
  rows: { id: string; currencyCode: string | null; customerId: string | null; cells: Record<string, string | null> }[];
  nextCursor: string | null;
}
type DetailSource = (db: AppTenantDb, args: DetailArgs) => Promise<DetailPage>;

const documentDetails = (kind: 'INVOICE' | 'CREDIT_NOTE'): DetailSource => async (db, a) => {
  const page = await issuedDocumentDetails(db, kind, { from: a.range.from, to: a.range.to, ...a.filters, cursor: a.cursor, limit: a.limit });
  return {
    columns: [
      { key: 'number', label: kind === 'INVOICE' ? 'Invoice' : 'Credit note', type: 'text' },
      { key: 'issueDate', label: 'Issued', type: 'date' },
      ...(kind === 'INVOICE' ? [{ key: 'dueDate', label: 'Due', type: 'date' as const }] : []),
      { key: 'total', label: 'Total', type: 'money' },
    ],
    rows: page.rows.map((r) => ({
      id: r.id, currencyCode: r.currencyCode, customerId: r.customerId,
      cells: { number: r.number, issueDate: r.issueDate, ...(kind === 'INVOICE' ? { dueDate: r.dueDate } : {}), total: r.total },
    })),
    nextCursor: page.nextCursor,
  };
};

export const DETAIL_SOURCES: Partial<Record<SourceKey, DetailSource>> = {
  'finance.invoices': documentDetails('INVOICE'),
  'finance.credit_notes': documentDetails('CREDIT_NOTE'),
  'finance.payments_received': async (db, a) => {
    const page = await receivedPaymentDetails(db, { from: a.range.from, to: a.range.to, ...a.filters, cursor: a.cursor, limit: a.limit });
    return {
      columns: [
        { key: 'receivedOn', label: 'Received', type: 'date' },
        { key: 'method', label: 'Method', type: 'status' },
        { key: 'reference', label: 'Reference', type: 'text' },
        { key: 'amount', label: 'Amount', type: 'money' },
      ],
      rows: page.rows.map((r) => ({
        id: r.id, currencyCode: r.currencyCode, customerId: r.customerId,
        cells: { receivedOn: r.receivedOn, method: r.method, reference: r.reference, amount: r.amount },
      })),
      nextCursor: page.nextCursor,
    };
  },
  'sales.won': async (db, a) => {
    const page = await wonOpportunityDetails(db, { from: a.range.from, to: a.range.to, timeZone: a.timeZone, ...a.filters, cursor: a.cursor, limit: a.limit });
    return {
      columns: [
        { key: 'title', label: 'Opportunity', type: 'text' },
        { key: 'closedAt', label: 'Won', type: 'datetime' },
        { key: 'amount', label: 'Amount', type: 'money' },
      ],
      rows: page.rows.map((r) => ({ id: r.id, currencyCode: r.currencyCode, customerId: r.customerId, cells: { title: r.title, closedAt: r.closedAt, amount: r.amount } })),
      nextCursor: page.nextCursor,
    };
  },
  'customers.new': async (db, a) => {
    const page = await newCustomerDetails(db, { from: a.range.from, to: a.range.to, timeZone: a.timeZone, cursor: a.cursor, limit: a.limit });
    return {
      columns: [
        { key: 'displayName', label: 'Customer', type: 'text' },
        { key: 'createdAt', label: 'Added', type: 'datetime' },
      ],
      rows: page.rows.map((r) => ({ id: r.id, currencyCode: null, customerId: null, cells: { displayName: r.displayName, createdAt: r.createdAt } })),
      nextCursor: page.nextCursor,
    };
  },
};
