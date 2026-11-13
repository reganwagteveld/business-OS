# ADR 0004: Database isolation design (Prisma, RLS, roles)

- Status: **Accepted as the design to spike**, 2026-11-13 (Regan's third architecture review on PR #1). This accepts the design, not proof that it works: tests S1 to S13 must pass in the Phase 1b spike before any product features, and a failure of S1 to S10 or S13 reopens this ADR.
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

To be filled in at Phase 1a/1b: Prisma version, driver adapter, PostgreSQL version, pooler and mode, prepared-statement setting.

## Spike results

To be filled in: results of tests S1 to S13 (data-model.md §5.4), including measured overhead.

## Consequences

- Each tenant request holds a pooled connection for its unit of work, so units of work must be short and must not make network calls.
- Two Prisma clients (app and auth) and two pools.
- Any Prisma or pooler upgrade re-runs the spike tests before merge.
- If S1 to S10 cannot pass, alternatives (session-mode pooling, per-request dedicated connections, or app-layer-only scoping) require a new decision and are not adopted silently.
