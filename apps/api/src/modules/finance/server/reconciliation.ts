import 'server-only';
// On-demand reconciliation (docs/finance-data-model.md §10 item 6, §18.5). Read-only by construction:
// one SELECT statement, so every check reads the same snapshot (no false positives from concurrent
// writes between checks, even under READ COMMITTED), and nothing is written, not even an audit row.
//
// It recomputes what the database already enforces (counters equal live links, settlement within
// totals, gapless series, unchanged content hashes) and reports every difference with the record and
// the expected and stored values. A difference means something bypassed the guards (an
// administrative fix, a disabled trigger, a bad migration) and needs a person; nothing is repaired.
//
// Safe for later scheduled execution: it takes no locks beyond MVCC reads, is bounded per business,
// needs only SELECT and EXECUTE on finance_content_hash, and runs inside any tenant unit of work (for
// example as bos_app per business, or a future read-only job role). No scheduler is added here.
import type { AppTenantDb } from '@/core/db';

export const RECONCILIATION_CHECKS = [
  'payment_allocated_total', 'invoice_allocated_total', 'credit_applied_total', 'invoice_settlement', 'payment_settlement',
  'credit_note_settlement', 'live_link_state', 'duplicate_live_allocation', 'duplicate_live_credit_application', 'credit_note_cap',
  'numbering_series', 'content_hash',
] as const;
type Check = (typeof RECONCILIATION_CHECKS)[number];
type RecordType = 'payment' | 'document' | 'allocation' | 'credit_application' | 'number_series';

const LIMIT = 500;

type Row = { kind: 'checked' | 'issue'; check: Check; record_type: RecordType | null; record_id: string | null; expected: string | null; actual: string | null; detail: string | null; n: number };

export async function runReconciliation(db: AppTenantDb) {
  const rows = await db.$queryRaw<Row[]>`
    WITH b AS (SELECT nullif(current_setting('app.business_id', true), '')::uuid AS id),
    pay AS (SELECT p.* FROM finance_payments p, b WHERE p.business_id = b.id),
    doc AS (SELECT d.* FROM finance_documents d, b WHERE d.business_id = b.id),
    alloc AS (SELECT a.* FROM finance_payment_allocations a, b WHERE a.business_id = b.id),
    appl AS (SELECT c.* FROM finance_credit_applications c, b WHERE c.business_id = b.id),
    series AS (SELECT s.* FROM finance_number_series s, b WHERE s.business_id = b.id),
    live_alloc_by_pay AS (SELECT payment_id, sum(amount) AS s FROM alloc WHERE reversed_at IS NULL GROUP BY payment_id),
    live_alloc_by_inv AS (SELECT invoice_id, sum(amount) AS s FROM alloc WHERE reversed_at IS NULL GROUP BY invoice_id),
    live_appl_by_doc AS (
      SELECT id, sum(s) AS s FROM (
        SELECT credit_note_id AS id, amount AS s FROM appl WHERE reversed_at IS NULL
        UNION ALL SELECT invoice_id, amount FROM appl WHERE reversed_at IS NULL) x GROUP BY id),
    issues AS (
      SELECT 'payment_allocated_total' AS chk, 'payment' AS rt, p.id::text AS rid, coalesce(l.s, 0)::text AS expected, p.allocated_total::text AS actual,
             'payment allocated_total differs from the sum of its live allocations' AS detail
        FROM pay p LEFT JOIN live_alloc_by_pay l ON l.payment_id = p.id WHERE p.allocated_total <> coalesce(l.s, 0)
      UNION ALL
      SELECT 'invoice_allocated_total', 'document', d.id::text, coalesce(l.s, 0)::text, d.allocated_total::text,
             'document allocated_total differs from the sum of its live allocations'
        FROM doc d LEFT JOIN live_alloc_by_inv l ON l.invoice_id = d.id WHERE d.allocated_total <> coalesce(l.s, 0)
      UNION ALL
      SELECT 'credit_applied_total', 'document', d.id::text, coalesce(l.s, 0)::text, d.credit_applied_total::text,
             'document credit_applied_total differs from the sum of its live credit applications'
        FROM doc d LEFT JOIN live_appl_by_doc l ON l.id = d.id WHERE d.credit_applied_total <> coalesce(l.s, 0)
      UNION ALL
      SELECT 'invoice_settlement', 'document', d.id::text, d.total::text, (d.allocated_total + d.credit_applied_total)::text,
             CASE WHEN d.status <> 'ISSUED' THEN 'an invoice that is not issued holds settlement'
                  ELSE 'payments and credit applied exceed the invoice total' END
        FROM doc d WHERE d.kind = 'INVOICE'
         AND (d.allocated_total + d.credit_applied_total > d.total OR (d.status <> 'ISSUED' AND d.allocated_total + d.credit_applied_total <> 0))
      UNION ALL
      SELECT 'payment_settlement', 'payment', p.id::text, CASE WHEN p.status = 'REVERSED' THEN '0' ELSE p.amount::text END, p.allocated_total::text,
             CASE WHEN p.status = 'REVERSED' THEN 'a reversed payment holds allocations' ELSE 'allocations exceed the payment amount' END
        FROM pay p WHERE p.allocated_total > p.amount OR (p.status = 'REVERSED' AND p.allocated_total <> 0)
      UNION ALL
      SELECT 'credit_note_settlement', 'document', d.id::text, CASE WHEN d.status = 'ISSUED' THEN d.total::text ELSE '0' END, d.credit_applied_total::text,
             CASE WHEN d.kind = 'QUOTE' THEN 'a quote holds applied credit'
                  WHEN d.status <> 'ISSUED' THEN 'a credit note that is not issued has applied credit'
                  ELSE 'applied credit exceeds the credit note total' END
        FROM doc d WHERE d.kind <> 'INVOICE'
         AND (d.credit_applied_total > d.total OR (d.status <> 'ISSUED' AND d.credit_applied_total <> 0) OR (d.kind = 'QUOTE' AND d.credit_applied_total <> 0))
      UNION ALL
      SELECT 'live_link_state', 'allocation', a.id::text, 'recorded payment, issued invoice', coalesce(p.status::text, 'missing') || ', ' || coalesce(d.status::text, 'missing'),
             'a live allocation links a payment or invoice that is no longer open'
        FROM alloc a LEFT JOIN pay p ON p.id = a.payment_id LEFT JOIN doc d ON d.id = a.invoice_id
       WHERE a.reversed_at IS NULL AND (p.status IS DISTINCT FROM 'RECORDED' OR d.status IS DISTINCT FROM 'ISSUED')
      UNION ALL
      SELECT 'live_link_state', 'credit_application', c.id::text, 'issued credit note, issued invoice', coalesce(cn.status::text, 'missing') || ', ' || coalesce(d.status::text, 'missing'),
             'a live credit application links a document that is not issued'
        FROM appl c LEFT JOIN doc cn ON cn.id = c.credit_note_id LEFT JOIN doc d ON d.id = c.invoice_id
       WHERE c.reversed_at IS NULL AND (cn.status IS DISTINCT FROM 'ISSUED' OR d.status IS DISTINCT FROM 'ISSUED')
      UNION ALL
      SELECT 'duplicate_live_allocation', 'payment', a.payment_id::text, '1', count(*)::text,
             'more than one live allocation between payment and invoice ' || a.invoice_id::text
        FROM alloc a WHERE a.reversed_at IS NULL GROUP BY a.payment_id, a.invoice_id HAVING count(*) > 1
      UNION ALL
      SELECT 'duplicate_live_credit_application', 'document', c.credit_note_id::text, '1', count(*)::text,
             'more than one live credit application between credit note and invoice ' || c.invoice_id::text
        FROM appl c WHERE c.reversed_at IS NULL GROUP BY c.credit_note_id, c.invoice_id HAVING count(*) > 1
      UNION ALL
      SELECT 'credit_note_cap', 'document', i.id::text, i.total::text, sum(c.total)::text, 'issued credit notes exceed the invoice they credit'
        FROM doc i JOIN doc c ON c.credited_invoice_id = i.id AND c.kind = 'CREDIT_NOTE' AND c.status = 'ISSUED'
       WHERE i.kind = 'INVOICE' GROUP BY i.id, i.total HAVING sum(c.total) > i.total
      UNION ALL
      -- A series has issued exactly next_value - starting_value numbers: starting_value .. next_value - 1, each once.
      SELECT 'numbering_series', 'number_series', s.id::text, (s.next_value - s.starting_value)::text || ' numbers from ' || s.starting_value::text,
             count(d.id)::text || ' numbered, ' || count(DISTINCT d.number_value)::text || ' distinct, range ' || coalesce(min(d.number_value)::text, '-') || '..' || coalesce(max(d.number_value)::text, '-'),
             'the series counter and its numbered documents disagree (gap, duplicate or out of range)'
        FROM series s LEFT JOIN doc d ON d.kind = s.kind AND d.number_value IS NOT NULL
       GROUP BY s.id, s.next_value, s.starting_value
      HAVING count(d.id) <> s.next_value - s.starting_value OR count(DISTINCT d.number_value) <> count(d.id)
          OR coalesce(min(d.number_value), s.starting_value) < s.starting_value OR coalesce(max(d.number_value), s.next_value - 1) > s.next_value - 1
      UNION ALL
      SELECT 'numbering_series', 'document', d.id::text, 'a series for ' || d.kind::text, 'none', 'a numbered document has no numbering series'
        FROM doc d WHERE d.number_value IS NOT NULL AND NOT EXISTS (SELECT 1 FROM series s WHERE s.kind = d.kind)
      UNION ALL
      SELECT 'content_hash', 'document', d.id::text, public.finance_content_hash(d), d.content_sha256,
             'the stored content hash does not match the document content'
        FROM finance_documents d, b WHERE d.business_id = b.id AND d.content_sha256 IS NOT NULL AND d.content_sha256 <> public.finance_content_hash(d)
    ),
    checked AS (
      SELECT 'payment_allocated_total' AS chk, (SELECT count(*) FROM pay) AS n
      UNION ALL SELECT 'invoice_allocated_total', (SELECT count(*) FROM doc)
      UNION ALL SELECT 'credit_applied_total', (SELECT count(*) FROM doc)
      UNION ALL SELECT 'invoice_settlement', (SELECT count(*) FROM doc WHERE kind = 'INVOICE')
      UNION ALL SELECT 'payment_settlement', (SELECT count(*) FROM pay)
      UNION ALL SELECT 'credit_note_settlement', (SELECT count(*) FROM doc WHERE kind <> 'INVOICE')
      UNION ALL SELECT 'live_link_state', (SELECT count(*) FROM alloc WHERE reversed_at IS NULL) + (SELECT count(*) FROM appl WHERE reversed_at IS NULL)
      UNION ALL SELECT 'duplicate_live_allocation', (SELECT count(*) FROM alloc WHERE reversed_at IS NULL)
      UNION ALL SELECT 'duplicate_live_credit_application', (SELECT count(*) FROM appl WHERE reversed_at IS NULL)
      UNION ALL SELECT 'credit_note_cap', (SELECT count(*) FROM doc WHERE kind = 'INVOICE' AND status = 'ISSUED')
      UNION ALL SELECT 'numbering_series', (SELECT count(*) FROM series)
      UNION ALL SELECT 'content_hash', (SELECT count(*) FROM doc WHERE content_sha256 IS NOT NULL)
    ),
    counted AS (SELECT chk, count(*)::int AS n FROM issues GROUP BY chk)
    SELECT 'checked' AS kind, c.chk AS "check", NULL AS record_type, NULL AS record_id, NULL AS expected, NULL AS actual, NULL AS detail,
           (c.n)::int AS n FROM checked c
    UNION ALL
    SELECT 'counted', k.chk, NULL, NULL, NULL, NULL, NULL, k.n FROM counted k
    UNION ALL
    (SELECT 'issue', i.chk, i.rt, i.rid, i.expected, i.actual, i.detail, 0 FROM issues i ORDER BY i.chk, i.rid LIMIT ${LIMIT + 1})`;

  const checkedBy = new Map<string, number>();
  const issuesBy = new Map<string, number>();
  const discrepancies = [];
  for (const r of rows as (Row | (Omit<Row, 'kind'> & { kind: 'counted' }))[]) {
    if (r.kind === 'checked') checkedBy.set(r.check, Number(r.n));
    else if (r.kind === 'counted') issuesBy.set(r.check, Number(r.n));
    else discrepancies.push({ check: r.check, recordType: r.record_type!, recordId: r.record_id!, expected: r.expected, actual: r.actual, detail: r.detail! });
  }
  const total = [...issuesBy.values()].reduce((a, b) => a + b, 0);
  return {
    ok: total === 0,
    checkedAt: new Date().toISOString(),
    checks: RECONCILIATION_CHECKS.map((check) => ({ check, checked: checkedBy.get(check) ?? 0, discrepancies: issuesBy.get(check) ?? 0 })),
    discrepancies: discrepancies.slice(0, LIMIT),
    truncated: total > LIMIT,
  };
}
