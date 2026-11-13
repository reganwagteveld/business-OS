# Business OS: Architecture (Phase 1)

> Status: **Reviewed (Phase 0); revised 2026-11-13 for the desktop-first decision ([ADR 0005](./adr/0005-desktop-first-client-architecture.md)).** D1, D3 (region), D4 and D9 are accepted; ADR 0004 is accepted as the design to spike, and the Phase 1b spike must pass before product features. Remaining open decisions in §10 are settled in the phase that needs them. The Phase 1a foundation (workspace, API skeleton, shared client, desktop shell, CI) is in PR #2.

## 1. Purpose and principles

Business OS is an AI-native, multi-tenant SaaS platform. Its **initial market is English-speaking US small businesses (about 5 to 50 employees)**; its long-term ambition is to serve organisations from small businesses up to large multinational enterprises.

**One platform. One interface. One source of truth.**

The principles below follow from that and act as tie-breakers for every design choice in this document:

1. **One backend, one client codebase.** A single cloud API (Next.js) and a single PostgreSQL database hold all business logic and data. One shared React client app is delivered as a **native desktop app (Windows, macOS) first** and a **companion browser app** (ADR 0005). No separate apps per Zone and no microservices until a measured need exists.
2. **One business data model.** Every Zone reads and writes the same records (a customer is a customer, whether you reach it from Customer, Sales or Finance). Zones are views over shared data, not data silos.
3. **Explicit domain boundaries inside the monolith.** Modules own their tables and expose a small public API. Boundaries are enforced by tooling, not convention.
4. **Tenant isolation is defence in depth.** Application checks, a tenant-scoped data layer and PostgreSQL Row-Level Security each independently prevent cross-tenant access.
5. **Real data or honest empty states.** No mock business metrics, placeholder charts or invented numbers anywhere in the product UI.
6. **Build only what Phase 1 needs.** Extension points (Zone registry, permission keys, AI interface) are designed now so they don't need rework, but only Customer Zone functionality is built.
7. **Simple for small customers, no artificial ceiling for enterprises.** SMBs are the starting market, not the limit. Phase 1 builds no enterprise functionality, but it must not make choices that block multi-entity organisations, enterprise permissions, regional or dedicated deployments, large volumes, or enterprise identity and compliance later. Enterprise capabilities arrive as optional layers that small customers never see. Decisions that would be expensive to reverse are listed and made deliberately (§13).
8. **International by default.** The US is the first market, not an assumption baked into the model: every business has its own currency, locale and time zone, and the shared data model avoids US-only concepts (ADR 0002).
9. **Clients are untrusted.** The desktop and browser apps never connect to the database and never contain server code or secrets. Authentication, authorisation, business rules and tenant isolation are enforced only in the API (ADR 0005).

## 2. Current repository state

- 2026-11-13: the repository `reganwagteveld/business-os` was created empty (greenfield). The Phase 0 documents were merged in PR #1.
- Phase 1a (PR #2) first scaffolded a single Next.js app, then, after the desktop-first decision (ADR 0005), was restructured into the pnpm workspace described in §4. What moved where is recorded in [migration-desktop-first.md](./migration-desktop-first.md). No product features exist yet.

## 3. System overview

```
┌─────── Desktop app (Windows, macOS) ───────┐   ┌──────── Browser app ────────┐
│ Tauri 2 shell: native window, OS web view, │   │ static Vite build           │
│ no custom commands, minimal permissions    │   │                             │
│  └ shared client (packages/app + ui)       │   │  └ shared client            │
│    Home · Zone views · Command palette     │   │                             │
└─────────────────────┬──────────────────────┘   └──────────────┬──────────────┘
                      │ HTTPS + JSON, /api/v1/... (packages/contracts)
                      │ no database access, no server code, no secrets
┌─────────────────────▼───────────────────────────────────────────▼─────────────┐
│ Cloud API: Next.js route handlers (apps/api), Vercel iad1, renders no UI      │
│                                                                               │
│  app/api/v1/   thin routing layer: route handlers (tenantRoute wrapper)       │
│     │                                                                         │
│  modules/      domain modules (public API → services → repos)                 │
│     │   identity · tenancy · access · customers · activity                    │
│     │                                                                         │
│  core/         shared kernel: db, tenant context, authz, http (CORS),         │
│                errors, audit, config, (later) ai                              │
└─────────────────────────────────────┬─────────────────────────────────────────┘
                                      │ Prisma (tenant-scoped client) + RLS session var
┌─────────────────────────────────────▼─────────────────────────────────────────┐
│  PostgreSQL (Neon, aws-us-east-1): single database, shared schema,            │
│  business_id on every tenant-owned row, RLS policies on every tenant table    │
└───────────────────────────────────────────────────────────────────────────────┘
External: email delivery, error tracking (ADR 0002); AI provider (D2, later).
```

**Multi-tenancy model: shared database, shared schema, `business_id` column.**

| Option | Isolation | Ops cost | Fit for SMB SaaS |
|---|---|---|---|
| Database per tenant | Strongest | High: N migrations, N connection pools | Poor at thousands of small tenants |
| Schema per tenant | Strong | Medium-high: migrations fan out, Prisma handles it poorly | Poor |
| **Shared schema + `business_id` + RLS** | Strong when RLS is enforced | Low | **Good: the standard choice for many small tenants** |

The shared-schema choice is only safe because of the layered safeguards in §7. If a large customer later needs physical isolation, the tenant-scoped data layer makes it possible to route that tenant to a dedicated database without changing module code.

## 4. Repository structure

A **pnpm workspace** with three deployables and three shared packages (ADR 0005). Workspaces are used because there are now genuinely separate build targets (a native app, a static web app and a server), and because a package boundary is the strongest way to keep server code out of clients. No build orchestrator (Turborepo, Nx) is added: `pnpm -r` is enough at this size.

```
business-os/
├── apps/
│   ├── api/                      # @business-os/api: Next.js cloud API (route handlers only)
│   │   ├── prisma/
│   │   │   ├── schema/           # multi-file schema, one file per module
│   │   │   └── migrations/       # generated SQL + hand-written RLS SQL
│   │   ├── src/
│   │   │   ├── app/api/v1/       # route handlers: routing ONLY
│   │   │   │   ├── health/       # liveness (Phase 1a)
│   │   │   │   └── b/[businessSlug]/...  # tenant-scoped routes (Phase 1b+)
│   │   │   ├── modules/
│   │   │   │   ├── identity/     # users, sessions (wraps Better Auth)
│   │   │   │   ├── tenancy/      # businesses, memberships, invitations
│   │   │   │   ├── access/       # roles, permissions, can()
│   │   │   │   ├── customers/    # customers, contacts
│   │   │   │   └── activity/     # activity timeline (cross-cutting)
│   │   │   │       ├── index.ts  # PUBLIC API: the only importable file
│   │   │   │       └── server/   # services, repositories
│   │   │   ├── core/
│   │   │   │   ├── db/           # Prisma client, tenant-scoped extension
│   │   │   │   ├── tenant/       # TenantContext, requireTenant()
│   │   │   │   ├── authz/        # authorize(), permission registry
│   │   │   │   ├── http/         # API headers, CORS allowlist, tenantRoute()
│   │   │   │   ├── audit/        # security audit log writer
│   │   │   │   ├── jobs/         # scheduled maintenance jobs (Phase 1e)
│   │   │   │   ├── config/       # env validation (zod), region map
│   │   │   │   └── errors/
│   │   │   └── generated/        # Prisma client (generated, not committed)
│   │   ├── tests/                # unit, contract and integration tests (real Postgres)
│   │   └── vercel.json           # functions pinned to iad1
│   ├── desktop/                  # @business-os/desktop: Tauri 2 app for Windows and macOS
│   │   ├── src/                  # entry: renders <App platform="desktop">
│   │   ├── src-tauri/            # Rust shell, tauri.conf.json (CSP), capabilities, icons
│   │   └── scripts/              # per-build CSP (connect-src = API origin only)
│   └── web/                      # @business-os/web: companion browser app (static Vite build)
│       └── src/                  # entry: renders <App platform="web">
├── packages/
│   ├── contracts/                # @business-os/contracts: endpoint definitions + zod schemas,
│   │                             # JSON Schema snapshot (schema/api-v1.json)
│   ├── ui/                       # @business-os/ui: design tokens, Tailwind theme, shadcn/ui-style
│   │                             # components, patterns (ZoneHeader, EntityTable, ...)
│   └── app/                      # @business-os/app: shared client: Home, Zone manifests and
│                                 # views, typed API client, client routing
├── tests/architecture/           # workspace-wide boundary, client-security and contract tests
├── scripts/check-boundaries.mjs  # source rules that import graphs cannot express
├── tooling/                      # shared lint config for client packages
├── docker/, docker-compose.yml   # local PostgreSQL 16 with the least-privilege roles
└── .github/workflows/ci.yml      # workspace checks + desktop builds (Windows, macOS, Linux compile)
```

**Allowed dependencies between workspace packages** (enforced by dependency-cruiser, §5.3):

| From | May depend on | Must never depend on |
|---|---|---|
| `apps/api` | `contracts` | `ui`, `app`, any other app |
| `apps/desktop`, `apps/web` | `app`, `ui` (and `contracts` through `app`) | `apps/api`, each other, database drivers, Prisma, `next`, `server-only` |
| `packages/app` | `contracts`, `ui` | any app, server or database packages |
| `packages/ui` | nothing internal | `app`, `contracts`, any app |
| `packages/contracts` | `zod` only | everything else internal |

Notes:

- **Route handlers are thin.** They call module public APIs; business rules never live in `app/`.
- **Only `apps/api` can reach PostgreSQL**, and inside it only `core/db` imports Prisma (§5.2 rule 6). The API is never a dependency of a client, so server code cannot be bundled into a client.
- **Clients receive only public build-time configuration** (`VITE_API_BASE_URL`). No secret or database setting exists in a client package.
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

- **Workspace package boundaries** (§4): clients cannot import the API or server-only packages at all.
- `dependency-cruiser` (`.dependency-cruiser.cjs`) in CI: cycles, module public APIs, layer rules inside the API (`modules` cannot import `app`; `core` imports nothing above it), Prisma only in `core/db`, no vendor SDKs in modules, and the package rules in §4.
- Source rules (`scripts/check-boundaries.mjs`): no `businessId` reads outside `core/tenant`/`core/db`, no hard-coded region names, no client components in the API, and no server imports or database configuration in any client source.
- Client security tests (`tests/architecture/clients.test.ts`): client manifests, the Tauri crate list, CSP and capabilities (ADR 0005).
- Every rule is proven by a fixture test that expects the violation to be caught (`tests/architecture/boundaries.test.ts`).

**Tradeoff:** module boundaries inside the API remain tool-enforced rules rather than packages, which keeps the API one deployable with no build overhead. The client/server line, where a mistake would ship server code to customers' machines, is a package boundary.

## 6. Zones: registration and navigation

### 6.1 Concepts

- **Home**: the landing dashboard for a business. Shows Zone entry points and widgets that each Zone contributes. Only real data or empty states.
- **Zone**: a top-level area (Customer, Sales, Finance, Projects, Operations, People). Each has an entry on Home, a header, and a small zone-local navigation.
- **No global sidebar.** Movement between Zones is via Home, a compact Zone switcher in the top bar, and the command palette.

### 6.2 Zone manifest

Each Zone is described by a typed, static manifest. The registry is a plain array assembled at build time; there is no runtime plugin loading.

```ts
// packages/app/src/zones/define-zone.ts  (illustrative, not final code)
export type ZoneStatus = "active" | "planned";

export interface ZoneManifest {
  id: ZoneId;                     // "customer" | "sales" | ...
  label: string;                  // "Customer"
  description: string;            // one line, shown on Home
  icon: IconName;                 // from the design-system icon set
  order: number;                  // position on Home and in the switcher
  status: ZoneStatus;             // planned Zones render no data
  basePath: `/${string}`;         // "/customer" (client route under /b/{businessSlug})
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
  load: () => Promise<{ default: WidgetComponent }>; // lazy client component; data via the API
}
```

```ts
// packages/app/src/zones/customer/zone.ts  (illustrative)
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
      load: () => import("./widgets/recent-activity") },
  ],
  commands: [
    { id: "new-customer", label: "New customer", requires: "customers:write", href: "/new" },
  ],
});
```

### 6.3 How the pieces fit

- **Where Zones live.** Zone manifests, views and client routes live in the shared client app (`packages/app/src/zones`), so the desktop and browser apps render the same Zones (ADR 0005). Their data comes only from API endpoints declared in `packages/contracts`, served by the modules in `apps/api`. Widgets are client components that call the API; `load` in the manifest is a lazy client import.
- **Routing.** Client routes follow ADR 0003 (`/b/{businessSlug}/<zone>/...`); the matching API routes are `/api/v1/b/{businessSlug}/...`. A test asserts that every `active` manifest has a client route and that every API endpoint it uses exists in the contracts, so the registry, routes and API cannot drift. The client router library is chosen in Phase 1c.
- **Visibility.** Shell, Home, switcher and command palette all derive from one function: `visibleZones(permissions) = registry.filter(z => permissions.includes(z.requires))`, using the permissions the API returns for the current membership. Nav items, widgets and commands are filtered the same way. Hiding a link is a UX convenience only: every API route re-checks permissions on the server (§7).
- **Planned Zones.** Sales, Finance, Projects, Operations and People are registered with `status: "planned"`, no routes, no widgets and no data. Whether they appear on Home (as clearly labelled "Not available yet" tiles) or are hidden entirely is an open decision (§10, D6).
- **Per-business enablement (later).** A `business_zone_settings` table can later let a business turn Zones on or off. It is not needed in Phase 1 and is deliberately not built.
- **Adding a Zone** is: a module and API routes (if new data is needed), contracts for those routes, a manifest and client views, and permission keys. No changes to shell code. This is the main scalability property of the model.

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

- One design system for desktop and web, in `packages/ui`: Tailwind CSS with design tokens as CSS variables (colour, spacing, radius, typography, Zone accent colours), light and dark themes from the start.
- shadcn/ui components are copied into `packages/ui/src/components` and owned by the project.
- Desktop conventions (keyboard shortcuts, window sizing, menus) are added in the shared app and adapt per platform only where the OS expects it; there is no separate desktop UI.
- Shared patterns in `packages/ui/src/patterns` (`ZoneHeader`, `EntityTable`, `EntityForm`, `EmptyState`, `Timeline`, `DetailPanel`) are the only way Zones build standard screens, so all Zones look and behave the same.
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

**Native and browser clients (ADR 0005).** The browser app uses an HTTP-only session cookie on the same site as the API. The desktop app signs in through the system browser and receives a revocable session token (PKCE code exchange) that it stores only in the OS credential store and sends as a bearer token. Both resolve to the same server-side session. Mechanism details: D9a.

Baseline requirements regardless of provider:

- Email + password and/or magic link; Google sign-in; optional TOTP 2FA (required for owners later).
- Browser: HTTP-only, `Secure`, `SameSite=Lax` session cookies with an `Origin` check on mutating requests. Desktop: bearer session tokens in the OS credential store, never in web storage. Server-side session revocation for both.
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

await authorize(ctx, "customers:write");            // throws ForbiddenError
await authorize(ctx, "customers:write", customer);  // optional resource: ignored in Phase 1,
                                                    // reserved for record/scope rules later (§13.2)
```

- A static `ROLE_PERMISSIONS` map in `modules/access` translates role → permissions.
- Each module declares the permission keys it owns; the registry is the union, so typos are type errors.
- **Future custom roles**: add `roles` and `role_permissions` tables, point `memberships.role_id` at them, and swap the static map for a lookup. Because call sites already use permission keys, no module code changes. This is why role checks are banned now.
- Record-level rules (e.g. "only see customers assigned to me") are **not** in Phase 1. If needed later they are implemented as additional RLS predicates and service-layer filters, not ad hoc page checks.

### 7.3 Tenant isolation safeguards (defence in depth)

Each layer below must independently prevent a cross-tenant read or write. A bug in any one layer should not cause a leak.

**Layer 1: tenant context is derived server-side, never trusted from the client.**

- The active business comes from the API path segment `/api/v1/b/{businessSlug}`, resolved on the server to a `business_id` **and** verified against the signed-in user's membership on every request. The desktop and browser apps are untrusted clients: nothing they send is trusted for identity or tenancy.
- `business_id` is never accepted from form data, query strings or request bodies. Zod schemas for actions do not contain it.
- `requireTenant()` returns an immutable `TenantContext { businessId, userId, membershipId, role, permissions }` and is the only way to obtain one.
- Membership is re-checked per request (cached only within the request), so removing a member takes effect immediately.

**Layer 2: every entry point goes through a wrapper.**

- Route handlers are public HTTP endpoints. All tenant-scoped routes are defined via `tenantRoute({ permission, input: contractSchema }, handler)`, which authenticates (cookie or bearer session), resolves the tenant, authorises, validates input with the contract schema and passes `ctx` to the handler. Pre-tenant routes use `publicRoute`. (These replace the `tenantAction`/`publicAction` wrappers of the web-only design; Server Actions are not used, ADR 0005.)
- A CI check fails if a route handler under `app/api/v1/b/` is not wrapped by `tenantRoute`, or one elsewhere under `app/api/v1/` is not wrapped by `publicRoute` or explicitly listed as unauthenticated (such as `health`).
- **Next.js middleware/proxy is not a security boundary.** It may redirect unauthenticated users for UX, but authentication and authorisation are always re-checked in the layout, page, action or handler. (A 2025 Next.js vulnerability allowed middleware to be bypassed entirely; the design must not depend on it.)

**Layer 3: tenant-scoped data access (unit of work).**

- `core/db` exposes `withTenant(ctx, work)`, which opens one Prisma **interactive transaction**, sets the tenant context as its first statement, and passes `work` a narrowed `TenantDb` client bound to that transaction. Every statement in the unit of work therefore runs on the same connection and transaction as the context (design and rationale in [data-model.md §5.3](./data-model.md#53-unit-of-work-how-the-tenant-context-reaches-postgresql)).
- `TenantDb` injects `businessId` into every read, update and delete on tenant models, sets it on every create (rejecting a mismatch), and does not expose `$transaction` or the `*Unsafe` raw-SQL methods.
- Module services accept a `TenantDb` parameter and never receive a client, so a tenant query outside a unit of work does not compile.
- The unscoped clients (`bos_auth` for the auth adapter, `bos_jobs` for scheduled jobs) are importable only from their single owning file, enforced by lint and a test.

**Layer 4: PostgreSQL Row-Level Security and least-privilege roles.**

- Every tenant-owned table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with a policy `TO bos_app` matching `business_id` to the transaction-local `app.business_id` setting.
- The application connects as `bos_app`: not a table owner, no `BYPASSRLS`, no access to auth tables or platform audit events. Migrations run as `bos_owner`, the auth library as `bos_auth`, scheduled jobs as `bos_jobs` (with purge limited by policy to businesses past the grace period, and maintenance done through `bos_maint`-owned functions) (roles and grants in [data-model.md §5.1](./data-model.md#51-roles-and-grants-least-privilege)).
- With no setting, the policy matches nothing: **fail closed**.
- The only paths around tenant RLS are three `SECURITY DEFINER` functions for pre-tenant operations (list my businesses, create business, accept invitation), plus maintenance functions for scheduled jobs that are limited to retention clean-up and purgeable businesses ([data-model.md §7.1](./data-model.md#71-scheduled-jobs-in-phase-1)). The pre-tenant functions take the **session token, not a user id**, verify the session inside the database, use a fixed `search_path`, are owned by a dedicated no-login role, and are not executable by `PUBLIC` ([data-model.md §5.5](./data-model.md#55-pre-tenant-trusted-paths-app_private-security-definer-functions)).
- `users` and `audit_events` are global tables with their own RLS and column grants, so tenant code cannot enumerate unrelated users or read platform audit events ([data-model.md §5.6](./data-model.md#56-global-data-users-and-audit-events)).
- **This design is gated by a spike** with thirteen concrete tests (same connection, fail closed, no carry-over, rollback, concurrency behind the pooler, raw queries, timeouts, overhead) before any Phase 1b feature work ([data-model.md §5.4](./data-model.md#54-rls-spike-what-must-be-proven-before-phase-1b-features)).

**Layer 5: referential integrity across tenants.**

- Child rows reference parents with **composite foreign keys** `(business_id, parent_id) → parent(business_id, id)`, so a contact cannot be attached to another business's customer even through a bug that bypasses layers 1 to 3.

**Layer 6: caches, files, search and logs.**

- API responses carrying tenant data are `Cache-Control: private, no-store`, so no CDN or shared cache stores them. Clients keep tenant data in memory only (no offline cache in Phase 1, ADR 0005).
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
- Security headers (CSP, HSTS, `X-Content-Type-Options`, `frame-ancestors 'none'`) on the API and browser app. The desktop app has its own strict CSP whose `connect-src` is only the configured API origin, `withGlobalTauri: false`, and only `core:default` permissions (ADR 0005).
- CORS: an exact origin allowlist from validated config (`CORS_ALLOWED_ORIGINS`), never a wildcard.
- `audit_events` table (security log, append-only) for sign-ins, membership changes, role changes, exports and deletions.
- Secrets only in the hosting provider's secret store, used only by the API; env validated at boot. Client builds receive only `VITE_*` public settings, and CI checks client bundles for database configuration.
- Desktop releases are code-signed and notarised, and updates are signed (D9c, D9d) before any external distribution.
- Dependency scanning (Dependabot/Renovate) and `npm audit` in CI.

## 8. AI-native foundations (design only)

No AI features are built in Phase 1. "AI-native" is protected now by decisions that would be expensive to retrofit:

1. **Structured, well-described data.** The shared data model, typed activity records and zod schemas are what an AI assistant will read and act on. Clean data is the main AI investment in Phase 1.
2. **Actions as the AI's hands.** Every write goes through a `tenantRoute` with a contract schema and a permission. A future assistant invokes the same actions as tools, so it can never do more than the signed-in user can, and every AI action is authorised, validated and audited like a human one.
3. **Provider abstraction.** A future `core/ai` module exposes a narrow interface (`generate`, `stream`, `embed`, tool calling). The provider is an **open decision** (§10, D2).
4. **Tenant-safe retrieval.** Any context sent to a model is fetched through the tenant-scoped data layer. Embeddings, if used, live in Postgres (pgvector) with `business_id` and RLS, not in a separate unscoped vector store.
5. **Attribution.** `activities.actor_type` already distinguishes `user`, `system` and (future) `ai`, so AI-made changes are visible in the timeline.

AI provider evaluation criteria (for the decision, not a recommendation yet): quality on tool use and structured output, data handling terms (no training on customer data, retention, regional processing), latency and cost per typical request, availability of a regional endpoint matching the hosting region, and SDK support. A thin abstraction (e.g. Vercel AI SDK or an in-house interface) keeps switching cost low, but provider-specific features (prompt caching, specific tool formats) are worth using where they help, so the abstraction should not aim for lowest-common-denominator.

## 9. Runtime and operations (assumed defaults)

| Concern | Proposed default | Notes |
|---|---|---|
| Hosting (API) | Vercel, functions in `iad1` (us-east-1) | ADR 0002; app kept portable (Next.js standalone output, platform services behind adapters) |
| Browser app | Static Vite build on Vercel, same site as the API | No tenant data in static assets; domain layout is D9b |
| Desktop app | Tauri 2, Windows (WebView2) and macOS (WKWebView) | Built in CI on both; signing, notarisation and updates before external release (D9c, D9d) |
| Database | Managed PostgreSQL 16+ with PITR backups, AWS us-east-1 | Neon proposed; colocated with compute (ADR 0002) |
| Pooling | Provider pooler in transaction mode | Compatible with transaction-local `set_config` |
| Scheduled jobs | Platform cron → authenticated internal route, `bos_jobs` role, idempotent + advisory-locked, introduced in Phase 1e for purge/retention/cleanup only ([data-model.md §7.1](./data-model.md#71-scheduled-jobs-in-phase-1)) | A queue (e.g. pg-boss on Postgres) only when user-facing async work appears |
| Email | Transactional provider for verification/invites | Open decision, low risk |
| Observability | Structured logs + error tracking (e.g. Sentry) | `businessId`/`userId` tags, no PII |
| Package manager | pnpm workspace (`apps/*`, `packages/*`) | ADR 0005 |
| Testing | Vitest (unit/integration against real Postgres), Playwright (e2e) | Integration tests use a real database, not mocks, because RLS must be exercised |

## 10. Open decisions

| ID | Decision | Recommendation | Needed by |
|---|---|---|---|
| D1 | Authentication provider | **Accepted:** Better Auth, our own tenancy tables, conditions verified in 1b ([ADR 0001](./adr/0001-authentication-provider.md)) | Phase 1b |
| D2 | AI provider and abstraction | Defer; evaluate against §8 criteria | Before first AI feature |
| D3 | Hosting, database vendor and data region | **Region accepted: US East (N. Virginia), us-east-1**, compute and database colocated, single region in Phase 1. Vercel + Neon proposed, verified in 1a ([ADR 0002](./adr/0002-hosting-and-data-region.md)) | Phase 1a |
| D4 | Tenant in URL: path `/b/[slug]` vs subdomain `slug.app.com` | **Accepted:** path-based ([ADR 0003](./adr/0003-tenant-in-url.md)) | Phase 1b |
| D5 | Customer ↔ Contact relationship | Contact belongs to at most one customer in Phase 1 (see data model) | Phase 1d |
| D6 | Show planned Zones on Home? | Show as labelled "Not available yet" tiles with no data, so the product shape is visible | Phase 1c |
| D7 | Locale, currency and date formats | Per-business locale, time zone and currency, required at onboarding (pre-filled `en-US`/`USD` for the US launch); UI in English only | Phase 1b |
| E1 | Primary keys `(business_id, id)` on high-volume tables (for future partitioning) | Yes for `activities` and future transactional tables (§13.4) | Phase 1b |
| D8 | Repository | Settled: `reganwagteveld/business-os` | Done |
| D9 | Client architecture | **Accepted:** desktop-first (Tauri 2, Windows and macOS) plus a companion browser app, one shared React client, Next.js as API only ([ADR 0005](./adr/0005-desktop-first-client-architecture.md)) | Done |
| D9a | Desktop sign-in mechanism (deep link vs loopback) and credential-store plugin | **Accepted:** system browser, loopback redirect, PKCE S256, OS credential store (ADR 0005 addendum) | Done (Phase 1b) |
| D9b | Browser app hosting and domains (same origin vs `app.`/`api.`) | **Accepted:** browser app on the same origin as the API (ADR 0005 addendum) | Done (Phase 1b) |
| D9c | Desktop app identifier, code signing and notarisation | Placeholder `com.business-os.desktop` until decided; cannot change after release | Before any external build |
| D9d | Desktop auto-update | Tauri updater with signed manifests | Before first external release |

Each decision gets a short ADR in `docs/adr/`. ADR 0004 (accepted as the design to spike) records the database isolation design and will hold the spike's results.

## 11. Assumptions

- A small team (one to a few developers) builds Phase 1, so operational simplicity is weighted heavily.
- Initial go-to-market: English-speaking US small businesses with roughly 5 to 50 employees, so Phase 1 tenants have roughly 1 to 50 users and up to low hundreds of thousands of records each. This is a hypothesis, not a limit (principles 7 and 8).
- **A user can belong to more than one business** (e.g. an owner of two companies, or a bookkeeper serving several clients). This is supported from day one because retrofitting it is hard.
- Desktop-first: native Windows and macOS apps are the primary experience, with a companion browser app; no native mobile apps in Phase 1. The desktop app requires a network connection (no offline mode).
- Supported desktop platforms: Windows 10 and later (WebView2) and macOS 11 and later. Linux is compiled in CI for fast feedback but is not a supported target.
- English (US) UI first; the data model and formatting are locale-, currency- and time-zone-aware per business.
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
| API routes treated as private because only our clients call them | High | Medium | `tenantRoute`/`publicRoute` wrappers + CI check; clients treated as untrusted (ADR 0005) |
| Server code, secrets or database access shipped in the desktop or browser app | Critical | Low with controls | Package boundary, dependency-cruiser and source rules, manifest/crate deny lists, desktop CSP, bundle scan in CI (ADR 0005) |
| Desktop shell gains privileges over time (plugins, IPC commands, broad CSP) | High | Medium | Capabilities and CSP checked by tests; any new capability needs an architecture review |
| Stolen desktop session token | High | Low-medium | Token only in the OS credential store, short-lived and revocable server-side, sign-in in the system browser |
| Client and API drift apart | Medium | Medium | Shared contracts, response validation on both sides, contract coverage and snapshot checks in CI, versioned paths |
| Desktop distribution friction (unsigned builds, SmartScreen/Gatekeeper warnings, updates) | Medium (adoption) | High until solved | D9c and D9d decided before any external release; CI already builds both platforms |
| Module boundaries erode into a "big ball of mud" | High over time | High without enforcement | Lint + dependency-cruiser in CI from the first commit |
| Shared data model becomes a god-schema as Zones grow | Medium | Medium | Modules own tables; cross-module access via public API; ADR for any shared table |
| Zone model feels slower than a sidebar for power users | Medium (UX) | Medium | Zone switcher, ⌘K, recent items; usability test in Phase 1c |
| Auth vendor lock-in or migration | Medium | Low-medium | `identity` module boundary; our own users table is the reference |
| Framework churn (Next.js, Prisma, Vite and Tauri all release often) | Medium | Medium | Lockfile pinned; upgrade deliberately; keep framework code in `app/` and `core/`; Tauri shell kept free of custom Rust |
| AI features leak data across tenants or exceed user permissions (incl. prompt injection from stored content) | Critical (later) | Medium | AI uses the same actions and tenant-scoped reads; treat stored content as untrusted in prompts; design review before first AI feature |
| Scope creep into speculative Zone features | Medium | High | Phase 1 is Customer Zone only; other Zones stay `planned` with no data |
| SMB-shaped choices block enterprise growth (single-entity tenant, role checks, US-only fields, vendor lock-in) | High over the long term | Medium | Principle 7; the irreversible-choices table in §13.6; preparations enforced by lint and acceptance criteria |
| Enterprise needs complicate the SMB product | High (product) | Medium | Enterprise features are optional layers invisible to SMBs (§13.7) |
| Customers outside the US expect in-region data storage before a region exists | Medium (sales) | Medium | Residency limits stated in terms (ADR 0002); regional-silo path designed |

## 13. Growth paths: from small business to enterprise

SMBs are the initial market, not the platform's limit (principle 7). This section assesses whether the Phase 1 design leaves reasonable expansion paths towards large, multi-entity, multinational organisations. **None of this is built in Phase 1.** The aim is to know which constraints Phase 1 creates, how each would be lifted later, and which choices are expensive or impossible to reverse, so those are made deliberately now.

Ratings: **Open** (no Phase 1 change needed), **Prepared** (a small, cheap Phase 1 choice keeps the path open), **Work later** (feasible, but a real project when the need comes), **Hard** (needs a dedicated design; may limit what is offered).

### 13.1 Parent organisations, subsidiaries, divisions and multi-entity structures

**Phase 1 model:** a `Business` is the tenant, the isolation boundary, and in practice one operating entity. Users can belong to several businesses.

**Assessment: Work later, with two cheap preparations now.**

- The future model adds an **`Organisation` above businesses** (`businesses.organisation_id`, nullable; SMBs never see it). Each subsidiary or legal entity is a `Business` with its own currency, locale, time zone and country, which matches how enterprises actually operate legal entities. Divisions and departments become an `org_units` hierarchy inside a business (or across an organisation), used for permissions and reporting dimensions, not as separate tenants.
- **Cross-entity access** (a group CFO seeing all subsidiaries) means a tenant context that covers **a set of businesses** for reads, while every write still targets exactly one business. RLS changes from `business_id = setting` to `business_id = ANY(setting_array)` for reads, keeping single-business `WITH CHECK` for writes.
- **Preparations now (cheap):**
  1. RLS policies are **generated from one template** and checked by the schema guard (data-model §5.2), so changing the predicate for every table later is one migration, not a hand edit of each policy.
  2. Only `core/tenant` and `core/db` read `businessId` from the context; modules never compare tenant ids themselves (lint rule). Widening the context to a set then touches core, not every module.
- **Not prepared, and deliberately so:** no `organisations` table, no org-level membership, no consolidated reporting in Phase 1.
- **Known future design work:** shared master data across entities (one global customer record used by several subsidiaries) does not fit "every row belongs to one business". Options when needed: organisation-owned tables with organisation-level RLS, or per-entity records linked to a shared master. Intercompany transactions will be modelled the way accounting does it: a record in each entity, linked, not one row spanning two tenants.

### 13.2 Enterprise-scale users, permissions and hierarchies

**Assessment: Prepared.**

- Permissions are checked by **permission key**, never by role (§7.2). Custom roles become a table without changing call sites.
- **Preparation now:** `authorize(ctx, permission, resource?)` takes an optional resource argument from the start, even though Phase 1 ignores it. Record-level and scope-based rules (e.g. "managers see their division's customers", "sales reps see assigned accounts") can then be added in `modules/access` without touching every call site.
- Later paths, in order of likely need: role assignment scoped to a business or org unit; record ownership and team-based visibility (enforced in both services and RLS predicates); and, if rules become a graph (delegation, sharing, matrix organisations), a relationship-based authorisation engine (e.g. OpenFGA, SpiceDB or Cedar) behind the same `authorize()` interface.
- Scale: member pickers, lists and searches are paginated and server-searched from the start (no "load all members" UI), so 10,000-user organisations do not need UI rewrites.
- Constraint to note: membership is per business. A user in 30 subsidiaries will need organisation-level membership with inheritance; this is part of the 13.1 work.

### 13.3 Regional data residency and dedicated enterprise deployments

**Assessment: Prepared for regional silos; Work later for dedicated deployments; Hard for one organisation split across regions.**

- Regional silos (full stack per region from the same codebase) are described in [ADR 0002](./adr/0002-hosting-and-data-region.md). Prepared by: `business_id` on everything with no cross-tenant references, globally unique UUIDv7 ids, region values only in environment config, and `businesses.home_region`.
- **Desktop clients and regions:** the desktop app talks to one API base URL. With regional silos it must learn its region's API at sign-in from the global directory (ADR 0002) rather than from a build-time setting; the API URL setting is therefore kept in one place in the client (`parseClientConfig`) so that change is local. CSP `connect-src` will then list the regional API origins.
- **Dedicated enterprise deployments** (single-tenant stack, possibly in the customer's preferred region or cloud) use the same mechanism as a region with one business or organisation in it. To keep this possible: the app must stay deployable outside Vercel (Next.js standalone output, no proprietary storage or KV APIs in modules; platform services behind adapters in `core`), and infrastructure should be defined as code from Phase 1a so a new stack is reproducible. Customer-managed encryption keys are realistic only in dedicated deployments.
- **Hard:** an organisation whose entities must be stored in different regions cannot have live, database-level cross-entity reporting. If this becomes a requirement it needs a specific design (e.g. residency-compliant aggregated exports into a reporting store), and may be offered only as a dedicated-deployment feature.

### 13.4 Large transaction volumes, complex workflows and cross-entity reporting

**Assessment: Open to Work later, with one decision to take before Phase 1b.**

- PostgreSQL is a sound system of record well beyond SMB scale. The scaling path is: indexes leading with `business_id` (already required), keyset pagination (already required), read replicas for heavy reads (RLS works on replicas), then **partitioning** of high-volume tables by `business_id` (hash) or by time.
- **Decision E1 (before Phase 1b):** PostgreSQL requires the partition key in the primary key of a partitioned table. Changing a primary key on a large, live table is one of the few genuinely expensive migrations. Because every tenant FK is already composite `(business_id, id)`, making the **primary key `(business_id, id)` on high-volume tables** (`activities` now; future ledgers, invoices, events) costs little today. Recommendation: do it for `activities` and future transactional tables; keep single-column keys on small tables.
- Workflows: Phase 1 has scheduled maintenance jobs only (data-model §7.1). The path is a Postgres-backed queue (pg-boss), then a durable workflow engine (e.g. Temporal or Inngest) when multi-step business processes appear, with a **transactional outbox** so domain events are never lost between the database and the queue.
- Reporting: in-app reports query PostgreSQL. Cross-entity and large-scale analytics later move to a separate analytical store fed by change data capture, keeping `business_id` (and later `organisation_id`) on every row so tenant filtering survives the copy.
- Money and time are already enterprise-grade by convention (integer minor units with ISO currency; UTC with IANA time zones). Multi-currency consolidation will need exchange-rate tables per organisation; nothing in Phase 1 blocks it.

### 13.5 Enterprise SSO, identity provisioning, compliance and audit

**Assessment: Prepared, with vendor maturity to verify.**

- Identity is behind the `identity` module, and users are keyed by our own id, not email, so an SSO subject or a changed email does not break records. SSO identities attach as additional `accounts` rows.
- SSO (SAML/OIDC) and SCIM provisioning: Better Auth offers SSO support; its SCIM maturity must be verified when the need arises. If insufficient, a broker such as WorkOS can be added **for enterprise connections only**, while users, sessions and memberships stay in our database (ADR 0001 lists this as the revisit trigger). SCIM deprovisioning maps to `memberships.status = SUSPENDED`, which already exists.
- Later additions: verified email domains per organisation (auto-join and enforced SSO), mandatory MFA policies, session-length policies per organisation.
- Audit and compliance: `audit_events` is append-only with RLS from Phase 1. Later: tenant-visible audit log UI, export/streaming to customer SIEMs, configurable retention per organisation, and SOC 2 / ISO 27001 controls (access reviews, change management, vendor list from ADR 0002). The separation of business activity from security audit (data-model §4.8) is what makes per-tenant retention and SIEM export straightforward later.

### 13.6 Choices that are expensive or impossible to reverse

These are the decisions to get right now. Everything else in this document can be changed with ordinary refactoring.

| Choice | Phase 1 position | Why it is hard to reverse | Status |
|---|---|---|---|
| Identifier format | UUIDv7 everywhere | Changing ids means rewriting every FK, URL and integration | Decided; also enables region moves |
| Every row owned by exactly one `business_id`, composite FKs | Yes | It is the basis of isolation, export, relocation and partitioning | Decided |
| Tenant granularity (business = entity; organisations added above) | Business-level tenant | Collapsing entities into one tenant later would mix data that is isolated today | Decided, with 13.1 preparations |
| Primary keys on high-volume tables | Proposed `(business_id, id)` | PK changes on large live tables need long, risky migrations | **Decision E1** |
| Time, money, locale representation | UTC `timestamptz`, IANA zones, ISO currency, minor units, BCP 47 locales | Retrofitting time zones or currency to stored data is error-prone and lossy | Decided |
| International data model (no US-only fields) | Yes | Renaming `state`/`zip`/`ein` across data and integrations later is costly | Decided (ADR 0002) |
| Users keyed by our id, identity data in our database | Yes | Moving away from a hosted identity vendor later means migrating every user | Decided (ADR 0001) |
| Permission-key authorisation with a resource argument | Yes | Role checks scattered through code are expensive to unwind | Decided |
| Portability of hosting (no proprietary APIs in modules) | Yes | Vendor-specific APIs inside business logic block regions and dedicated deployments | Decided, enforced by lint in 1a |
| Desktop application identifier and signing identity | Placeholder | Changing the identifier after release orphans installed apps' data and breaks the update path | **Decision D9c** |
| Public API paths and contracts | `/api/v1`, contracts package | Installed desktop apps cannot be updated instantly, so old clients call the API for weeks; breaking a published contract strands them | Decided: additive changes only within a version (ADR 0005) |
| Region of existing customers' data | us-east-1 | Moving live tenants needs a relocation procedure and customer communication | Accepted (ADR 0002); relocation possible by design |

### 13.7 Keeping it simple for small customers

Enterprise structure must be **additive and invisible** until used: an SMB has one business, no organisation, no org units, three fixed roles and no SSO configuration, and never sees settings for any of them. New enterprise capabilities are introduced as optional layers above the Phase 1 model, never as required fields or extra steps in the SMB experience.
