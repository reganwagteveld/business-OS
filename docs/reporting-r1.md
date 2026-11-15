# Reporting R1: trusted metrics, query engine and saved reports

Status: implemented on `feature/reporting-r1` for audit. Not merged, not deployed, migration not applied
anywhere but disposable local databases.

Baseline: branched from `main` at `1b65e74` (STAB-01): Finance F1–F4 (#31, #34, #35, #37), People P1 (#36),
Scheduling S1 (#38), Communications C1 (#39), STAB-01 (#40), UI phases 1–2 (#32, #33). Communications C2-A (#41,
migration `20261121000000_communications_providers`) merged to `main` as `4f2d437` during this work and is merged into
this branch; Reporting does not depend on it. Finance F5 (#42, migration `20261122000000_finance_documents`) merged to
`main` as `186d53a` and is merged into this branch too; Reporting does not depend on it either. Finance F6 has reserved
`20261123000000`. The Reporting migration was therefore
renamed from `20261122000000_reporting` to **`20261124000000_reporting`** (contents unchanged; it had not been
applied anywhere but disposable local databases).

## 1. What R1 is

A secure, tenant-isolated reporting foundation over the operational data the Zones already hold:

- a **typed registry** of metrics with stable ids and versions, defined in code only;
- a **query engine** that runs registered metrics over a date range (day, week or month buckets or
  totals), with a previous-period comparison, paginated drill-down records and hard limits;
- **saved views**: stored report configurations (never results), private by default, shareable with
  explicit enforcement, validated against the current registry on every run;
- a **Reporting Zone** in the existing shell and reusable **KPI card**, **line chart** and **bar chart**
  components in `@business-os/ui` for other Zones.

It adds no snapshot tables, materialised views, ETL, warehouse or copies of ledgers. Every figure is
recomputed from the source records each time.

## 2. Architecture

```
packages/app (Reporting Zone)  ──HTTPS──▶  /api/v1/b/:slug/reporting/*   (tenantRoute: auth, tenant from URL, reporting:* key)
                                                   │
                                     modules/reporting (registry, engine, saved views)
                                                   │  public APIs only (depcruise: module-public-api-only)
                       ┌───────────────────────────┼─────────────────────────┐
             modules/finance/server/reporting  modules/sales/server/reporting  modules/customers/server/reporting
             (+ invoiceReceivables, unchanged)
                                                   │
                                   PostgreSQL as bos_app, forced RLS, explicit business_id predicate
```

- **Zone-owned read models.** Each source Zone publishes its own reporting functions next to its other
  services (`finance/server/reporting.ts`, `sales/server/reporting.ts`, `customers/server/reporting.ts`).
  Reporting calls them through each module's `index.ts` and has no SQL over another Zone's tables. The
  rules for "which records count, by which date" live with the Zone that owns them, beside the drill-down
  query that lists exactly the same records (same predicates). Outstanding and overdue receivables reuse
  `invoiceReceivables()` (the Finance overview's calculation) unchanged.
- **No client-supplied SQL.** Requests name metrics by `{id, version}`; dimensions, filters, granularities,
  date presets and sort keys are closed enums in the contract (`packages/contracts/src/reporting.ts`); bodies
  are strict (unknown fields are rejected). Everything reaching SQL is a bound parameter of a tagged
  `$queryRaw` template.
- **ADR 0005 respected.** The UI lives in `packages/app` (shared by web and Tauri), presentational
  components in `packages/ui`, contracts in `packages/contracts`; the client never reaches the database.

## 3. Metric registry

`apps/api/src/modules/reporting/server/registry.ts`. Each definition carries: id and version (+ the stored
versions that still mean the same thing), display name, description, source Zone, value type and unit,
calculation semantics, date field and time-zone rule, treatment of draft / void / cancelled / reversed /
archived records, supported granularities, dimensions and filters, required permissions (plus extra keys
per dimension), tenant scope, availability, whether it has drill-down, default chart and minimum group size.
`GET /reporting/metrics` returns all of it (no data) with `accessible` for the caller.

### Available in R1

| Id | Meaning | Date | Included / excluded | Needs |
|---|---|---|---|---|
| `finance.invoiced_amount` | Sum of the **total** (tax included, after line discounts) of issued invoices, per currency. **Billing, not recognised revenue, not money received.** Credit notes are not netted. | Issue date | Issued only; drafts never; **voided invoices removed from every period** | `finance:read` |
| `finance.invoices_issued` | Number of issued invoices | Issue date | As above | `finance:read` |
| `finance.credited_amount` | Sum of issued credit-note totals, per currency, reported beside (never netted against) invoiced | Issue date | Issued only; void removed | `finance:read` |
| `finance.payments_received` | Sum of recorded payments **received** from customers, allocated or not; payments made to suppliers excluded | Date received | Recorded only; **reversed payments removed from every period** | `finance:read` |
| `finance.receivables_outstanding` | Current amount still owed on issued invoices (total − allocated payments − applied credit), per currency. Snapshot as of today; not netted with unallocated payments or unapplied credit | Today | Issued invoices only | `finance:read` |
| `finance.receivables_overdue` | The overdue part of the above (due date before today in the business zone) | Today | As above | `finance:read` |
| `sales.won_value` | Sum of `amount` of opportunities **currently** won, per currency. Sales outcome, not invoiced or received money | Won time (`closed_at`) | Won only; reopened leaves every period until won again; lost, open and archived never; no-amount opportunities count in `won_count` only | `sales:read` |
| `sales.won_count` | Number of opportunities currently won | Won time | As above | `sales:read` |
| `customers.new_customers` | Number of customers created | Created time | Archived customers excluded from every period | `customers:read` |

Grouping by **customer** additionally needs `customers:read` (customer names belong to the Customers
Zone). Money is always split by currency and never converted or added across currencies.

### Registered as planned (not executable)

`finance.expenses_recorded`, `projects.tasks_completed` (Projects has no completion timestamp yet),
`scheduling.events_scheduled` (must respect ADR 0006 privacy), `people.headcount` (directory fields only,
never `people:read_sensitive`, groups under 5 suppressed), `communications.messages_recorded` (restricted
notes are enforced in the activity service, not RLS, so any activity metric must go through it). A planned
metric answers `metric_unavailable`; no data is invented.

### Versioning

A metric's version changes whenever its meaning changes. A stored `{id, version}` runs only if the
version is in `compatible`; otherwise the run returns `metric_version_unsupported` with an instruction
to re-select it. Saved configs also carry `config_version` (1); an unreadable format is reported
(`view_config_invalid`), never guessed at.

## 4. Dates, time zones, buckets and comparison

- Ranges are inclusive calendar dates in the **business's time zone** (`businesses.time_zone`). Presets
  (`last_7_days`, `last_30_days`, `last_90_days`, `this_month`, `last_month`, `last_3_months`,
  `last_12_months`, `year_to_date`) resolve against today in that zone at every run, so a saved
  "last 30 days" stays current.
- Finance dates (`issue_date`, `received_on`) are already business-local dates. Timestamps
  (`closed_at`, `created_at`) are compared with `[from 00:00, to+1 00:00)` in the business zone and bucketed
  by their business-local date (DST-safe: PostgreSQL converts each boundary).
- Weeks start on Monday (ISO). The first bucket may start before the range but holds only in-range records.
- **Previous period** (R-D5) = the **immediately preceding period with the same number of days**, ending the
  day before the range starts: 1–15 Nov → 17–31 Oct; 1–30 Nov (30 days) → 2–31 Oct; 1–31 Mar → 29 Jan–28 Feb.
  There is no calendar-month alignment. Comparison buckets are aligned by position (bucket n with bucket n)
  and may be one shorter when week or month boundaries fall differently. Year-over-year is not in R1. The UI
  says "the same number of days immediately before" under the toggle. (Audit round 1 corrected an earlier
  month-shifting rule.)

## 5. Limits

At most 6 metrics per query or view; ranges up to 1,827 days; at most 400 buckets per series (so daily
≤ ~13 months); at most 12 series per metric (the rest counted in `hiddenSeries`, largest kept,
deterministic order); drill-down pages ≤ 100 rows; 100 saved views per person per business; stored config
≤ 16 KB (CHECK). The saved-view list is keyset-paginated (≤ 100 per page, `updated_at` desc then id, timestamps
to the microsecond): rows the caller may not see are skipped while a page is filled, a request scans at most
1,000 rows and then returns a cursor to continue, and following `nextCursor` to null reaches every visible view.
Nothing is truncated (audit round 1 fixed an earlier fixed 500-row read). The client follows the cursor for up to
50 pages of 100 (an injectable bound); if more remain, or the cursor stops moving, it returns an explicit `incomplete`
(or failed) outcome and the Zone shows "Saved reports could not all be listed" rather than a silently shorter list.
Drill-down uses keyset cursors bound to their list (`invalid_cursor` otherwise) with
stable order (date desc, id desc; timestamps keep PostgreSQL microseconds in the cursor).

## 6. Authorisation and tenancy

Access = **`reporting:*` key ∩ the metric's source keys ∩ the dimension's keys ∩ the business in the URL**.

| Key | OWNER | ADMIN | MANAGER | MEMBER |
|---|---|---|---|---|
| `reporting:read` (open Reporting, run metrics, open visible views) | ✓ | ✓ | ✓ | ✓ |
| `reporting:save` (create, edit, delete own views) | ✓ | ✓ | ✓ | ✓ |
| `reporting:share` (make a view visible to the business) | ✓ | ✓ | ✓ | — |
| `reporting:manage` (delete others' shared views) | ✓ | ✓ | — | — |

With today's role defaults a MEMBER runs Sales and Customers metrics but no Finance metric (no
`finance:read`). The same rule applies to every entry point: catalogue (`accessible` flag only), ad-hoc
query (403), drill-down (403; customer names only with `customers:read`), saved-view list (views using a
source you cannot read are left out), saved-view get/run (404), and run of your own view after losing a key
(that metric returns `forbidden_source` with no data; the rest run). Future exports must call the same
engine functions.

**A saved view never grants access.** It stores configuration only and runs as the viewer. Nobody can save
a view over data they cannot read, so sharing never extends anyone's reach.

**Tenancy.** All routes are `tenantRoute`s (slug resolved through the caller's verified membership; a
foreign slug answers 404). Every statement runs inside `withTenant` as `bos_app` with forced RLS and an
explicit `business_id` predicate. Tests show a customer id from another business used as a filter returns
nothing.

**Restricted and sensitive data.** No R1 metric touches activities, messages or People. The registry test
refuses any metric requiring `people:read_sensitive`, and the engine supports small-group suppression
(`minimumGroupSize`): suppressed buckets are `null`, and a suppressed bucket also hides the series totals so
the hidden value cannot be recovered by subtraction.

## 7. Database: one configuration table

Migration **`20261124000000_reporting`** (additive, one transaction, `BEGIN … COMMIT` per STAB-M6):

- `reporting_saved_views` (id, business_id, owner_user_id, title, description, report_type, config jsonb,
  config_version, visibility, version, updated_by_id, created_at, updated_at), FK to `businesses` ON DELETE
  CASCADE, indexes on (business, owner, updated_at) and (business, visibility, updated_at).
- CHECKs: title 1–120, description ≤ 1000, report_type `metrics`, visibility `PRIVATE|BUSINESS`, config is a
  JSON object ≤ 16 KB, versions ≥ 1.
- Grants: `bos_app` SELECT, INSERT, DELETE, and UPDATE on the editable columns only (owner, business and
  creation time are fixed). Nothing for `bos_auth`/`bos_jobs`.
- RLS enabled and **forced**: `tenant_isolation` plus RESTRICTIVE policies — private rows visible only to
  their owner, inserts/updates only by the owner (as `app.user_id`), deletes by the owner or of shared rows.
- Depends only on the tenancy migration; touches no other Zone's objects. Sorts after main's newest
  (`20261122000000_finance_documents`, F5) and after F6's reserved
  `20261123000000`, so fresh databases and production apply the same order whichever merges first (checked with
  `.github/scripts/check-migration-order.sh` against current main, and against main + a 20261123 F6 placeholder).
  The file's header comment still names the older F5/C2-A timestamps: the contents were deliberately left
  byte-identical through the rename.
- No privileged SQL step.

Shared-file overlap with open PRs (trivial rebases, no semantic conflict): `access/server/permissions.ts`
(new keys), `prisma/schema/tenancy.prisma` (one relation line), `core/db/app-client.ts` (one model),
`core/http/errors.ts` (two conflict codes), `packages/contracts/src/index.ts` and `schema/api-v1.json`
(regenerate after rebase).

## 8. Rollout assessment

1. STAB-H1 still applies: Vercel deploys `main` immediately, so the migration must be applied before (or
   with deploys paused, sequencing B) the merge. Until it is, `/reporting/views*` would 500; the metric
   endpoints need no new table and would work.
2. Recovery branch `pre-reporting-migration` first; `prisma migrate deploy` applies exactly
   `20261124000000_reporting` (plus F5's and F6's if they merged first; independent of them).
3. Verify: table exists with RLS + FORCE, the five policies, grants as above, `prisma migrate status` clean.
4. Rollback: code revert is safe (table unused); dropping the table loses only saved configurations.

## 9. API

| Endpoint | Key | Notes |
|---|---|---|
| `GET /reporting/metrics` | `reporting:read` | Registry + `accessible`, business time zone, today, limits |
| `POST /reporting/query` | `reporting:read` + sources | Strict: 400 with actionable code, 403 for a source you cannot read |
| `POST /reporting/details` | `reporting:read` + source | One page of the records behind a metric |
| `GET/POST /reporting/views` | read / save | List visible views, paginated (`scope`, `limit` ≤ 100, `cursor`; `nextCursor`), with `issues` against the current registry; create (private by default) |
| `GET/PATCH/DELETE /reporting/views/:id` | read / save / save | PATCH owner-only with `version` (409 `stale`); DELETE owner, or `reporting:manage` for shared |
| `POST /reporting/views/:id/run` | `reporting:read` | Runs the stored config as the caller; per-metric errors, no data for failing metrics |

Error codes: `unknown_metric`, `metric_unavailable`, `metric_version_unsupported`, `unsupported_granularity`,
`unsupported_dimension`, `unsupported_filter`, `invalid_date_range`, `range_too_large`, `too_many_buckets`,
`no_detail`, `invalid_cursor`, `forbidden_source`, `stale`, `too_many_views`, `view_config_invalid`.
Audit events: `reporting.view.created|updated|deleted`.

## 10. UI

Reporting replaces the planned "Insights" entry in the Zone registry (`requires: ['reporting:read']`). The
screen has: saved-report selector, Zone filter, date range (presets + custom), interval, chart metric, chart
type, previous-period toggle; headline KPI cards (one value per currency, change in words, "as of" for
balances); the selected metric as bar or line chart (one currency at a time, comparison dashed) with a
sortable period table and a "How this is calculated" panel from the registry; the drill-down records with
"Show more"; save, rename/share and delete dialogs. States: loading, empty ("No … in this period"),
unauthorised (no accessible metric, or a figure you cannot read in a shared report), error with retry.
A saved report shown unchanged runs through `/views/:id/run`, so the server re-validates it on every open.

Reusable components in `@business-os/ui`: `KpiCard`, `LineChart`, `BarChart` (figure + caption, `role="img"`
summary, text legend with dashed comparison, visually hidden data table; values are exact strings formatted
by the caller). New tokens `--chart-1..5`, `--chart-comparison`, `--chart-grid` meet 3:1 on cards in both
themes (token test). Screenshots: `docs/ui/screenshots/reporting-r1`.

## 11. Tests (local, Node 22, PostgreSQL 16 ICU en-US on docker)

- `apps/api/tests/unit/reporting.test.ts` (25): buckets, presets in the business zone, previous period, limits,
  registry invariants (sources bound, no sensitive People, invoiced ≠ received ≠ outstanding, no "revenue"),
  validation and malicious wire input, access intersection and role defaults, series shaping (no cross-currency
  sums, exact decimals, zero fill, comparison, top-N determinism, suppression without subtraction leaks).
- `apps/api/tests/integration/reporting.test.ts` (41): real routes and PostgreSQL. Figures equal Finance's own
  document totals and the Finance overview's receivables; void/draft/reversed/reopened/lost/archived handling;
  Perth day boundaries; empty business; source-permission 403s; no `reporting:read` → 403; customer names need
  `customers:read`; cross-tenant isolation through query, details, filters and slug; pagination without repeats
  and foreign/tampered cursors; limit and injection inputs; saved-view CRUD, privacy, sharing, owner-only edit,
  manage delete, stale version, audit; access lost after save; retired versions and unreadable configs; RLS
  backstops tested directly as `bos_app`; saved-view list pagination behind 550 newer views from another owner
  (520 the caller cannot see), complete for the caller and for the owner, tampered and cross-scope cursors refused.
- `packages/app/tests/reporting-zone.test.tsx` (16, incl. client paging bound, incomplete state and a repeated cursor) and `packages/ui/tests/charts.test.tsx` (5); three shell
  tests updated for Insights → Reporting; token contrast pairs added.

## 12. Divergences from the brief

- **One chart metric per saved view in the UI** (accepted R1 limitation). The API and config accept up to six
  metrics; the R1 screen saves the selected chart metric and says so under the Chart control (KPI cards are always
  the headline set). Multi-metric layouts can follow without a schema change.
- **Snapshot metrics** (receivables) are present-day balances with no history (accepted R1 limitation): past
  balances would need snapshots, which the brief excludes. Their cards read "Current balance as of <date>. Not
  affected by the date range."; they ignore the interval and comparison, and say so.
- **Delete is a hard delete** of the configuration (audited), not an archive: it is personal config, not a
  business record.
- **Insights → Reporting** in the navigation registry (one entry, same icon).

## 13. Owner decisions (audit round 1, 2026-11-15)

1. **R-D1 Role defaults** (all roles read and save private views; OWNER/ADMIN/MANAGER share; OWNER/ADMIN delete
   others' shared views): **approved.**
2. **R-D2 Invoiced = tax-inclusive total:** **retained.**
3. **R-D3 Present-state restatement** (voids, reversals, reopenings and archiving remove records from every
   period; not historical events): **retained.**
4. **R-D4 Archived customers and archived won opportunities excluded:** **retained.**
5. **R-D5 Previous period = immediately preceding period of equal length:** approved in principle subject to
   correction. **Corrected** to the equal-day-length rule in §4.
6. **R-D6 Reporting replaces Insights:** **approved.**
7. **R-D7 Audit-logged hard deletion of saved views:** **approved.**
8. **R-D8 Rollout sequencing B** (pause automatic deploys, migrate, promote): **approved conditionally** after CI,
   migration and deploy-gate review. No merge, migration or deployment approval has been given yet.

## 14. Unresolved / not verified

- PgBouncer-mode run of the reporting suite and the RLS isolation spike were not run locally (no local
  pgbouncer); CI runs isolation behind PgBouncer. Reporting's statements are single transactions with
  `set_config(..., true)` like every other module.
- Native desktop (Tauri) window not exercised; the shared client is the same build.
- Pre-existing, outside R1: Finance list cursors use millisecond `created_at` (same-millisecond rows could be
  skipped); the web app has no favicon (one 404 in the browser console).
