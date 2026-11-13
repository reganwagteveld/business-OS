# Business OS: Implementation Plan (Phase 1)

> Status: **Draft for review.** No phase after Phase 0 starts until the architecture is approved and the decisions marked "needed by" for that phase are recorded as ADRs.

Related: [architecture.md](./architecture.md) · [data-model.md](./data-model.md)

## 1. Goal of Phase 1

A secure, multi-tenant foundation with one working Zone:

> A person can sign up, create a business, invite colleagues, and manage that business's **customers, contacts and activity history** from the **Home dashboard and Customer Zone**, with tenant isolation verified by automated tests.

Explicitly **not** in Phase 1: Sales, Finance, Projects, Operations and People functionality; AI features; billing; mobile apps; integrations; custom fields; reporting/analytics; any dashboard metric not computed from real records.

## 2. Phase overview

| Phase | Outcome | Depends on | Decisions needed |
|---|---|---|---|
| 0. Architecture review | Approved docs, decisions recorded | — | — |
| 1a. Foundation | Empty app skeleton with enforced boundaries and CI | 0 | D3 (hosting, region) |
| 1b. Identity, tenancy and isolation | Sign-in, businesses, memberships, invitations, RLS proven | 1a | D1 (auth), D4 (URL), D7 (locale) |
| 1c. Shell, Home and Zone registry | Navigable app frame with design system | 1b | D6 (planned Zones on Home) |
| 1d. Customer Zone | Customers, contacts, activity timeline | 1c | D5 (contact cardinality) |
| 1e. Hardening and release readiness | Audit, rate limits, observability, export, a11y, e2e | 1d | DM5 (retention) |

Phases are sequential by dependency, but 1c (UI shell) can start against 1b's tenant context once the context API is stable.

Each phase is delivered as one or more pull requests. **A phase is done only when every acceptance criterion is checked and evidenced** (CI link, test name, or screenshot in the PR).

---

## Phase 0: Architecture review

**Deliverables:** `docs/architecture.md`, `docs/data-model.md`, `docs/implementation-plan.md` (this PR); ADR template.

**Acceptance criteria**

- [ ] Regan has reviewed and approved the three documents (PR approved/merged).
- [ ] D1, D3 and D4 ADRs (`docs/adr/0001` to `0003`) move from Proposed to Accepted, with D3's region filled in (they block 1a/1b). Other decisions may stay open until their phase.
- [ ] ADR 0004 (database isolation design) is accepted as the design to spike in Phase 1b.
- [ ] Any change requested in review is reflected in the docs before scaffolding begins.

---

## Phase 1a: Foundation

**Scope:** Next.js (App Router, TypeScript strict), Tailwind CSS, shadcn/ui initialised, Prisma with multi-file schema, local PostgreSQL via Docker Compose, env validation, lint and boundary rules, test runners, CI. No product features.

**Acceptance criteria**

- [ ] `pnpm install && pnpm dev` starts the app locally against Docker Postgres with a documented one-command setup in `README.md`.
- [ ] `tsconfig` has `strict: true`, `noUncheckedIndexedAccess: true`; `pnpm typecheck` passes with zero errors.
- [ ] Folder structure matches architecture §4 (`app`, `zones`, `modules`, `core`, `ui`).
- [ ] Lint fails on: a deep import into another module (`@/modules/x/server/...`), `modules` importing `app`, client components importing `server-only` code. Each rule is proven by a fixture test that expects the violation to be caught.
- [ ] `dependency-cruiser` runs in CI and fails on circular module dependencies.
- [ ] A test fails if any file outside `src/core/db` imports `@prisma/client`.
- [ ] App boots only if required env vars are valid (zod); a missing var produces a clear error.
- [ ] Two database roles exist in local and CI databases: an owner role for migrations and an app role without `BYPASSRLS`; the app connects as the app role.
- [ ] CI (GitHub Actions) on every PR runs: install, typecheck, lint, boundaries, unit tests, integration tests against a real Postgres service, `prisma migrate diff` check for un-generated migrations.
- [ ] Preview deployment of the empty app succeeds on the chosen host (D3) in the chosen region.

---

## Phase 1b: Identity, tenancy and isolation

**Scope:** auth integration (D1) behind `modules/identity`; `businesses`, `memberships`, `invitations`, `audit_events` tables; onboarding (create first business); business switcher data; tenant context; `tenantAction` wrapper; tenant-scoped Prisma client; RLS; the isolation test suite.

**Starts with a spike** (time-boxed, ~2 days) to prove RLS + Prisma + pooled connections, with a short written result in `docs/adr/`. If the spike fails its targets, stop and review before continuing.

**Spike acceptance criteria**

- [ ] Prisma version, driver adapter, PostgreSQL version and pooler (with its mode and prepared-statement setting) are pinned and recorded in ADR 0004.
- [ ] Tests S1 to S10 from [data-model.md §5.4](./data-model.md#54-rls-spike-what-must-be-proven-before-phase-1b-features) pass in CI against PostgreSQL behind a transaction-mode pooler container: same connection and transaction for context and queries, fail closed with no context (runtime and type level), no carry-over between pooled uses, clean rollback and timeout paths, 0 leaks in 2,000 concurrent interleaved units of work, raw queries filtered by RLS, RLS holds with the app-layer guard disabled, composite FKs hold with RLS bypassed.
- [ ] S11 overhead is measured and recorded; under 2 ms p95 per unit of work, or reported for decision.
- [ ] S12 prepared-statement behaviour behind the pooler is confirmed and any required setting recorded.
- [ ] If any of S1 to S10 fails, work stops and the design is reviewed before features start.

**Feature acceptance criteria**

- [ ] A new user can sign up, verify their email, and sign in; unverified users cannot create or join a business.
- [ ] A signed-in user with no business is sent to onboarding and can create a business; they become its `OWNER`.
- [ ] A user with memberships in two businesses can switch between them; the URL (`/b/[slug]`) reflects the active business.
- [ ] Visiting `/b/<slug>` for a business the user is not a member of returns 404 (not 403, to avoid confirming existence).
- [ ] An owner/admin can invite by email; the invitee can accept only when signed in with that verified email; expired or revoked invitations fail.
- [ ] The last active owner cannot be removed or demoted (service test and UI test).
- [ ] Removing a member revokes their access on their next request (integration test).
- [ ] Every Server Action exported from a `"use server"` module is wrapped in `tenantAction` or `publicAction` (CI check).
- [ ] `business_id` does not appear in any action input schema (CI check).
- [ ] **Isolation suite** (`tests/isolation/`) passes, covering for every tenant table: read, list, update, delete and foreign-key reference from business A to business B fail, both via module services and via raw SQL as the app role.
- [ ] **Schema guard** test passes: every table with a `business_id` column has RLS enabled and forced, a `tenant_isolation` policy, and a `business_id`-leading index.
- [ ] Database roles `bos_owner`, `bos_app`, `bos_auth`, `bos_definer`, `bos_jobs` exist with exactly the grants in data-model §5.1; a test compares actual grants to the expected list.
- [ ] The three pre-tenant `SECURITY DEFINER` functions take a session token (never a user id) and pass every test listed in data-model §5.5: impersonation, forged/expired/revoked sessions, deactivated users, invitation misuse and replay, `PUBLIC`/`bos_auth` execution denied, `search_path` shadowing, and the schema guard for all definer functions.
- [ ] `users` and `audit_events` RLS and column grants pass the tests in data-model §5.6: no enumeration of users outside the current business, no access to auth columns from `bos_app`, platform audit events invisible to `bos_app`, no cross-business audit reads or writes, no updates or deletes.
- [ ] Sign-up, password reset and invitation responses do not reveal whether an email has an account (test compares responses).
- [ ] Sign-in, membership changes, role changes and invitation events write `audit_events`.
- [ ] Rate limiting is active on sign-in, sign-up, password reset and invitation endpoints (integration test hits the limit).

---

## Phase 1c: Shell, Home and Zone registry

**Scope:** design tokens (light/dark), base shadcn/ui components, shared patterns (`ZoneHeader`, `EntityTable`, `EntityForm`, `EmptyState`, `Timeline`), app shell (top bar with business switcher, Zone switcher, search trigger, user menu), Home dashboard, Zone manifest type and registry, command palette, business settings and members screens.

**Acceptance criteria**

- [ ] `ZoneManifest` and `defineZone()` exist; the registry contains Customer (`active`) and the five other Zones (`planned`).
- [ ] Shell, Home tiles, Zone switcher and command palette are all generated from the registry; adding a test manifest in a test makes it appear in all four without touching shell code (component test).
- [ ] A test fails if an `active` Zone has no matching route folder or a route folder has no manifest.
- [ ] Items whose `requires` permission the user lacks are not rendered (component test with a `MEMBER` vs `ADMIN` context), **and** direct navigation to the URL is refused server-side (integration test).
- [ ] Planned Zones follow decision D6 and render no data, numbers or charts.
- [ ] Home shows only widgets whose data comes from real queries; with an empty business, every widget shows an empty state with a next step (e.g. "Add your first customer"). A grep/test guard rejects hard-coded numeric literals in widget components.
- [ ] There is no persistent global sidebar.
- [ ] Command palette opens with ⌘K / Ctrl+K and can navigate to every visible Zone and nav item.
- [ ] Light and dark themes both pass automated contrast checks (axe) on the shell and Home.
- [ ] Keyboard-only navigation works across the shell, Home and Zone switcher (Playwright test).
- [ ] Members screen lets owners/admins view members, change roles (within rules) and invite; members see it read-only or not at all per permissions.

---

## Phase 1d: Customer Zone

**Scope:** `customers` and `activity` modules; Customer Zone routes: customer list, customer detail (profile, contacts, timeline), contact list, contact detail, create/edit/archive; notes and logged calls/meetings; system activities; search across customers and contacts.

**Acceptance criteria**

- [ ] Create, view, edit and archive customers (company or individual); archived customers are hidden by default and can be restored.
- [ ] Create, view, edit and archive contacts, optionally linked to one customer; set a customer's primary contact.
- [ ] Customer detail shows its contacts and a unified timeline including activities logged against its contacts, ordered by `occurredAt`.
- [ ] Users can add a note, a call or a meeting (with back-dated `occurredAt`) to a customer or contact; users can delete their own manual activities; system activities cannot be deleted.
- [ ] Creating, updating and archiving customers and contacts writes a system activity **in the same transaction** (test: forced failure after the write rolls back both).
- [ ] Every activity `type` has a registered zod schema for `data`; writing an unregistered type or an invalid payload fails (unit test).
- [ ] Customer and contact lists use keyset pagination and stay under 300 ms server time at 50k customers / 200k contacts in one business (seeded benchmark, not a production claim).
- [ ] Search by name, email or phone returns matching customers and contacts within the current business only (isolation test included).
- [ ] Contact ↔ customer links across businesses are impossible: attempts via service and raw SQL both fail (isolation suite extended).
- [ ] A customer's primary contact must be one of that customer's own contacts: setting another customer's contact (same business) fails at the database; moving, unlinking, archiving or deleting a primary contact clears the primary in the same transaction, and a path that forgets is rejected by the FK (tests).
- [ ] Every row of the activity history table in data-model §4.7 (contact moved, unlinked, archived, erased; customer erased) has a test showing the expected timeline on the old customer, the new customer and the contact.
- [ ] `MEMBER` can read and write customers/contacts/activity; only `ADMIN`/`OWNER` hold `customers:delete` (hard delete is not exposed in UI in Phase 1); permission tests cover each action.
- [ ] All screens use the shared patterns from 1c; no Zone-specific copies of tables, forms or empty states.
- [ ] Empty states for no customers, no contacts and no activity are designed and contain no sample data.

---

## Phase 1e: Hardening and release readiness

**Acceptance criteria**

- [ ] Security headers (CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors`) are set and verified by an automated check.
- [ ] Error tracking and structured logging are live with `businessId`/`userId` tags; a test confirms request bodies and customer PII fields are not logged.
- [ ] Owners can export all business data (CSV/JSON); export writes an audit event.
- [ ] Contact erasure service removes PII from the contact and related activity payloads (integration test).
- [ ] Scheduled jobs from data-model §7.1 (`purge-archived-businesses`, `scrub-audit-network-data`, `cleanup-expired-auth`) run from platform cron through an authenticated internal route as `bos_jobs`; an unauthenticated or wrong-secret call is rejected (test).
- [ ] Each job is idempotent (running twice changes nothing the second time), single-flight (a concurrent second run exits on the advisory lock), batched, and logs to `job_runs`; failures reach error tracking.
- [ ] The purge job deletes only the target business's rows: a test with three businesses, one due for purge, shows the other two untouched, and RLS confines each purge to its own `withTenant` unit of work.
- [ ] Dry-run mode output was reviewed on staging before destructive jobs were enabled in production.
- [ ] Business archive and scheduled hard-delete work end to end on a staging database.
- [ ] Database backups with point-in-time recovery are enabled; a restore has been performed once on staging and documented.
- [ ] `tenantCache()` is the only cache path for tenant data (lint), and a test proves two businesses never receive each other's cached results.
- [ ] Playwright e2e covers: sign up → create business → invite member → member accepts → create customer → add contact → log a call → see it on the timeline → second business cannot see any of it.
- [ ] axe reports no serious or critical violations on all Phase 1 screens.
- [ ] Dependency scanning is enabled; no known high/critical vulnerabilities at release.
- [ ] A short security review of the diff since Phase 1a is completed and findings are resolved or accepted in writing.

---

## 3. After Phase 1 (indicative only, not committed)

Listed so Phase 1 decisions can be checked against them, not as a plan:

- **AI foundation:** decide D2, build `core/ai`, first assistant capability operating through existing `tenantAction`s (e.g. summarise a customer's history), with a dedicated security review for prompt injection and tenant scoping.
- **Next Zone:** most likely Sales (it reuses customers and contacts), designed with its own data-model doc before any code.
- **Custom roles**, per-business Zone enablement, tags/custom fields, billing: each only when a real user need is confirmed.

## 4. Risks to the plan

| Risk | Effect on plan | Response |
|---|---|---|
| RLS spike fails performance or pooling targets | 1b slips | Options: dedicated pooled role per request, session-mode pooling, or app-layer-only scoping with stronger tests. Requires an explicit decision; not a silent downgrade |
| Auth decision delayed | 1b blocked | 1a can proceed; 1c can start against a stub `requireUser()` used only in tests |
| Scope creep (adding "just one" Sales feature) | Phase 1 never finishes | Anything outside §1 goes to a backlog note, not into Phase 1 PRs |
| Framework major-version change mid-phase | Rework | Pin versions in 1a; upgrade only between phases |
| Design system built ad hoc per screen | Inconsistent Zones, rework | 1c patterns are mandatory for 1d; review checks for it |

## 5. Assumptions for estimating

- One to two developers; each sub-phase is roughly one to three weeks, with 1b the largest because of isolation work. These are rough and will be re-estimated after Phase 0.
- Regan reviews each phase's PRs and approves before the next phase starts.
- Hosting, auth and email accounts can be created when their phase begins.

## 6. Definition of done (every PR)

- CI green: typecheck, lint, boundaries, unit, integration, isolation suite.
- New tenant tables include RLS policy, composite FKs and tests in the same PR.
- New Server Actions use `tenantAction` with a permission and a zod schema.
- No hard-coded or mock business figures in product UI.
- Docs/ADRs updated if the change affects architecture or the data model.
