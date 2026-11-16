# Pixa OS — Agent Context

**Purpose:** Fast onboarding for Claude agents working in `reganwagteveld/business-OS` without rereading every pull request.
**Snapshot:** 2026-11-16 (Australia/Perth), checked against `main` at `e3eb636` and the open PRs of that day. **This is a navigation aid, not a source of live truth.**

Read with [agent-task-protocol.md](./agent-task-protocol.md) (how to run a task) and [active-workstreams.md](./active-workstreams.md) (who owns what right now).

## Product

Pixa OS (repository and package names still say Business OS) is a desktop-first, multi-tenant operating system for small and medium businesses, developed under Pixakova. The goal is one cohesive all-in-one experience rather than disconnected modules: Zones (Customers, Sales, Projects, Finance, People, Scheduling, Communications, Reporting) reached from a Home dashboard through the app shell (`packages/app/src/shell`).

Initial go-to-market hypothesis: English-speaking US small businesses of roughly 5–50 people. The platform is international by default (per-business currency, locale and time zone; no US-only fields) and should not hit an artificial ceiling as customers grow. Do not build enterprise features early.

Production is an **invite-only private beta**: platform admission and the right to create a business are granted per user by an operator (PR #71, `docs/private-beta-lockdown.md`).

## Working model

- **Regan** is the owner and makes every final decision.
- **Claude on Regan's Mac** (a Remote Control session in the local checkout) is the primary developer and owns each active PR end to end: code, tests, CI, Vercel and Neon. Cloud threads cannot reach the production database.
- **ChatGPT** does independent architecture, security and quality audits. Regan relays its findings.
- **One thread, one branch and one draft PR per numbered piece of work** (for example A2-B, P3-A, GS1). Fixes for that work stay in the same thread and PR.
- The roadmap is GitHub issue #55.

## Technical orientation

Always confirm framework versions, paths, commands, migrations and API contracts in the repository. Do not guess. The stack as merged on `main`:

- **pnpm monorepo** (`pnpm-workspace.yaml`): `apps/api`, `apps/web`, `apps/desktop`, `packages/app`, `packages/ui`, `packages/contracts`. See the table in `README.md`.
- **Clients:** Tauri 2 desktop app (Windows and macOS) and a companion browser app, sharing one Vite/React client (`packages/app`). Clients reach data **only through the API**. They never import server code or talk to Postgres. `pnpm boundaries` and `tests/architecture` enforce this (ADR 0005).
- **API:** Next.js route handlers in `apps/api`, used as an API only, under `/api/v1`. Tenant routes are `/api/v1/b/:slug/...` (ADR 0003). Contracts live in `packages/contracts` and stay additive within `/api/v1`. `apps/api/AGENTS.md` warns that this Next.js version differs from training data.
- **Auth:** Better Auth (ADR 0001).
- **Hosting:** Vercel. **Merging to `main` deploys to production automatically.** Database: Neon PostgreSQL in `aws-us-east-1` (ADR 0002).
- **Data:** Prisma migrations in `apps/api/prisma/migrations`. Privileged SQL (`SECURITY DEFINER` functions, grants) lives in `apps/api/prisma/privileged/*.sql` and is applied with `pnpm --filter @business-os/api db:privileged`, not by Prisma.
- **Tenant isolation** (architecture.md §7.3, ADR 0004): every tenant table has `ENABLE` and `FORCE ROW LEVEL SECURITY`; the app connects as `bos_app` (no owner rights, no `BYPASSRLS`); tenant code runs inside `withTenant` / `TenantDb`; child rows use **composite tenant foreign keys** `(business_id, parent_id)`; tenant data is never cached without `businessId` in the key; `tests/isolation` and a schema test enforce all of this in CI.
- **Roles:** Owner, Admin, Manager, Member with module-specific permission keys. Do not assume any role can read a record or field without checking the implementation.
- **Security invariants:** enforce tenant isolation server-side and in SQL; check record-level and field-level authority; never rely on UI gating alone; preserve audit logs and optimistic concurrency/locking (ADR 0007, ADR 0008) where they exist.
- **Protected:** the production database, authentication and admission policies, migration execution, live integrations, scheduled jobs and credentials. Nothing touches production without Regan's explicit approval (see the protocol).

## Current product map — verify against main

Status as of 2026-11-16. "Merged" means the code is on `main`. It does **not** mean a feature is switched on in production.

| Zone / capability | State | First lookup |
|---|---|---|
| Customers & Contacts | Merged: records, contacts, activity timeline | `apps/api/src/modules/customers`, `docs/data-model.md` |
| Sales | Merged: pipeline and Kanban board | `docs/sales-data-model.md` |
| Projects | Merged: projects, tasks, board, locking/versioning | `docs/projects-data-model.md` |
| Finance | Merged: F1–F5 (quotes, invoices, payments ledger, expenses, PDFs), F6 recurring billing, statements and reminders, F7-A/B catalog. F6 scheduled jobs stay **off**. | `docs/finance-data-model.md`, `docs/finance-*.md` |
| Finance F8 banking | Architecture being drafted in a thread; no PR yet | Wait for its docs PR |
| People | Merged: P1 workforce, P2 employee interface. P3-A leave policies: open PR #68 | `docs/people-data-model.md`, `docs/people-p2.md` |
| Scheduling | Merged: S1 calendars/events, S2 resources and availability | `docs/scheduling-s1.md`, `docs/scheduling-s2.md` |
| Communications | Merged: C1 activity foundation, C2-A provider foundation, C2-B1 mailbox identity, E1 retention/erasure (**dormant**; activation waits on the legal decisions in `communications-e1.md` §13) | `docs/communications-c2.md`, `docs/communications-e1.md` |
| Reporting | Merged: R1 metrics and saved reports, R2 interactive dashboards (#62) | `docs/reporting-r1.md`, `docs/reporting-r2.md` |
| Administration | Merged: A2-A business profile API (#70), invite-only admission (#71). A2-B membership lifecycle: draft PR #76 | `docs/administration-a2.md`, `docs/private-beta-lockdown.md` |
| UI V2 | Merged: V2-A Pixa design system spec (#74). V2-B waits for Regan's go-ahead | `docs/ui/pixa-design-system-v2-a.md` |
| Global Search | Architecture: draft docs PR #75, decisions D-GS1-1..14 pending | `docs/global-search-gs1.md` on that PR |

These are orientation notes only. A feature listed above may be incomplete or not wired end to end.

## Where to find truth (in this order)

1. The checked-out branch and commit, and the current `main` SHA.
2. Files in the relevant subsystem, its tests, and the merged specs and ADRs (`docs/adr/`).
3. **Only relevant** open PRs and their changed-file lists. Read full diffs only when the task depends on them.
4. For production migration state: the production `_prisma_migrations` table (read-only, from the Mac session), then the log in `docs/migration-readiness.md` §9 and `ops/neon/recovery-points.json`. CI for the scope at hand.
5. This document, for background only.

## Minimal onboarding routine

1. Read `docs/agent-task-protocol.md` and `docs/active-workstreams.md`.
2. Run `git status`, and note the branch, HEAD and current `main` without changing working state unexpectedly.
3. Identify Zone ownership and dependencies from file paths. Use targeted searches (`rg`, `git grep`, `git ls-tree`) instead of dumping the repository.
4. Check the **titles, status and changed filenames** of directly related open PRs. Read a full PR only if it overlaps owned files, changes an API contract or migration order, or changes security assumptions.
5. Write a brief plan and file-ownership list before editing.

## Product decisions to preserve

- Pixa OS markets an integrated experience. Essential third-party provider costs may be bundled into subscription pricing when sustainable. Never assume a provider is free for commercial multi-tenant production use.
- Native functionality can progressively replace integrations. Do not build regulated or expensive infrastructure without a feasibility assessment.
- UI V2 direction is **Pixa Hybrid** with light and dark themes. Check the merged specification and any later amendments before implementing design components.
- Beta readiness is **not** the immediate workstream: finish product functionality, settings, search and connected workflows first. Security review and tests remain mandatory on every PR, and the invite-only admission controls must not be weakened.
- No mock business metrics or speculative features, no per-Zone apps, no microservices.

## Agent handoff format

At completion provide: branch and PR link, base commit, scope and files changed, tests run and results, migrations and deployments (none unless separately approved), security implications, dependencies, known gaps, owner decisions needed, and what the next agent should read. Keep the handoff short and don't paste logs unless a failure needs diagnosis. The template is in `agent-task-protocol.md`.
