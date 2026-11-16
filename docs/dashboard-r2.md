# R2: Operational dashboard (Dashboard V2)

Status: draft PR for review. Not merged, not deployed. **No migration.** One new read-only endpoint (`GET /sales/summary`).

Home is now the business's operational homepage: the figures that matter today and the work that needs attention,
above the existing Zone launcher. It builds on Reporting R1 (metrics, query engine) and R2 (KPI and chart widgets)
and on existing Zone endpoints. The Reporting Zone's own dashboard (R2, PR #62) is unchanged.

## 1. What is on the page

| Area | Contents |
|---|---|
| Money | Date range (R1 presets or custom), then four KPIs: Amount invoiced, Amount received (both for the range, with the previous period), Outstanding and Overdue receivables (balances as of today) |
| Operations | Open opportunities (count, open value per currency), Active projects, Scheduled events in the next 7 days, Active customers |
| Financial performance | Invoiced and received charts for the range, compared with the previous period (R2 chart widget) |
| Overdue invoices | Up to 5 overdue invoices with customer, due date, days overdue and open amount |
| Sales pipeline | Open opportunities by stage for the default pipeline (switchable), count and value per currency |
| Upcoming schedule | Scheduled events from now to the end of the 7th business day, grouped by business day |
| Recent activity | The 8 newest entries on customer timelines the person may see |

Every area has loading, empty and error states. Each panel fails on its own (with a retry); an ended session sends the
person to sign in once. Desktop first: four KPI columns and a two-column panel grid at ≥ 1280 px, two columns at
≥ 640 px, one column on phones. No horizontal overflow at 1440, 900 (Tauri minimum) or 390 px.

## 2. Widget-to-data-source matrix

The table is code: `packages/app/src/shell/dashboard/sources.ts` (`DASHBOARD_SOURCES`). It decides which widgets a
person sees, and `tests/architecture/dashboard-sources.test.ts` checks every endpoint is declared in the contract and
every key exists in the server's permission registry.

| Widget | Endpoint | Field | Permissions (all) | Definition owner |
|---|---|---|---|---|
| Amount invoiced | `POST /reporting/query` | `results[].series[].total` | reporting:read, finance:read | R1 `finance.invoiced_amount` |
| Amount received | `POST /reporting/query` | same | reporting:read, finance:read | R1 `finance.payments_received` |
| Outstanding receivables | `POST /reporting/query` | same | reporting:read, finance:read | R1 `finance.receivables_outstanding` |
| Overdue receivables | `POST /reporting/query` | same | reporting:read, finance:read | R1 `finance.receivables_overdue` |
| Open opportunities | `GET /sales/summary` **(new)** | `summary.open` | sales:read | Sales: status OPEN, not archived |
| Active projects | `GET /projects/summary` | `summary.byStatus.ACTIVE` | projects:read | Projects (existing) |
| Scheduled, next 7 days | `GET /scheduling/events` | `events.length` (+ "more" from `nextCursor`) | scheduling:read | Scheduling (existing) |
| Active customers | `GET /customers/summary` | `summary.customers.active` | customers:read | Customers (existing, shared with the Zone card) |
| Financial performance | `POST /reporting/query` | `buckets`, `series[].points` | reporting:read, finance:read | R1 invoiced and received |
| Overdue invoices | `GET /finance/invoices?overdue=true&limit=5` | `documents[]` | finance:read | Finance (existing filter) |
| Sales pipeline | `GET /sales/summary` **(new)** | `summary.pipelines[].stages[]` | sales:read | Sales |
| Upcoming schedule | `GET /scheduling/events` (same request) | `events[]` | scheduling:read | Scheduling |
| Recent activity | `GET /activities?limit=8` | `activities[]` | activity:read | Activity (existing, restricted entries filtered by the API) |

No figure is computed on the client from records. The only arithmetic is per-row presentation that Finance already
does (`openAmount` = total − payments − applied credit, exact decimals) and "days overdue" from two calendar dates.
There is no "revenue" figure: R1 deliberately keeps invoiced, received and won apart, so the page shows invoiced and received.

### Metric definitions are not duplicated

Finance figures are R1 registry metrics, requested by id and version through the R1 query, and rendered with R2's
`Kpis` and `MetricChartWidget`. The only new definition is the open pipeline (§3), owned by the Sales module next to its
R1 read model. It is not a Reporting metric: R1's registry has only `currency` and `customer` dimensions, and the board
needs stage. If the owner wants it in Explore later, it can be registered as an R1 snapshot metric that calls the same function.

## 3. New endpoint: `GET /api/v1/b/:slug/sales/summary`

- Permission `sales:read` (every role by default), tenant unit of work, RLS.
- One grouped SQL query: open (status OPEN, not archived) opportunities by pipeline, stage and currency, joined to the
  business's stages. Opportunities, stages and pipelines are each filtered to the business explicitly (joins also match
  on `business_id`), with forced RLS on all three as the backstop. Bounded by stages × currencies; no opportunity rows leave the database.
- Amounts are summed exactly (`Decimal`), per currency, formatted to the currency's minor unit. Unpriced opportunities
  are counted but add nothing. Archived pipelines and stages appear only while they still hold open opportunities.
- Contract: `SalesSummaryResponse` in `packages/contracts/src/sales.ts`; endpoint `salesSummary`; JSON schema regenerated.
- Integration tests (`apps/api/tests/integration/sales.test.ts`, "R2 dashboard"): empty business (and reading creates
  nothing), exact multi-currency totals beyond float precision, won/lost/archived excluded, reopen counted again, second
  pipeline, every role 200, no session 401, another business 404 with no figures leaked; an archived stage and an archived
  pipeline that still hold open work, with mixed currencies (including a 3-decimal one) and unpriced deals, and every
  per-stage and overall count equal to the Sales board's own open list.

## 4. Permissions and tenancy

- A widget is shown only when the membership holds all its keys; otherwise it is not rendered **and not requested**.
  Reporting widgets also need the metric to be `accessible` in the catalogue. The API checks every request again.
- With the server's defaults, Member (no `finance:read`) sees no Finance KPI, chart or overdue list, and no Finance or
  Reporting-Finance request is sent (tested in the client and against `ROLE_PERMISSIONS`).
- Home is mounted under `dashboardIdentity(context)`: business slug, membership id, role and the sorted permission keys.
  A business switch, a different membership, or a role or permission change within the same business discards every
  figure loaded before and starts again with the new access (tested: an Owner downgraded to Member in the same business
  loses the overdue list and Finance figures at once, and no Finance request follows). Signing out unmounts Home. Every
  request is under `/b/:slug`, and the API checks each one again.

## 5. Requests and bounds

First load for an Owner: customers summary, Reporting catalogue, KPI query, chart query, sales summary, projects
summary, events (≤ 100), overdue invoices (5), activity (8): nine parallel requests, each one page. Changing the date
range re-runs only the two Reporting queries. No cursor is followed; "100+" and "More are in Finance" say when there is more.

## 6. Dates and time zones

"Today" is the business's calendar date in its IANA zone. The schedule window is `[now, start of (today + 7))` in the
business zone, so it is 7 days minus or plus an hour across a clock change (tested for Perth, Sydney across DST and New
York). Events are grouped by business day; an event already under way is listed under today. Reporting ranges are
resolved by the R1 engine in the business zone.

If Home stays open across the business's midnight, it rolls over: the schedule window, the overdue list (and its
"days overdue"), the Reporting catalogue (its "today") and the Money KPIs and charts are fetched again for the new
day; the chosen date range is kept (tested with a clock crossing midnight in Perth).

Period figures (Amount invoiced, Amount received, the charts) are for the chosen dates; Outstanding and Overdue are
balances as of today. The Money header says so.

## 7. UI V2 compatibility

Built only from `@business-os/ui` (`Card`, `KpiCard`, `SectionHeader`, `EmptyState`, `Skeleton`, `Badge`, `Button`,
`Select`) and the R2 Reporting widgets; no new tokens, colours or components. Widgets are described as data
(`DASHBOARD_SOURCES`) and each panel is a small component taking one load, so V2-D can restyle or rearrange them
without touching data or permissions. The layout already follows V2-A's dashboard direction (eight KPIs in two rows of
four; compact lists beside the chart). The "needs attention" list for tasks and opportunities stays out (it needs a
cross-Zone endpoint, per V2-A §10).

## 8. Tests

- `packages/app/tests/dashboard-r2.test.tsx` (22): source table, role gating (Owner, Manager, Member, none), real
  figures through the real clients and contracts, request budget and page sizes, date range re-query, schedule window
  and DST, days overdue and day labels, empty business, per-panel error and retry, offline vs server error, 401, contract
  mismatch, navigation targets, no customer link without `customers:read`, tenant separation, permission change in the
  same business, midnight roll-over, client paths.
- `tests/architecture/dashboard-sources.test.ts` (3): endpoints declared, keys exist, server role defaults, Home keyed by
  `dashboardIdentity`.
- `apps/api/tests/integration/sales.test.ts` (+4): §3.
- Existing tests changed: `screens.test.tsx` (the "no combined activity feed yet" placeholder is gone, replaced by real
  activity), `shell.test.tsx` (passes the dashboard client over the same fake API). `packages/app/tests/setup.ts` makes
  any default client in tests fail as offline at once instead of trying DNS.

## 9. Known limitations

- Upcoming schedule has no link: Scheduling is not in the navigation yet (D-V2A-8, deferred to V2-C). The events API
  keeps its own authorisation.
- Overdue invoices shows the 5 most recently created, not the oldest due (the list endpoint orders by creation). The
  panel says "Newest invoices first". Oldest-due ordering needs `sort=due_asc` on Finance's invoice list, planned as a
  separate small Finance PR (D-R2D-4).
- The "Scheduled, next 7 days" count stops at 100: with more it shows "100+" and "At least 100: only the first 100 …
  were counted", never an unqualified total.
- Pipeline value is unweighted (no probability weighting) and shows the default pipeline first.
- Activity rows show no customer name or author (that would need per-record lookups); "Open" goes to the customer.
- Expenses and project metrics remain unavailable (R1 planned metrics), as accepted for R2.
- Not verified: native desktop window, signed-in production walkthrough.

## 10. Migration requirements

None. No schema change, no privileged SQL. One additive read-only endpoint; deploys like any API change.

## 11. Screenshots

`docs/ui/screenshots/dashboard-r2/`: Owner light and dark at 1440, Member at 1440, Owner at 900 × 600, Owner and Member on
a 390 px phone. Rendered by the real `App` against the in-memory test fakes (sample data only, no server or production
data); harness sources in `harness/` as `.txt`. Colour-quantized; not golden baselines.

## 12. Review amendments (owner review, 2026-11-16)

Recommendations recorded in the review: D-R2D-1 approve `/sales/summary`; D-R2D-2 show the schedule now, no link;
D-R2D-3 default Last 30 days (already the default); D-R2D-4 oldest due first, via a separate Finance PR; D-R2D-5 defer
weighted value. Changes made for the review's checks:

| Check | Change |
|---|---|
| Sales SQL tenancy | Explicit business filter on opportunities, stages and pipelines; new archived/mixed-currency/board-agreement test |
| Permission change in the same business | Home keyed by `dashboardIdentity` (slug, membership, role, permissions); client and architecture tests |
| Schedule count | Partial-count note "At least N" alongside "N+" |
| Midnight while mounted | Roll-over timer at the business's midnight; date-dependent loads re-run; test |
| Overdue order | Panel says "Newest invoices first" until the Finance sort lands |
| Desktop and signed-in walkthrough | Still to do before pilot release (§9) |
