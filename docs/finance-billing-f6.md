# Finance F6: Automated billing and receivables

Status: **plan and audit (v1, 2026-11-15)**. Built on recommended defaults; none of the owner
decisions in §6 are approved yet. Nothing here is merged, deployed or applied to production.

F6 adds recurring invoices (F6A), payment reminders (F6B) and customer statements with receivables
ageing (F6C) on top of F1-F5, C1 and C2-A. It reuses the existing invoice service, money rules,
numbering, settlement projections and (once merged) F5's PDF renderer. It adds no provider
integration and sends nothing.

## 1. Audit findings (main at 4f2d437, F5 PR #42 at a958c20)

| Area | What exists | What F6 does with it |
|---|---|---|
| Invoices | `createInvoice` / `updateDraft` / `issueDocument` (`finance/server/documents.ts`): exact decimal pricing, tax only from the business's tax rates, idempotency keys with a transaction advisory lock, document lock order, DB guard triggers. **Numbers are taken only at issue** (gapless series, FD-L1). | Recurring generation calls the same draft-creation path with a deterministic idempotency key. A draft never has a number, so a failed or repeated run can never consume one. |
| Settlement | `allocated_total` and `credit_applied_total` are DB-maintained counters; `settlementStateOf`, `listCustomerBalances`, `invoiceReceivables` derive balances from them. | Reminder eligibility and AR ageing reuse the same formula (`total − allocated − credit_applied`). Nothing new is stored. |
| Statements | No statement or as-of-date view. Payment allocations and credit applications carry `created_at`/`reversed_at`; documents carry `issue_date`, `voided_at`; payments `received_on`, `reversed_at`. | Statements are computed from these records (§4). |
| Documents (F5, open) | `issueWithOriginal`, `pdf/render.ts`, `document_pdf_versions` (bytea), branding, audited downloads. Migration `20261122000000_finance_documents`. | Statement PDFs reuse the renderer and branding. Automatic issue of generated invoices must go through `issueWithOriginal`. Both wait for F5 to merge. |
| Communications | C1: activity timeline, immutable messages. C2-A (merged, migration **not** in production): mail connections, encrypted credentials, `mail_sync_jobs` lease pattern. **No outbound sending exists**; C2-C is unbuilt. C2 never shows "delivered", because Gmail and Graph never confirm delivery (D-C2-13). `core/email` (Resend) is for Business OS's own mail only. | Reminders cannot be sent until C2-C exists. F6B builds policies, schedules, eligibility, suppression and the reminder record, and stops at "ready to send". |
| Jobs | **No scheduler exists.** Architecture §9: platform cron → internal route, `bos_jobs` is purge-only, "no scheduler without approval". C2-B proposes Vercel Cron + an `app_private` dispatcher function, not built. | F6 needs the first business-data scheduler. Proposed design in §5; it needs a new privileged SQL file and a cron secret, so it is an owner decision (D-F6-1). |
| Audit | `audit_tenant_write` requires `actor_user_id = session user`; C2-A added `audit_system_write` for `communications.system.*` only. | System-run generation needs a matching additive policy for `finance.system.*` (D-F6-2). |
| Permissions | `finance:read/write/issue/payments/expenses/manage`; MANAGER has read, write, expenses. | One new key, `finance:billing` (§6, D-F6-3). |
| Migrations | Newest on main `20261121000000`. F5 PR #42 **and** Reporting R1 PR #43 both use `20261122000000` (collision to resolve between those two). | F6 uses `20261126000000_finance_billing`, which sorts after all of them. |

## 2. PR boundaries (recommended)

| PR | Scope | Depends on | Testable now |
|---|---|---|---|
| **F6-1** Recurring billing + scheduler foundation | Templates, schedules, runs, generation into drafts, preview, pause/resume/cancel, history; the cron route and dispatcher; Finance UI. | main only | Yes, fully |
| **F6-2** Statements and receivables | Statement and ageing computations, API, UI, statement audit. PDF statements behind F5. | main for data; F5 for PDF | Data yes; PDF after F5 merges |
| **F6-3** Payment reminders | Policies, stages, exclusions, suppression, reminder schedule, pre-dispatch balance check, reminder history. Dispatch adapter to C2-C. | main for policy/schedule; C2-C for sending | Up to "ready to send"; sending after C2-C |

Optional later: automatic issue of generated invoices (needs F5 + owner approval) and automatic
reminder sending (needs C2-C + owner approval).

## 3. F6A design (as implemented in F6-1)

- `finance_recurring_templates`: name, customer, optional contact and project, currency, notes,
  payment terms (null = Finance settings default), lines as jsonb (same shape as draft lines; tax
  rates and references are re-validated every time a draft is generated), frequency (`WEEKLY |
  MONTHLY | QUARTERLY | ANNUAL`) with an interval count, start date, optional end date, billing time
  zone (default: the business's), `next_period_index`, `next_run_on`, status `ACTIVE | PAUSED |
  CANCELLED | ENDED`, version.
- Calendar rules: period *n* is computed from the start date, never from the previous period, so
  clamping never drifts (31 Jan → 28/29 Feb → 31 Mar). Monthly/quarterly/annual clamp to the last
  day of shorter months; weekly adds 7 × interval days. A period is due when its date ≤ today in
  the template's billing zone.
- `finance_recurring_runs`: one row per (template, period index), **unique**. Status `PENDING →
  RUNNING → GENERATED | FAILED | SKIPPED` (FAILED → PENDING on retry), attempts / max attempts,
  lease id and expiry, `run_after` for backoff, stable error code, and the generated draft
  (`document_id`, unique, composite FK to an INVOICE of the same business). The unique keys are the
  idempotency safeguard; the draft insert and the run's `GENERATED` update commit in one
  transaction, and the draft carries the system idempotency key `system recurring <template>:<n>`
  (a space, which client keys cannot contain).
- Output is a **draft** invoice. Drafts have no number (numbers are assigned only at issue), so a
  failed or repeated run can never consume or skip an invoice number. Generated, issued and sent are
  separate facts shown separately; F6-1 never issues or sends.
- Failures: rule errors (archived customer, archived tax rate, invalid lines) fail the run at once
  with a stable code and wait for a person (Retry or Skip). Unexpected errors roll back the whole
  transaction and return the run to PENDING with backoff (1 min × 4^(n−1), capped at 6 h) up to
  `max_attempts` (5). The template stays ACTIVE either way.
- Pause / resume: pausing skips every period that was planned but not yet generated
  (`template_paused`), and while paused nothing is planned or generated. Resume continues from the
  first period on or after today; periods before or inside the pause are never billed afterwards,
  so a resume can't produce catch-up drafts (D-F6-12, confirmed by the owner). FAILED periods stay
  failed and only run again if a person presses Retry. Cancel skips every
  waiting or failed run (`template_cancelled`) and is final. Drafts already generated never change.
- "Generate next draft now" (person action) creates the next period's draft immediately, as that
  person, in one transaction, and advances the schedule.
- Database guards (bos_app cannot bypass them): identity fields fixed, `next_period_index` never
  decreases, the schedule (frequency, interval, start, zone) is fixed once any run exists, status
  transitions are whitelisted, CANCELLED and ENDED are final, a GENERATED run must point at a draft
  invoice of the template's customer and currency, attempts never decrease, no DELETE on either
  table. SQLSTATEs FN030–FN033.

## 4. F6C design (as implemented in F6-2)

F6-2 adds customer statements and accounts-receivable ageing as of a date. It is read-only: no
migration, no table, no stored balance and no second ledger. Every figure is computed on request from
the F1–F3 records (`finance_documents`, `finance_payments`, `finance_payment_allocations`,
`finance_credit_applications`), loaded in **one SQL statement** (one snapshot) by
`finance/server/statements.ts`, and the pure functions in `finance/server/receivables-core.ts`. It
changes nothing in F1–F5 or F6-1, sends nothing, and has no reminders, delivery states or schedule.

### 4.1 Effective dates

A record is in effect on calendar day D when `start ≤ D` and (`end` is null or `end > D`), in the
business's time zone:

| Record | start | end |
|---|---|---|
| Invoice / credit note (numbered only; discarded drafts never appear) | `issue_date` | void: `max(date(voided_at), issue_date)` |
| Payment received (`direction = RECEIVED`) | `received_on` | reversal: `max(date(reversed_at), received_on)` |
| Payment allocation | `max(date(created_at), payment received_on, invoice issue_date)` | `max(date(reversed_at), payment received_on, invoice issue_date)` |
| Credit application | `max(date(created_at), credit note issue_date, invoice issue_date)` | `max(date(reversed_at), credit note issue_date, invoice issue_date)` |

`date(t)` is `(t AT TIME ZONE business.time_zone)::date`. The "never before" rule guarantees that every
allocation or application in effect links a payment, credit note and invoice that are themselves in
effect. Together with the existing guards (an invoice can be voided only with no live allocations or
credit, a credit note only with nothing applied, and reversing a payment reverses its allocations in the
same instant), this makes the reconciliation below an identity on every day.

### 4.2 Statement (D-F6-10)

`GET /finance/statements?customerId&currencyCode&from&to` (inclusive range, `to` ≤ today). Account
events: invoice issued (+total), credit note issued (−total), payment received (−amount), and each void
or reversal as an offsetting entry on its own effective date. Allocations and credit applications are
never entries and never move the balance. Opening balance = Σ events before `from`; closing = opening +
Σ entries in range. Events after `to` never reach the statement. Within one day: invoices, credit notes,
payments, then reversals and voids. One currency per statement, never converted. The response also
carries the **position** at the end of `to` (aged buckets, unallocated payments, unapplied credit,
`balanced`). More than 2,000 entries is refused (`409 statement_too_large`).

### 4.3 Ageing (D-F6-11)

`GET /finance/receivables-ageing?asOf&currencyCode&customerId&cursor&limit` (`asOf` defaults to today,
may not be after it): per customer and currency, open invoice balances in **Current, 1–30, 31–60, 61–90,
90+ days past due**, plus **No due date** (see 4.6), with unallocated payments and unapplied credit
beside them, never netted into a bucket. Totals per currency cover every customer (not paginated); rows
are keyset-paginated with a cursor bound to `asOf`. `GET /finance/receivables-ageing/detail` lists each
open invoice (total, paid, credited, outstanding, days past due, bucket) and each credit separately.
Outstanding = total − allocations in effect − credit applications in effect: the F2/F4 formula, applied
to dated links instead of today's counters. Overdue = due date before the date, so due today is Current,
as in F4 and R1.

Reconciliation, per customer and currency and in the totals: `accountBalance` (Σ account events up to
the date) = `receivable − unallocatedPayments − unappliedCredit`, returned as `balanced` (logged without
amounts if it ever fails; the interface warns not to rely on the figures). As of today the ageing totals
equal the Finance overview receivables (`invoiceReceivables`), and so R1's `finance.receivables_outstanding`
and `finance.receivables_overdue` metrics, for every invoice not issued with a future date (tested).
R1's registry is unchanged: its receivables metrics stay today-only snapshots.

### 4.4 PDF and audit (D-F6-9)

`GET /finance/statements/pdf?…` (same query) renders the statement on demand with the F5 template's
fonts, margins, footer and branding (`pdf/statement.ts`, template `statement-standard@1`) and never
stores it. Seller details are the current Finance settings and the customer's current billing details
(a statement is not a sealed document). Characters the fonts cannot draw print as □ and are flagged
(`X-Unsupported-Characters`), as in F5. Each download is audited as
`finance.statement_pdf.downloaded` (target: the customer) with `currencyCode`, `from`, `to`,
`fileSha256` of the bytes served and the template id. Never amounts, entries or customer details.

### 4.5 Access and interface

Statements and ageing: `finance:read` (OWNER, ADMIN, MANAGER; D-F6-3). PDF: `finance:documents_download`,
the F5 download rule (MANAGER allowed, D3). All through the API under the existing tenant context and RLS;
another business's customer is `404`. No client database access, no Tauri capability. The Finance Zone
has a **Receivables** section (ageing with drill-down and a Statement action per row) and a statement
screen; the customer page's Finance panel has a Statement action per currency.

### 4.6 Ambiguities found in the existing code, and how F6-2 treats them

1. **Voids, reversals, allocations and applications have no business date**, only database timestamps
   stamped by triggers. They are dated in the business's *current* time zone; if the zone is changed
   later, past timestamps re-date.
2. **Effective time, not knowledge time.** Issue dates can be set in the future (no check refuses it) and
   documents and payments can be back-dated. "As of" follows the dates on the records (D-F6-10), so a
   back-dated record changes a statement that was produced earlier. Reproducing "as known at the time"
   would need knowledge-time data and is not built.
3. **The "never before the linked records" rule (4.1)** is F6-2's own choice, not an earlier decision.
   Without it a future-dated invoice could show payments before it exists and the reconciliation would
   not hold.
4. A payment received on 1 March but allocated on 10 March is, as of 5 March, **unallocated credit**, and
   the invoice is still fully open. The account balance is the same either way.
5. **Conflict with the brief ("include invoices with a due date")**: F1 allows issued invoices without a
   due date and F4/R1 count them as outstanding, never overdue. Excluding them would break the
   reconciliation, so they are shown in a separate **No due date** column, inside the receivable total
   and outside every aged bucket.
6. **Future-dated invoices**: as of today they are not yet in effect, so ageing as of today can differ
   from the F2/F4 counters (and R1) by exactly those invoices.
7. **PDF hash**: F5 audits a stored file's recorded hash; a statement is never stored, so the audit carries
   the hash of the bytes actually served (renders differ per request because the PDF records its
   creation time).

## 5. Scheduler (implemented; inactive until the owner turns it on, §8)

`GET /api/internal/jobs/finance-billing` with `Authorization: Bearer $CRON_SECRET` (Vercel Cron's
format; SHA-256 digests compared in constant time; 503 when the secret is unset, 401 when wrong). It
calls `app_private.finance_billing_due(limit)`, a SECURITY DEFINER function owned by `bos_definer`
that returns only `business_id`s: businesses with an ACTIVE template whose next date is due in its
own zone, a due PENDING run, or a RUNNING run whose lease expired. `bos_definer` can read only five
columns of each table, through row policies limited to those statuses; EXECUTE is granted to
`bos_app` only. For each business the worker opens `withTenant({ businessId, userId: null })` as
`bos_app` (RLS applies), plans due periods in bounded batches (20 templates per batch, each batch its own short
transaction, one `INSERT … SELECT unnest … ON CONFLICT DO NOTHING` per template, `FOR NO KEY UPDATE
SKIP LOCKED`; at most 12 periods per template per pass across all batches, and at most 25 batches), then claims runs one at a time with `FOR UPDATE SKIP
LOCKED` and a 120 s lease, and executes each in its own transaction. Execution checks the lease is
still held; a worker that lost it changes nothing. Expired leases are reclaimed by the next pass;
a run whose attempts are used up fails with `lease_expired`. The pass stops at a 45 s budget and
returns counts only (no tenant data). System-made drafts and transitions are audited as
`finance.system.*` with no actor, allowed by the additive `audit_finance_system_write` policy.

## 6. Owner decisions (recommended defaults; the owner supported them on 2026-11-15, with the D-F6-12 clarification that a resume must not produce catch-up invoices)

| # | Decision | Recommended default |
|---|---|---|
| D-F6-1 | Introduce the first scheduler | Vercel Cron every 15 minutes, internal route with `CRON_SECRET`, one privileged `app_private` "due businesses" function, worker as `bos_app` with no session user |
| D-F6-2 | Who generated drafts are "by" | The system (no user), with `finance.system.*` audit events and the template's approver recorded; an additive audit policy like C2-A's |
| D-F6-3 | Permissions | New `finance:billing` for OWNER/ADMIN: manage recurring templates and reminder policies. MANAGER and others with `finance:read` view templates, runs, statements and ageing; statement PDF download follows F5's D3 (MANAGER allowed) |
| D-F6-4 | Automatic issue | Off. Generation makes drafts only. Auto-issue is a later, per-template opt-in after F5 merges |
| D-F6-5 | Missed periods (worker down) | Generate each missed period once, oldest first, at most 12 per template per pass (the rest on later passes); never skip silently |
| D-F6-6 | Month-end | Keep the anchor day, clamp to the last day of shorter months |
| D-F6-7 | Due date of generated invoice | Template payment terms, else Finance settings default, else none |
| D-F6-8 | Reminder delivery | Through C2-C mailbox sending only; until then reminders stop at "ready to send". Strongest state ever shown is "accepted by provider", never "delivered" |
| D-F6-9 | Statement PDFs | Generated on demand, not stored; download audited with content hash |
| D-F6-10 | Statement basis | Balance-forward by document date in the business zone; voids and reversals as offsetting entries; one statement per currency |
| D-F6-11 | Ageing buckets | Current, 1-30, 31-60, 61-90, 90+ days past due date |
| D-F6-12 | Periods inside a pause | Not billed on resume: pausing skips planned periods, resume continues from the first period on or after today. "Generate next draft now" bills a period on purpose |

## 7. Risks

- The scheduler is new production infrastructure (privileged SQL, secret, cron). A bug could generate
  drafts for many businesses at once; drafts are harmless and discardable, which is why D-F6-4 matters.
- Production auto-deploys main before migrations (production-migrations note); F6 migrations and the
  privileged step must be applied before merge.
- Migration collision between F5 and R1 (`20261122000000`) must be resolved by whichever merges second.
- Reminders depend on C2-C, which depends on D-C2-1..14 and Google verification; F6-3 cannot send
  before then.

## 8. Activation (owner action, after approval; nothing here is done by this PR)

Order matters because production auto-deploys main (see production-migrations):

1. Approve D-F6-1 to D-F6-12 (or change them).
2. Take a Neon recovery branch (for example `pre-f6-migrations`).
3. Apply migrations in timestamp order. On main: C2-A `20261121000000`, F5 `20261122000000`,
   Reporting R1 `20261124000000` (already applied to production); C2-B1 (PR 46) will add
   `20261125000000`. F6 is `20261126000000_finance_billing`, after all of them. F6 depends on none of
   their code, only on the order.
4. Run `pnpm db:privileged` against production (applies `002_finance_billing_due.sql`; idempotent).
5. Merge and deploy. Recurring screens work at this point; nothing runs on a schedule yet.
6. To turn the scheduler on: set `CRON_SECRET` (at least 32 random characters) on the API project,
   then add to `apps/api/vercel.json`:
   `"crons": [{ "path": "/api/internal/jobs/finance-billing", "schedule": "*/15 * * * *" }]` and deploy.

Rollback: remove the cron entry (or unset `CRON_SECRET`, which makes the route answer 503) and
deploy. The tables can stay; they are inert without the worker. To fully remove before any real data:
`DROP FUNCTION app_private.finance_billing_due(integer); DROP TABLE finance_recurring_runs,
finance_recurring_templates;` plus the three trigger functions and the `audit_finance_system_write`
policy, then delete the migration row. With real data, restore from the recovery branch instead.

## 9. Operations and recovery

- **Stop all automatic generation now:** unset `CRON_SECRET` or remove the cron entry. Person actions
  in the app keep working.
- **Stop one customer's schedule:** Pause (reversible) or Cancel (final) on the schedule screen.
- **A period failed:** the schedule and the run show the reason in words. Fix the schedule (for
  example replace an archived tax rate), then Retry. Or Skip to leave the period unbilled.
- **A run is stuck RUNNING:** nothing to do; its lease expires after 120 s and the next pass reclaims
  it. Executing with a lost lease is a no-op, so two workers never both create a draft.
- **A wrong draft was generated:** it is an unnumbered draft; discard it in Invoices. The run stays
  GENERATED (the period counts as billed); use "Generate next draft now" only if a replacement for a
  later period is wanted. Re-billing the same period needs a manual invoice.
- **Check health:** `SELECT status, count(*) FROM finance_recurring_runs GROUP BY 1` (as the owner
  role); many FAILED or old PENDING rows mean the worker is off or a rule keeps failing. Audit
  events `finance.system.recurring.failed` carry the error code.
