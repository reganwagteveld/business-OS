# Finance F4: API additions

F4 is a client release. It adds **one** endpoint to the API, documented here on its own so the audit can
review it separately from the screens. It is additive and read-only: no migration, no schema change, no new
table, column, trigger, permission key or write path, and no existing endpoint changes.

## `GET /api/v1/b/:slug/finance/receivables`

| | |
|---|---|
| Permission | `finance:read` (the same key as customer balances; no `customers:*` key needed or granted) |
| Contract | `endpoints.getReceivables`, response `InvoiceReceivablesResponse` (`packages/contracts/src/finance.ts`) |
| Service | `invoiceReceivables` in `apps/api/src/modules/finance/server/settlement.ts` |
| Route | `apps/api/src/app/api/v1/b/[slug]/finance/receivables/route.ts` (`tenantRoute`, RLS as `bos_app`) |
| Test | `apps/api/tests/integration/finance-payments.test.ts` › "F4 receivables summary (read-only)" |

**Why.** The Finance overview needs what issued invoices still have open, per currency, for the whole
business. The existing reads give it only per customer (`/customer-balances`, paginated), so the client would
have had to page through every customer and add the amounts up in the browser. The smallest correct
addition is the same calculation grouped by currency on the server, next to the existing `/expense-payables`
(F3), which is the same shape for expenses.

**What it returns.** `{ receivables: { asOf, currencies: [{ currencyCode, currencyScale, outstanding, overdue,
openCount, overdueCount, unallocatedPayments, unappliedCredit }] } }`, one row per currency, decimal strings.

- `outstanding`: Σ (`total − allocated_total − credit_applied_total`) of `ISSUED` invoices. The same counters
  and rule as `/customer-balances.receivable` (§18.4); the test asserts the two agree exactly per currency.
- `overdue` / `overdueCount`: the part due before `asOf` (today in the business's time zone).
- `unallocatedPayments`, `unappliedCredit`: reported beside `outstanding`, **never netted against it**.
- Nothing is converted or added across currencies. Drafts, void documents and reversed payments never count.
  Payments made to suppliers (direction `PAID`) are excluded.
- One SQL statement, so all figures come from one snapshot. Currencies with nothing open and no credit are
  omitted.

**What it is not.** Not cash, not revenue and not profit; not an aged-receivables report (no buckets), not an
as-of-past-date view (it uses current counters, as `/customer-balances` does), and not bank reconciliation.

## Request headers the client now sends (no API change)

The F4 client sends the existing `Idempotency-Key` header on the endpoints that already accept it: recording a
payment received or made (required since F2/F3), creating a draft quote or invoice, converting a quote and
starting a credit note (optional since F1). A retry of the same request reuses its key; any change to the
details makes a new key.

## Backend capabilities the brief asked for that would need more API (not built)

| Wanted | What exists | What it would take |
|---|---|---|
| Free-text search of quotes and invoices (number, customer name) | Filters by status, customer, dates, settlement, overdue | An optional `q` on the three document lists (additive query parameter) |
| Contact, opportunity and project pickers on documents | The API accepts `contactId`, `opportunityId`, `projectId` | Client work only (deferred to keep F4's scope) |
| Total quoted or invoiced per period, collected per period | — | The F5 reports endpoints (§9), not built |
| Receipts on expenses | Deferred by F3-D2 | Storage decision FD-P6 |
