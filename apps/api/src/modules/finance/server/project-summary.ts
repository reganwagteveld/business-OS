import 'server-only';
// Project financial summary (docs/cross-zone-workflows-wf1.md §6.6.1, D-WF1-05). Read-only and derived on
// every request from Finance's own ledger: quotes, invoices, credit notes, their database-maintained
// settlement counters, and expenses. Nothing is stored, cached or converted across currencies, so the
// figures can never disagree with the documents they come from. The route requires finance:read AND
// projects:read; a project of another business is invisible (forced RLS) and answers 404.
import type { ProjectFinanceCurrency, ProjectFinanceSummary } from '@business-os/contracts';
import { Decimal, type AppTenantDb } from '@/core/db';
import { RecordNotFoundError } from '@/core/http/errors';
import { currencyScale, formatAmount } from './money';
import type { Kind, Status } from './shared';

type Doc = {
  id: string; kind: Kind; status: Status; currencyCode: string; currencyScale: number; subtotal: Decimal; total: Decimal;
  allocatedTotal: Decimal; creditAppliedTotal: Decimal;
};
const docSelect = {
  id: true, kind: true, status: true, currencyCode: true, currencyScale: true, subtotal: true, total: true, allocatedTotal: true, creditAppliedTotal: true,
} as const;

const FIELDS = [
  'quotedNet', 'acceptedNet', 'invoicedNet', 'invoicedGross', 'creditedNet', 'creditedGross', 'billedNet', 'paymentsAllocated', 'creditApplied',
  'outstanding', 'unappliedCredit', 'expensesNet',
] as const;
type Field = (typeof FIELDS)[number];
type Sums = Record<Field, Decimal>;

const STATUSES: Status[] = ['DRAFT', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID'];
const emptyCounts = () => Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;

export async function projectFinanceSummary(db: AppTenantDb, projectId: string): Promise<{ summary: ProjectFinanceSummary }> {
  const project = await db.project.findFirst({ where: { id: projectId }, select: { id: true, sourceQuoteId: true } });
  if (!project) throw new RecordNotFoundError();

  // Q(P): the deduplicated union of quotes linked while draft (project_id = P) and the source quote.
  // One query with OR returns each row once, so a quote that is both is counted once.
  const quoteMatch: Record<string, unknown>[] = [{ projectId }];
  if (project.sourceQuoteId) quoteMatch.push({ id: project.sourceQuoteId });
  const [quotes, invoices, expenses] = await Promise.all([
    db.financeDocument.findMany({ where: { kind: 'QUOTE', OR: quoteMatch }, select: docSelect }) as Promise<Doc[]>,
    // I(P): invoices with project_id = P (after D-WF1-10 this includes drafts converted from the source quote).
    db.financeDocument.findMany({ where: { kind: 'INVOICE', projectId }, select: docSelect }) as Promise<Doc[]>,
    // E(P): expenses with project_id = P.
    db.financeExpense.findMany({ where: { projectId }, select: { status: true, currencyCode: true, subtotal: true } }),
  ]);
  // C(P): credit notes whose credited invoice is in I(P). Membership follows the credited invoice, not the
  // credit note's own copied project_id, so it cannot drift.
  const creditNotes = invoices.length === 0 ? [] : ((await db.financeDocument.findMany({
    where: { kind: 'CREDIT_NOTE', creditedInvoiceId: { in: invoices.map((i) => i.id) } }, select: docSelect,
  })) as Doc[]);

  const byCurrency = new Map<string, Sums>();
  const row = (code: string): Sums => {
    let sums = byCurrency.get(code);
    if (!sums) {
      sums = Object.fromEntries(FIELDS.map((f) => [f, new Decimal(0)])) as Sums;
      byCurrency.set(code, sums);
    }
    return sums;
  };
  const add = (sums: Sums, field: Field, value: Decimal) => { sums[field] = sums[field].add(value); };

  for (const q of quotes) {
    const sums = row(q.currencyCode);
    if (q.status === 'ISSUED' || q.status === 'ACCEPTED') add(sums, 'quotedNet', q.subtotal);
    if (q.status === 'ACCEPTED') add(sums, 'acceptedNet', q.subtotal);
  }
  for (const i of invoices) {
    const sums = row(i.currencyCode);
    if (i.status !== 'ISSUED') continue; // drafts and VOID excluded
    add(sums, 'invoicedNet', i.subtotal);
    add(sums, 'invoicedGross', i.total);
    add(sums, 'paymentsAllocated', i.allocatedTotal); // payment allocations only ("Received")
    add(sums, 'creditApplied', i.creditAppliedTotal); // credit applied to these invoices; not cash
    add(sums, 'outstanding', i.total.sub(i.allocatedTotal).sub(i.creditAppliedTotal)); // each credit subtracted once
  }
  for (const c of creditNotes) {
    const sums = row(c.currencyCode);
    if (c.status !== 'ISSUED') continue;
    add(sums, 'creditedNet', c.subtotal);
    add(sums, 'creditedGross', c.total);
    add(sums, 'unappliedCredit', c.total.sub(c.creditAppliedTotal)); // shown, never subtracted from outstanding
  }
  for (const e of expenses) {
    const sums = row(e.currencyCode);
    if (e.status === 'RECORDED') add(sums, 'expensesNet', e.subtotal as Decimal); // net of tax
  }

  const currencies: ProjectFinanceCurrency[] = [...byCurrency.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, sums]) => {
      const scale = currencyScale(code);
      sums.billedNet = sums.invoicedNet.sub(sums.creditedNet);
      const out = Object.fromEntries(FIELDS.map((f) => [f, formatAmount(sums[f], scale)])) as Record<Field, string>;
      return { currencyCode: code, currencyScale: scale, ...out };
    });

  const counts = { quotes: emptyCounts(), invoices: emptyCounts(), creditNotes: emptyCounts() };
  for (const q of quotes) counts.quotes[q.status] += 1;
  for (const i of invoices) counts.invoices[i.status] += 1;
  for (const c of creditNotes) counts.creditNotes[c.status] += 1;

  return { summary: { projectId: project.id, currencies, counts } };
}
