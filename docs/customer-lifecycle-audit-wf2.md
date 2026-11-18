# WF-2: End-to-end customer lifecycle audit

**Status:** audit only (merged in #165); decisions D-WF2-1..4 accepted 2026-11-18 (§10). No product code, migrations, merges or deployments.
**Base:** `main` at `2a96f44` (2026-11-18). **Author:** Claude (WF-2 audit thread), for Regan and ChatGPT audit.
**Scope:** customer/contact → opportunity → quote → explicit project creation → project execution → invoice →
payment → reporting, checked in the backend routes, schema, UI, RBAC and tests, against the accepted W1
(`docs/cross-zone-workflows-w1.md`) and WF-1 (`docs/cross-zone-workflows-wf1.md`) decisions.

> **Naming.** W1 §13 used "WF-2" for the "job source" package; D-WF1-13 folded that into WF-1 and asked for the
> remaining W1 items to be renumbered when next scheduled. "WF-2" here means *this audit*. The packages it
> proposes are named **LC-1 … LC-7** (lifecycle) so they clash with neither W1 nor WF-1 names.

## Contents

1. Summary
2. Method and evidence
3. Lifecycle map: what works today
4. Reproducible scenario matrix
5. Tenant isolation and financial visibility
6. Gap register (evidence-backed, ranked)
7. Dependencies
8. Proposed implementation packages
9. Acceptance criteria (testable)
10. Decisions needed

---

## 1. Summary

**Verdict.** Every stage of the lifecycle works *inside its own Zone*, and the API can already carry most of the
links between Zones. What a person cannot do today is walk the chain in the app: **no screen creates or shows a
link between an opportunity, a quote, a project and an invoice**, and **the "explicit project creation" step
has no API at all**. The WF-1B-1 schema (merged in #110, migration applied in production) is in place but
nothing writes to it.

| Stage | Backend | UI | Rating |
|---|---|---|---|
| Customer and contacts | Complete | Complete | Working |
| Opportunity | Complete | Complete; customer page lists opportunities | Working |
| Quote | Complete; can carry `opportunityId`/`projectId` | Quote form has no opportunity or project field; opportunity page shows no quotes | Incomplete UI integration |
| Quote accepted → opportunity won | Two separate actions, nothing links them | Same | Planned (W1 WF-3), not built |
| Explicit project creation from opportunity or quote | **Missing**: no `workflows` module, no endpoint, source columns cannot be written | Missing | Missing backend capability (planned WF-1B-2) |
| Project execution (tasks, status) | Complete | Complete | Working; no visits link (W1 WF-4), no project costs in UI |
| Invoice | Complete; convert from quote; I1 customer rule enforced | Convert works; invoice form cannot pick a project or opportunity | Incomplete UI integration |
| Payment and settlement | Complete | Complete | Working |
| Project financials | `GET finance/projects/:id/summary` built and tested | No client, no panel | Incomplete UI integration (planned WF-1C-2) |
| Reporting | Finance, Sales, Customers, tasks, events metrics | No project, opportunity or funnel dimension; no margin | Missing (planned W1 WF-7) |
| Customer timeline | Customer and contact events, messages | No Sales, Projects or Finance events | Missing (planned W1 WF-8) |

**Security.** No tenant-isolation or finance-leak defect was found. Cross-business ids are refused with 4xx or
404, MEMBER is refused on every Finance read, project responses omit finance keys entirely for non-finance
roles, and a linked project's customer is locked. Two low-severity policy points are listed in §5.

**Top three gaps** (full list §6): G-01 no way to create or link a project from an opportunity or accepted
quote (**High**); G-02 quote/invoice forms cannot set the project or opportunity, so in the app every link stays
empty and the project summary would show nothing (**High**); G-03 accepting a quote leaves the opportunity open
and nothing prompts the next step (**Medium**).

**Recommended next step:** build WF-1B-2 (already designed and decided) as **LC-1**, with WF-1C-1 (**LC-2**) in
parallel. Neither needs a migration.

---

## 2. Method and evidence

1. **Static reading** of the routes under `apps/api/src/app/api/v1/b/[slug]/`, the Zone modules
   (`apps/api/src/modules/{customers,sales,projects,finance,reporting,activity,access}`), the Prisma schema, the
   contracts in `packages/contracts/src`, and the client Zones in `packages/app/src/zones`. File references are
   given per finding.
2. **Existing suites run** on a local PostgreSQL 16 with all migrations and privileged SQL applied exactly as in
   the CI integration job: `tests/integration/cross-zone.test.ts` (45 tests) and
   `tests/integration/workflow-links.test.ts` (30 tests): **75/75 passed**.
3. **A lifecycle probe** (14 steps, L1–L14) that drives the real route handlers through the whole chain as
   OWNER, ADMIN, MANAGER and MEMBER of one business plus an OWNER of a second business, and records what the
   API returns, including the gaps. **14/14 passed** (the assertions describe current behaviour). Source:
   [`docs/evidence/wf2/lifecycle-probe.test.ts.txt`](evidence/wf2/lifecycle-probe.test.ts.txt); output:
   [`docs/evidence/wf2/probe-output.txt`](evidence/wf2/probe-output.txt). It is stored as `.txt` so it never runs
   in CI; the file header says how to re-run it.

Not done: no browser or desktop run (the UI findings come from the component code and its tests), no production
access (none is needed for an audit; `_prisma_migrations` state is taken from the merged migration logs).

---

## 3. Lifecycle map: what works today

### 3.1 Data relationships on `main`

```
customers 1─N contacts
customers 1─N opportunities            (opportunities.customer_id, optional)
customers 1─N projects                 (projects.customer_id, optional)
customers 1─N finance_documents        (required)
opportunities 1─N finance_documents    (finance_documents.opportunity_id; frozen + sealed after issue)
projects 1─N finance_documents         (finance_documents.project_id; frozen + sealed after issue;
                                        I1: (business_id, project_id, customer_id) composite FK)
projects 1─N finance_expenses, recurring templates (project_id, I1 FK)
quote 1─N invoices                     (finance_documents.source_quote_id, convert)
opportunities 1─N projects             projects.source_opportunity_id   ← column + FK exist, NO WRITE PATH
accepted quote 1─1 project             projects.source_quote_id         ← column + FK + guard exist, NO WRITE PATH
invoices N─M payments                  payment allocations, credit applications
scheduling_events ─ projects           NO relationship (W1 WF-4)
```

Every arrow is a composite tenant FK under forced RLS (`workflow-links.test.ts` "migration shape").

### 3.2 Per-stage detail

| Stage | Routes and code | Permission (default roles) | UI | Tests |
|---|---|---|---|---|
| Customer, contacts | `customers/**`, `contacts/**`; `modules/customers` | `customers:*` (all roles read/write) | Directory, detail, contacts | `customers*.test.ts`, `cross-zone` |
| Opportunity | `sales/opportunities/**` incl. `win`, `lose`, `reopen` | `sales:read/write` (MEMBER included) | Board, list, detail, form; `CustomerOpportunities` panel on the customer page (`zones/sales/customer-opportunities.tsx`) | `sales*.test.ts`, `sales-zone*.test.tsx` |
| Quote | `finance/quotes` (+ `issue`, `accept`, `decline`, `expire`, `void`, `convert`, PDFs) | create/convert `finance:write` (MANAGER+); issue/accept `finance:issue` (OWNER, ADMIN) | Form (customer, currency, lines, notes only: `zones/finance/document-form.tsx:18`), detail with Convert/Mark accepted (`document-detail.tsx:59-72`) | `finance*.test.ts` |
| Project | `projects/**`, `customers/:id/projects` | `projects:*` (MEMBER all but archive) | List, detail, task board, form with customer picker; `CustomerProjects` panel | `projects*.test.ts`, `projects-*.test.tsx` |
| Link to project or opportunity | Via `opportunityId`/`projectId` on quote/invoice create and draft PATCH (`documents.ts:137-189`), plus `sales:read`/`projects:read` (D-WF1-11) | MANAGER+ | **None** | `workflow-links.test.ts` T-10..16, T-20..30 |
| Invoice | `finance/invoices/**`; `convertQuote` (`documents.ts:360`) copies customer, opportunity, project, lines; D-WF1-10 fills the project from `source_quote_id` (unreachable today, §6 G-01) | create `finance:write`, issue `finance:issue` | Form, detail, Convert dialog | `finance*.test.ts`, `cross-zone` |
| Payment | `finance/payments/**`, allocations, reversals, settlement, credit notes | `finance:payments` (OWNER, ADMIN) | Payment form with invoice prefill, receivables | `finance-payments`, `finance-integrity` |
| Project financials | `finance/projects/:projectId/summary` (`project-summary.ts`) | `finance:read` + `projects:read` | **None** (no client method in `packages/app/src/api/finance.ts`) | T-27..30, T-49 |
| Reporting | `reporting/query`, `views`, `details`; registry `modules/reporting/server/registry.ts:64-192` | per metric | Reporting Zone, Home dashboard | `reporting*.test.ts` |

---

## 4. Reproducible scenario matrix

Re-run with the probe (§2). "Result" is what `main` at `2a96f44` returned on 2026-11-18.

| # | Scenario (actor) | Expected by WF-1/W1 decisions | Result today | Class |
|---|---|---|---|---|
| L1 | Create customer and contact (OWNER) | Works | 201, 201 | Working |
| L2 | Create opportunity with amount for the customer (MEMBER) | Works | 201; MEMBER sees `amount` | Working (see §5 P-2) |
| L3 | Quote from opportunity: `POST finance/quotes {opportunityId}` (MANAGER); list `?opportunityId=` | Works via API; UI prefills (WF-1 §6.1) | 201; listed by opportunity; opportunity response has no quotes; quote total from its own lines, not the opportunity amount (D-WF1-04 holds) | Backend working, UI missing |
| L4 | Issue and accept the quote (OWNER), then read the opportunity | W1 WF-3: accept may also win in one confirmed action | Opportunity stays `OPEN` until a separate `win` call | Planned, not built |
| L5 | Create a project from the opportunity / accepted quote | `POST workflows/projects/from-opportunity`, `from-quote` (WF-1 §6.2-6.3) | No `workflows` module or route; `POST projects {sourceOpportunityId}` → 400; `PATCH` with it → 400; `GET projects?sourceOpportunityId=` → 400; plain project has `sourceOpportunityId: null, sourceQuoteId: null` | **Missing backend** |
| L6 | Point the already issued quote at the new project | Not allowed by design (sealed hash, D-WF1-08); `link-quote` sets `projects.source_quote_id` instead | `PATCH` issued quote `projectId` → 409; `link-quote` does not exist | Missing backend (via L5) |
| L7 | Convert the accepted quote | Draft invoice; project from the quote or its source-quote project (D-WF1-10) | 201 draft with `projectId: null`; draft PATCH `projectId` → 200 (API only) | Working; project lost without LC-1/LC-2 |
| L8 | Invoice from project; then with another customer | Same customer only (I1) | 201; other customer's project → 400 | Working (API), UI missing |
| L9 | Issue invoice, record full payment, read settlement; MANAGER records a payment | PAID; MANAGER refused | `outstanding 0.00, PAID`; MANAGER 403 | Working |
| L10 | Complete project; read project summary per role; second business reads it | OWNER/ADMIN/MANAGER 200, MEMBER 403, other business 404 | As expected; summary shows `quotedNet 0.00` because the quote could not be attached (L6) | Working; data gap via G-01 |
| L11 | MEMBER reads project, customer projects, invoice, opportunity | No finance keys; invoice 403 | No `sourceQuote*` keys (absent, not null); invoice 403; opportunity amount visible | Working |
| L12 | Change the customer of a project that an invoice links | 409 `project_customer_locked` | 409 | Working (UI message generic, G-09) |
| L13 | Reporting by project (`filters.projectId`, `groupBy: project`) | W1 WF-7 | 400 both | Missing (planned) |
| L14 | Customer timeline after the whole chain | W1-D8: redacted Sales/Projects/Finance events | Only `customer.created`, `contact.created` | Missing (planned WF-8) |

Already covered by existing suites (not repeated in the probe): cross-business links refused with 4xx and no row
(`cross-zone.test.ts:311-361`), outsider gets 404 (`:393`), restricted roles 403 (`:428`), source-quote guard
and lock-order races (`workflow-links.test.ts` T-47, T-51, T-52), project summary arithmetic (T-49).

---

## 5. Tenant isolation and financial visibility

| Check | Evidence | Result |
|---|---|---|
| Every lifecycle table has forced RLS and composite tenant FKs | `workflow-links.test.ts` "migration shape"; `tests/isolation` | Pass |
| A record of another business cannot be linked (customer, contact, opportunity, project, quote) | `cross-zone.test.ts:311-361`, T-01..05 | Pass |
| Another business cannot read a project summary | Probe L10: 404 | Pass |
| A document links only a project of its own customer (I1) | Probe L8; T-10..16, T-53 | Pass |
| A linked project's customer cannot change | Probe L12; `projects.ts:111-117` | Pass |
| Non-finance roles get no finance identifiers on projects | Probe L11 (MEMBER keys listed in output); `projects.ts:71-77` | Pass (keys absent) |
| Finance reads refused for MEMBER | Probe L11, `cross-zone.test.ts:428` | Pass |
| Project summary needs `finance:read` **and** `projects:read` | `summary/route.ts`; T-27..30 | Pass |
| Naming a project/opportunity on a document needs `projects:read`/`sales:read` | `authorizeFinanceLinks` (`documents.ts:185`), T-20..30 | Pass |
| Finance figures in Reporting need `finance:read` | `registry.ts` `requires: ['finance:read']` | Pass |
| Search cannot leak finance data | GS1-A routes are still disabled (404) | Not reachable today; must be rechecked when search is enabled (WF-1 R-1) |

Policy points (not defects; for Regan's awareness):

- **P-1 (Low).** A finance reader without `projects:read` or `sales:read` still sees the *ids* in a document's
  `projectId`/`opportunityId`. No default role is in that position (every role with `finance:read` also has
  both read keys) and custom roles do not exist yet (A2-C). Recheck when custom roles land.
- **P-2 (Low).** MEMBER sees opportunity `amount` and pipeline value (Sales data, not Finance). This matches the
  Sales design (`sales:read`), but a business that treats deal value as confidential has no way to hide it.
  Revisit with custom roles; no change proposed now.

**No G-4 regression:** nothing in this audit found finance numbers, amounts or existence signals reaching a
person without `finance:read`.

---

## 6. Gap register (evidence-backed, ranked)

Severity: **High** blocks the lifecycle in the app; **Medium** forces a workaround or loses data; **Low** is
polish or future-proofing. "Planned" names the existing package that already covers it.

| Id | Gap | Evidence | Class | Severity | Planned |
|---|---|---|---|---|---|
| G-01 | No way to create a project from an opportunity or accepted quote, or link one afterwards. `projects.source_opportunity_id` and `source_quote_id` (migration `20261207000000`) have no write path, so the D-WF1-10 convert rule and the project summary's source-quote figures can never take effect | Probe L5, L6, L10; no `apps/api/src/modules/workflows`; `CreateProjectRequest` and `ListProjectsQuery` are `.strict()` without source fields (`contracts/src/projects.ts:78-118`) | Missing backend | **High** | WF-1B-2 |
| G-02 | Quote and invoice forms cannot set or show the project or opportunity; the expense form cannot set a project or customer. In the app every Finance link stays NULL, so project financials and opportunity quotes are empty | `document-form.tsx:18` (fields: customer, currency, date, notes, lines); `expense-form.tsx` has no project/customer field; `document-detail.tsx` shows neither | Incomplete UI | **High** | WF-1C-1 |
| G-03 | Accepting a quote does not win the opportunity, and winning does not offer "Create project" | Probe L4; `transitionQuote` (`documents.ts:645`) and `winOpportunity` (`opportunities.ts:256`) touch only their own Zone | Planned, not built | Medium | W1 WF-3 (accept+win); offer per D-WF1-02 in WF-1C-2 |
| G-04 | Opportunity detail shows no quotes, invoices or projects; project detail shows no finance panel or source chips | `opportunity-detail.tsx`, `project-detail.tsx` (no Finance or Sales references); no client for the summary in `api/finance.ts` | Incomplete UI | Medium | WF-1C-1 (opportunity panel), WF-1C-2 (project panel) |
| G-05 | Repeated conversion of one quote is unguarded: convert takes no lock and checks no prior invoices, so over-billing a quote is possible | `convertQuote` (`documents.ts:360-380`) | Planned, not built | Medium | W1 WF-6 / FD-P3 |
| G-06 | No project or opportunity dimension in Reporting; no quote-to-cash funnel; no project margin | Probe L13; `ReportingDimension = ['currency','customer']` (`contracts/src/reporting.ts:30`) | Missing | Medium | W1 WF-7 |
| G-07 | Scheduling events cannot be tied to a project or task, so "project execution" has no visits | `scheduling.prisma` has no project column | Planned | Medium | W1 WF-4/WF-5 |
| G-08 | Customer timeline shows no Sales, Projects or Finance events | Probe L14; `SYSTEM_ACTIVITY_TYPES` (`activities.ts:23-26`) | Planned | Low | W1 WF-8 |
| G-09 | Clients do not map the new link errors: `project_customer_locked` shows "This project changed in a way that prevents saving. Reload…" (misleading); `project_customer_mismatch` relies on the server message | `project-form.tsx:136-139`; no matches for the codes in `packages/app/src/zones` | Incomplete UI | Low | Add to LC-2 |
| G-10 | No end-to-end UI test of the lifecycle (only API-level `cross-zone.test.ts` and unit-level client tests) | No e2e directory; WF-1D not started | Planned | Low | WF-1D |
| G-11 | Finance ids visible to a finance reader lacking `projects:read`/`sales:read` (custom roles only) | §5 P-1 | Future risk | Low | Recheck with custom roles |

No **broken relationships** were found: every existing FK and guard behaved as designed, and the I1 rule holds.
The closest thing is G-01, where a designed relationship exists in the schema but is unreachable.

---

## 7. Dependencies

```
LC-1 (WF-1B-2 workflows API) ──┬──► LC-3 (WF-1C-2 workflow UI) ──► LC-7 (WF-1D e2e, UI half)
                               └──► LC-4 (accept + win) ─────────┘
LC-2 (WF-1C-1 links UI)  ── independent; starts now ──► LC-3
LC-5 (invoice the job, FD-P3) ◄── LC-1
LC-6 (reporting: project, funnel, margin) ◄── LC-1, LC-2 (needs linked data to be meaningful)
Visits (W1 WF-4/5), timeline (W1 WF-8): separate, not on the critical path
```

- **Schema:** none of LC-1..LC-4 needs a migration; WF-1B-1's schema is applied in production. LC-5 and LC-6 are
  expected to be derived reads (W1 §13 "None expected"); confirm in their designs.
- **Open PRs checked for overlap (titles and status only):** #163 A3-A account management, #162 / #160 CI-A6,
  #140 P3-C1 leave ledger. None touches Sales, Projects, Finance documents, `_lib/routes.ts` or contracts for
  these Zones. No reserved migration stamp is needed.
- **UI overlap:** V2-D Zone restyles (not started) will touch the same detail screens; WF-1 R-3 recommends
  WF-1C first.

---

## 8. Proposed implementation packages

Each is one thread, one branch, one draft PR, ChatGPT audit, merge verdict, merge queue. Sizes are estimates.

| Pkg | = existing name | Scope | Gaps closed | Migration | Size |
|---|---|---|---|---|---|
| **LC-1** | WF-1B-2 | `modules/workflows`; `POST workflows/projects/from-opportunity`, `from-quote`, `:id/link-opportunity`, `:id/link-quote`; `GET projects?sourceOpportunityId=`; contracts; tests T-31..39, T-43..46 (WF-1 §12) | G-01 | No | 15–20 files |
| **LC-2** | WF-1C-1 (+G-09) | Project and opportunity pickers on quote/invoice forms (prefilled when started from an opportunity or project), project/customer pickers on the expense form, opportunity "Quotes and invoices" panel, link chips on document detail, client error messages for the I1 codes | G-02, G-04 (opportunity side), G-09 | No | 10–14 files |
| **LC-3** | WF-1C-2 | "Create project" on won/open opportunity and accepted quote, "Link opportunity/quote" on project, project Finance panel (summary client), source chips, "Create quote/invoice from project" | G-03 (offer half), G-04 | No | 12–18 files |
| **LC-4** | W1 WF-3 | Accept quote with optional opportunity win in one transaction, with "Start a job" option calling LC-1; lock-order tests (G-2) | G-03 | No | 8–12 files |
| **LC-5** | W1 WF-6 | Invoice-the-job: draft from project, quote billing figures, over-quote confirmation at draft and issue (FD-P3), convert guard | G-05 | Not expected | 10–15 files |
| **LC-6** | W1 WF-7 | `project` and `opportunity` reporting dimensions and filters, quote-to-cash funnel, project recorded-cost margin per currency | G-06 | Not expected | 10–15 files |
| **LC-7** | WF-1D | End-to-end scenarios E-1..E-7, plus promote this audit's probe into a real suite asserting the *target* behaviour | G-10 | No | 1–2 suites |

Not proposed here: visits (W1 WF-4/5, needs its own migration) and the cross-Zone timeline (W1 WF-8); both stay
in the W1 sequence.

**Recommended order:** LC-1 and LC-2 in parallel now → LC-3 and LC-4 → LC-5 → LC-6 → LC-7 alongside.

---

## 9. Acceptance criteria (testable)

Each criterion is a test in the named package. "Role" means the default roles in `access/server/permissions.ts`.

**LC-1 (workflows API)**
- AC-1.1 `from-opportunity` on an OPEN or WON opportunity creates one project with `sourceOpportunityId` set and
  the opportunity's customer; LOST → 409 `opportunity_lost`; archived → 409 `archived_reference`.
- AC-1.2 Same Idempotency-Key and body → 200 with the same project; different body → 409 `idempotency_conflict`;
  stale `existingProjectCount` → 409 `opportunity_projects_changed`.
- AC-1.3 `from-quote` only from ACCEPTED (409 `quote_not_accepted` otherwise); a second call for the same quote →
  409 `quote_has_project`; MEMBER → 403.
- AC-1.4 After `link-quote`, converting that quote yields a draft invoice whose `projectId` is the project
  (closes probe L7), and the project summary's `acceptedNet` includes the quote (closes probe L10's 0.00).
- AC-1.5 `GET projects?sourceOpportunityId=` returns the created projects for a `sales:read` caller.
- AC-1.6 Every new route: another business's ids → 404/400 and no row; no `sourceQuote*` keys for callers
  without `finance:read`, including in error bodies (G-4).

**LC-2 (links UI)**
- AC-2.1 Starting a quote from an opportunity pre-fills customer, contact and opportunity; the saved draft has
  `opportunityId` set.
- AC-2.2 The invoice and quote forms list only the chosen customer's active projects; picking another customer
  clears an incompatible project before saving (no 400 round trip).
- AC-2.3 The opportunity page lists its quotes and invoices for `finance:read` holders and shows no Finance
  section (not even an empty one) for MEMBER.
- AC-2.4 `project_customer_locked` and `project_customer_mismatch` show specific, plain messages.

**LC-3 (workflow UI)**
- AC-3.1 After "Mark won" the person is offered "Create project", and nothing is created unless they confirm.
- AC-3.2 The project page shows source opportunity (for `sales:read`) and source quote and Finance panel (for
  `finance:read`); MEMBER sees neither, verified in the DOM.
- AC-3.3 "Create invoice from project" opens a draft pre-filled with the project's customer and project.

**LC-4 (accept and win)**
- AC-4.1 Accept with "also win" sets the quote ACCEPTED and the opportunity WON in one transaction; failure of
  either rolls back both; real-PostgreSQL lock-order test shows no `40P01`.
- AC-4.2 Accept without "also win" leaves the opportunity unchanged (D-WF1-04 style).

**LC-5 (invoice the job)**
- AC-5.1 Converting a quote that is already fully invoiced requires explicit confirmation of the current
  figures; without it → 409; with it → draft.

**LC-6 (reporting)**
- AC-6.1 `finance.invoiced_amount` grouped by project returns one row per project per currency; MEMBER → 403.
- AC-6.2 Funnel counts (won → quoted → accepted → invoiced → paid) reconcile with the probe scenario's records.

**LC-7 (end to end)**
- AC-7.1 One scenario walks L1→L14 through the UI-facing API in the *target* order (opportunity → quote →
  accept+win → project from quote → tasks → convert → issue → pay → summary → report) and every link is set.

---

## 10. Decisions

**Decided (Regan, 2026-11-18 15:46 UTC, "I approve all"):** every recommendation below is accepted as written.
This authorises starting the LC-1 and LC-2 build threads (draft PRs). It does not approve any merge, migration or
production action; each package still goes through ChatGPT audit, a merge verdict and the merge queue. LC-1
stays migration-free as designed.

| Id | Question | Decision (recommendation accepted) |
|---|---|---|
| D-WF2-1 | Start LC-1 (WF-1B-2) now? It is already designed and its decisions accepted (D-WF1-07..16); it needs no migration | **Yes** |
| D-WF2-2 | Start LC-2 (WF-1C-1) in parallel with LC-1? | **Yes**; it uses only existing APIs, in its own thread and PR |
| D-WF2-3 | Package naming: adopt LC-1..LC-7 for the lifecycle work (mapping in §8), to end the WF-1/W1 numbering clash (D-WF1-13) | **Yes** |
| D-WF2-4 | Should deal value (opportunity amount) stay visible to MEMBER (§5 P-2)? | **Keep as is** until custom roles exist |
