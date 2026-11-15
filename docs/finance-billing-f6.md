# Finance F6: Automated billing and receivables

Status: **F6-1 merged** to `main` on 2026-11-15 (PR #45, `5c6ff5a`), with owner decisions in §6
supported on 2026-11-15. F6-2 (statements) and F6-3 (reminders) are not started. The scheduler stays
inactive until the §8 activation steps; production migration state: see `migration-readiness.md` §2.

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

## 4. F6C design summary

- Statement for (customer, currency, from, to): opening balance = signed sum of all account events
  before `from`; activity in range; closing balance = opening + activity. Events: invoice issued
  (+total, issue date), credit note issued (−total), payment received (−amount, received date),
  reversals and voids as offsetting entries on their own date. Allocations and credit applications
  only match items, so they never move the account balance.
- Outstanding invoices and ageing (current, 1-30, 31-60, 61-90, 90+ days past due) as of a date,
  from the same counters as F2/F4. A consistency test proves closing balance = receivable −
  unallocated payments − unapplied credit.
- PDF via F5's renderer when F5 is merged; statements are regenerated on demand, the download is
  audited with a content hash (D-F6-9).

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
- ~~Migration collision between F5 and R1 (`20261122000000`)~~ resolved: R1 was renamed to `20261124000000`.
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
