# Business OS: Architecture (Phase 1)

> Status: **Draft for review.** Nothing in this document has been implemented. No application code or scaffolding should be written until this document, [data-model.md](./data-model.md) and [implementation-plan.md](./implementation-plan.md) have been reviewed and the open decisions in §10 are settled.

## 1. Purpose and principles

Business OS is an AI-native, multi-tenant SaaS platform for small and medium-sized businesses.

**One platform. One interface. One source of truth.**

The principles below follow from that and act as tie-breakers for every design choice in this document:

1. **One deployable application.** A single Next.js app and a single PostgreSQL database. No separate apps per Zone and no microservices until a measured need exists.
2. **One business data model.** Every Zone reads and writes the same records (a customer is a customer, whether you reach it from Customer, Sales or Finance). Zones are views over shared data, not data silos.
3. **Explicit domain boundaries inside the monolith.** Modules own their tables and expose a small public API. Boundaries are enforced by tooling, not convention.
4. **Tenant isolation is defence in depth.** Application checks, a tenant-scoped data layer and PostgreSQL Row-Level Security each independently prevent cross-tenant access.
5. **Real data or honest empty states.** No mock business metrics, placeholder charts or invented numbers anywhere in the product UI.
6. **Build only what Phase 1 needs.** Extension points (Zone registry, permission keys, AI interface) are designed now so they don't need rework, but only Customer Zone functionality is built.

## 2. Current repository state

Inspected on 2026-11-13:

- The repository `reganwagteveld/business-os` was created on 2026-11-13 and is **empty**: no commits, no branches, no files.
- None of the other GitHub repositories accessible to this project is related to Business OS.
- The project is therefore **greenfield**. There is no existing code, schema, CI or design system to preserve or migrate.
- To allow a reviewable pull request, `main` was initialised with a single commit containing only a minimal `README.md`. These docs arrive in a PR against it.

## 3. System overview

```
┌──────────────────────────── Browser ─────────────────────────────┐
│  Home dashboard · Zone views · Command palette (⌘K)              │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTPS (RSC, Server Actions, Route Handlers)
┌───────────────────────────────▼──────────────────────────────────┐
│  Next.js application (single deployable, App Router)             │
│                                                                  │
│  app/          thin routing layer (layouts, pages, actions)      │
│     │                                                            │
│  zones/        Zone manifests + registry (navigation, widgets)   │
│     │                                                            │
│  modules/      domain modules (public API → services → repos)    │
│     │   identity · tenancy · access · customers · activity       │
│     │                                                            │
│  core/         shared kernel: db, tenant context, authz, errors, │
│                audit, config, (later) ai                         │
│  ui/           design system (tokens, shadcn/ui, patterns)       │
└───────────────────────────────┬──────────────────────────────────┘
                                │ Prisma (tenant-scoped client) + RLS session var
┌───────────────────────────────▼──────────────────────────────────┐
│  PostgreSQL: single database, shared schema, business_id on      │
│  every tenant-owned row, RLS policies on every tenant table      │
└──────────────────────────────────────────────────────────────────┘
External (decisions pending): auth provider, AI provider, email delivery, hosting.
```

**Multi-tenancy model: shared database, shared schema, `business_id` column.**

| Option | Isolation | Ops cost | Fit for SMB SaaS |
|---|---|---|---|
| Database per tenant | Strongest | High: N migrations, N connection pools | Poor at thousands of small tenants |
| Schema per tenant | Strong | Medium-high: migrations fan out, Prisma handles it poorly | Poor |
| **Shared schema + `business_id` + RLS** | Strong when RLS is enforced | Low | **Good: the standard choice for many small tenants** |

The shared-schema choice is only safe because of the layered safeguards in §7. If a large customer later needs physical isolation, the tenant-scoped data layer makes it possible to route that tenant to a dedicated database without changing module code.

## 4. Repository structure

A single repository, single package. A monorepo with workspaces (Turborepo, Nx) is **not** proposed: with one app and no shared external packages it adds tooling cost without benefit. Module boundaries are enforced with lint rules instead (§5.3). If a second deployable ever appears (e.g. a public API or background worker that needs separate scaling), promoting `core/` and `modules/` to workspace packages is a mechanical change.

```
business-os/
├── docs/                         # architecture, data model, plan, ADRs
│   └── adr/                      # one file per accepted decision
├── prisma/
│   ├── schema/                   # multi-file schema, one file per module
│   │   ├── _base.prisma          # generator + datasource
│   │   ├── identity.prisma
│   │   ├── tenancy.prisma
│   │   ├── customers.prisma
│   │   └── activity.prisma
│   ├── migrations/               # generated SQL + hand-written RLS SQL
│   └── seed.ts                   # dev-only seed, clearly fake names, never in prod
├── src/
│   ├── app/                      # Next.js App Router: routing ONLY
│   │   ├── (public)/             # sign-in, sign-up, accept-invite
│   │   ├── (app)/b/[businessSlug]/
│   │   │   ├── layout.tsx        # resolves tenant context, renders shell
│   │   │   ├── page.tsx          # Home dashboard
│   │   │   ├── customer/...      # Customer Zone routes → delegate to modules
│   │   │   └── settings/...      # business settings, members
│   │   └── api/                  # route handlers (auth callbacks, webhooks)
│   ├── zones/
│   │   ├── define-zone.ts        # ZoneManifest type + defineZone()
│   │   ├── registry.ts           # static list of all Zone manifests
│   │   └── customer/zone.ts      # one manifest per Zone
│   ├── modules/
│   │   ├── identity/             # users, sessions (wraps auth provider)
│   │   ├── tenancy/              # businesses, memberships, invitations
│   │   ├── access/               # roles, permissions, can()
│   │   ├── customers/            # customers, contacts
│   │   └── activity/             # activity timeline (cross-cutting)
│   │       ├── index.ts          # PUBLIC API: the only importable file
│   │       ├── server/           # services, repositories (server-only)
│   │       ├── ui/               # module-specific components
│   │       ├── schemas.ts        # zod input/output schemas
│   │       └── *.test.ts
│   ├── core/
│   │   ├── db/                   # Prisma client, tenant-scoped extension
│   │   ├── tenant/               # TenantContext, requireTenant()
│   │   ├── authz/                # authorize(), permission registry
│   │   ├── actions/              # tenantAction() wrapper for Server Actions
│   │   ├── audit/                # security audit log writer
│   │   ├── jobs/                 # scheduled maintenance jobs (Phase 1e)
│   │   ├── config/               # env validation (zod)
│   │   └── errors/
│   └── ui/
│       ├── tokens/               # design tokens (CSS variables, Tailwind theme)
│       ├── components/           # shadcn/ui primitives (owned, not a dependency)
│       └── patterns/             # composites: ZoneHeader, EntityTable,
│                                 # EmptyState, Timeline, CommandPalette
├── tests/
│   ├── isolation/                # cross-tenant test suite (must stay green)
│   └── e2e/                      # Playwright
└── .github/workflows/            # CI
```

Notes:

- **`app/` is thin.** Pages load data via module public APIs and render module or `ui/` components. Business rules never live in `app/`.
- **Server-only code** in `modules/*/server` and `core/db` imports the `server-only` package so it cannot be bundled to the client.
- **The dev seed** uses obviously synthetic data ("Example Customer 1"), is never run in production, and is never shown as product content.

## 5. Domain boundaries

### 5.1 Modules in Phase 1

| Module | Owns (tables) | Responsibility | Depends on |
|---|---|---|---|
| `identity` | `users` (+ auth provider's session/account tables) | Who the person is; sign-in; profile | `core` |
| `tenancy` | `businesses`, `memberships`, `invitations` | Which businesses exist; who belongs to which | `identity`, `core` |
| `access` | none in Phase 1 (role→permission map in code) | `can(ctx, permission)`; permission registry | `tenancy`, `core` |
| `customers` | `customers`, `contacts` | Customer and contact records | `access`, `activity`, `core` |
| `activity` | `activities` | Business-facing timeline of what happened | `access`, `core` |
| `core` (kernel) | `audit_events`, `job_runs` | DB, tenant context, authz plumbing, audit, scheduled jobs, config | nothing |

**Modules are not Zones.** A module is a data and logic boundary. A Zone is a navigation and UI grouping. The Customer Zone composes `customers` and `activity`; the future Sales Zone will also read `customers`. This separation is what keeps "one source of truth" intact as Zones are added: no Zone ever gets its own copy of customers.

Future modules (not built in Phase 1, listed only to show where they would go): `sales` (deals, quotes), `finance` (invoices, payments), `projects`, `operations`, `people` (employees, as distinct from platform users).

### 5.2 Rules

1. A module may import another module **only through its `index.ts`**. Deep imports (`@/modules/customers/server/repo`) are a lint error.
2. A module **writes only its own tables.** Cross-module writes go through the owning module's public API.
3. **Reads across modules** also go through public APIs in Phase 1. If a read path becomes a performance problem, a module may publish a read-only query (e.g. a SQL view) in its public API; nobody joins another module's tables directly.
4. **No circular dependencies** between modules (enforced by dependency-cruiser in CI).
5. **Cross-module side effects** (e.g. "customer created" → activity entry) are called explicitly from the service in Phase 1, inside the same database transaction. An in-process domain event bus is deferred until there are enough consumers to justify it; the cost of adding it later is low because the call sites are few and explicit.
6. **The raw Prisma client is not exported** to modules. Modules receive the tenant-scoped client from `core/db` (§7.3).

### 5.3 Enforcement

- ESLint `no-restricted-imports` (or `eslint-plugin-boundaries`) for deep-import and layer rules (`ui` cannot import `modules/*/server`; `modules` cannot import `app`).
- `dependency-cruiser` in CI for cycles and the module dependency graph above.
- A unit test that fails if any module other than `core/db` imports `@prisma/client` directly.

**Tradeoff:** lint-enforced boundaries are weaker than package boundaries (anyone can disable a rule) but have zero build overhead. Code review plus CI is judged sufficient for a small team.

## 6. Zones: registration and navigation

### 6.1 Concepts

- **Home**: the landing dashboard for a business. Shows Zone entry points and widgets that each Zone contributes. Only real data or empty states.
- **Zone**: a top-level area (Customer, Sales, Finance, Projects, Operations, People). Each has an entry on Home, a header, and a small zone-local navigation.
- **No global sidebar.** Movement between Zones is via Home, a compact Zone switcher in the top bar, and the command palette.

### 6.2 Zone manifest

Each Zone is described by a typed, static manifest. The registry is a plain array assembled at build time; there is no runtime plugin loading.

```ts
// src/zones/define-zone.ts  (illustrative, not final code)
export type ZoneStatus = "active" | "planned";

export interface ZoneManifest {
  id: ZoneId;                     // "customer" | "sales" | ...
  label: string;                  // "Customer"
  description: string;            // one line, shown on Home
  icon: IconName;                 // from the design-system icon set
  order: number;                  // position on Home and in the switcher
  status: ZoneStatus;             // planned Zones render no data
  basePath: `/${string}`;         // "/customer" (under /b/[businessSlug])
  requires: Permission;           // minimum permission to see the Zone
  nav: ZoneNavItem[];             // zone-local navigation
  homeWidgets?: HomeWidgetDef[];  // widgets contributed to Home
  commands?: CommandDef[];        // entries for the command palette
  search?: SearchProviderDef;     // contributes to global search
}

export interface ZoneNavItem {
  id: string;
  label: string;
  path: string;                   // relative to basePath
  requires?: Permission;
}

export interface HomeWidgetDef {
  id: string;
  title: string;
  requires: Permission;
  size: "sm" | "md" | "lg";
  load: () => Promise<{ default: WidgetComponent }>; // lazy server component
}
```

```ts
// src/zones/customer/zone.ts  (illustrative)
export const customerZone = defineZone({
  id: "customer",
  label: "Customer",
  description: "Customers, contacts and their history",
  icon: "users",
  order: 10,
  status: "active",
  basePath: "/customer",
  requires: "customers:read",
  nav: [
    { id: "customers", label: "Customers", path: "" },
    { id: "contacts",  label: "Contacts",  path: "/contacts" },
  ],
  homeWidgets: [
    { id: "recent-activity", title: "Recent customer activity",
      requires: "activity:read", size: "md",
      load: () => import("@/modules/activity/ui/recent-activity-widget") },
  ],
  commands: [
    { id: "new-customer", label: "New customer", requires: "customers:write", href: "/new" },
  ],
});
```

### 6.3 How the pieces fit

- **Routing.** Next.js uses file-system routes, so each active Zone also has a route folder under `app/(app)/b/[businessSlug]/<zone>/`. Route files are thin and delegate to module UI. A test asserts that every `active` manifest has a matching route folder and vice versa, so the registry and routes cannot drift.
- **Visibility.** Shell, Home, switcher and command palette all derive from one function: `visibleZones(ctx) = registry.filter(z => can(ctx, z.requires))`. Nav items, widgets and commands are filtered the same way. Hiding a link is a UX convenience only: every page and action re-checks permissions on the server (§7).
- **Planned Zones.** Sales, Finance, Projects, Operations and People are registered with `status: "planned"`, no routes, no widgets and no data. Whether they appear on Home (as clearly labelled "Not available yet" tiles) or are hidden entirely is an open decision (§10, D6).
- **Per-business enablement (later).** A `business_zone_settings` table can later let a business turn Zones on or off. It is not needed in Phase 1 and is deliberately not built.
- **Adding a Zone** is: a module (if new data is needed), a manifest, a route folder, and permission keys. No changes to shell code. This is the main scalability property of the model.

### 6.4 Navigation UX

| Surface | Purpose |
|---|---|
| Top bar | Business switcher, Zone switcher (current Zone + menu of visible Zones), search / ⌘K, user menu |
| Home | Grid of Zone tiles + contributed widgets |
| Zone header | Zone name, zone-local nav as tabs (max ~6 items), primary action |
| Command palette | Jump to any Zone, nav item or record; run registered commands |
| Breadcrumbs | Business › Zone › Record, for deep pages |

**Tradeoff vs a sidebar:** a sidebar gives constant one-click access to everything but becomes cluttered as Zones grow, which is the problem the product wants to avoid. The cost of the Zone model is one extra click to change Zone; the command palette and Zone switcher offset that for frequent users.

### 6.5 Design system

- Tailwind CSS with design tokens as CSS variables (colour, spacing, radius, typography, Zone accent colours), light and dark themes from the start.
- shadcn/ui components are copied into `src/ui/components` and owned by the project.
- Shared patterns in `src/ui/patterns` (`ZoneHeader`, `EntityTable`, `EntityForm`, `EmptyState`, `Timeline`, `DetailPanel`) are the only way Zones build standard screens, so all Zones look and behave the same.
- Accessibility target: WCAG 2.2 AA (keyboard navigation, focus states, contrast, labelled controls).

## 7. Authentication, authorisation and tenant isolation

### 7.1 Authentication

The auth provider is an **open decision** (§10, D1). Whatever is chosen sits behind the `identity` module so the rest of the app depends only on:

```ts
getCurrentUser(): Promise<User | null>   // our users table, not the provider's object
requireUser(): Promise<User>             // throws/redirects if unauthenticated
```

Options evaluated:

| Option | Model | Pros | Cons |
|---|---|---|---|
| **Better Auth** | Open-source library, self-hosted, data in our Postgres | Prisma adapter; email/password, magic link, OAuth, passkeys, 2FA; no per-user cost; users table is ours; Auth.js is now maintained under the same project | We operate it (security patches, email delivery, rate limits); enterprise SSO/SAML less mature than hosted vendors |
| **Clerk** | Hosted | Fastest to integrate; prebuilt UI; built-in organisations; MFA; strong session handling | Per-MAU cost; user data lives with vendor and must be synced to our DB via webhooks; their "organisations" would overlap our `businesses`/`memberships` (two sources of truth unless we ignore theirs) |
| **WorkOS AuthKit** | Hosted | Strong enterprise SSO/SCIM path; generous free tier for basic auth | Enterprise focus is ahead of SMB needs; same sync concern as Clerk |
| **Supabase Auth** | Hosted (with Supabase Postgres) | Integrated with RLS via JWT claims | Couples auth choice to database host; less natural with Prisma |
| Auth.js (NextAuth) v5 | Library | Familiar | Development has effectively moved to Better Auth; not recommended for a new project |

**Recommendation: Better Auth**, using its core user/session/account tables only, with **our own `businesses` and `memberships` tables as the tenancy source of truth** (we would not use its organisation plugin, to avoid two membership models). Reasons: user data stays in our database alongside the business data model, no per-seat cost for SMB customers, and no webhook sync. **Revisit if** enterprise SSO/SCIM becomes a near-term requirement, which would favour WorkOS.

Baseline requirements regardless of provider:

- Email + password and/or magic link; Google sign-in; optional TOTP 2FA (required for owners later).
- HTTP-only, `Secure`, `SameSite=Lax` session cookies; server-side session revocation.
- Email verification before a user can create or join a business.
- Rate limiting on sign-in, sign-up, password reset and invitation endpoints.

### 7.2 Authorisation

**Phase 1: fixed roles per membership, checked by permission key.**

| Role | Intended for |
|---|---|
| `owner` | Created the business; billing (later), delete business, manage all members including admins |
| `admin` | Manage members (except owners) and settings; full data access |
| `member` | Read and write business data; no member or settings management |

Code never checks roles directly. It checks **permissions**:

```ts
type Permission =
  | "business:manage" | "members:manage"
  | "customers:read" | "customers:write" | "customers:delete"
  | "activity:read"  | "activity:write";

await authorize(ctx, "customers:write"); // throws ForbiddenError
```

- A static `ROLE_PERMISSIONS` map in `modules/access` translates role → permissions.
- Each module declares the permission keys it owns; the registry is the union, so typos are type errors.
- **Future custom roles**: add `roles` and `role_permissions` tables, point `memberships.role_id` at them, and swap the static map for a lookup. Because call sites already use permission keys, no module code changes. This is why role checks are banned now.
- Record-level rules (e.g. "only see customers assigned to me") are **not** in Phase 1. If needed later they are implemented as additional RLS predicates and service-layer filters, not ad hoc page checks.

### 7.3 Tenant isolation safeguards (defence in depth)

Each layer below must independently prevent a cross-tenant read or write. A bug in any one layer should not cause a leak.

**Layer 1: tenant context is derived server-side, never trusted from the client.**

- The active business comes from the URL segment `/b/[businessSlug]`, resolved on the server to a `business_id` **and** verified against the signed-in user's membership on every request.
- `business_id` is never accepted from form data, query strings or request bodies. Zod schemas for actions do not contain it.
- `requireTenant()` returns an immutable `TenantContext { businessId, userId, membershipId, role, permissions }` and is the only way to obtain one.
- Membership is re-checked per request (cached only within the request), so removing a member takes effect immediately.

**Layer 2: every entry point goes through a wrapper.**

- Server Actions and Route Handlers are public HTTP endpoints regardless of where they are called from. All tenant-scoped actions are defined via `tenantAction({ permission, input: zodSchema }, handler)`, which resolves the tenant, authorises, validates input and passes `ctx` to the handler.
- A CI check fails if a `"use server"` file exports a function not wrapped by `tenantAction`/`publicAction`.
- **Next.js middleware/proxy is not a security boundary.** It may redirect unauthenticated users for UX, but authentication and authorisation are always re-checked in the layout, page, action or handler. (A 2025 Next.js vulnerability allowed middleware to be bypassed entirely; the design must not depend on it.)

**Layer 3: tenant-scoped data access (unit of work).**

- `core/db` exposes `withTenant(ctx, work)`, which opens one Prisma **interactive transaction**, sets the tenant context as its first statement, and passes `work` a narrowed `TenantDb` client bound to that transaction. Every statement in the unit of work therefore runs on the same connection and transaction as the context (design and rationale in [data-model.md §5.3](./data-model.md#53-unit-of-work-how-the-tenant-context-reaches-postgresql)).
- `TenantDb` injects `businessId` into every read, update and delete on tenant models, sets it on every create (rejecting a mismatch), and does not expose `$transaction` or the `*Unsafe` raw-SQL methods.
- Module services accept a `TenantDb` parameter and never receive a client, so a tenant query outside a unit of work does not compile.
- The unscoped clients (`bos_auth` for the auth adapter, `bos_jobs` for scheduled jobs) are importable only from their single owning file, enforced by lint and a test.

**Layer 4: PostgreSQL Row-Level Security and least-privilege roles.**

- Every tenant-owned table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with a policy `TO bos_app` matching `business_id` to the transaction-local `app.business_id` setting.
- The application connects as `bos_app`: not a table owner, no `BYPASSRLS`, no access to auth tables or platform audit events. Migrations run as `bos_owner`, the auth library as `bos_auth`, scheduled jobs as `bos_jobs` (roles and grants in [data-model.md §5.1](./data-model.md#51-roles-and-grants-least-privilege)).
- With no setting, the policy matches nothing: **fail closed**.
- The only paths around tenant RLS are three `SECURITY DEFINER` functions for pre-tenant operations (list my businesses, create business, accept invitation). They take the **session token, not a user id**, verify the session inside the database, use a fixed `search_path`, are owned by a dedicated no-login role, and are not executable by `PUBLIC` ([data-model.md §5.5](./data-model.md#55-pre-tenant-trusted-paths-app_private-security-definer-functions)).
- `users` and `audit_events` are global tables with their own RLS and column grants, so tenant code cannot enumerate unrelated users or read platform audit events ([data-model.md §5.6](./data-model.md#56-global-data-users-and-audit-events)).
- **This design is gated by a spike** with twelve concrete tests (same connection, fail closed, no carry-over, rollback, concurrency behind the pooler, raw queries, timeouts, overhead) before any Phase 1b feature work ([data-model.md §5.4](./data-model.md#54-rls-spike-what-must-be-proven-before-phase-1b-features)).

**Layer 5: referential integrity across tenants.**

- Child rows reference parents with **composite foreign keys** `(business_id, parent_id) → parent(business_id, id)`, so a contact cannot be attached to another business's customer even through a bug that bypasses layers 1 to 3.

**Layer 6: caches, files, search and logs.**

- Any server cache (`use cache`, `unstable_cache`, `fetch` cache, external cache) that stores tenant data **must include `businessId` in its key**, enforced by a `tenantCache()` helper; direct use of the Next.js cache APIs with tenant data is banned by lint. Cross-tenant cache bleed is one of the most common multi-tenant bugs in Next.js apps.
- Future file storage uses `businesses/{businessId}/...` key prefixes with signed, short-lived URLs.
- Future search indexes and AI embeddings carry `business_id` and are always filtered by it server-side.
- Logs include `businessId` and `userId` for traceability but never log customer PII payloads.

**Layer 7: verification.**

- `tests/isolation/` is a dedicated suite that creates two businesses and asserts, for every tenant table and every module service, that business A cannot read, update, delete or reference business B's rows, both through services and through raw SQL as the app role.
- A schema test enumerates every table with a `business_id` column and fails if it lacks an RLS policy, `FORCE ROW LEVEL SECURITY`, or a `business_id`-leading index.
- These tests run in CI on every pull request and block merge.

### 7.4 Other security baselines

- Non-guessable IDs (UUIDv7) for all records; slugs are for display and routing only and are always resolved through membership.
- Security headers (CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`).
- `audit_events` table (security log, append-only) for sign-ins, membership changes, role changes, exports and deletions.
- Secrets only in the hosting provider's secret store; env validated at boot.
- Dependency scanning (Dependabot/Renovate) and `npm audit` in CI.

## 8. AI-native foundations (design only)

No AI features are built in Phase 1. "AI-native" is protected now by decisions that would be expensive to retrofit:

1. **Structured, well-described data.** The shared data model, typed activity records and zod schemas are what an AI assistant will read and act on. Clean data is the main AI investment in Phase 1.
2. **Actions as the AI's hands.** Every write goes through `tenantAction` with a zod schema and a permission. A future assistant invokes the same actions as tools, so it can never do more than the signed-in user can, and every AI action is authorised, validated and audited like a human one.
3. **Provider abstraction.** A future `core/ai` module exposes a narrow interface (`generate`, `stream`, `embed`, tool calling). The provider is an **open decision** (§10, D2).
4. **Tenant-safe retrieval.** Any context sent to a model is fetched through the tenant-scoped data layer. Embeddings, if used, live in Postgres (pgvector) with `business_id` and RLS, not in a separate unscoped vector store.
5. **Attribution.** `activities.actor_type` already distinguishes `user`, `system` and (future) `ai`, so AI-made changes are visible in the timeline.

AI provider evaluation criteria (for the decision, not a recommendation yet): quality on tool use and structured output, data handling terms (no training on customer data, retention, regional processing), latency and cost per typical request, availability of a regional endpoint matching the hosting region, and SDK support. A thin abstraction (e.g. Vercel AI SDK or an in-house interface) keeps switching cost low, but provider-specific features (prompt caching, specific tool formats) are worth using where they help, so the abstraction should not aim for lowest-common-denominator.

## 9. Runtime and operations (assumed defaults)

| Concern | Proposed default | Notes |
|---|---|---|
| Hosting | Vercel (or any Node host) | Open decision D3 |
| Database | Managed PostgreSQL 16+ with PITR backups | Neon, Supabase, RDS all fit; region per D3 |
| Pooling | Provider pooler in transaction mode | Compatible with transaction-local `set_config` |
| Scheduled jobs | Platform cron → authenticated internal route, `bos_jobs` role, idempotent + advisory-locked, introduced in Phase 1e for purge/retention/cleanup only ([data-model.md §7.1](./data-model.md#71-scheduled-jobs-in-phase-1)) | A queue (e.g. pg-boss on Postgres) only when user-facing async work appears |
| Email | Transactional provider for verification/invites | Open decision, low risk |
| Observability | Structured logs + error tracking (e.g. Sentry) | `businessId`/`userId` tags, no PII |
| Package manager | pnpm | Assumption |
| Testing | Vitest (unit/integration against real Postgres), Playwright (e2e) | Integration tests use a real database, not mocks, because RLS must be exercised |

## 10. Open decisions

| ID | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | Authentication provider | Better Auth, our own tenancy tables ([ADR 0001](./adr/0001-authentication-provider.md), proposed) | Phase 1b |
| D2 | AI provider and abstraction | Defer; evaluate against §8 criteria | Before first AI feature |
| D3 | Hosting, database vendor and **data region** | Vercel + managed Postgres in one region; region depends on target market ([ADR 0002](./adr/0002-hosting-and-data-region.md), proposed, needs region) | Phase 1a |
| D4 | Tenant in URL: path `/b/[slug]` vs subdomain `slug.app.com` | Path-based ([ADR 0003](./adr/0003-tenant-in-url.md), proposed) | Phase 1b |
| D5 | Customer ↔ Contact relationship | Contact belongs to at most one customer in Phase 1 (see data model) | Phase 1d |
| D6 | Show planned Zones on Home? | Show as labelled "Not available yet" tiles with no data, so the product shape is visible | Phase 1c |
| D7 | Locale, currency and date formats | Per-business locale/timezone/currency fields now; UI in English only | Phase 1b |
| D8 | Repository | Settled: `reganwagteveld/business-os` | Done |

Each decision gets a short ADR in `docs/adr/`. ADR 0004 records the database isolation design and will hold the spike's results.

## 11. Assumptions

- A small team (one to a few developers) builds Phase 1, so operational simplicity is weighted heavily.
- Target tenants are SMBs with roughly 1 to 50 users and up to low hundreds of thousands of records each in Phase 1 scope.
- **A user can belong to more than one business** (e.g. an owner of two companies, or a bookkeeper serving several clients). This is supported from day one because retrofitting it is hard.
- Web only (responsive), no native mobile apps in Phase 1.
- English UI first; data model is locale-aware.
- No billing/subscriptions in Phase 1.
- Customer PII (names, emails, phones) is stored, so GDPR-style obligations (export, deletion) apply and are designed for.

## 12. Technical risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Cross-tenant data leak | Critical | Medium without controls | Seven layers in §7.3; isolation suite blocks merge |
| RLS with Prisma adds complexity (interactive transaction per unit of work, pooled connections, prepared statements behind the pooler) | High if wrong: isolation; Medium: perf and DX | Medium | Twelve-test spike gates Phase 1b (data-model §5.4); tests stay in CI and re-run on any Prisma/pooler upgrade; any fallback needs an explicit decision |
| `SECURITY DEFINER` functions become an isolation bypass | Critical | Low with controls | Session-token identity binding, fixed `search_path`, dedicated owner, no `PUBLIC` execute, schema test + impersonation tests |
| Long units of work exhaust the connection pool | Medium | Medium | No network calls inside a unit of work; 5 s timeout; pool metrics alerting |
| Cache keyed without tenant | Critical | Medium | `tenantCache()` helper, lint ban on raw cache APIs with tenant data, isolation tests on cached paths |
| Server Actions treated as private functions | High | Medium | `tenantAction` wrapper + CI check |
| Module boundaries erode into a "big ball of mud" | High over time | High without enforcement | Lint + dependency-cruiser in CI from the first commit |
| Shared data model becomes a god-schema as Zones grow | Medium | Medium | Modules own tables; cross-module access via public API; ADR for any shared table |
| Zone model feels slower than a sidebar for power users | Medium (UX) | Medium | Zone switcher, ⌘K, recent items; usability test in Phase 1c |
| Auth vendor lock-in or migration | Medium | Low-medium | `identity` module boundary; our own users table is the reference |
| Framework churn (Next.js and Prisma both had major releases in late 2025) | Medium | Medium | Pin versions; upgrade deliberately; keep framework code in `app/` and `core/` |
| AI features leak data across tenants or exceed user permissions (incl. prompt injection from stored content) | Critical (later) | Medium | AI uses the same actions and tenant-scoped reads; treat stored content as untrusted in prompts; design review before first AI feature |
| Scope creep into speculative Zone features | Medium | High | Phase 1 is Customer Zone only; other Zones stay `planned` with no data |
