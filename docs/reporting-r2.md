# Reporting R2: interactive dashboards

Status: implemented on `claude/project-thread-ghjn61` for independent audit. Draft PR, not merged, not deployed.
**Client-only: no migration, no new endpoint, no backend change.** Builds on R1 (#43, `docs/reporting-r1.md`).

## 1. R1 audit (what R2 reuses)

| R1 piece | Where | R2 use |
|---|---|---|
| Metric registry (9 available, 5 planned), `accessible` per caller | `GET /reporting/metrics` | Decides every figure shown; only `available && accessible` metrics are ever requested |
| Query engine (≤ 6 metrics, presets resolved in the business zone, previous period, buckets ≤ 400) | `POST /reporting/query` | Dashboard KPIs and charts, Explore |
| Drill-down records (keyset pages, `filters`) | `POST /reporting/details` | Explore records, now also per period |
| Saved views (list/get/create/patch/delete/run, owner/share/manage rules) | `/reporting/views*` | Explore save/open, the new Saved reports list |
| `KpiCard`, `LineChart`, `BarChart`, tokens | `@business-os/ui` | Unchanged; reused by every widget |
| Client (`ReportingClient`, contract-checked) | `packages/app/src/api/reporting.ts` | Unchanged |

No analytics logic is added on the client: every number is a string the API returned, only formatted here.

## 2. What R2 adds

Reporting gets three sections in the shell's secondary navigation (`registry.ts` children):

- **Dashboard** (`/reporting`, the Zone's homepage): date range (presets or custom), interval (automatic or day/week/month),
  previous-period toggle; six headline KPIs (invoiced, received, outstanding and overdue receivables, won value, new
  customers); chart panels grouped by owning Zone (Finance: invoiced, received, invoices issued; Sales: won value, won
  count; Customers: new customers); a "Not available yet" list of registered planned metrics (no numbers).
- **Explore** (`/reporting/explore`): R1's report screen, plus a **Records** button per period that narrows the records
  to that period.
- **Saved reports** (`/reporting/saved`): every report visible to the person, labelled **Private**, **Shared by you** or
  **Shared with you**, filterable (All / Mine / Shared with me), with Open, Rename (or share), Delete per R1 rules.

### Dashboard as data (owner requirement 1)

The layout is fixed (`DEFAULT_DASHBOARD` in `dashboard.tsx`) but is a typed description (`DashboardLayout` in
`widgets.tsx`: `layoutVersion`, KPI metric ids, sections of `metric-chart` widgets naming a metric id and chart type).
Rendering, fetching and permission filtering work from that description, so a later phase can store layouts per
person or business and render them with the same components. Widgets for metrics the person cannot read are left out.

### Saved reports (owner requirement 2)

`ownership()` and `savedActions()` in `saved-list.tsx` (unit tested):

| Report | Label | Rename / share | Delete |
|---|---|---|---|
| Mine, private | Private | `reporting:save` (share option needs `reporting:share`) | `reporting:save` |
| Mine, shared | Shared by you | as above | `reporting:save` |
| Someone else's, shared | Shared with you | never | `reporting:manage` |

The API enforces all of this again on every request; rename and delete fetch the view first (current `version`, and a
fresh access check).

### Drill-down keeps context (owner requirement 3)

- Dashboard → Explore (panel or KPI "Explore"): same metric, date setting (preset or custom range), comparison and the
  interval the dashboard used.
- Explore period → records: `POST /details` with the same metric and `filters`, and a fixed range equal to that bucket
  clipped to the report range (weeks Monday–Sunday, months to their last day). "Show all periods" returns to the whole
  range; changing any setting forgets the picked period.
- Opening a saved report runs it through `/views/:id/run` as before.

## 3. Permissions and tenancy

- The Zone still opens with `reporting:read` only. Every metric request is built from `accessible` metrics, so a person
  without `finance:read` never sends a Finance metric and never sees a Finance section, KPI or planned Finance metric.
  The API still answers 403 / `forbidden_source` if the client were bypassed.
- The Zone is mounted with `key={slug}`; a business switch discards dashboard, Explore and list state. Every request is
  under `/b/:slug`. Tested with two businesses.

## 4. Performance and bounds

Dashboard: 2 requests per change (KPIs, charts), each ≤ `limits.maxMetrics` metrics (split if the limit were lower).
Automatic interval: ≤ 31 days → day, ≤ 92 → week, else month; a manual interval is stepped up if it would exceed
`limits.maxBuckets`. Custom ranges are validated (real dates, start ≤ end, ≤ `limits.maxRangeDays`) before sending.
Saved list: R1's bounded cursor loop; scope filtering is client-side on that list (no extra requests). No new
dependency.

## 5. Currency, locale and time zone

Money is formatted with the business locale and the series' own currency, never converted or summed across currencies
(multi-currency panels have a currency switch, defaulting to the business currency). Dates are business-local calendar
dates (shown with `timeZone: UTC` so they never shift); the dashboard states the business time zone. Count axes only
label whole numbers.

## 6. Tests

`packages/app/tests/reporting-r2.test.tsx` (23): navigation sections and controlled/uncontrolled section; KPI and chart
rendering and request shape (contract-parsed, ≤ 6 metrics); planned metrics; Finance never requested without
`finance:read`; no `reporting:read`; loading, request failure, per-metric error, empty period; presets, interval,
comparison, custom-range validation; Dashboard → Explore with preset and custom range; period → records (contract-parsed
details request); saved-report labels, scope filter, permission matrix, rename with version, delete of a shared report,
open via run; business switching; currency/locale formatting and date helpers. R1's 16 Explore tests still pass
(rendered in the Explore section). Fake API gained the missing registry metrics, per-metric errors, held queries and
the slug per call.

Quality gates run locally: `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `pnpm contracts:check`, `pnpm test`
(contracts 24, ui 95, api 133, app 401, root 287), `pnpm build` (with `VITE_API_BASE_URL` set).

Screenshots: `docs/ui/screenshots/reporting-r2` (seeded local docker database, production builds; console errors 0,
horizontal overflow 0 px at 1440 and 390 px, light and dark).

## 7. Limitations and future Reporting enhancements

- **Update (WP-R1, [reporting-operational-r1.md](reporting-operational-r1.md)):** expenses recorded, tasks completed and events scheduled are now executable and on the dashboard. The next line describes R2 as merged.
- **Expenses and project metrics** did not exist in R1 (`finance.expenses_recorded`, `projects.tasks_completed` are
  planned). Accepted for R2 by the owner; they need Zone-owned read models in a backend PR. Also future: scheduling,
  headcount and communications metrics (planned in R1).
- No "revenue" metric: R1 deliberately separates invoiced (billing), received and won value.
- Comparison is previous period only (no year-over-year). Receivables are current balances (no history).
- Configurable dashboards (stored layouts) are prepared for but not built.
- Drill-down from a chart bar itself is not supported by the chart component; periods drill from the table.
- Saved reports show "Shared with you" without the owner's name (R1's API returns only `ownerUserId`).
- Not verified: native desktop (Tauri) window; signed-in production walkthrough.

## 8. Shared navigation with People P2 (#56)

R2 changes the Reporting entry in `shell/registry.ts` (adds `children`) and the Reporting branch in `app.tsx` (passes
`section` and `onSection`). P2 changes the People entry and adds a People branch and client. The hunks do not overlap;
a trial merge of P2 onto this branch is clean (§9 of the PR). Whichever merges second needs no manual resolution.

## 9. Migration requirements

None. No schema, privileged SQL or API change; deploys like any client change.
