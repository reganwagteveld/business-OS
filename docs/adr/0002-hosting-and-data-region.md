# ADR 0002: Hosting, database vendor and data region

- Status: **Accepted (region)**, 2026-11-13, decided by Regan. Hosting and database vendors remain **Proposed** until verified in Phase 1a.
- Date: 2026-11-13
- Decision ID: D3 (architecture.md §10)

## Context

Phase 1a needs a preview deployment, and every later phase depends on where data lives. The data region determines user latency, which privacy laws apply, what customers will accept, and retention periods (DM5).

**Initial go-to-market hypothesis:** English-speaking US small businesses with roughly 5 to 50 employees. This is a starting market, not a limit on the customer base: the platform must stay adaptable to other countries and, over time, to larger organisations up to multinational enterprises (architecture.md §1, principle 7 and §13).

The isolation design (ADR 0004) also requires: PostgreSQL 16+, custom roles without `BYPASSRLS`, `FORCE ROW LEVEL SECURITY`, `SECURITY DEFINER` functions, a transaction-mode pooler, point-in-time recovery, and a scheduler for maintenance jobs.

## Decision

### Region (accepted)

- **US East (Northern Virginia), AWS `us-east-1`**, for both application compute and PostgreSQL.
- **Single region in Phase 1.** No multi-region infrastructure, replicas in other regions, or regional routing is built in Phase 1.

### Vendors (proposed, to verify in Phase 1a)

| Layer | Proposed | Region setting |
|---|---|---|
| Application | Vercel | Functions region `iad1` (Washington, D.C. / us-east-1) |
| PostgreSQL | Neon (fallback: Supabase Postgres or AWS RDS) | `aws-us-east-1` |
| Error tracking | Sentry (or equivalent) | US data region |
| Transactional email | Postmark, Resend or SES | US |
| Scheduled jobs | Vercel Cron → internal route (data-model.md §7.1) | Runs in `iad1` |

Phase 1a must confirm the database vendor supports the role attributes, `FORCE ROW LEVEL SECURITY`, `SECURITY DEFINER` ownership and pooler mode that ADR 0004 needs; if not, switch to the fallback before any data exists.

## Principles this decision must preserve

1. **Compute and PostgreSQL are colocated.** The application's server functions and the primary database are always in the same cloud region. Any future region is a full stack (app + database + job runner) in that region, never app in one region and database in another. A CI/deploy check asserts the configured function region matches the database region.
2. **Business-specific currency, locale and timezone are preserved.** Every business stores its own `currency` (ISO 4217), `locale` (BCP 47), `time_zone` (IANA) and `country_code` (ISO 3166-1). These are chosen at onboarding (pre-filled from the browser and selected country) and are **required fields, not code defaults**. The US launch only changes the pre-filled values (`en-US`, `USD`), never the model.
3. **No unnecessary US-specific assumptions in the shared data model.** Addresses use international field names (`region`, `postal_code`, not `state`, `zip`); phone numbers are E.164 where parseable; tax identifiers are generic strings with an optional type, not EIN/SSN fields; dates are stored as UTC `timestamptz` and displayed in the business's time zone; formatting uses `Intl` APIs with the business or user locale; no imperial units or US date formats in stored data. A review checklist item in the PR template enforces this.
4. **Data residency limitations are documented** (below) and updated whenever a new external service is added.
5. **Regional deployments are possible later without substantial redesign** (path below).
6. **No multi-region infrastructure in Phase 1.**

## Data residency in Phase 1 and its limitations

All Business OS customer data is intended to be stored and processed in the United States. Specifically:

| Data flow | Where it lives | Limitation / note |
|---|---|---|
| Primary database (all business data) | AWS us-east-1 via the database vendor | Single region; no cross-region replica |
| Database backups and point-in-time recovery | Vendor-managed, expected in the same region | **Verify in Phase 1a** that the vendor does not store backups or WAL archives outside the region, and record the answer here |
| Application compute | Vercel `iad1` | Server functions process data in the US region |
| CDN / edge network | Vercel's global edge | Static assets are cached worldwide. **Tenant data must not be cached at the edge**: tenant pages are dynamic and served with `Cache-Control: private, no-store`; this is tested |
| Application and request logs | Vercel (US), plus any log drain | Logs carry `businessId`/`userId` but no customer PII payloads (architecture §7.3, layer 6). Log retention follows the vendor's plan |
| Error tracking | Sentry US region (or equivalent) | Scrubbing of request bodies and PII fields enabled; verified by test in Phase 1e |
| Transactional email | Email provider (US) | Email content (invitations, verification) includes recipient addresses and business names |
| Auth | Our own database (ADR 0001) | No third-party identity store in Phase 1 |
| AI provider (future) | Undecided (D2) | Will process tenant data; residency and retention terms are evaluation criteria for D2 |
| Source control and CI (GitHub) | GitHub (US) | CI uses synthetic data only; production data never leaves production systems for testing |
| Support and analytics tooling (future) | Not chosen | Each must be added to this table before it receives customer data |

Known limitations to state honestly to customers and in any data processing agreement:

- There is **no in-region option for non-US customers** in Phase 1. Non-US businesses can sign up (nothing in the product blocks them), but their data is stored in the US.
- A US business's own records may include **personal data of people outside the US** (for example contacts at a European supplier). Laws such as GDPR can apply to that data regardless of where the business is based; export and erasure (data-model.md §7) are designed with that in mind.
- Edge caching, CDN logs and sub-processors (email, error tracking) may involve infrastructure outside us-east-1 even when the primary data is in the US. A sub-processor list is maintained from this table.

## Path to regional deployments (EU, UK, Australia), not built in Phase 1

The intended model is **regional silos**: each region runs a complete, independent copy of Business OS (application, database, job runner, error tracking project) from the same codebase, configured only by environment. This keeps compute and data colocated and avoids cross-region queries entirely.

What makes this possible later without substantial redesign, and is already true of the Phase 1 design:

- All tenant data is keyed by `business_id` with no cross-tenant references (composite FKs), so a business's data can be exported from one region and imported into another as a unit.
- IDs are UUIDv7, globally unique, so moving or merging data between regions never collides.
- Region-specific values (database URL, email sender, error-tracking DSN, public base URL) are environment configuration, validated at boot; no region is hard-coded in code.
- Platform-specific services are behind small adapters (cron, cache, file storage later), so a region on a different host is possible.

What will need to be added when the first non-US region is needed (estimated as a contained project, not a redesign):

- A small **global directory** (the only global component) that maps a business slug and a user's email to their home region, used at sign-in and on shared links to redirect to the right regional host (e.g. `eu.app.example.com/b/acme`). It holds no business data. ADR 0003's path-based URLs remain valid within each regional host.
- `businesses.home_region` (added in Phase 1 with the single value `us-east-1`, see data-model.md §4.2) becomes meaningful.
- Users who belong to businesses in two regions: initially one account per region; federated identity across regions is a later decision.
- A tested **tenant relocation** procedure (export, import, verify, switch directory entry) for businesses that move regions.
- Per-region sub-processor configuration (EU error-tracking region, EU email provider endpoint, etc.).

Known hard problem, recorded now: an organisation whose entities must be stored in **different** regions cannot have live cross-region reporting through the database. That would need a deliberate design (for example aggregated, residency-compliant reporting exports). See architecture.md §13.

## Consequences

- Low latency and the strongest provider choice for the initial US market.
- Platform cron with function time limits is the job runner (data-model.md §7.1); jobs must be batched.
- Retention periods (DM5) are set for US requirements first and revisited per region.
- Non-US customers are possible but served from the US until a regional deployment exists; sales and terms must say so.
