# ZCR-1: Zone completion audit and roadmap

**Status:** Draft for ChatGPT audit. Documentation only: no code, no migrations, no production change.
**Base:** `main` at `84271b3` (2026-11-17 09:02 UTC, "Fix flaky search leakage test (#111)").
**Method:** read-only inspection of the repository at that commit: route handlers (`apps/api/src/app`), modules
(`apps/api/src/modules`), Prisma schema and migrations, contracts (`packages/contracts`), the shared client
(`packages/app/src`), tests and CI. Specs, PR descriptions and reported test counts were **not** taken as evidence; where
a spec disagrees with the code, the code wins and the difference is listed in §9.
**Not in scope:** implementation, approvals, production access. No production database was read from this thread
(cloud threads cannot reach it), so production state is "last recorded", not verified (§1.3).

## Contents

1. [Baseline and how to read this](#1-baseline-and-how-to-read-this)
2. [Executive summary](#2-executive-summary)
3. [Completeness matrix](#3-completeness-matrix)
4. [Zone findings](#4-zone-findings)
5. [Cross-cutting findings](#5-cross-cutting-findings)
6. [Cross-Zone dependencies](#6-cross-zone-dependencies)
7. [Work in flight (do not duplicate)](#7-work-in-flight-do-not-duplicate)
8. [Roadmap and work packages](#8-roadmap-and-work-packages)
9. [Doc-versus-code discrepancies](#9-doc-versus-code-discrepancies)
10. [Owner decisions needed](#10-owner-decisions-needed)
11. [Blocked on legal, approvals or owner actions](#11-blocked-on-legal-approvals-or-owner-actions)
12. [How to reproduce the evidence](#12-how-to-reproduce-the-evidence)

---

## 1. Baseline and how to read this

### 1.1 The nine Zones audited

The shell registry (`packages/app/src/shell/registry.ts`) lists eight Zone ids. The product has nine functional areas
with backend code, so this audit uses these nine:

| # | Zone | Backend module | Client Zone | In the shell registry? |
|---|---|---|---|---|
| 1 | Customers (customers, contacts, activity timeline) | `modules/customers`, `modules/activity` | `zones/customers`, `zones/activity` | Yes, `built` |
| 2 | Sales | `modules/sales` | `zones/sales` | Yes, `built` |
| 3 | Projects | `modules/projects` | `zones/projects` | Yes, `built` |
| 4 | Finance | `modules/finance` | `zones/finance` | Yes, `built` |
| 5 | People | `modules/people` | `zones/people` | Yes, `built` |
| 6 | Scheduling | `modules/scheduling` | `zones/scheduling` | **No** |
| 7 | Communications (mailboxes, conversations, retention/erasure) | `modules/communications` | none (read-only panels in `zones/activity`) | **No** |
| 8 | Reporting (plus the Home dashboard) | `modules/reporting` | `zones/reporting`, `shell/dashboard` | Yes, `built` |
| 9 | Settings / Administration (business profile, team, invitations, roles) | `modules/tenancy`, `modules/access` | none | Yes, but `planned` ("coming soon") |

"Operations" is also a registry entry, `planned`, with no backend and no defined scope. It is not counted as a Zone here.
Global Search, Notifications and cross-Zone workflows are treated as cross-cutting (§5).

### 1.2 Levels used in the matrix

| Level | Meaning |
|---|---|
| **L0** | Nothing built. |
| **L1** | Schema and API exist; no reachable UI. A user cannot use it. |
| **L2** | API plus partial UI; at least one core job cannot be finished in the app. |
| **L3** | A real business can complete the Zone's core jobs end to end in the app, with known gaps. |
| **L4** | Beta-complete: core and expected secondary jobs, every role path, connected to the neighbouring Zones. |

No Zone is L4 today. A Zone must not be declared complete on the strength of its API or tests alone.

### 1.3 Production state (last recorded, not verified here)

- `main` has **23** migrations (`apps/api/prisma/migrations`, newest `20261205000000_membership_lifecycle`) and privileged
  SQL `001`–`005`. The last recorded production state (`docs/migration-readiness.md` §9, `docs/active-workstreams.md`)
  is the same 23 plus `001`–`005`. **Re-read production `_prisma_migrations` from the Mac session before relying on it.**
- Reserved stamps in open PRs: `20261206000000_search_indexes` (#97, not applied) and `20261207000000_workflow_links`
  (#110, not applied). Any new migration must sort after both.
- Checked live from this thread on 2026-11-17: `GET https://app.pixakova.com/api/v1/health` returned `status: ok`, and an
  unauthenticated `POST /api/v1/b/x/search` returned 404, consistent with `SEARCH_API_ENABLED = false`
  (`apps/api/src/modules/search/server/availability.ts`). The Vercel API token was not usable from this thread, so the
  deployed commit was not confirmed.
- Switched off in code or configuration: search routes (source constant), F6 billing and reminder jobs and E1 retention
  job (`apps/api/src/app/api/internal/jobs/*`, no cron in `apps/api/vercel.json`), Communications sync (no worker exists).

### 1.4 Size of the surface

- 221 route files exporting 291 handlers under `apps/api/src/app/api`.
- 291 endpoints declared in `packages/contracts/src/index.ts` `endpoints` (one per handler).
- Endpoints with **no caller in the shared client** (`packages/app/src`), excluding auth built-ins and finance paths
  the client builds as strings: 0 in Customers core, 3 in activity, 4 in conversations, all 29 in Communications,
  1 in Sales, all 17 in People leave, 3 in Scheduling (plus the whole Zone unmounted), 2 in Search, 14 in Finance
  (13 reminder handlers and the integrity check), and 11 Settings/Administration endpoints (business profile, member
  role change and removal, transfer, step-down, leave, invitations). Method in §12.

---

## 2. Executive summary

Pixa OS has a broad, well-tested backend (RLS, composite tenant keys, version checks and audit across every Zone) and
four Zones a single user can genuinely run day to day: **Customers, Sales, Projects and Finance**. Reporting and the
Home dashboard work on the data those Zones hold. Everything else is either API-only or not reachable.

**Top gaps, in order of business impact:**

1. **A business cannot add a second person in the app.** Invitations, member roles, removal, ownership transfer and
   the business profile all have APIs (A2-A, A2-B) but **no UI** (`registry.ts` marks Settings `planned`; no client
   calls `endpoints.createInvitation`). Every multi-user feature (task assignees, opportunity owners, People links,
   Scheduling resources, permissions by role) is therefore unusable in practice for a new business. The planned UI
   (A2-D) is gated on V2-C, which is not authorised (§10, D-ZCR-1).
2. **Scheduling is built but unreachable.** `zones/scheduling` (calendar views, events, resources, availability) has
   tests (`packages/app/tests/scheduling-zone.test.tsx`) but is not in `registry.ts` or `app.tsx`. The integration patch
   `docs/scheduling-s1-integration.patch` **no longer applies** to `main` (`git apply --check` fails on `app.tsx`).
   Switching it on is an owner decision (D-ZCR-2).
3. **Communications cannot send or receive mail.** C2-A/B1 store OAuth connections and mailbox identity, but there is
   no sync worker (`claimSyncJob` has no caller), no send path and no UI. Conversations can only be recorded through the
   API; the Customer page shows them read-only. Gated on provider setup, Gates A to C and E1 §13 legal decisions.
4. **Zones are not connected.** No quote from an opportunity, no project from a won deal, no project finance view, no
   opportunities on the customer page, no event linked to a project. WF-1B-1 (#110) starts this; the rest is planned.
5. **Finance has no way to deliver documents or chase payment.** Invoices produce PDFs to download; nothing emails them
   and nothing collects online payment. F6-3 reminders exist as an API with **no UI** and the job is off.
6. **People stops at the directory.** Leave types and policies (P3-A) have 17 endpoints and no UI; balances and
   requests (P3-C, P3-B) are not built; members have no People access, so there is no self-service.
7. **Shell placeholders.** Search and Notifications are visible "Soon" buttons (`shell/app-shell.tsx:140-141`), and
   Operations and Settings are "coming soon" cards on Home.
8. **No end-to-end browser tests.** UI tests run against an in-memory fake API (`packages/app/tests/support`); API
   tests run against real PostgreSQL. Nothing exercises a full workflow through the real API and UI together.

**Quick wins with no migration:** mount Scheduling (once approved), an opportunities panel on the customer page, note
edit/remove in the activity timeline, a leave types and policies screen on the existing P3-A API, and the
`projects.tasks_completed` metric (the "needs a Projects change" note is stale, §9).

---

## 3. Completeness matrix

Backend = schema, API, tests. UI = reachable screens. Workflow = can a real business finish the job in the app.

| Zone | Backend | UI | Core workflows end to end | Level | Biggest missing piece |
|---|---|---|---|---|---|
| Customers | Strong: customers, contacts, activity, archive/restore, summary | Directory, detail, form, contacts, timeline, note and interaction logging, read-only conversations | Yes for records and notes | **L3** | Opportunities on the customer page; note edit/remove; import/export |
| Sales | Strong: pipelines, stages (read), opportunities, win/lose/reopen, outcomes, summary | List, Kanban board, detail, form, win/lose/reopen | Yes inside Sales | **L3** | Quote from opportunity; pipeline and stage configuration |
| Projects | Strong: projects, tasks, move/board, archive, summary, customer projects | List, detail, task board with drag and drop, forms | Yes inside Projects (single user) | **L3** | Finance and Sales links (WF-1); assignees need a team (Settings) |
| Finance | Very broad: quotes, invoices, credit notes, payments, allocations, receivables, statements, ageing, expenses, expense payments, catalog, tax, numbering, branding, PDFs, recurring, reminders | Nine sections incl. recurring and statements | Yes: quote to invoice to payment to statement, expenses to paid | **L3** | Document delivery, reminders UI, project/opportunity links, receipts, bank feeds |
| People | Directory, org units, status history, personal details, leave config (P3-A) | Directory, profile, forms, departments, locations, status changes | Yes for HR records only | **L2** | Any leave UI; balances and requests not built; no self-service |
| Scheduling | Calendars, events (DST-safe), resources, availability, conflict-safe bookings | Built but **not mounted** | No (unreachable) | **L1** | Navigation entry (owner decision) |
| Communications | OAuth connections, mailbox identity, domains, addresses, members, retention, legal holds, erasure (dormant), C1 conversations | Read-only conversation history on the customer page | No | **L1** | Sync worker, sending, any mailbox UI |
| Reporting | 9 executable metrics, 5 planned, query, details, saved and shared views | Dashboard, Explore, Saved reports; Home operational dashboard | Yes for the 9 metrics | **L3** | Expense, profit, scheduling, people and communications metrics |
| Settings / Administration | Business profile, members, invitations, ownership, step-down, leave, invite-only admission | **None** (Home card "coming soon") | No | **L1** | A2-D Settings stage 1 |

---

## 4. Zone findings

Each Zone lists (a) backend that exists, (b) UI that exists, (c) workflows, (d) gaps, (e) placeholders and dead
controls, (f) security and permission notes. Paths are relative to the repository root; `routes/` means
`apps/api/src/app/api/v1/b/[slug]/`.

### 4.1 Customers (L3)

**(a) Backend.** `routes/customers` (list, create, get, patch, archive, restore, summary, `:id/projects`),
`routes/contacts` (CRUD, archive, restore), `routes/activities` (list, create, get, patch note, remove),
`routes/conversations` (list, create, get, messages list/record/import). Modules `modules/customers`,
`modules/activity`, `modules/communications/server/communications.ts`. Tests: `apps/api/tests/integration/customers.test.ts`,
`communications.test.ts`, `cross-zone.test.ts`.

**(b) UI.** `zones/customers/directory.tsx`, `customer-detail.tsx`, `customer-form.tsx`, `manage-contacts.tsx`,
`activity-composer.tsx`; `zones/activity/*` (timeline, note composer, log-interaction form, conversation history).
The detail page also shows the customer's projects (`zones/projects/customer-projects.tsx`) and finance
(`zones/finance/customer-finance.tsx`) when the viewer holds those keys (`customer-detail.tsx:182-202`).

**(c) Workflows.** Create and edit a customer with contacts: yes. Archive and restore: yes. Log notes, calls, meetings
and emails as activities: yes. See the customer's projects, invoices and balance: yes. See the customer's sales
opportunities: **no**. Edit or remove a logged note: **no**. Record an email conversation: API only.

**(d) Gaps.**
- No opportunities panel on the customer page, although `ListOpportunities` accepts `customerId`
  (`packages/contracts/src/sales.ts:140`).
- Activity note edit and remove (`endpoints.updateNote`, `removeActivity`, `getActivity`) have no UI.
- Conversation create, record and import have no UI; conversation history is read-only by design until C2-D.
- No customer import or export (no CSV anywhere in `apps/api/src` or `packages/app/src`).
- No customer-level scheduling view (Scheduling unmounted).

**(e) Placeholders.** None found.

**(f) Security.** All records visible to every role holding `customers:read` (including MEMBER); `can()` ignores the
`ResourceScope` argument (`modules/access/server/permissions.ts`), so there is no record-level ownership. This is the
Phase 1 design, not a defect, but it matters before larger teams (§10, D-ZCR-9).

### 4.2 Sales (L3)

**(a) Backend.** `routes/sales`: pipelines (list, create, `default`), stages (list only), opportunities (CRUD, archive,
restore, win, lose, reopen, outcomes), summary. `modules/sales/server/pipelines.ts` (`ensureDefaultPipeline`). Tests:
`integration/sales.test.ts`, `packages/app/tests/sales-*.test.tsx`.

**(b) UI.** `zones/sales/opportunity-list.tsx`, `pipeline-board.tsx` (Kanban), `opportunity-detail.tsx`,
`opportunity-form.tsx` (customer, contact, stage, amount, currency, probability, close date, owner).

**(c) Workflows.** Set up the default pipeline, create, move, win, lose and reopen opportunities: yes. Turn a deal into
a quote or a project: **no** (WF-1). Configure stages or add a second pipeline: **no**.

**(d) Gaps.**
- No stage create, rename, reorder or delete endpoint exists; `createPipeline` has an API but no UI. Every business gets
  the fixed default stages.
- Quote from opportunity and project from opportunity are WF-1 scope (§7).
- Opportunity owners need team members, so in practice only the creator can own (Settings gap).
- `sales:manage` gates only `POST sales/pipelines`, which has no UI.

**(e) Placeholders.** None found.

**(f) Security.** As Customers: no record-level scoping for MEMBER.

### 4.3 Projects (L3)

**(a) Backend.** `routes/projects`: projects (CRUD, archive, restore, summary), tasks (list, create, patch, move,
archive, restore). Version checks and `completed_at` consistency constraints in
`prisma/migrations/20261114120000_projects/migration.sql:120-127`. Tests: `integration/projects.test.ts`,
`packages/app/tests/projects-*.test.tsx`.

**(b) UI.** `zones/projects/project-list.tsx`, `project-detail.tsx`, `task-board.tsx` (HTML5 drag and drop),
`project-form.tsx` (customer, owner, dates), `task-form.tsx` (assignee, priority, due date).

**(c) Workflows.** Plan a project with tasks and move them across the board: yes. Assign tasks to colleagues: only if
colleagues exist, which needs the API (Settings gap). See quotes, invoices, costs or margin for a project: **no** (WF-1).
Schedule project work: **no**.

**(d) Gaps.** Project finance summary and links (WF-1B/1C); project from accepted quote or won deal (WF-1B-2); task
comments, attachments and time tracking do not exist (no schema). No "my tasks" view across projects.

**(e) Placeholders.** None found.

**(f) Security.** MEMBER holds `projects:create/update/manage_tasks` on every project.

### 4.4 Finance (L3)

**(a) Backend.** 87 route files under `routes/finance` (the largest surface): documents (quotes, invoices, credit notes
with issue/void/discard/accept/decline/expire/convert), payments and allocations with reversal, credit applications,
customer balances, receivables, statements (+PDF), ageing (+detail), expenses, expense categories, expense payments,
catalog, tax rates, number series, settings, branding and logo, PDF versions and draft previews, recurring invoices
(preview, generate, pause, resume, cancel, runs, retry, skip), reminder policies, holds, reminders, per-customer
reminder settings, and an internal integrity check (`finance/reconciliation`, read-only, not bank reconciliation).
Integration suites run behind PgBouncer in CI (`.github/workflows/ci.yml:185-217`).

**(b) UI.** `zones/finance/*`: Overview, Quotes, Invoices, Credit notes, Payments, Receivables (statements and ageing),
Expenses (with payments), Products and services, Settings (tax, numbering, branding) and recurring invoices
(`recurring.tsx`). The client is `packages/app/src/api/finance.ts`.

**(c) Workflows.**

| Job | In the app? |
|---|---|
| Quote, issue, accept, convert to invoice | Yes (acceptance is recorded by staff; no customer-facing accept) |
| Invoice, issue, PDF, record payment, allocate, receivables, statement PDF | Yes |
| Credit note and apply credit | Yes |
| Expenses: draft, record, pay, void | Yes, without receipts (FD-P6, `zones/README.md`) |
| Recurring invoices: schedule, preview, generate manually | Yes; automatic generation is off (F6 job) |
| Send a quote, invoice or statement to the customer | **No**: download and send outside Pixa OS |
| Payment reminders | **No UI**; job off |
| Online card or bank payment | **No** |
| Bank feeds and bank reconciliation | **No** (F8 architecture only) |
| Link documents and expenses to a project or opportunity | API fields exist, **no UI**; rules arrive with WF-1B-1 (#110) |

**(d) Gaps.** Reminders UI (13 handlers); document delivery (outbound email, an external effect: Regan); receipt
attachments (file storage decision); online payments (paid provider: Regan); F8 banking; project and opportunity
linking (WF-1); expense metrics in Reporting.

**(e) Placeholders.** None in Finance screens.

**(f) Security.** MANAGER has write but not issue or payments; MEMBER has no Finance. Finance figures in other Zones
are gated by Finance keys (W1 gate G-4 to be proven in WF-1). No new issue found.

### 4.5 People (L2)

**(a) Backend.** `routes/people`: employees (CRUD, status, department, manager, history, personal details),
departments and locations (CRUD, archive, restore), leave types and leave policies (CRUD, archive, restore, revisions,
assignments, per-employee policies, end assignment). Tests: `integration/people.test.ts`, `people-leave.test.ts`,
`unit/people-boundaries.test.ts`.

**(b) UI.** `zones/people/people-zone.tsx` tabs Employees, Departments, Locations; profile with history and sensitive
personal section (`people:read_sensitive`); status dialog; employee link to a team member (`employee-form.tsx`,
`userId`).

**(c) Workflows.** Maintain an employee directory and reporting lines: yes. Configure leave types and policies: API
only. Request, approve or track leave: **not built**. An employee viewing their own record: **no** (MEMBER has no
`people:*` key, `permissions.ts`).

**(d) Gaps.** P3-A UI; P3-C ledger and P3-B requests; self-service (P3-B uses the `user_id` link); linking an employee
to a user needs the user to be a member first (Settings gap); leave on the schedule (P3-E).

**(e) Placeholders.** None found.

**(f) Security.** `people:read_sensitive` separation is enforced server-side; keep it when adding self-service.

### 4.6 Scheduling (L1: built, unreachable)

**(a) Backend.** `routes/scheduling`: calendars (CRUD, default, archive, restore), events (CRUD, cancel, archive, linked
customer), resources (CRUD, archive, restore, availability), business availability. ADR 0006 privacy (busy-only
details). Tests: `integration/scheduling.test.ts`, `scheduling-resources.test.ts`, `unit/scheduling-access.test.ts`,
isolation spike suite.

**(b) UI.** `zones/scheduling/*`: day, week and month views, event form with DST disambiguation, event detail,
resources screen, resource timeline, resource picker. Covered by `packages/app/tests/scheduling-zone.test.tsx`.
**Not mounted:** no `scheduling` id in `ZoneId`, no entry in `ZONES`, no branch in `app.tsx` (only the test imports
`SchedulingZone`). `docs/migration-readiness.md` §9 (S2) records "Scheduling navigation not switched on" by instruction.

**(c) Workflows.** None in the app.

**(d) Gaps.** Navigation entry (the documented patch is stale); project and task links on events (W1 WF-4); event
completion (WF-5); leave on the calendar (P3-E); `getCalendar`, `archiveCalendar`, `restoreCalendar` have no UI;
`scheduling.events_scheduled` metric is planned.

**(f) Security.** Mounting it is a "switch on a disabled feature" merge, so it escalates to Regan (protocol, "Merges are
deployments").

### 4.7 Communications (L1)

**(a) Backend.** `routes/communications` (23 route files, 29 handlers): providers, OAuth authorize and callback
(`api/v1/communications/oauth/callback`), connections (get, patch, disconnect, members, sync request, sync jobs),
business domains (add, verify, remove), business addresses, retention settings and eligibility, legal holds, erasures.
Provider adapters `modules/communications/server/providers/{google,microsoft}.ts` implement code exchange, account,
business mailbox and revoke only. Sync jobs table and lease state machine exist (`sync-jobs.ts`), but **no worker
claims jobs** and no adapter fetches or sends mail. E1 erasure and retention are dormant (job answers 503).

**(b) UI.** None for mailboxes, settings or erasure. Read-only conversation history on the customer page
(`zones/activity/conversation-history.tsx`), tested in `packages/app/tests/communications-ui.test.tsx`.

**(c) Workflows.** None a business can complete: no mailbox can be connected from the app, no mail arrives, none is sent.

**(d) Gaps.** C2-B2 sharing, C2-B3 inbound sync, C2-B4 sync operations, C2-C sending, C2-D interface
(`docs/communications-c2.md` §17). Provider registrations, credentials key and STAB-H2 are owner actions (§573-590 of
that doc). C2-UI plan in flight as draft #114.

**(f) Security.** Credential encryption, PKCE and mailbox classification exist; the erasure/retention design carries
legal decisions (§11).

### 4.8 Reporting and the Home dashboard (L3)

**(a) Backend.** `routes/reporting`: metrics, query, details, saved views (CRUD, run, share). Registry
`modules/reporting/server/registry.ts`: 9 executable metrics (invoiced amount, invoices issued, credited amount,
payments received, receivables outstanding and overdue, won value, won count, new customers) and 5 `planned`
(expenses recorded, tasks completed, events scheduled, headcount, messages recorded). Summary endpoints feed Home:
`customers/summary`, `sales/summary`, `projects/summary`.

**(b) UI.** `zones/reporting/*` (Dashboard, Explore, Saved reports; "Not available yet" section for planned metrics) and
`shell/dashboard/operational-dashboard.tsx` on Home.

**(c) Workflows.** Revenue, receivables and sales performance over a period, saved and shared: yes. Costs, profit,
utilisation, headcount: **no**.

**(d) Gaps.** The 5 planned metrics; no profit or margin (needs expenses and WF-7); no export.

### 4.9 Settings / Administration (L1)

**(a) Backend.** `routes/business` (profile get/patch), `routes/members` (list, change role, remove, transfer
ownership), `routes/membership` (step-down, leave), `routes/invitations` (list, create, resend, revoke),
`api/v1/invitations/accept`, invite-only admission (`api/v1/access`). Tests: `integration/business-profile.test.ts`,
`membership-lifecycle.test.ts`, `beta-admission.test.ts`, `tenancy.test.ts`.

**(b) UI.** Only onboarding (`shell/onboarding.tsx`: name, address, country, currency, time zone, locale) and invitation
acceptance (`auth/auth-screens.tsx:180`). Settings is `planned` in `registry.ts`. Per-Zone settings exist inside Finance
only.

**(c) Workflows.** Create a business: yes. Invite a colleague, change a role, remove someone, transfer ownership, edit
the business profile: **no** (API only).

**(d) Gaps.** A2-C roles read API, A2-D Settings stage 1, A3-A account (password, sessions), A2-E/A3-C audit log viewer
(`AuditEvent` has no read route; `audit:read` is unused), A3-D lifecycle (archive, deletion, export).

**(f) Security.** A3-0 allow-list merged (#85). A3 §16 lists a hard gate before wider beta: transfer step-up
(D-A3-17). Any Settings UI must show `delivery: failed` and resend wait for invitations (`active-workstreams.md`, A2-B).

---

## 5. Cross-cutting findings

| Area | State | Evidence |
|---|---|---|
| Global search | Backend merged and **disabled**; index migration #97 not applied; UI is a "Soon" button | `modules/search/server/availability.ts`, `shell/app-shell.tsx:140` |
| Notifications | Architecture only (N1, #80); "Soon" button | `shell/app-shell.tsx:141`, `docs/notifications-n1-architecture.md` |
| Cross-Zone workflows | W1 and WF-1A docs merged; WF-1B-1 draft #110 | `docs/cross-zone-workflows-w1.md`, `docs/cross-zone-workflows-wf1.md` |
| Files and attachments | Only the Finance branding logo is stored; no general file storage | `prisma/schema/finance-documents.prisma` |
| Outbound email | Only auth and invitation mail via Resend (`core/email`); no customer-facing mail | `docs/communications-c2.md` §1 |
| Background work | Three cron routes exist, none scheduled; no queue or worker runtime | `api/internal/jobs/*`, `apps/api/vercel.json` |
| Roles | Four fixed roles; no custom roles; no record-level scope | `modules/access/server/permissions.ts` |
| Audit | Written in every Zone; no viewer | `prisma/schema/tenancy.prisma` (`AuditEvent`) |
| Testing | Strong API integration and isolation suites on real PostgreSQL; UI tests use a fake API; visual harness #108 non-gating; no full-stack end-to-end tests | `apps/api/tests`, `packages/app/tests/support` |
| Desktop release | CI-2B nightly macOS build merged; CI-2C three-platform validation draft #113; signing and auto-update open (D9c/d) | `.github/workflows/nightly.yml` |
| Design system | V2-B1 tokens, V2-B2-2 foundations and Pixa Rail merged; V2-C and V2-D not authorised | `docs/ui/*` |

---

## 6. Cross-Zone dependencies

```text
Settings A2-D (team, invitations, profile)
  ├─► every multi-user job: task assignees, opportunity owners, People user links, Scheduling resources, mailbox members
  └─► A2-E/A3-C audit viewer, A3-A account, A3-B integrations pages
V2-C (not authorised) ──gates──► A2-D (per A3 §16)       ← D-ZCR-1 asks to decouple

WF-1B-1 (#110, migration 20261207) ─► WF-1B-2 endpoints ─► WF-1C-2 UI ─► WF-1D e2e
WF-1C-1 pickers/panels (parallel) ─► Customers opportunities panel overlaps (§8 WP-C1)
WF-1 ─► WF-2 workflow_requests ─► WF-3 accept+win ─► WF-6 invoice-from-project ─► WF-7 margin (Reporting)
Scheduling mount ─► WF-4 event↔project ─► WF-5 completion ─► P3-E leave on calendar

P3-A (merged) ─► P3-C ledger ─► P3-B requests (self-service via user_id, needs A2-D) ─► P3-D UI ─► P3-E

C2-B2 ─► C2-B3 sync ─► C2-B4 ─► C2-C send ─► C2-D UI      (all gated on provider setup, Gates A-C, E1 §13 legal)
Finance document delivery ─► C2-C (send from mailbox) or Resend (owner choice, external effect)
Search: #97 index migration ─► GS readiness gate ─► enablement PR (Regan) ─► GS2 palette UI (replaces "Soon")
N1 notifications ─► reminders, approvals, mentions; replaces "Soon"
```

---

## 7. Work in flight (do not duplicate)

Checked against GitHub on 2026-11-17 09:10 UTC and the coordinator's brief.

| Item | Where | Owns (from the changed-file list) | Status |
|---|---|---|---|
| WF-1B-1 workflow links | draft #110 | Migration `20261207000000_workflow_links`, `routes.ts`, finance document routes and `documents.ts`/`expenses.ts`, `projects.ts`, new `finance/projects/:id/summary`, contracts `finance.ts`/`projects.ts`/`index.ts`/`api-v1.json` | Not applied; needs audit, preflight, recovery branch, apply approval before merge |
| GS1-A search indexes | #97 | Migration `20261206000000_search_indexes`, rehearsal scripts | Not applied; enablement separately not authorised |
| C2-UI mailbox audit and plan | draft #114 | `docs/communications-c2-ui.md` | Docs only |
| CI-2C release validation | draft #113 | `.github/workflows/release-validation.yml`, `.github/scripts/*`, `ci.yml` | No publish |
| V2-B2-1 visual harness | #108 | `tooling/visual/*` | Non-gating |
| P3-B leave architecture | thread (no PR found at this base) | People leave docs | Do not start P3 code until decided |
| Settings A3 / A2-D | thread (no PR found at this base) | Settings UI, `registry.ts` | Gated per A3 §16 |
| #53, #48 | open, stale | — | Ignore unless Regan asks |

---

## 8. Roadmap and work packages

Rules for parallel work: one thread, branch and draft PR per package. **Hot files** that conflict across packages:
`packages/app/src/app.tsx`, `packages/app/src/shell/registry.ts`, `packages/contracts/src/index.ts` and
`packages/contracts/schema/api-v1.json`, `apps/api/src/app/api/_lib/routes.ts`, and migration order. A package that
touches a hot file says so below and must sequence with the others that do.

### 8.1 Wave 1: unlock what is already built (no migrations)

| ID | Package | Owned paths | Hot files | Depends on | Gate |
|---|---|---|---|---|---|
| **WP-S1** | Mount Scheduling: registry entry, `app.tsx` branch, cross-links from customer to events; refresh or delete the stale patch | `zones/scheduling/*` (light), `shell/registry.ts`, `app.tsx`, `docs/scheduling-s1*.md` | registry, app.tsx | — | **Regan** (switches on a feature), D-ZCR-2 |
| **WP-A1** | A2-C roles read API (`GET /access/roles`) and matrix tests | `routes/access/*` (new), `modules/access`, contracts | contracts | — | ChatGPT verdict |
| **WP-A2** | A2-D Settings stage 1: Business › General, Team (members, invitations, roles), Ownership | new `zones/settings/*`, `api/tenancy.ts`, registry (Settings `built`), app.tsx | registry, app.tsx | WP-A1; **D-ZCR-1** | ChatGPT verdict |
| **WP-C1** | Customer page: opportunities panel; activity note edit and remove | `zones/customers/customer-detail.tsx`, `zones/activity/*`, `api/customers.ts`, `api/sales.ts` | app.tsx (Sales link only) | Coordinate with WF-1C-1 | ChatGPT verdict |
| **WP-P1** | Leave types and policies screens on the P3-A API (configuration only, OWNER/ADMIN) | `zones/people/leave-*` (new), `api/people.ts` | — | D-ZCR-5 (or wait for P3-D) | ChatGPT verdict |
| **WP-R1** | `projects.tasks_completed` metric from `project_tasks.completed_at` | `modules/reporting/server/*`, `modules/projects` read model | — | Semantics decision on reopened tasks | ChatGPT verdict |
| **WP-T1** | Full-stack golden-path e2e (sign up, create business, customer, opportunity, quote, invoice, payment) on local PostgreSQL | `tooling/e2e/*` (new) | — | — | ChatGPT verdict |

WP-S1 and WP-A2 both edit `registry.ts` and `app.tsx`: merge them one after the other, not in parallel branches with
long lives.

### 8.2 Wave 2: connect the Zones (in flight, keep the existing order)

| ID | Package | Notes |
|---|---|---|
| WF-1B-1 | #110 | Apply migration before merge (protocol) |
| WF-1B-2 | Workflows endpoints (from-opportunity, from-quote, link) | After #110 |
| WF-1C-1 / WF-1C-2 | Pickers, link panels, project finance summary UI | WF-1C-1 overlaps WP-C1 on the customer page: one owner |
| WF-1D | End-to-end tests | Reuse WP-T1 harness |
| WF-4/5 | Event ↔ project/task, event completion | After WP-S1; needs migration |

### 8.3 Wave 3: finish the half-built Zones

| ID | Package | Migration | Gate |
|---|---|---|---|
| P3-C → P3-B → P3-D | Leave ledger, requests and approvals, leave UI and self-service | Yes (two) | D-P3-12..25 |
| F-REM | Finance reminders UI (policies, holds, reminder list, dismiss) | No | Useful only with the reminder job or manual sending; D-ZCR-6 |
| F-DEL | Document delivery (email quote, invoice, statement) | Probably | **Regan** (outbound email), D-ZCR-4 |
| F-RCPT | Expense receipts and attachments | Yes | File storage decision (cost): D-ZCR-7 |
| S-CFG | Sales pipeline and stage configuration | Yes (stage writes) | D-ZCR-8 |
| R-MET | Expenses, events, headcount metrics | No | Per source Zone |
| A-AUD | A2-E audit viewer API + A3-C UI | No | After WP-A2 |
| A3-A | Account: password, sessions, step-up; transfer step-up before wider beta | Yes | D-A3-11/12 |

### 8.4 Wave 4: external effects and paid services (owner-led)

C2-B2 → C2-B3 → C2-B4 → C2-C → C2-D; E1 activation; Search enablement and GS2 palette; N1 notifications; F6 jobs on;
F8 banking; online payments. Each needs Regan's explicit approval and, for Communications, legal decisions (§11).

### 8.5 Suggested parallel lanes right now

Four lanes with no file overlap: (1) WP-A1 then WP-A2 if D-ZCR-1 is approved; (2) WF-1B-1 to WF-1B-2 (#110);
(3) WP-P1 or P3-C (People only); (4) WP-T1 (tooling only). WP-S1 joins lane 1's sequence once approved.

---

## 9. Doc-versus-code discrepancies

| Document says | Code says | Action |
|---|---|---|
| `registry.ts` planned note for `projects.tasks_completed`: "Projects has no completion timestamp on tasks yet" | `project_tasks.completed_at` exists with a CHECK (`status = 'DONE'`) since `20261114120000_projects`, set in `modules/projects/server/tasks.ts:94,119,214` | Fix the note in WP-R1; note that reopening a task clears it |
| `docs/scheduling-s1.md` §: "apply `scheduling-s1-integration.patch`" | Patch fails on `packages/app/src/app.tsx` | Replace in WP-S1 |
| `docs/agent-context.md` product map: "Scheduling: Merged"; "Administration: A2-B draft PR #76" | Scheduling merged but unreachable; A2-B merged as `f866b2b` | Refresh agent-context in a docs PR |
| `docs/active-workstreams.md` snapshot of 2026-11-16 (`4dfdbe1`) | 28 commits since; open PRs are now #53, #48, #97, #108, #110, #113, #114 | Refresh on request |
| `packages/app/src/zones/README.md` "Built" list omits Scheduling, Communications panels, Finance beyond F3 | Finance has nine sections; Scheduling built, not mounted | Refresh with WP-S1 |

---

## 10. Owner decisions needed

| ID | Decision | Recommendation | Why it matters |
|---|---|---|---|
| **D-ZCR-1** | Let A2-D (Settings stage 1) start on the current V2-B foundations instead of waiting for V2-C | **Yes** | It is the single biggest blocker: without it no business can add a second person |
| **D-ZCR-2** | Switch on the Scheduling Zone in navigation | **Yes**, as WP-S1 with its own audit | Built and tested, invisible to users |
| D-ZCR-3 | Order of Wave 1 vs finishing WF-1 | Run in parallel lanes (§8.5) | Avoids idle threads |
| D-ZCR-4 | How documents reach customers: send from the user's mailbox (waits for C2-C) or Pixa-sent mail via Resend now | Decide channel first; Resend is faster but is an external effect and a cost line | Invoicing is incomplete without delivery |
| D-ZCR-5 | Build leave configuration screens now (WP-P1) or wait for P3-D | Now, configuration only | Uses a merged API; no schema |
| D-ZCR-6 | Turn on F6 billing and reminder jobs, and when | Not before document delivery is decided | Reminders without delivery do nothing useful |
| D-ZCR-7 | File storage provider for receipts and attachments | Feasibility note first | Paid service, retention and privacy impact |
| D-ZCR-8 | Custom sales stages and multiple pipelines | Stage editing only, one pipeline | Common SMB expectation; needs migration |
| D-ZCR-9 | Record-level visibility (own records only for MEMBER) | Defer until after Settings; document as known limit | Larger teams and sensitive deals |
| D-ZCR-10 | Remove the "Operations" placeholder or define it | Remove or define in one line | A permanent "coming soon" erodes trust |

---

## 11. Blocked on legal, approvals or owner actions

| Item | Blocked on |
|---|---|
| E1 retention and erasure activation | Legal decisions in `docs/communications-e1.md` §13 |
| Any real mailbox (C2-B3 onward) | Google and Microsoft app registrations, credentials key in Vercel, STAB-H2, Gates A-C (`communications-c2.md` §14, §17) |
| Search enablement (GS2-C) | Not authorised; needs #97 applied and the readiness gate |
| V2-C, V2-D | Not authorised |
| WF-1B-1 production migration | Own audit, preflight, recovery branch, apply approval |
| F6 jobs, cron, workers, outbound email, billing | Regan (not delegated) |
| F8 banking | Feasibility, provider cost, legal Q1-Q8 (`finance-banking-f8.md`) |
| N1 notifications | Implementation not authorised |
| P3-B/C | Decisions D-P3-12..25 |
| Wider beta | A3 transfer step-up gate (D-A3-17) |

---

## 12. How to reproduce the evidence

All commands are read-only and run at `84271b3`.

```bash
# Route handlers by area
find apps/api/src/app -name route.ts | sed 's|apps/api/src/app/||' | sort
# Contract endpoints with no caller in the shared client (finance builds paths as strings: check api/finance.ts by hand)
sed -n '/export const endpoints/,$p' packages/contracts/src/index.ts \
  | perl -0ne 'while(/^\s+(\w+):\s*\{\s*method/mg){print "$1\n"}' \
  | while read n; do grep -rqw "endpoints\.$n" packages/app/src || echo "$n"; done
# Scheduling not mounted, stale patch
grep -n "scheduling" packages/app/src/shell/registry.ts packages/app/src/app.tsx
git apply --check docs/scheduling-s1-integration.patch
# Sync worker absent
grep -rn "claimSyncJob" apps/api/src | grep -v sync-jobs.ts
# Shell placeholders
grep -n "<Unavailable" packages/app/src/shell/app-shell.tsx
# Reporting planned metrics
grep -n "PLANNED, id:" apps/api/src/modules/reporting/server/registry.ts
```
