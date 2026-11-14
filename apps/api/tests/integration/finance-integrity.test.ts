/**
 * Finance F1 integrity suite: the F0 spike (tests/isolation/finance-spike.test.ts) moved onto the REAL
 * migrated tables (migration 20261115000000_finance), as bos_app under forced RLS with the scoped
 * client. Same tests, same names (T, M, L, P, K, E, R, Z), so the evidence of finance-data-model.md §12
 * now applies to what production will run. Differences from the spike, all deliberate:
 *   - every guard raises its own SQLSTATE in class FN (finance-data-model §5, "Error codes") instead of
 *     the spike's generic 42501/55000/23514, so the expected codes below are the specific ones;
 *   - tax on a line always comes from a tax rate whose name and percentage the database copies (FD-T1),
 *     so the helpers pick a seeded rate for each percentage;
 *   - due dates belong to invoices and validity to quotes (CHECKs), so the issue helper sets them by kind;
 *   - a credit note's issue also refuses crediting more than the invoice total (FN012, test L6b);
 *   - T1 includes finance_settings; TR (trigger inventory) and the retention test are new.
 * The service and API behaviour is covered by finance.test.ts.
 *
 * Connections: TEST_ADMIN_URL (administrative, direct) and DATABASE_URL (bos_app), as the other
 * integration suites. The tables must be empty of these fixtures' ids: every run seeds new businesses.
 */
import { randomUUID as uuid } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@/generated/prisma/client';
import { createWithTenant, TenantScopeError } from '@/core/db/with-tenant';

const adminUrl = process.env.TEST_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl || !appUrl) throw new Error('The finance integrity suite needs TEST_ADMIN_URL and DATABASE_URL.');
const strict = process.env.SPIKE_STRICT_CONCURRENCY !== 'off';

const admin = new pg.Client({ connectionString: adminUrl });
const app = new PrismaClient({ adapter: new PrismaPg({ connectionString: appUrl, max: 60, idleTimeoutMillis: 120_000 }) });
const MODELS = {
  financeSettings: 'businessId', financeNumberSeries: 'businessId', financeTaxRate: 'businessId', financeDocument: 'businessId',
  financeDocumentLine: 'businessId', financePayment: 'businessId', financePaymentAllocation: 'businessId', financeExpenseCategory: 'businessId',
  financeExpense: 'businessId',
} as const;
const runner = createWithTenant({ clients: { app }, models: MODELS });
type Db = Parameters<Parameters<typeof runner>[1]>[0];
const as = <T>(businessId: string, userId: string | null, work: (db: Db) => Promise<T>) => runner({ businessId, userId }, work, { timeoutMs: 20_000 });

const Dec = Prisma.Decimal;
type Dec = InstanceType<typeof Prisma.Decimal>;

/** SQLSTATE of a failure, unwrapped from Prisma's driver-adapter error; 'ok' when it succeeded. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof TenantScopeError) return 'tenant_scope';
    const err = e as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } }; cause?: { originalCode?: string } };
    return err.meta?.driverAdapterError?.cause?.originalCode ?? err.cause?.originalCode ?? err.meta?.code ?? err.code ?? 'error';
  }
}
const count = (outcomes: string[], code: string) => outcomes.filter((o) => o === code).length;

// --- Seed (real tables; administrative inserts stand in for the Customer, Sales and Projects Zones) ---
const A = uuid(), B = uuid(), C = uuid();
const alice = uuid(), dave = uuid(), carl = uuid();
const cust1 = uuid(), cust2 = uuid(), contact1 = uuid(), opp1 = uuid(), proj1 = uuid(), custB = uuid(), contactB = uuid(), oppB = uuid(), projB = uuid();
const custC = uuid(), projC = uuid();
const tax10 = uuid(), taxB = uuid(), catTravel = uuid(), catB = uuid(), catC = uuid();
/** Tax rates by business and percentage: lines take their tax only from a rate (FD-T1). */
const RATES: Record<string, Record<string, string>> = { [A]: { '10': tax10 }, [B]: { '19': taxB }, [C]: {} };

async function seed() {
  const q = (sql: string, params: unknown[] = []) => admin.query(sql, params);
  const tag = uuid().slice(0, 8);
  await q(`INSERT INTO businesses (id, name, slug, legal_name, country_code, time_zone, locale, currency, home_region) VALUES
    ($1, 'Fin A', $4, 'A Pty', 'AU', 'UTC', 'en', 'USD', 'us-east-1'), ($2, 'Fin B', $5, 'B GmbH', 'DE', 'UTC', 'de', 'EUR', 'us-east-1'),
    ($3, 'Fin C', $6, 'C Ltd', 'GB', 'UTC', 'en', 'USD', 'us-east-1')`, [A, B, C, `fin-a-${tag}`, `fin-b-${tag}`, `fin-c-${tag}`]);
  await q(`INSERT INTO customers (id, business_id, display_name, address_line1) VALUES
    ($1, $4, 'Acme', '1 Old Street'), ($2, $4, 'Globex', '2 Side Road'), ($3, $5, 'B customer', 'B street'), ($6, $7, 'C customer', 'C road')`, [cust1, cust2, custB, A, B, custC, C]);
  await q(`INSERT INTO contacts (id, business_id, customer_id, display_name) VALUES ($1, $2, $3, 'Ann'), ($4, $5, $6, 'Bea')`, [contact1, A, cust1, contactB, B, custB]);
  for (const [b, opp, cust] of [[A, opp1, cust1], [B, oppB, custB]] as const) {
    const pipeline = uuid(), stage = uuid();
    await q(`INSERT INTO sales_pipelines (id, business_id, name) VALUES ($1, $2, 'Default')`, [pipeline, b]);
    await q(`INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) VALUES ($1, $2, $3, 'New', 1000)`, [stage, b, pipeline]);
    await q(`INSERT INTO opportunities (id, business_id, title, customer_id, pipeline_id, stage_id, currency_code) VALUES ($1, $2, 'Deal', $3, $4, $5, 'USD')`, [opp, b, cust, pipeline, stage]);
  }
  await q(`INSERT INTO projects (id, business_id, name) VALUES ($1, $2, 'Fit-out'), ($3, $4, 'B project'), ($5, $6, 'C project')`, [proj1, A, projB, B, projC, C]);
  for (const [b, kind, prefix] of [[A, 'QUOTE', 'Q-'], [A, 'INVOICE', 'INV-'], [A, 'CREDIT_NOTE', 'CN-'], [B, 'INVOICE', 'RE-'], [C, 'INVOICE', 'C-'], [C, 'CREDIT_NOTE', 'CCN-']] as const) {
    await q(`INSERT INTO finance_number_series (id, business_id, kind, prefix) VALUES ($1, $2, $3, $4)`, [uuid(), b, kind, prefix]);
  }
  await q(`INSERT INTO finance_tax_rates (id, business_id, name, rate_percent) VALUES ($1, $2, 'Sales tax', 10), ($3, $4, 'USt', 19)`, [tax10, A, taxB, B]);
  for (const [b, pct] of [[A, '8.875'], [A, '5'], [C, '10']] as const) {
    const id = uuid();
    await q(`INSERT INTO finance_tax_rates (id, business_id, name, rate_percent) VALUES ($1, $2, $3, $4)`, [id, b, `Tax ${pct}`, pct]);
    RATES[b]![pct] = id;
  }
  await q(`INSERT INTO finance_expense_categories (id, business_id, name) VALUES ($1, $2, 'Travel'), ($3, $4, 'Reisen'), ($5, $6, 'Materials')`, [catTravel, A, catB, B, catC, C]);
}

// --- Service-style helpers (what the F1 services will do) -----------------------------------------
/** ISO 4217 minor units; F1 takes them from Intl (as Sales does) and snapshots them on each record. */
const SCALE: Record<string, number> = { USD: 2, EUR: 2, JPY: 0, KWD: 3 };
const round = (d: Dec, scale: number) => d.toDecimalPlaces(scale, Dec.ROUND_HALF_UP); // = PostgreSQL round() for values >= 0

interface LineIn { qty: string; price: string; discount?: string; taxPct?: string; taxName?: string; taxRateId?: string; description?: string }
/** Exact line arithmetic: net = round(qty × price, scale) − discount; tax = round(net × pct / 100, scale). */
function lineAmounts(l: LineIn, scale: number) {
  const net = round(new Dec(l.qty).mul(l.price), scale).sub(l.discount ?? '0');
  const tax = round(net.mul(l.taxPct ?? '0').div(100), scale);
  return { net, tax };
}

interface DraftIn {
  kind?: 'QUOTE' | 'INVOICE' | 'CREDIT_NOTE'; customerId?: string; currency?: string; lines?: LineIn[];
  projectId?: string; contactId?: string; opportunityId?: string; creditedInvoiceId?: string; sourceQuoteId?: string;
  /** Overrides for negative tests: store these totals instead of the computed ones. */
  forceTotals?: { subtotal: string; taxTotal: string };
}
/** Creates a draft with its lines; totals computed with exact decimals. */
async function createDraft(db: Db, businessId: string, d: DraftIn) {
  const id = uuid();
  const currency = d.currency ?? 'USD';
  const scale = SCALE[currency]!;
  const lines = d.lines ?? [{ qty: '1', price: '100' }];
  const amounts = lines.map((l) => lineAmounts(l, scale));
  const subtotal = amounts.reduce((s, a) => s.add(a.net), new Dec(0));
  const taxTotal = amounts.reduce((s, a) => s.add(a.tax), new Dec(0));
  await db.financeDocument.create({
    data: {
      id, businessId, kind: d.kind ?? 'INVOICE', customerId: d.customerId ?? cust1, currencyCode: currency, currencyScale: scale,
      projectId: d.projectId ?? null, contactId: d.contactId ?? null, opportunityId: d.opportunityId ?? null,
      creditedInvoiceId: d.creditedInvoiceId ?? null, sourceQuoteId: d.sourceQuoteId ?? null,
      subtotal: d.forceTotals?.subtotal ?? subtotal, taxTotal: d.forceTotals?.taxTotal ?? taxTotal,
      total: d.forceTotals ? new Dec(d.forceTotals.subtotal).add(d.forceTotals.taxTotal) : subtotal.add(taxTotal),
    },
  });
  await db.financeDocumentLine.createMany({
    data: lines.map((l, i) => ({
      id: uuid(), businessId, documentId: id, position: (i + 1) * 1000, description: l.description ?? `Line ${i + 1}`,
      quantity: l.qty, unitPrice: l.price, discountAmount: l.discount ?? '0',
      // The database copies the rate's name and percentage onto the line (FD-T1).
      taxRateId: l.taxRateId ?? (l.taxPct && l.taxPct !== '0' ? RATES[businessId]![l.taxPct] ?? null : null),
      lineNet: amounts[i]!.net, lineTax: amounts[i]!.tax,
    })),
  });
  return id;
}

/** pg_advisory/FOR … locks return nothing Prisma can read, so lock statements are wrapped in count(). */
async function lockDocuments(db: Db, ids: string[]) {
  if (ids.length) await db.$queryRaw`SELECT count(*)::int AS n FROM (SELECT id FROM finance_documents WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE) locked`;
}
async function lockPayments(db: Db, ids: string[]) {
  if (ids.length) await db.$queryRaw`SELECT count(*)::int AS n FROM (SELECT id FROM finance_payments WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR NO KEY UPDATE) locked`;
}

/** Issue: lock the draft, then one conditional UPDATE. The database checks totals, numbers it and seals it. */
async function issue(db: Db, id: string, opts: { issueDate?: Date; dueDate?: Date | null; customerName?: string } = {}) {
  await lockDocuments(db, [id]);
  const issueDate = opts.issueDate ?? new Date(Date.UTC(2031, 0, 1));
  // Due dates belong to invoices only (CHECK); quotes and credit notes have none.
  const kind = (await db.financeDocument.findFirst({ where: { id }, select: { kind: true } }))?.kind;
  const dueDate = kind !== 'INVOICE' ? null : opts.dueDate === undefined ? new Date(issueDate.getTime() + 30 * 86_400_000) : opts.dueDate;
  const r = await db.financeDocument.updateMany({
    where: { id, status: 'DRAFT' },
    data: {
      status: 'ISSUED', issueDate, dueDate,
      sellerSnapshot: { legalName: 'A Pty', address: 'Seller St 1' },
      billToSnapshot: { name: opts.customerName ?? 'Acme', address: '1 Old Street' },
      version: { increment: 1 },
    },
  });
  if (r.count !== 1) throw Object.assign(new Error('not a draft'), { code: 'not_draft' });
  return (await db.financeDocument.findFirstOrThrow({ where: { id }, select: { number: true, numberValue: true } }));
}
const invoice = async (amount = '100', o: Omit<DraftIn, 'lines'> & { businessId?: string; user?: string; dueDate?: Date | null; issueDate?: Date } = {}) => {
  const b = o.businessId ?? A;
  return as(b, o.user ?? alice, async (db) => {
    const id = await createDraft(db, b, { ...o, lines: [{ qty: '1', price: amount }] });
    await issue(db, id, { dueDate: o.dueDate, issueDate: o.issueDate });
    return id;
  });
};
async function recordPayment(db: Db, businessId: string, p: { amount: string; customerId?: string; currency?: string; key?: string; hash?: string; receivedOn?: Date }) {
  const id = uuid();
  const currency = p.currency ?? 'USD';
  await db.financePayment.create({
    data: {
      id, businessId, customerId: p.customerId ?? cust1, currencyCode: currency, currencyScale: SCALE[currency]!, amount: p.amount,
      receivedOn: p.receivedOn ?? new Date(Date.UTC(2031, 0, 5)), method: 'BANK_TRANSFER', idempotencyKey: p.key ?? null, requestHash: p.key ? (p.hash ?? 'h') : null,
    },
  });
  return id;
}
const payment = (amount: string, o: { customerId?: string; currency?: string; businessId?: string; receivedOn?: Date } = {}) =>
  as(o.businessId ?? A, alice, (db) => recordPayment(db, o.businessId ?? A, { amount, ...o }));

/** Allocation: lock the payment, then the invoices in id order (ADR 0007 §3), then insert. */
async function allocateIn(db: Db, businessId: string, paymentId: string, items: { invoiceId: string; amount: string }[], opts: { sorted?: boolean } = {}) {
  if (opts.sorted !== false) {
    await lockPayments(db, [paymentId]);
    await lockDocuments(db, items.map((i) => i.invoiceId));
  }
  const pay = await db.financePayment.findFirstOrThrow({ where: { id: paymentId }, select: { customerId: true, currencyCode: true } });
  for (const i of items) {
    await db.financePaymentAllocation.create({
      data: { id: uuid(), businessId, paymentId, invoiceId: i.invoiceId, customerId: pay.customerId, currencyCode: pay.currencyCode, amount: i.amount },
    });
  }
}
const allocate = (paymentId: string, items: { invoiceId: string; amount: string }[], businessId = A) =>
  as(businessId, alice, (db) => allocateIn(db, businessId, paymentId, items));

/** Reverse one live allocation: payment, then invoice (same order). */
const unallocate = (paymentId: string, invoiceId: string, businessId = A) => as(businessId, alice, async (db) => {
  await lockPayments(db, [paymentId]);
  await lockDocuments(db, [invoiceId]);
  const r = await db.financePaymentAllocation.updateMany({ where: { paymentId, invoiceId, reversedAt: null }, data: { reversedAt: new Date() } });
  if (r.count !== 1) throw Object.assign(new Error('no live allocation'), { code: 'not_found' });
});

/** A database-stamped time: the transaction time of the change, never a client-supplied backdate. */
const BACKDATE = new Date(Date.UTC(2020, 0, 1));
const recent = (t: Date | string | null) => t !== null && Math.abs(new Date(t).getTime() - Date.now()) < 60_000;
const doc = (id: string) => admin.query(`SELECT * FROM finance_documents WHERE id = $1`, [id]).then((r) => r.rows[0]);
const pay = (id: string) => admin.query(`SELECT * FROM finance_payments WHERE id = $1`, [id]).then((r) => r.rows[0]);

beforeAll(async () => {
  await admin.connect();
  await seed();
  // Open the pool before the concurrency tests (see scheduling-spike.test.ts: cold TLS connections to a
  // remote pooler can exceed Prisma's 2 s maxWait). Locally and in CI this is instant.
  await Promise.all(Array.from({ length: 60 }, () => app.$queryRaw`SELECT 1`));
}, 120_000);
afterAll(async () => {
  await app.$disconnect();
  await admin.end();
});

const FINANCE_TABLES = [
  'finance_settings', 'finance_number_series', 'finance_tax_rates', 'finance_documents', 'finance_document_lines', 'finance_payments',
  'finance_payment_allocations', 'finance_expense_categories', 'finance_expenses',
];

describe('T: tenant isolation and composite FKs', () => {
  it('T1: every finance table has forced RLS and the tenant policy; bos_app has no DELETE except draft lines, no TRUNCATE; other runtime roles have nothing', async () => {
    const rls = await admin.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1) AND c.relrowsecurity AND c.relforcerowsecurity
        AND EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation')`, [FINANCE_TABLES]);
    expect(rls.rows.map((r) => r.relname).sort()).toEqual([...FINANCE_TABLES].sort());
    const priv = await admin.query(`SELECT t, has_table_privilege('bos_app', '' || t, 'DELETE') AS del,
        has_table_privilege('bos_app', '' || t, 'TRUNCATE') AS trunc,
        has_table_privilege('bos_jobs', '' || t, 'SELECT') AS jobs, has_table_privilege('bos_auth', '' || t, 'SELECT') AS auth
      FROM unnest($1::text[]) AS t`, [FINANCE_TABLES]);
    for (const r of priv.rows) {
      expect(r.del, r.t).toBe(r.t === 'finance_document_lines');
      expect([r.trunc, r.jobs, r.auth], r.t).toEqual([false, false, false]);
    }
  });

  it('T2: another business sees nothing and cannot write into this one, through the scoped client or raw SQL', async () => {
    const inv = await invoice('100');
    const p = await payment('10');
    expect(await as(B, dave, (db) => db.financeDocument.count({ where: { id: inv } }))).toBe(0);
    expect(await as(B, dave, (db) => db.financePayment.count({ where: { id: p } }))).toBe(0);
    expect(await as(B, dave, (db) => db.financeDocumentLine.count({ where: { documentId: inv } }))).toBe(0);
    expect(await as(B, dave, (db) => db.financeDocument.updateMany({ where: { id: inv }, data: { notes: 'x' } }))).toEqual({ count: 0 });
    expect(await outcome(as(B, dave, (db) => db.financePayment.create({ data: { id: uuid(), businessId: A, customerId: cust1, currencyCode: 'USD', currencyScale: 2, amount: '1', receivedOn: new Date(), method: 'CASH' } })))).toBe('tenant_scope');
    // The application layer bypassed: RLS refuses the row (WITH CHECK).
    expect(await outcome(as(B, dave, (db) => db.$queryRaw`INSERT INTO finance_payments (id, business_id, customer_id, currency_code, currency_scale, amount, received_on, method)
      VALUES (${uuid()}::uuid, ${A}::uuid, ${cust1}::uuid, 'USD', 2, 1, current_date, 'CASH') RETURNING id`))).toBe('42501');
    // A context for a business that is not A sees none of A's rows, even with no user and raw SQL.
    expect(await as(uuid(), null, (db) => db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM finance_documents`)).toEqual([{ n: 0 }]);
  });

  it('T3: links to another business\'s customers, contacts, opportunities, projects, tax rates, categories, payments and invoices are refused (23503)', async () => {
    const bInvoice = await invoice('100', { businessId: B, user: dave, customerId: custB, currency: 'EUR' });
    const draftIn = (o: DraftIn) => as(A, alice, (db) => createDraft(db, A, o));
    expect(await outcome(draftIn({ customerId: custB }))).toBe('23503');
    expect(await outcome(draftIn({ contactId: contactB }))).toBe('23503');
    expect(await outcome(draftIn({ opportunityId: oppB }))).toBe('23503');
    expect(await outcome(draftIn({ projectId: projB }))).toBe('23503');
    expect(await outcome(draftIn({ lines: [{ qty: '1', price: '10', taxPct: '19', taxRateId: taxB }] }))).toBe('23503');
    expect(await outcome(as(A, alice, (db) => db.financeExpense.create({ data: { id: uuid(), businessId: A, categoryId: catB, description: 'x', incurredOn: new Date(), currencyCode: 'USD', currencyScale: 2, amount: '1' } })))).toBe('23503');
    expect(await outcome(as(A, alice, (db) => db.financeExpense.create({ data: { id: uuid(), businessId: A, categoryId: catTravel, projectId: projB, description: 'x', incurredOn: new Date(), currencyCode: 'USD', currencyScale: 2, amount: '1' } })))).toBe('23503');
    const p = await payment('10');
    expect(await outcome(as(A, alice, (db) => db.financePaymentAllocation.create({ data: { id: uuid(), businessId: A, paymentId: p, invoiceId: bInvoice, customerId: cust1, currencyCode: 'USD', amount: '1' } })))).toBe('23503');
    expect(await outcome(draftIn({ kind: 'CREDIT_NOTE', creditedInvoiceId: bInvoice }))).toBe('23503');
  });

  it('T4: kind-, customer- and currency-bound links: allocations only to invoices of the same customer and currency; credit notes only for invoices; conversions only from quotes', async () => {
    const quote = await as(A, alice, async (db) => { const id = await createDraft(db, A, { kind: 'QUOTE' }); await issue(db, id); return id; });
    const inv = await invoice('100');
    const otherCustomer = await invoice('100', { customerId: cust2 });
    const eurInvoice = await invoice('100', { currency: 'EUR' });
    const p = await payment('50');
    expect(await outcome(allocate(p, [{ invoiceId: quote, amount: '1' }]))).toBe('23503');
    expect(await outcome(allocate(p, [{ invoiceId: otherCustomer, amount: '1' }]))).toBe('23503');
    expect(await outcome(allocate(p, [{ invoiceId: eurInvoice, amount: '1' }]))).toBe('23503');
    expect(await outcome(allocate(p, [{ invoiceId: inv, amount: '1' }]))).toBe('ok');
    // The kind columns cannot be spoofed to point a kind-bound link at another kind of document.
    expect(await outcome(as(A, alice, (db) => db.financePaymentAllocation.create({ data: { id: uuid(), businessId: A, paymentId: p, invoiceId: quote, invoiceKind: 'QUOTE', customerId: cust1, currencyCode: 'USD', amount: '1' } })))).toBe('23514');
    expect(await outcome(as(A, alice, (db) => db.financeDocument.create({ data: { id: uuid(), businessId: A, kind: 'CREDIT_NOTE', customerId: cust1, currencyCode: 'USD', currencyScale: 2, creditedInvoiceId: quote, creditedInvoiceKind: 'QUOTE' } })))).toBe('23514');
    expect(await outcome(as(A, alice, (db) => db.financeDocument.create({ data: { id: uuid(), businessId: A, kind: 'INVOICE', customerId: cust1, currencyCode: 'USD', currencyScale: 2, sourceQuoteId: inv, sourceQuoteKind: 'INVOICE' } })))).toBe('23514');
    const draftIn = (o: DraftIn) => as(A, alice, (db) => createDraft(db, A, o));
    expect(await outcome(draftIn({ kind: 'CREDIT_NOTE', creditedInvoiceId: quote }))).toBe('23503');
    expect(await outcome(draftIn({ kind: 'CREDIT_NOTE', creditedInvoiceId: inv, customerId: cust2 }))).toBe('23503');
    expect(await outcome(draftIn({ kind: 'CREDIT_NOTE', creditedInvoiceId: inv, currency: 'EUR' }))).toBe('23503');
    expect(await outcome(draftIn({ kind: 'INVOICE', sourceQuoteId: inv }))).toBe('23503');
    expect(await outcome(draftIn({ kind: 'INVOICE', sourceQuoteId: quote }))).toBe('ok');
    expect(await outcome(draftIn({ kind: 'QUOTE', sourceQuoteId: quote }))).toBe('23514');
  });
});

describe('M: exact money', () => {
  it('M1: decimal line arithmetic agrees with the database for 0-, 2- and 3-decimal currencies, including values binary floating point gets wrong', async () => {
    // 1.005 × 1 in floating point is 1.00499999…, which rounds to 1.00; exact decimal arithmetic gives 1.01.
    expect(Math.round(1.005 * 100) / 100).toBe(1);
    const cases: { currency: string; lines: LineIn[]; total: string }[] = [
      { currency: 'USD', lines: [{ qty: '1', price: '1.005' }], total: '1.01' },
      { currency: 'USD', lines: [{ qty: '3', price: '0.335', taxPct: '8.875' }, { qty: '0.5', price: '19.99', discount: '0.50' }], total: '10.60' },
      { currency: 'JPY', lines: [{ qty: '3', price: '333.5', taxPct: '10' }], total: '1101' },
      { currency: 'KWD', lines: [{ qty: '1', price: '1.2345', taxPct: '5' }], total: '1.297' },
    ];
    for (const c of cases) {
      const id = await as(A, alice, async (db) => { const id = await createDraft(db, A, { currency: c.currency, lines: c.lines }); await issue(db, id); return id; });
      const row = await as(A, alice, (db) => db.financeDocument.findFirstOrThrow({ where: { id } }));
      expect(row.status).toBe('ISSUED');
      expect(row.total.toFixed(SCALE[c.currency]!), c.currency).toBe(c.total);
      expect(row.total.equals(row.subtotal.add(row.taxTotal))).toBe(true);
    }
  });

  it('M2: float-derived or over-precise amounts are refused: wrong line arithmetic at issue, more decimals than the currency allows everywhere', async () => {
    // A line whose stored net was computed in floating point (1.00 instead of 1.01).
    const bad = await as(A, alice, async (db) => {
      const id = await createDraft(db, A, { lines: [{ qty: '1', price: '1.005' }], forceTotals: { subtotal: '1.00', taxTotal: '0' } });
      await db.financeDocumentLine.updateMany({ where: { documentId: id }, data: { lineNet: '1.00' } });
      return id;
    });
    expect(await outcome(as(A, alice, (db) => issue(db, bad)))).toBe('FN003');
    // Header totals that do not equal the lines.
    const mismatch = await as(A, alice, (db) => createDraft(db, A, { lines: [{ qty: '2', price: '5' }], forceTotals: { subtotal: '9.99', taxTotal: '0' } }));
    expect(await outcome(as(A, alice, (db) => issue(db, mismatch)))).toBe('FN003');
    // More decimals than the currency's minor unit.
    expect(await outcome(as(A, alice, (db) => createDraft(db, A, { forceTotals: { subtotal: '100.001', taxTotal: '0' } })))).toBe('23514');
    expect(await outcome(as(A, alice, (db) => createDraft(db, A, { currency: 'JPY', forceTotals: { subtotal: '100.5', taxTotal: '0' } })))).toBe('23514');
    expect(await outcome(payment('10.005'))).toBe('23514');
    const inv = await invoice('100');
    const p = await payment('10');
    expect(await outcome(allocate(p, [{ invoiceId: inv, amount: '0.005' }]))).toBe('23514');
    // An empty document cannot be issued.
    const empty = await as(A, alice, async (db) => { const id = await createDraft(db, A, { forceTotals: { subtotal: '0', taxTotal: '0' } }); await db.financeDocumentLine.deleteMany({ where: { documentId: id } }); return id; });
    expect(await outcome(as(A, alice, (db) => issue(db, empty)))).toBe('FN004');
  });
});

describe('L: lifecycle, numbering and immutability', () => {
  it('L1: the database assigns the number and the content hash at issue; clients cannot create numbered or sealed documents', async () => {
    const id = await as(A, alice, (db) => createDraft(db, A, {}));
    expect(await outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id }, data: { numberValue: BigInt(999), number: 'INV-0999' } })))).toBe('FN008');
    expect(await outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id }, data: { contentSha256: 'f'.repeat(64) } })))).toBe('FN008');
    expect(await outcome(as(A, alice, (db) => db.financeDocument.create({ data: { id: uuid(), businessId: A, kind: 'INVOICE', status: 'ISSUED', customerId: cust1, currencyCode: 'USD', currencyScale: 2 } })))).toBe('FN010');
    const n = await as(A, alice, async (db) => {
      await lockDocuments(db, [id]);
      // A client that sends its own number and hash with the issue gets the database's instead.
      await db.financeDocument.updateMany({ where: { id, status: 'DRAFT' }, data: {
        status: 'ISSUED', issueDate: new Date(Date.UTC(2031, 0, 1)), dueDate: new Date(Date.UTC(2031, 0, 31)), sellerSnapshot: { legalName: 'A Pty' }, billToSnapshot: { name: 'Acme' },
        numberValue: BigInt(999_999), number: 'INV-999999', contentSha256: 'f'.repeat(64) } });
      return db.financeDocument.findFirstOrThrow({ where: { id }, select: { number: true, numberValue: true } });
    });
    expect(n.number).toMatch(/^INV-\d{4,}$/);
    expect(n.numberValue).not.toBe(BigInt(999_999));
    const row = await doc(id);
    const recomputed = await as(A, alice, (db) => db.$queryRaw<{ h: string }[]>`SELECT finance_content_hash(d) AS h FROM finance_documents d WHERE d.id = ${id}::uuid`);
    expect(row.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(recomputed[0]!.h).toBe(row.content_sha256);
    // A client cannot pick or reset numbers through the series either.
    expect(await outcome(as(A, alice, (db) => db.financeNumberSeries.updateMany({ where: { kind: 'INVOICE' }, data: { nextValue: BigInt(1) } })))).toBe('FN008');
    expect(await outcome(as(A, alice, (db) => db.financeNumberSeries.updateMany({ where: { kind: 'INVOICE' }, data: { prefix: 'INV/' } })))).toBe('ok');
    expect((await as(A, alice, (db) => issue(db, '00000000-0000-4000-8000-000000000000').catch((e) => e.code)))).toBe('not_draft');
    await as(A, alice, (db) => db.financeNumberSeries.updateMany({ where: { kind: 'INVOICE' }, data: { prefix: 'INV-' } }));
  });

  it('L2: an issued document and its lines are immutable; only status, settlement and void fields move', async () => {
    const id = await invoice('100');
    const change = (data: Prisma.FinanceDocumentUpdateManyMutationInput) => outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id }, data })));
    for (const data of [{ total: '1' }, { subtotal: '1', total: '1' }, { notes: 'edited' }, { issueDate: new Date() }, { dueDate: null }, { billToSnapshot: { name: 'Other' } }, { currencyCode: 'EUR' }, { customerId: cust2 }, { projectId: proj1 }]) {
      expect(await change(data), JSON.stringify(data)).toBe('FN001');
    }
    expect(await outcome(as(A, alice, (db) => db.financeDocumentLine.updateMany({ where: { documentId: id }, data: { description: 'x' } })))).toBe('FN001');
    expect(await outcome(as(A, alice, (db) => db.financeDocumentLine.deleteMany({ where: { documentId: id } })))).toBe('FN001');
    expect(await outcome(as(A, alice, (db) => db.financeDocumentLine.create({ data: { id: uuid(), businessId: A, documentId: id, position: 9, description: 'x', quantity: '1', unitPrice: '1', lineNet: '1', lineTax: '0' } })))).toBe('FN001');
    // Lines cannot be moved onto an issued document from a draft either.
    const draft = await as(A, alice, (db) => createDraft(db, A, {}));
    expect(await outcome(as(A, alice, (db) => db.financeDocumentLine.updateMany({ where: { documentId: draft }, data: { documentId: id } })))).toBe('FN001');
    // Void: allowed while unsettled, then final.
    expect(await change({ status: 'VOID', voidedAt: new Date(), voidReason: 'Raised in error', version: { increment: 1 } })).toBe('ok');
    expect(await change({ voidReason: 'changed my mind' })).toBe('FN010');
    expect(await change({ status: 'ISSUED' })).toBe('FN002');
    const row = await doc(id);
    expect(row.number).toMatch(/^INV-/); // a void invoice keeps its number: the sequence has no hole
  });

  it('L3: issued documents keep their billing snapshot when the customer changes', async () => {
    const id = await invoice('100');
    const before = await doc(id);
    await admin.query(`UPDATE customers SET display_name = 'Acme Renamed', address_line1 = '9 New Street' WHERE id = $1`, [cust1]);
    const after = await doc(id);
    expect(after.bill_to_snapshot).toEqual({ name: 'Acme', address: '1 Old Street' });
    expect(after.content_sha256).toBe(before.content_sha256);
    const h = await as(A, alice, (db) => db.$queryRaw<{ h: string }[]>`SELECT finance_content_hash(d) AS h FROM finance_documents d WHERE d.id = ${id}::uuid`);
    expect(h[0]!.h).toBe(before.content_sha256);
    await admin.query(`UPDATE customers SET display_name = 'Acme', address_line1 = '1 Old Street' WHERE id = $1`, [cust1]);
  });

  it('L4: transitions follow the lifecycle per kind', async () => {
    const quote = await as(A, alice, async (db) => { const id = await createDraft(db, A, { kind: 'QUOTE' }); await issue(db, id); return id; });
    const set = (id: string, status: 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'ISSUED' | 'DRAFT') => outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id }, data: { status } })));
    const inv = await invoice('100');
    expect(await set(inv, 'ACCEPTED')).toBe('FN002');
    expect(await set(inv, 'DRAFT')).toBe('FN002');
    const draft = await as(A, alice, (db) => createDraft(db, A, { kind: 'QUOTE' }));
    expect(await set(draft, 'ACCEPTED')).toBe('FN002');
    expect(await set(quote, 'ACCEPTED')).toBe('ok');
    expect(await set(quote, 'DECLINED')).toBe('FN002');
    expect((await doc(quote)).number).toMatch(/^Q-/);
    // An accepted quote becomes an invoice: a new document that links to it (one quote may be invoiced in parts).
    const fromQuote = await as(A, alice, async (db) => { const id = await createDraft(db, A, { sourceQuoteId: quote }); await issue(db, id); return id; });
    expect((await doc(fromQuote)).source_quote_id).toBe(quote);
  });

  it('L5: nothing financial can be deleted by tenant code; draft lines can', async () => {
    const inv = await invoice('100');
    const p = await payment('10');
    await allocate(p, [{ invoiceId: inv, amount: '10' }]);
    for (const [model, where] of [['financeDocument', { id: inv }], ['financePayment', { id: p }], ['financePaymentAllocation', { paymentId: p }], ['financeNumberSeries', {}], ['financeTaxRate', {}], ['financeExpenseCategory', {}], ['financeExpense', {}]] as const) {
      expect(await outcome(as(A, alice, (db) => (db[model] as unknown as { deleteMany(a: object): Promise<unknown> }).deleteMany({ where }))), model).toBe('42501');
    }
    const draft = await as(A, alice, (db) => createDraft(db, A, { lines: [{ qty: '1', price: '1' }, { qty: '1', price: '2' }] }));
    expect(await as(A, alice, (db) => db.financeDocumentLine.deleteMany({ where: { documentId: draft, position: 2000 } }))).toEqual({ count: 1 });
  });

  it('L6: credit notes: only for an issued invoice, numbered in their own series; a credited invoice cannot be voided', async () => {
    const draftInvoice = await as(A, alice, (db) => createDraft(db, A, {}));
    const cnForDraft = await as(A, alice, (db) => createDraft(db, A, { kind: 'CREDIT_NOTE', creditedInvoiceId: draftInvoice, lines: [{ qty: '1', price: '10' }] }));
    expect(await outcome(as(A, alice, (db) => issue(db, cnForDraft)))).toBe('FN005');
    const inv = await invoice('100');
    const cn = await as(A, alice, async (db) => { const id = await createDraft(db, A, { kind: 'CREDIT_NOTE', creditedInvoiceId: inv, lines: [{ qty: '1', price: '20' }] }); return (await issue(db, id)).number; });
    expect(cn).toMatch(/^CN-/);
    expect(await outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id: inv }, data: { status: 'VOID', voidedAt: new Date() } })))).toBe('FN006');
  });

  it('L6b: credit notes never exceed their invoice: concurrent credit-note issues for one invoice serialise on it, exactly as many as fit commit', { timeout: 60_000 }, async () => {
    const inv = await invoice('100');
    const drafts = await Promise.all(Array.from({ length: 10 }, () => as(A, alice, (db) => createDraft(db, A, { kind: 'CREDIT_NOTE', creditedInvoiceId: inv, lines: [{ qty: '1', price: '30' }] }))));
    const results = await Promise.all(drafts.map((id) => outcome(as(A, alice, (db) => issue(db, id)))));
    expect(count(results, 'ok'), results.join(',')).toBe(3); // 3 × 30 ≤ 100 < 4 × 30
    expect(count(results, 'FN012')).toBe(7);
    const credited = (await admin.query(`SELECT sum(total)::text AS t FROM finance_documents WHERE credited_invoice_id = $1 AND status = 'ISSUED'`, [inv])).rows[0].t;
    expect(Number(credited)).toBe(90);
    // A credit note does not settle the invoice (credit applications are F2).
    expect((await doc(inv)).allocated_total).toBe('0.0000');
  });

  it('L8: a numbering series starts unused at an explicit starting value, which is fixed once a number has been issued', async () => {
    const series = (data: { startingValue?: bigint; nextValue?: bigint }) => as(B, dave, (db) => db.financeNumberSeries.create({
      data: { id: uuid(), businessId: B, kind: 'QUOTE', prefix: 'AN-', ...data } }));
    // Refused: a series created part-way through its numbers, or with an invalid start.
    expect(await outcome(series({ nextValue: BigInt(500) }))).toBe('FN008');
    expect(await outcome(series({ startingValue: BigInt(1043), nextValue: BigInt(1) }))).toBe('FN008');
    expect(await outcome(series({ startingValue: BigInt(0), nextValue: BigInt(0) }))).toBe('23514');
    // Allowed: a business moving from another system continues at 1043.
    expect(await outcome(series({ startingValue: BigInt(1043), nextValue: BigInt(1043) }))).toBe('ok');
    expect(await outcome(series({}))).toBe('23505'); // one series per kind
    const update = (data: { startingValue?: bigint; nextValue?: bigint }) => outcome(as(B, dave, (db) => db.financeNumberSeries.updateMany({ where: { kind: 'QUOTE' }, data })));
    // While unused, the starting value may be corrected, and next_value follows it; next_value alone may not move.
    expect(await update({ startingValue: BigInt(2001) })).toBe('ok');
    expect(await update({ nextValue: BigInt(5000) })).toBe('FN008');
    const row = (await admin.query(`SELECT starting_value::int AS s, next_value::int AS n FROM finance_number_series WHERE business_id = $1 AND kind = 'QUOTE'`, [B])).rows[0];
    expect(row).toEqual({ s: 2001, n: 2001 });
    const issued = await as(B, dave, async (db) => issue(db, await createDraft(db, B, { kind: 'QUOTE', customerId: custB, currency: 'EUR' })));
    expect(issued.number).toBe('AN-2001');
    // Once used, the start is history: no change, in either direction, and no reset through next_value.
    expect(await update({ startingValue: BigInt(1) })).toBe('FN008');
    expect(await update({ startingValue: BigInt(9000) })).toBe('FN008');
    expect(await update({ nextValue: BigInt(2001) })).toBe('FN008');
    expect(await update({ startingValue: BigInt(2002), nextValue: BigInt(2002) })).toBe('FN008');
  });

  it('L9: document transition metadata is stamped by the database and cannot be fabricated, cleared or rewritten', async () => {
    const create = (extra: Record<string, unknown>) => outcome(as(A, alice, (db) => db.financeDocument.create({
      data: { id: uuid(), businessId: A, kind: 'INVOICE', customerId: cust1, currencyCode: 'USD', currencyScale: 2, ...extra } })));
    for (const extra of [{ voidReason: 'x' }, { voidedAt: BACKDATE }, { statusChangedAt: BACKDATE }, { issuedAt: BACKDATE }, { number: 'INV-0001' }]) {
      expect(await create(extra), JSON.stringify(extra)).toBe('FN010');
    }
    const set = (id: string, data: Prisma.FinanceDocumentUpdateManyMutationInput) => outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id }, data })));
    // Drafts: no metadata, and a discarded draft cannot be dressed up as a voided issued invoice.
    const draft = await as(A, alice, (db) => createDraft(db, A, {}));
    expect(await set(draft, { voidReason: 'x' })).toBe('FN010');
    expect(await set(draft, { statusChangedAt: BACKDATE })).toBe('FN010');
    expect(await set(draft, { status: 'VOID', numberValue: BigInt(7), number: 'INV-0007', issuedAt: BACKDATE })).toBe('FN008');
    // Issued: nothing changes without its transition.
    const inv = await invoice('100');
    expect(await set(inv, { statusChangedAt: BACKDATE })).toBe('FN010');
    expect(await set(inv, { voidedAt: BACKDATE })).toBe('FN010');
    expect(await set(inv, { voidReason: 'Raised in error' })).toBe('FN010');
    const quote = await as(A, alice, async (db) => { const id = await createDraft(db, A, { kind: 'QUOTE' }); await issue(db, id); return id; });
    expect(await set(quote, { status: 'ACCEPTED', voidReason: 'x' })).toBe('FN010');
    expect(await set(quote, { status: 'ACCEPTED', voidedAt: BACKDATE })).toBe('FN010');
    expect(await set(quote, { status: 'ACCEPTED', statusChangedAt: BACKDATE })).toBe('ok');
    expect(recent((await doc(quote)).status_changed_at)).toBe(true); // stamped, not the backdate
    // The void transition: the database stamps both times; the reason is accepted only here.
    expect(await set(inv, { status: 'VOID', voidedAt: BACKDATE, statusChangedAt: BACKDATE, voidReason: 'Raised in error' })).toBe('ok');
    const v = await doc(inv);
    expect([recent(v.voided_at), recent(v.status_changed_at), v.void_reason]).toEqual([true, true, 'Raised in error']);
    // Afterwards: fixed.
    for (const data of [{ voidReason: 'Other reason' }, { voidReason: null }, { voidedAt: BACKDATE }, { voidedAt: null }, { statusChangedAt: BACKDATE }]) {
      expect(await set(inv, data), JSON.stringify(data)).toBe('FN010');
    }
    expect(await set(inv, { version: { increment: 1 } })).toBe('FN001'); // void is final
  });

  it('L7: a tax rate\'s percentage is fixed; lines keep the name and rate they were issued with', async () => {
    expect(await outcome(as(A, alice, (db) => db.financeTaxRate.updateMany({ where: { id: tax10 }, data: { ratePercent: '12' } })))).toBe('42501');
    const id = await as(A, alice, async (db) => { const id = await createDraft(db, A, { lines: [{ qty: '1', price: '100', taxPct: '10', taxName: 'Sales tax', taxRateId: tax10 }] }); await issue(db, id); return id; });
    await as(A, alice, (db) => db.financeTaxRate.updateMany({ where: { id: tax10 }, data: { name: 'Renamed tax', archivedAt: new Date() } }));
    const line = (await admin.query(`SELECT tax_name, tax_rate_percent::text AS pct, line_tax::text AS tax FROM finance_document_lines WHERE document_id = $1`, [id])).rows[0];
    expect(line).toEqual({ tax_name: 'Sales tax', pct: '10.0000', tax: '10.0000' });
  });
});

describe('TX: tax snapshots on lines (FD-T1)', () => {
  it('TX1: the database copies the rate\'s name and percentage onto a line, whatever the client sends; tax without a rate is refused', async () => {
    const id = await as(A, alice, (db) => createDraft(db, A, {}));
    const lineId = uuid();
    // A client claiming a different name and percentage for the rate gets the rate's own.
    await as(A, alice, (db) => db.financeDocumentLine.create({ data: {
      id: lineId, businessId: A, documentId: id, position: 5000, description: 'x', quantity: '1', unitPrice: '100', taxRateId: RATES[A]!['5'],
      taxName: 'Made up', taxRatePercent: '50', lineNet: '100', lineTax: '5' } }));
    expect((await admin.query(`SELECT tax_name, tax_rate_percent::text AS pct FROM finance_document_lines WHERE id = $1`, [lineId])).rows[0]).toEqual({ tax_name: 'Tax 5', pct: '5.0000' });
    // Without a rate there is no tax: a percentage sent on its own is reset to 0, and the line tax then fails the issue check.
    const noRate = uuid();
    await as(A, alice, (db) => db.financeDocumentLine.create({ data: {
      id: noRate, businessId: A, documentId: id, position: 6000, description: 'y', quantity: '1', unitPrice: '10', taxName: 'Ad hoc', taxRatePercent: '20', lineNet: '10', lineTax: '2' } }));
    expect((await admin.query(`SELECT tax_name, tax_rate_percent::text AS pct FROM finance_document_lines WHERE id = $1`, [noRate])).rows[0]).toEqual({ tax_name: null, pct: '0.0000' });
    expect(await outcome(as(A, alice, (db) => issue(db, id)))).toBe('FN003');
    // Another business's rate is invisible under RLS: the same answer as a missing one (23503).
    expect(await outcome(as(A, alice, (db) => db.financeDocumentLine.create({ data: {
      id: uuid(), businessId: A, documentId: id, position: 7000, description: 'z', quantity: '1', unitPrice: '1', taxRateId: taxB, lineNet: '1', lineTax: '0' } })))).toBe('23503');
  });
});

describe('TR: trigger, function and constraint inventory (finance-data-model §13 risk 1)', () => {
  it('TR1: exactly the reviewed triggers exist on finance tables, and no finance trigger is attached to any other table', async () => {
    const { rows } = await admin.query(`SELECT c.relname AS t, tg.tgname AS name, p.proname AS fn
      FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = tg.tgfoid
      WHERE NOT tg.tgisinternal AND n.nspname = 'public' AND (c.relname LIKE 'finance%' OR p.proname LIKE 'finance%') ORDER BY 1, 2`);
    expect(rows.map((r) => `${r.t}.${r.name}→${r.fn}`)).toEqual([
      'finance_document_lines.finance_guard_line→finance_guard_line',
      'finance_documents.finance_guard_document→finance_guard_document',
      'finance_expense_categories.finance_stamp_times→finance_stamp_times',
      'finance_expenses.finance_guard_expense→finance_guard_expense',
      'finance_number_series.finance_guard_number_series→finance_guard_number_series',
      'finance_payment_allocations.finance_apply_allocation_insert→finance_apply_allocation',
      'finance_payment_allocations.finance_apply_allocation_reversal→finance_apply_allocation',
      'finance_payment_allocations.finance_stamp_allocation→finance_stamp_allocation',
      'finance_payments.finance_guard_payment→finance_guard_payment',
      'finance_settings.finance_stamp_times→finance_stamp_times',
      'finance_tax_rates.finance_stamp_times→finance_stamp_times',
    ]);
  });

  it('TR2: every finance function is SECURITY INVOKER with a fixed search_path, and none is executable by PUBLIC', async () => {
    const { rows } = await admin.query(`SELECT p.proname AS name, p.prosecdef AS definer, p.proconfig AS config,
        has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE 'finance%' ORDER BY 1`);
    expect(rows.map((r) => r.name)).toEqual([
      'finance_apply_allocation', 'finance_content_hash', 'finance_document_content', 'finance_guard_document', 'finance_guard_expense',
      'finance_guard_line', 'finance_guard_number_series', 'finance_guard_payment', 'finance_stamp_allocation', 'finance_stamp_times',
    ]);
    for (const r of rows) {
      expect(r.definer, r.name).toBe(false);
      expect(r.config, r.name).toEqual(['search_path=pg_catalog, public']);
      expect(r.public_exec, r.name).toBe(false);
    }
  });

  it('TR3: every finance table references businesses ON DELETE RESTRICT (FD-L3), and all its other links are tenant-scoped composite keys', async () => {
    const { rows } = await admin.query(`SELECT c.conrelid::regclass::text AS t, c.conname AS name, c.confrelid::regclass::text AS target, c.confdeltype AS del,
        (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols
      FROM pg_constraint c WHERE c.contype = 'f' AND c.conrelid::regclass::text LIKE 'finance%'`);
    const tables = [...new Set(rows.map((r) => r.t))].sort();
    expect(tables).toEqual([...FINANCE_TABLES].sort());
    for (const r of rows) {
      if (r.target === 'businesses') expect(r.del, r.name).toBe('r');
      else expect(r.cols[0], r.name).toBe('business_id');
    }
    for (const t of FINANCE_TABLES) expect(rows.some((r) => r.t === t && r.target === 'businesses'), t).toBe(true);
  });
});

describe('P: payments, allocations, reversal, idempotency', () => {
  it('P1: partial payments and multi-invoice settlement keep both counters exact', async () => {
    const i1 = await invoice('100');
    const i2 = await invoice('50');
    const p1 = await payment('120');
    await allocate(p1, [{ invoiceId: i2, amount: '20' }, { invoiceId: i1, amount: '100' }]);
    const p2 = await payment('30');
    await allocate(p2, [{ invoiceId: i2, amount: '30' }]);
    expect([(await doc(i1)).allocated_total, (await doc(i2)).allocated_total]).toEqual(['100.0000', '50.0000']);
    expect([(await pay(p1)).allocated_total, (await pay(p2)).allocated_total]).toEqual(['120.0000', '30.0000']);
    // An unallocated remainder stays on the payment as customer credit.
    const p3 = await payment('80');
    const i3 = await invoice('50');
    await allocate(p3, [{ invoiceId: i3, amount: '50' }]);
    expect((await pay(p3)).allocated_total).toBe('50.0000');
  });

  it('P2: over-settlement, over-allocation, duplicates and allocations to drafts or void invoices are refused', async () => {
    const inv = await invoice('100');
    const big = await payment('500');
    expect(await outcome(allocate(big, [{ invoiceId: inv, amount: '100.01' }]))).toBe('23514');
    const small = await payment('10');
    const inv2 = await invoice('100');
    expect(await outcome(allocate(small, [{ invoiceId: inv2, amount: '10.01' }]))).toBe('23514');
    expect(await outcome(allocate(small, [{ invoiceId: inv2, amount: '5' }]))).toBe('ok');
    expect(await outcome(allocate(small, [{ invoiceId: inv2, amount: '1' }]))).toBe('23505'); // one live allocation per pair
    const draft = await as(A, alice, (db) => createDraft(db, A, {}));
    expect(await outcome(allocate(big, [{ invoiceId: draft, amount: '1' }]))).toBe('FN013');
    const voided = await invoice('100');
    await as(A, alice, (db) => db.financeDocument.updateMany({ where: { id: voided }, data: { status: 'VOID', voidedAt: new Date() } }));
    expect(await outcome(allocate(big, [{ invoiceId: voided, amount: '1' }]))).toBe('FN013');
    // A settled invoice cannot be voided until its allocations are reversed.
    expect(await outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id: inv2 }, data: { status: 'VOID', voidedAt: new Date() } })))).toBe('FN007');
  });

  it('P3: counters, numbers and allocation amounts cannot be written directly', async () => {
    const inv = await invoice('100');
    const p = await payment('10');
    await allocate(p, [{ invoiceId: inv, amount: '10' }]);
    expect(await outcome(as(A, alice, (db) => db.financeDocument.updateMany({ where: { id: inv }, data: { allocatedTotal: '0' } })))).toBe('FN010');
    expect(await outcome(as(A, alice, (db) => db.financePayment.updateMany({ where: { id: p }, data: { allocatedTotal: '0' } })))).toBe('FN010');
    expect(await outcome(as(A, alice, (db) => db.financePayment.updateMany({ where: { id: p }, data: { amount: '100' } })))).toBe('FN001');
    expect(await outcome(as(A, alice, (db) => db.financePaymentAllocation.updateMany({ where: { paymentId: p }, data: { amount: '1' } })))).toBe('42501');
    expect(await outcome(as(A, alice, (db) => db.financePayment.create({ data: { id: uuid(), businessId: A, customerId: cust1, currencyCode: 'USD', currencyScale: 2, amount: '5', receivedOn: new Date(), method: 'CASH', allocatedTotal: '5' } })))).toBe('FN010');
  });

  it('P4: reversal is explicit, one way and ordered: allocations first, then the payment', async () => {
    const inv = await invoice('100');
    const p = await payment('60');
    await allocate(p, [{ invoiceId: inv, amount: '60' }]);
    const reversePayment = () => as(A, alice, (db) => db.financePayment.updateMany({ where: { id: p }, data: { status: 'REVERSED', reversedAt: new Date(), reversalReason: 'Bounced' } }));
    expect(await outcome(reversePayment())).toBe('23514'); // still allocated
    await unallocate(p, inv);
    expect([(await doc(inv)).allocated_total, (await pay(p)).allocated_total]).toEqual(['0.0000', '0.0000']);
    expect(await outcome(as(A, alice, (db) => db.financePaymentAllocation.updateMany({ where: { paymentId: p }, data: { reversedAt: null } })))).toBe('FN001');
    expect(await outcome(reversePayment())).toBe('ok');
    expect(await outcome(allocate(p, [{ invoiceId: inv, amount: '1' }]))).toBe('FN013');
    expect(await outcome(as(A, alice, (db) => db.financePayment.updateMany({ where: { id: p }, data: { status: 'RECORDED', reversedAt: null } })))).toBe('FN001');
    // History kept: the reversed allocation is still there.
    expect((await admin.query(`SELECT count(*)::int AS n FROM finance_payment_allocations WHERE payment_id = $1 AND reversed_at IS NOT NULL`, [p])).rows[0].n).toBe(1);
  });

  it('P5: idempotency: a repeated key returns the first payment; the same key with a different request is a conflict', async () => {
    /** The F1 service: insert; on a key conflict, read the original and compare request hashes. */
    const record = (key: string, amount: string) => as(A, alice, async (db) => {
      const hash = `sha256:${amount}`;
      const existing = await db.financePayment.findFirst({ where: { idempotencyKey: key } });
      if (existing) return existing.requestHash === hash ? { id: existing.id, replayed: true } : { conflict: true };
      return { id: await recordPayment(db, A, { amount, key, hash }), replayed: false };
    });
    const key = uuid();
    const first = await record(key, '25');
    expect(await record(key, '25')).toEqual({ id: (first as { id: string }).id, replayed: true });
    expect(await record(key, '26')).toEqual({ conflict: true });
    // The database is the backstop when two requests race past the read.
    expect(await outcome(as(A, alice, (db) => recordPayment(db, A, { amount: '25', key, hash: 'sha256:25' })))).toBe('23505');
    // Keys are per business.
    expect(await outcome(as(B, dave, (db) => recordPayment(db, B, { amount: '25', key, hash: 'sha256:25', customerId: custB, currency: 'EUR' })))).toBe('ok');
  });
  it('P6: payment and allocation times are stamped by the database; reversal metadata exists only through the reversal', async () => {
    expect(await outcome(as(A, alice, (db) => db.financePayment.create({ data: { id: uuid(), businessId: A, customerId: cust1, currencyCode: 'USD', currencyScale: 2, amount: '5', receivedOn: new Date(), method: 'CASH', reversalReason: 'x' } })))).toBe('FN010');
    expect(await outcome(as(A, alice, (db) => db.financePayment.create({ data: { id: uuid(), businessId: A, customerId: cust1, currencyCode: 'USD', currencyScale: 2, amount: '5', receivedOn: new Date(), method: 'CASH', reversedAt: BACKDATE } })))).toBe('FN010');
    const inv = await invoice('100');
    const p = await payment('40');
    const setPay = (data: Prisma.FinancePaymentUpdateManyMutationInput) => outcome(as(A, alice, (db) => db.financePayment.updateMany({ where: { id: p }, data })));
    expect(await setPay({ reversalReason: 'Bounced' })).toBe('FN010');
    expect(await setPay({ reversedAt: BACKDATE })).toBe('FN010');
    // Allocation times: a backdated created_at or reversed_at is replaced by the transaction time.
    await as(A, alice, async (db) => {
      await lockPayments(db, [p]);
      await lockDocuments(db, [inv]);
      await db.financePaymentAllocation.create({ data: { id: uuid(), businessId: A, paymentId: p, invoiceId: inv, customerId: cust1, currencyCode: 'USD', amount: '40', createdAt: BACKDATE } });
    });
    const alloc = async () => (await admin.query(`SELECT created_at, reversed_at FROM finance_payment_allocations WHERE payment_id = $1`, [p])).rows[0];
    expect(recent((await alloc()).created_at)).toBe(true);
    await as(A, alice, async (db) => {
      await lockPayments(db, [p]);
      await lockDocuments(db, [inv]);
      await db.financePaymentAllocation.updateMany({ where: { paymentId: p, reversedAt: null }, data: { reversedAt: BACKDATE } });
    });
    expect(recent((await alloc()).reversed_at)).toBe(true);
    expect(await outcome(as(A, alice, (db) => db.financePaymentAllocation.updateMany({ where: { paymentId: p }, data: { reversedAt: new Date() } })))).toBe('FN001');
    // The payment reversal: reversed_at stamped, reason accepted, then both fixed.
    expect(await setPay({ status: 'REVERSED', reversedAt: BACKDATE, reversalReason: 'Bounced' })).toBe('ok');
    const r = await pay(p);
    expect([recent(r.reversed_at), r.reversal_reason]).toEqual([true, 'Bounced']);
    for (const data of [{ reversalReason: 'Other' }, { reversalReason: null }, { reversedAt: BACKDATE }]) {
      expect(await setPay(data), JSON.stringify(data)).toBe('FN010');
    }
  });
});

describe('K: concurrency', () => {
  it('K1: 40 concurrent issues, 10 of which roll back after being numbered: the committed numbers are unique and gapless', { timeout: 120_000 }, async () => {
    const drafts = await Promise.all(Array.from({ length: 40 }, () => as(A, alice, (db) => createDraft(db, A, { kind: 'QUOTE' }))));
    const start = Number((await admin.query(`SELECT next_value FROM finance_number_series WHERE business_id = $1 AND kind = 'QUOTE'`, [A])).rows[0].next_value);
    const results = await Promise.all(drafts.map((id, i) => outcome(as(A, alice, async (db) => {
      await issue(db, id);
      if (i % 4 === 0) throw new Error('simulated failure after numbering');
    }))));
    expect(count(results, 'ok'), results.join(',')).toBe(30);
    const nums = (await admin.query(`SELECT number_value::int AS n FROM finance_documents WHERE business_id = $1 AND kind = 'QUOTE' AND number_value >= $2 ORDER BY 1`, [A, start])).rows.map((r) => r.n);
    expect(nums).toEqual(Array.from({ length: 30 }, (_, i) => start + i));
    const rolledBack = drafts.filter((_, i) => i % 4 === 0);
    expect((await admin.query(`SELECT count(*)::int AS n FROM finance_documents WHERE id = ANY($1) AND status = 'DRAFT' AND number IS NULL`, [rolledBack])).rows[0].n).toBe(10);
  });

  it('K2: 30 concurrent 10.00 payments allocated to one 100.00 invoice: exactly 10 succeed and it is never over-settled', { timeout: 120_000 }, async () => {
    const inv = await invoice('100');
    const payments = await Promise.all(Array.from({ length: 30 }, () => payment('10')));
    const results = await Promise.all(payments.map((p) => outcome(allocate(p, [{ invoiceId: inv, amount: '10' }]))));
    expect(count(results, 'ok'), results.join(',')).toBe(10);
    expect(count(results, '23514')).toBe(20);
    expect((await doc(inv)).allocated_total).toBe('100.0000');
  });

  it('K3: one 100.00 payment allocated concurrently to 30 invoices: exactly 10 succeed and it is never over-allocated', { timeout: 120_000 }, async () => {
    const p = await payment('100');
    const invoices = await Promise.all(Array.from({ length: 30 }, () => invoice('50')));
    const results = await Promise.all(invoices.map((i) => outcome(allocate(p, [{ invoiceId: i, amount: '10' }]))));
    expect(count(results, 'ok'), results.join(',')).toBe(10);
    expect(count(results, '23514')).toBe(20);
    expect((await pay(p)).allocated_total).toBe('100.0000');
  });

  it('K4: lock ordering: crossed multi-invoice settlements deadlock without it (one rolls back whole) and queue with it', { timeout: 60_000 }, async () => {
    const [i1, i2] = [await invoice('100'), await invoice('100')];
    const [p1, p2] = [await payment('100'), await payment('100')];
    const open = async () => {
      const c = new pg.Client({ connectionString: appUrl });
      await c.connect();
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)`, [A, alice]);
      return c;
    };
    const alloc = (c: pg.Client, p: string, i: string) => c.query(
      `INSERT INTO finance_payment_allocations (id, business_id, payment_id, invoice_id, customer_id, currency_code, amount) VALUES ($1, $2, $3, $4, $5, 'USD', 10)`, [uuid(), A, p, i, cust1]);
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? 'error');
    const waitForLockWait = async () => {
      for (let i = 0; i < 100; i++) {
        const n = (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n;
        if (n > 0) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error('no transaction started waiting');
    };
    const liveFor = async (ids: string[]) => (await admin.query(`SELECT count(*)::int AS n FROM finance_payment_allocations WHERE payment_id = ANY($1) AND reversed_at IS NULL`, [ids])).rows[0].n;

    // Without ordering: t1 holds i1 and wants i2; t2 holds i2 and wants i1.
    const [t1, t2] = [await open(), await open()];
    await alloc(t1, p1, i1);
    await alloc(t2, p2, i2);
    const r1 = code(alloc(t1, p1, i2));
    await waitForLockWait();
    const r2 = code(alloc(t2, p2, i1));
    const outcomes = await Promise.all([r1, r2]);
    expect([...outcomes].sort()).toEqual(['40P01', 'ok']);
    const [winner, loser] = outcomes[0] === 'ok' ? [t1, t2] : [t2, t1];
    await loser.query('ROLLBACK');
    await winner.query('COMMIT');
    expect(await liveFor([p1, p2])).toBe(2); // the winner's two allocations; nothing of the loser's
    await Promise.all([t1.end(), t2.end()]);

    // With ordering: payment, then invoices in id order. The second transaction queues instead.
    const [i3, i4] = [await invoice('100'), await invoice('100')];
    const [p3, p4] = [await payment('100'), await payment('100')];
    const sorted = [i3, i4].sort();
    const lockAll = (c: pg.Client, p: string) => c.query(
      `SELECT 1 FROM finance_payments WHERE id = $1 FOR NO KEY UPDATE`, [p]).then(() =>
      c.query(`SELECT id FROM finance_documents WHERE id = ANY($1) ORDER BY id FOR NO KEY UPDATE`, [sorted]));
    const [u1, u2] = [await open(), await open()];
    await lockAll(u1, p3);
    await alloc(u1, p3, i3);
    const q2 = code(lockAll(u2, p4).then(() => alloc(u2, p4, i4)).then(() => alloc(u2, p4, i3)));
    await waitForLockWait();
    expect(await code(alloc(u1, p3, i4))).toBe('ok');
    await u1.query('COMMIT');
    expect(await q2).toBe('ok');
    await u2.query('COMMIT');
    await Promise.all([u1.end(), u2.end()]);
    expect(await liveFor([p3, p4])).toBe(4);
  });

  it('K5: void racing allocation: per invoice exactly one wins, and a void invoice never holds money', { timeout: 120_000 }, async () => {
    const pairs = await Promise.all(Array.from({ length: 20 }, async () => ({ inv: await invoice('100'), p: await payment('10') })));
    const results = await Promise.all(pairs.flatMap(({ inv, p }) => [
      outcome(allocate(p, [{ invoiceId: inv, amount: '10' }])),
      outcome(as(A, alice, async (db) => {
        await lockDocuments(db, [inv]);
        const r = await db.financeDocument.updateMany({ where: { id: inv, status: 'ISSUED' }, data: { status: 'VOID', voidedAt: new Date(), version: { increment: 1 } } });
        if (r.count !== 1) throw Object.assign(new Error('not issued'), { code: 'not_issued' });
      })),
    ]));
    for (let k = 0; k < pairs.length; k++) {
      const [a, v] = [results[2 * k]!, results[2 * k + 1]!];
      const d = await doc(pairs[k]!.inv);
      if (a === 'ok') {
        expect(v).toBe('FN007');
        expect([d.status, d.allocated_total]).toEqual(['ISSUED', '10.0000']);
      } else {
        expect([a, v]).toEqual(['FN013', 'ok']);
        expect([d.status, d.allocated_total]).toEqual(['VOID', '0.0000']);
      }
    }
  });

  it('K6: 20 concurrent payments with one idempotency key: exactly one is recorded', { timeout: 60_000 }, async () => {
    const key = uuid();
    const results = await Promise.all(Array.from({ length: 20 }, () => outcome(as(A, alice, (db) => recordPayment(db, A, { amount: '42', key, hash: 'sha256:42' })))));
    expect(count(results, 'ok'), results.join(',')).toBe(1);
    expect(count(results, '23505')).toBe(19);
    expect((await admin.query(`SELECT count(*)::int AS n FROM finance_payments WHERE business_id = $1 AND idempotency_key = $2`, [A, key])).rows[0].n).toBe(1);
  });

  it('K7: line writes racing an issue: the issued totals and hash always match the lines that committed', { timeout: 120_000 }, async () => {
    for (let round = 0; round < 5; round++) {
      const id = await as(A, alice, (db) => createDraft(db, A, { lines: [{ qty: '1', price: '10' }] }));
      const writers = Array.from({ length: 10 }, (_, i) => outcome(as(A, alice, async (db) => {
        await lockDocuments(db, [id]); // lock order: the document, then its lines
        await db.financeDocumentLine.create({ data: { id: uuid(), businessId: A, documentId: id, position: 2000 + i, description: 'extra', quantity: '1', unitPrice: '1', lineNet: '1', lineTax: '0' } });
        const sums = await db.financeDocumentLine.aggregate({ where: { documentId: id }, _sum: { lineNet: true } });
        await db.financeDocument.updateMany({ where: { id, status: 'DRAFT' }, data: { subtotal: sums._sum.lineNet!, total: sums._sum.lineNet!, version: { increment: 1 } } });
      })));
      const issuer = outcome(as(A, alice, (db) => issue(db, id)));
      const [issued, ...written] = await Promise.all([issuer, ...writers]);
      expect(issued).toBe('ok');
      expect(written.every((w) => w === 'ok' || w === 'FN001'), written.join(',')).toBe(true);
      const d = await doc(id);
      const lines = (await admin.query(`SELECT count(*)::int AS n, sum(line_net)::text AS net FROM finance_document_lines WHERE document_id = $1`, [id])).rows[0];
      expect(lines.n).toBe(1 + count(written, 'ok'));
      expect(Number(d.subtotal)).toBe(Number(lines.net));
      const h = await as(A, alice, (db) => db.$queryRaw<{ h: string }[]>`SELECT finance_content_hash(d) AS h FROM finance_documents d WHERE d.id = ${id}::uuid`);
      expect(h[0]!.h).toBe(d.content_sha256);
    }
  });

  it('K7b: a line writer that skips the document lock still cannot slip a line into an issued document (the guard\'s FOR SHARE)', { timeout: 120_000 }, async () => {
    for (let round = 0; round < 10; round++) {
      const id = await as(A, alice, (db) => createDraft(db, A, { lines: [{ qty: '1', price: '10' }] }));
      // Zero-priced lines leave the totals unchanged, so the issue succeeds whichever way the race goes;
      // what matters is that every committed line is inside the sealed content.
      const writers = Array.from({ length: 10 }, (_, i) => outcome(as(A, alice, (db) =>
        db.financeDocumentLine.create({ data: { id: uuid(), businessId: A, documentId: id, position: 2000 + i, description: 'note', quantity: '1', unitPrice: '0', lineNet: '0', lineTax: '0' } }))));
      const [issued, ...written] = await Promise.all([outcome(as(A, alice, (db) => issue(db, id))), ...writers]);
      expect(issued).toBe('ok');
      expect(written.every((w) => w === 'ok' || w === 'FN001'), written.join(',')).toBe(true);
      const d = await doc(id);
      const h = await as(A, alice, (db) => db.$queryRaw<{ h: string }[]>`SELECT finance_content_hash(d) AS h FROM finance_documents d WHERE d.id = ${id}::uuid`);
      expect(h[0]!.h, `round ${round}`).toBe(d.content_sha256);
    }
  });

  it('K8: a storm of crossed multi-invoice allocations and reversals with ordered locks: no deadlocks, every counter exact', { timeout: 180_000 }, async () => {
    const invoices = await Promise.all(Array.from({ length: 5 }, () => invoice('30')));
    const payments = await Promise.all(Array.from({ length: 5 }, () => payment('30')));
    const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
    const ops = Array.from({ length: 120 }, (_, n) => {
      const p = pick(payments);
      if (n % 3 === 2) {
        return outcome(as(A, alice, async (db) => {
          await lockPayments(db, [p]);
          const live = await db.financePaymentAllocation.findFirst({ where: { paymentId: p, reversedAt: null } });
          if (!live) return;
          await lockDocuments(db, [live.invoiceId]);
          await db.financePaymentAllocation.updateMany({ where: { id: live.id, reversedAt: null }, data: { reversedAt: new Date() } });
        }));
      }
      const [x, y] = [pick(invoices), pick(invoices)];
      const items = x === y ? [{ invoiceId: x, amount: '1' }] : [{ invoiceId: y, amount: '1' }, { invoiceId: x, amount: '1' }]; // deliberately unsorted
      return outcome(allocate(p, items));
    });
    const results = await Promise.all(ops);
    const unexpected = results.filter((r) => !['ok', '23505', '23514'].includes(r) && !(r === '40P01' && !strict));
    expect(unexpected, results.join(',')).toEqual([]);
    expect(count(results, 'ok')).toBeGreaterThan(40);
  });
});

describe('E: expenses', () => {
  it('E1: recording snapshots the category; a recorded expense is immutable and can only be voided; project links are optional', async () => {
    const id = uuid();
    await as(A, alice, (db) => db.financeExpense.create({ data: { id, businessId: A, categoryId: catTravel, projectId: proj1, description: 'Flights', supplierName: 'Air Co', incurredOn: new Date(Date.UTC(2031, 0, 3)), currencyCode: 'USD', currencyScale: 2, amount: '110', taxAmount: '10', receiptReference: 'receipt:2031-01-03-air' } }));
    expect(await outcome(as(A, alice, (db) => db.financeExpense.updateMany({ where: { id }, data: { amount: '120' } })))).toBe('ok'); // drafts are editable
    expect(await outcome(as(A, alice, (db) => db.financeExpense.updateMany({ where: { id }, data: { categoryName: 'Forged' } })))).toBe('FN010');
    await as(A, alice, (db) => db.financeExpense.updateMany({ where: { id }, data: { status: 'RECORDED' } }));
    await as(A, alice, (db) => db.financeExpenseCategory.updateMany({ where: { id: catTravel }, data: { name: 'Travel & lodging' } }));
    const row = (await admin.query(`SELECT category_name, recorded_at FROM finance_expenses WHERE id = $1`, [id])).rows[0];
    expect(row.category_name).toBe('Travel');
    expect(row.recorded_at).not.toBeNull();
    for (const data of [{ amount: '1' }, { projectId: null }, { categoryId: catTravel, categoryName: 'x' }, { receiptReference: 'other' }, { status: 'DRAFT' as const }]) {
      expect(await outcome(as(A, alice, (db) => db.financeExpense.updateMany({ where: { id }, data }))), JSON.stringify(data)).not.toBe('ok');
    }
    expect(await outcome(as(A, alice, (db) => db.financeExpense.updateMany({ where: { id }, data: { status: 'VOID', voidedAt: new Date(), voidReason: 'Duplicate' } })))).toBe('ok');
    expect(await outcome(as(A, alice, (db) => db.financeExpense.updateMany({ where: { id }, data: { status: 'RECORDED' } })))).toBe('FN002');
    expect(await outcome(as(A, alice, (db) => db.financeExpense.create({ data: { id: uuid(), businessId: A, status: 'RECORDED', categoryId: catTravel, description: 'x', incurredOn: new Date(), currencyCode: 'USD', currencyScale: 2, amount: '1' } })))).toBe('FN010');
    await as(A, alice, (db) => db.financeExpenseCategory.updateMany({ where: { id: catTravel }, data: { name: 'Travel' } }));
  });

  it('E2: expense void metadata is stamped by the database and exists only through the void transition', async () => {
    const base = { businessId: A, categoryId: catTravel, description: 'Taxi', incurredOn: new Date(Date.UTC(2031, 0, 4)), currencyCode: 'USD', currencyScale: 2, amount: '20' };
    for (const extra of [{ voidReason: 'x' }, { voidedAt: BACKDATE }, { recordedAt: BACKDATE }, { categoryName: 'Forged' }]) {
      expect(await outcome(as(A, alice, (db) => db.financeExpense.create({ data: { id: uuid(), ...base, ...extra } }))), JSON.stringify(extra)).toBe('FN010');
    }
    const id = uuid();
    await as(A, alice, (db) => db.financeExpense.create({ data: { id, ...base } }));
    const set = (data: Prisma.FinanceExpenseUpdateManyMutationInput) => outcome(as(A, alice, (db) => db.financeExpense.updateMany({ where: { id }, data })));
    expect(await set({ voidReason: 'x' })).toBe('FN010');
    expect(await set({ recordedAt: BACKDATE })).toBe('FN010');
    const discard = uuid();
    await as(A, alice, (db) => db.financeExpense.create({ data: { id: discard, ...base } }));
    expect(await outcome(as(A, alice, (db) => db.financeExpense.updateMany({ where: { id: discard }, data: { status: 'VOID', recordedAt: BACKDATE } })))).toBe('FN010');
    expect(await set({ status: 'RECORDED', recordedAt: BACKDATE })).toBe('ok');
    expect(recent((await admin.query(`SELECT recorded_at FROM finance_expenses WHERE id = $1`, [id])).rows[0].recorded_at)).toBe(true);
    expect(await set({ voidReason: 'Duplicate' })).toBe('FN010');
    expect(await set({ voidedAt: BACKDATE })).toBe('FN010');
    expect(await set({ status: 'VOID', voidedAt: BACKDATE, voidReason: 'Duplicate' })).toBe('ok');
    const row = (await admin.query(`SELECT voided_at, void_reason FROM finance_expenses WHERE id = $1`, [id])).rows[0];
    expect([recent(row.voided_at), row.void_reason]).toEqual([true, 'Duplicate']);
    for (const data of [{ voidReason: 'Other' }, { voidReason: null }, { voidedAt: BACKDATE }, { voidedAt: null }]) {
      expect(await set(data), JSON.stringify(data)).toBe('FN010');
    }
  });
});

describe('R: reporting semantics (docs/finance-data-model.md §9), per currency, no conversion', () => {
  it('R1: invoiced revenue, collected cash, receivables, overdue, expenses and recorded-cost project margin', async () => {
    const asOf = new Date(Date.UTC(2031, 2, 1));
    const jan = new Date(Date.UTC(2031, 0, 10));
    const inC = <T>(work: (db: Db) => Promise<T>) => as(C, carl, work);
    const issueC = (o: DraftIn & { due: Date; lines: LineIn[] }) => inC(async (db) => {
      const id = await createDraft(db, C, { customerId: custC, ...o });
      await issue(db, id, { issueDate: jan, dueDate: o.due });
      return id;
    });
    // USD: an overdue invoice with tax, a future one, a void one and a credit note; EUR: one project invoice.
    const inv1 = await issueC({ projectId: projC, due: new Date(Date.UTC(2031, 1, 1)), lines: [{ qty: '1', price: '100', taxPct: '10', taxName: 'Tax' }] });
    await issueC({ due: new Date(Date.UTC(2031, 5, 1)), lines: [{ qty: '2', price: '100' }] });
    const voided = await issueC({ due: new Date(Date.UTC(2031, 1, 1)), lines: [{ qty: '1', price: '50' }] });
    await inC((db) => db.financeDocument.updateMany({ where: { id: voided }, data: { status: 'VOID', voidedAt: new Date() } }));
    await issueC({ kind: 'CREDIT_NOTE', creditedInvoiceId: inv1, projectId: projC, due: jan, lines: [{ qty: '1', price: '20', taxPct: '10', taxName: 'Tax' }] });
    const inv4 = await issueC({ currency: 'EUR', projectId: projC, due: new Date(Date.UTC(2031, 5, 1)), lines: [{ qty: '1', price: '300' }] });
    const pUsd = await inC((db) => recordPayment(db, C, { amount: '60', customerId: custC, receivedOn: jan }));
    await allocate(pUsd, [{ invoiceId: inv1, amount: '60' }], C);
    const bounced = await inC((db) => recordPayment(db, C, { amount: '30', customerId: custC, receivedOn: jan }));
    await inC((db) => db.financePayment.updateMany({ where: { id: bounced }, data: { status: 'REVERSED', reversedAt: new Date() } }));
    const pEur = await inC((db) => recordPayment(db, C, { amount: '100', customerId: custC, currency: 'EUR', receivedOn: jan }));
    await allocate(pEur, [{ invoiceId: inv4, amount: '100' }], C);
    for (const [currency, amount, tax] of [['USD', '33', '3'], ['EUR', '50', '0']] as const) {
      const id = uuid();
      await inC((db) => db.financeExpense.create({ data: { id, businessId: C, categoryId: catC, projectId: projC, description: 'Materials', incurredOn: jan, currencyCode: currency, currencyScale: 2, amount, taxAmount: tax } }));
      await inC((db) => db.financeExpense.updateMany({ where: { id }, data: { status: 'RECORDED' } }));
    }

    // The report definitions, as bos_app under RLS. Period: January 2031. As-of date for balances: 1 March 2031.
    const from = new Date(Date.UTC(2031, 0, 1)), to = new Date(Date.UTC(2031, 1, 1));
    const rows = await inC((db) => db.$queryRaw<{ currency: string; revenue: string; cash: string; receivable: string; overdue: string; expenses: string; margin: string }[]>`
      WITH cur AS (SELECT DISTINCT currency_code AS c FROM finance_documents UNION SELECT DISTINCT currency_code FROM finance_expenses),
      revenue AS (SELECT currency_code AS c, sum(CASE kind WHEN 'INVOICE' THEN subtotal ELSE -subtotal END) AS v FROM finance_documents
                  WHERE kind IN ('INVOICE', 'CREDIT_NOTE') AND status = 'ISSUED' AND issue_date >= ${from}::date AND issue_date < ${to}::date GROUP BY 1),
      cash AS (SELECT currency_code AS c, sum(amount) AS v FROM finance_payments
               WHERE status = 'RECORDED' AND received_on >= ${from}::date AND received_on < ${to}::date GROUP BY 1),
      open AS (SELECT currency_code AS c, sum(total - allocated_total) AS v, sum(total - allocated_total) FILTER (WHERE due_date < ${asOf}::date) AS o
               FROM finance_documents WHERE kind = 'INVOICE' AND status = 'ISSUED' AND issue_date <= ${asOf}::date GROUP BY 1),
      spent AS (SELECT currency_code AS c, sum(amount - tax_amount) AS v FROM finance_expenses
                WHERE status = 'RECORDED' AND incurred_on >= ${from}::date AND incurred_on < ${to}::date GROUP BY 1),
      margin AS (SELECT c, sum(v) AS v FROM (
                   SELECT currency_code AS c, CASE kind WHEN 'INVOICE' THEN subtotal ELSE -subtotal END AS v FROM finance_documents
                   WHERE project_id = ${projC}::uuid AND kind IN ('INVOICE', 'CREDIT_NOTE') AND status = 'ISSUED'
                   UNION ALL
                   SELECT currency_code, -(amount - tax_amount) FROM finance_expenses WHERE project_id = ${projC}::uuid AND status = 'RECORDED') m GROUP BY 1)
      SELECT cur.c AS currency, coalesce(revenue.v, 0)::text AS revenue, coalesce(cash.v, 0)::text AS cash, coalesce(open.v, 0)::text AS receivable,
             coalesce(open.o, 0)::text AS overdue, coalesce(spent.v, 0)::text AS expenses, coalesce(margin.v, 0)::text AS margin
      FROM cur LEFT JOIN revenue USING (c) LEFT JOIN cash USING (c) LEFT JOIN open USING (c) LEFT JOIN spent USING (c) LEFT JOIN margin USING (c) ORDER BY 1`);
    const num = (r: (typeof rows)[number]) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'currency' ? v : Number(v)]));
    expect(rows.map(num)).toEqual([
      { currency: 'EUR', revenue: 300, cash: 100, receivable: 200, overdue: 0, expenses: 50, margin: 250 },
      // revenue 100 + 200 − 20 (credit note), the void invoice excluded; the bounced payment excluded;
      // receivables 110 − 60 + 200 (credit applications are F2, see §9); overdue: only inv1.
      { currency: 'USD', revenue: 280, cash: 60, receivable: 250, overdue: 50, expenses: 30, margin: 50 },
    ]);
  });
});

describe('Z: reconciliation', () => {
  it('Z1: after everything above, every settlement counter equals the sum of its live allocations', async () => {
    const docs = await admin.query(`SELECT count(*)::int AS n FROM finance_documents d
      WHERE d.allocated_total <> coalesce((SELECT sum(a.amount) FROM finance_payment_allocations a
        WHERE a.business_id = d.business_id AND a.invoice_id = d.id AND a.reversed_at IS NULL), 0)`);
    const pays = await admin.query(`SELECT count(*)::int AS n FROM finance_payments p
      WHERE p.allocated_total <> coalesce((SELECT sum(a.amount) FROM finance_payment_allocations a
        WHERE a.business_id = p.business_id AND a.payment_id = p.id AND a.reversed_at IS NULL), 0)`);
    expect([docs.rows[0].n, pays.rows[0].n]).toEqual([0, 0]);
    const gaps = await admin.query(`SELECT business_id, kind, count(*)::int AS n, max(number_value)::int AS hi, min(number_value)::int AS lo
      FROM finance_documents WHERE number_value IS NOT NULL GROUP BY 1, 2`);
    for (const g of gaps.rows) expect(g.hi - g.lo + 1, `${g.kind}`).toBe(g.n);
  });
});
