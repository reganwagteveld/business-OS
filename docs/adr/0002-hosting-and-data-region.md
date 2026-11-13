# ADR 0002: Hosting, database vendor and data region

- Status: **Proposed, needs a decision on region**
- Date: 2026-11-13
- Decision ID: D3 (architecture.md §10)

## Context

Phase 1a needs a preview deployment, and every later phase depends on where data lives. The data region determines latency for users, which privacy law applies (for example the Australian Privacy Act, GDPR/UK GDPR, US state laws), what customers will accept, and retention periods (DM5). The isolation design needs: PostgreSQL 16+, custom roles without `BYPASSRLS`, `FORCE ROW LEVEL SECURITY`, `SECURITY DEFINER` functions, a transaction-mode pooler, point-in-time recovery, and a scheduler for maintenance jobs.

## Options considered

| Option | Notes |
|---|---|
| **Vercel + Neon** | Native Next.js hosting; Neon offers branching per PR (useful for migration tests), built-in pooler, custom roles. Region-matched pairs available in AU, EU, US |
| Vercel + Supabase (Postgres only) | Good managed Postgres with pooler; we would not use Supabase Auth (ADR 0001) |
| Vercel + AWS RDS / Aurora | Most control, more ops; RDS Proxy as pooler |
| Self-managed container host (Fly.io, Render, Railway) + managed Postgres | Fewer platform limits on job duration; more ops |

All need confirming against the custom-role and `FORCE ROW LEVEL SECURITY` requirements during Phase 1a; some managed providers restrict role attributes.

## Decision (proposed)

- **Vercel** for the application, with **one region** for both compute and database.
- **Neon** as the default database choice, because PR branches make the isolation and migration tests cheaper to run; Supabase-as-Postgres is the fallback if a requirement is not met.
- **Region: to be chosen by Regan.** If the first customers are Australian, use Sydney (Vercel `syd1`, database in AWS `ap-southeast-2`). If EU/UK, Frankfurt or London. Single region in Phase 1; multi-region is out of scope.

## Consequences

- Platform cron with function time limits is the job runner (data-model.md §7.1); jobs must be batched.
- Changing region later means a data migration, so the choice should follow where the first paying customers are.
- Retention periods (DM5) are set once the jurisdiction is known.
