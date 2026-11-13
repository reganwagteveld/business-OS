# ADR 0004: Database isolation design (Prisma, RLS, roles)

- Status: **Accepted**, 2026-11-13, by Regan after the Phase 1b spike (PR 3: S1 to S13 pass, S11 within target). Previously "accepted as the design to spike" (PR #1). A Prisma, driver-adapter or pooler upgrade re-runs the spike suite; a failure of S1 to S10 or S13 reopens this ADR.
- Date: 2026-11-13

## Context

Tenant isolation relies on PostgreSQL Row-Level Security in addition to application checks. The first draft's example set the tenant context with a per-query batch transaction inside a Prisma client extension, which did not clearly establish that `set_config` and the query share a transaction and connection. Pre-tenant `SECURITY DEFINER` functions also trusted a caller-supplied `user_id`. Both were raised as blockers in architecture review.

## Decision

The design in data-model.md §5:

1. **Unit of work**: all tenant data access runs inside one Prisma interactive transaction opened by `withTenant` with an explicit database role (`bos_app`, or `bos_jobs` for the purge job), whose first statement is a transaction-local `set_config` issued through `$queryRaw` and checked against the intended tenant. Services only receive the transaction-bound, narrowed `TenantDb`.
2. **Roles**: `bos_owner` (migrations), `bos_app` (tenant code), `bos_auth` (auth library), `bos_definer` (owner of pre-tenant functions, no login), `bos_maint` (owner of maintenance functions, no login), `bos_jobs` (scheduled jobs, purge limited to purgeable businesses). No runtime role owns tables or has `BYPASSRLS`, and no role is a member of `bos_definer` or `bos_maint`.
3. **Trusted paths**: three pre-tenant `SECURITY DEFINER` functions take a session token and verify it in the database, with explicit column grants and `bos_definer` row policies; onboarding inputs are validated twice and the region is derived from `app_private.deployment_config`; maintenance functions are owned by `bos_maint` with their own narrow policies; fixed `search_path`; no `PUBLIC` execute.
4. **Global tables**: RLS and column grants on `users` and `audit_events` prevent enumeration and hide platform events from tenant code.

## Pinned versions

Verified by the spike on 2026-11-13 (PR 3, CI run on commit 96e3c31):

| Component | Version / setting |
|---|---|
| Prisma (`prisma`, `@prisma/client`) | 7.10.1, `prisma-client` generator |
| Driver adapter | `@prisma/adapter-pg` 7.10.1 over `pg` 8.23.1, default statement handling |
| PostgreSQL | 16.10 in CI; the Neon project runs 18.7 (`pnpm verify:vendor` passes 8 of 8 there) |
| Pooler and mode | PgBouncer 1.22.0, `pool_mode = transaction`, `default_pool_size = 5`; a second pooler database with `pool_size = 1` for the carry-over tests |
| Prepared statements | PgBouncer default for 1.22.0 (`max_prepared_statements` not set); no setting required |
| Unit-of-work defaults | `ReadCommitted`, 5 s timeout, context set by tagged `$queryRaw` `set_config(..., true)` and checked |

## Spike results

All mandatory tests pass in CI against PostgreSQL behind PgBouncer in transaction mode (`apps/api/tests/isolation/db-context.test.ts`, `tenant-db.typecheck.ts`).

| # | Result |
|---|---|
| S1 | Pass: `set_config` returns the intended values; `current_setting`, `txid_current()` and `pg_backend_pid()` are identical across raw and model queries; a malformed tenant id is rejected before any query |
| S2 | Pass: with no context, `bos_app` sees 0 rows on every tenant table and `INSERT` raises an RLS violation (model and raw) |
| S3 | Pass: a plain client or a transaction opened outside `withTenant` does not type-check as a `TenantDb`; `$transaction`, `$queryRawUnsafe` and `$executeRawUnsafe` are not reachable (`tsc` in CI) |
| S4 | Pass: with a single pooled server connection, the next query on the same backend has an empty setting and sees 0 rows |
| S5 | Pass: a unit of work that throws leaves no setting and no partial write |
| S6 | Pass: 2,000 interleaved units of work across 3 businesses, pool size 5, 25 in flight: 0 leaks, 0 failures |
| S7 | Pass: tagged `$queryRaw` is filtered by RLS exactly like model queries |
| S8 | Pass: cross-tenant writes are rejected by the app-layer scope, and with that scope disabled RLS alone rejects inserts and re-parenting and hides other tenants' rows from updates and deletes |
| S9 | Pass: a contact cannot reference another business's customer as `bos_owner` with `FORCE` removed (RLS bypassed) or as a superuser (`23503`) |
| S10 | Pass: a unit of work past its 500 ms timeout fails with the transaction timeout, rolls back, and its connection returns clean |
| S11 | Added latency of `withTenant` vs a bare query, 400 rounds on the CI runner: **p50 0.98 ms, p95 1.10 ms** (first run: p50 1.36 ms, p95 1.54 ms). Within the < 2 ms p95 target. Not measured against Neon over the network |
| S12 | Pass: S6 passes with the adapter's default statement handling and PgBouncer's default prepared-statement setting |
| S13 | Pass: `role: "jobs"` connects as `bos_jobs`, reads and deletes only a purgeable business's rows (30-day floor), sees 0 rows for active or recently archived businesses, and cannot insert or update |

Limitations: the spike uses a test-only fixture schema with the production policy template (not the application migrations); PgBouncer runs in CI as the Ubuntu package, not a container; S11 was measured on the CI runner. The real tenancy tables must reuse the same template, and this suite re-runs on any Prisma, adapter or pooler upgrade.

## Consequences

- Each tenant request holds a pooled connection for its unit of work, so units of work must be short and must not make network calls.
- Two Prisma clients (app and auth) and two pools.
- Any Prisma or pooler upgrade re-runs the spike tests before merge.
- If S1 to S10 cannot pass, alternatives (session-mode pooling, per-request dedicated connections, or app-layer-only scoping) require a new decision and are not adopted silently.

## Addendum 2026-11-13: desktop-first clients (ADR 0005)

Nothing in this design changes. The cloud API (`apps/api`) is the only database client; the desktop and browser apps reach data only through it and hold no database credentials. The unit of work is opened by the `tenantRoute` wrapper for API route handlers instead of a Server Action wrapper, and the pre-tenant functions receive the session token from the cookie or the bearer header. The spike tests (S1 to S13) are unchanged.
