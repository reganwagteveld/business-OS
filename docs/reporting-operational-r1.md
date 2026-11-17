# Reporting WP-R1: operational metrics

**Status:** draft PR for ChatGPT audit. No migration, no new endpoint, no contract change, no production action.
**Scope:** turns three of the five metrics that Reporting R1 registered as `planned` into executable metrics, from data the
owning Zones already hold. Source: ZCR-1 audit (PR #117) work package WP-R1 and R-MET.

## 1. What is new

| Metric | Zone key | Counts | Date | Dimensions / filters |
|---|---|---|---|---|
| `finance.expenses_recorded` | `finance:read` | Gross cost (tax included, as billed) of **recorded** expenses, per currency | Expense date (`incurred_on`, a business-local calendar date) | currency, customer / currency, customer |
| `projects.tasks_completed` | `projects:read` | Tasks that are **done**, by completion time | `completed_at` in the business time zone | none |
| `scheduling.events_scheduled` | `scheduling:read` | **Scheduled** (not cancelled), unarchived events, by start time | `start_at` in the business time zone | customer / customer |

All three run through the existing `POST /reporting/query` and `POST /reporting/details` endpoints, support day, week, month
and "none" buckets, comparison with the previous period, saved and shared views, and a record list behind the total
(keyset-paginated, newest first). Every id and version is still `1`: they were never executable, so no saved view can have
stored them.

## 2. Rules (each owned by the source Zone)

- **Expenses.** Draft expenses never count. A voided expense is removed from every period, including the one it was
  incurred in. Payments made to suppliers are not counted again, and nothing is converted between currencies. The figure is
  a cost incurred, not money paid out, and is deliberately not netted against Amount invoiced (no profit or margin metric;
  that needs WF-7).
- **Tasks.** A task moved out of Done clears `completed_at` (database CHECK), so it leaves every period until completed
  again. Archived tasks are not counted. Tasks in an archived project still count: the work happened. The stale registry note
  ("Projects has no completion timestamp") was wrong: `project_tasks.completed_at` has existed since
  `20261114120000_projects`.
- **Events.** Counts events that take place, not when they were booked or whether they went ahead. Cancelling or archiving
  removes an event from every period. Calendars are shared by everyone holding `scheduling:read` and private entries are not
  built (ADR 0006 §4 is a future requirement), so the count and the list reveal nothing the Scheduling Zone does not
  already show. When private entries are built, this read model must apply the same privacy rule.

## 3. Boundaries and security

- Each Zone owns its read model (`finance/server/reporting.ts`, new `projects/server/reporting.ts`, new
  `scheduling/server/reporting.ts`), exported through that Zone's public `index.ts`. Reporting calls them from
  `reporting/server/sources.ts` and has no SQL of its own over another Zone's tables (the existing dependency rules apply).
- Every statement runs on the tenant client with forced RLS and an explicit `business_id` predicate.
- Access = `reporting:read` ∩ the source Zone key ∩ (for customer grouping) `customers:read`. Without `customers:read`, the
  record lists leave the customer column out and grouping is refused.
- Only the fields needed to recognise a record leave a Zone: expenses (date, description, supplier, category, amount; never
  notes, receipt reference or tax internals), tasks (title, project name, completion time; never description or assignee),
  events (title, start, customer id; never description, location or resources).
- **Communications isolation (C2-B2).** Nothing here reads Communications tables or any synced mailbox data.
  `communications.messages_recorded` and `people.headcount` stay `planned` with their notes, and a unit test pins that no
  executable metric uses a `communications:` key or source. Headcount needs a People history read model with groups under
  five suppressed (unchanged in the registry).

## 4. Client

No new screen. Explore and Saved reports are driven by the catalogue, so the metrics appear there as soon as the API lists
them as available and `accessible`. The R2 dashboard layout (data, not code) gains three widgets: Expenses recorded under
Finance, and new Projects and Scheduling sections. Widgets for metrics the person cannot read are never requested or shown.
Chart requests are now split into at most six metrics each (the API limit), so a full dashboard makes three requests.

## 5. Tests

- `apps/api/tests/integration/reporting-operational.test.ts` (18, real route handlers, PostgreSQL, two businesses, Perth
  time-zone boundary at 15:59:59 / 16:00:00 UTC): figures match the Zones' own records; draft, void, reopened, archived and
  cancelled records excluded; currencies never added; previous-period comparison; customer filter and grouping; drill-down
  pages exactly the records behind the total; Zone-key and `customers:read` refusals; another business's data and a foreign
  customer id never visible; cursors from another metric and tampered cursors refused; saved report with all three runs, and a
  member without Finance cannot save one with expenses.
- `apps/api/tests/unit/reporting.test.ts`: registry invariants for the new metrics, headcount and messages still planned,
  Communications isolation.
- `packages/app/tests/reporting-r2.test.tsx`: dashboard requests, role gating, planned list now headcount and messages.

## 6. Not done, and why

- Headcount (People read model, history and small-group suppression) and messages recorded (Communications; blocked by
  C2-B2 isolation): later packages.
- No profit or margin, no year-over-year, no export, no per-project or per-assignee task breakdown: separate decisions.
- Not verified here: native desktop window; a signed-in production walkthrough.

## 7. Shared files touched

`packages/app/src/zones/reporting/dashboard.tsx` (Reporting-owned), the Reporting registry and sources, and one export line
in each of the Finance, Projects and Scheduling `index.ts`. Not touched: `registry.ts` (shell), `app.tsx`, contracts,
`api-v1.json`, routes, migrations.

## 8. Migration requirements

None. Deploys like any API and client change.
