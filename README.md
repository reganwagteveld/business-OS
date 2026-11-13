# Business OS

**One platform. One interface. One source of truth.**

Business OS is desktop-first: native Windows and macOS apps (Tauri 2), a companion browser app, and a cloud API that holds all business logic and data (ADR 0005). This is the Phase 1a foundation: the workspace, an API skeleton, the shared client app, a working desktop shell, enforced architectural and security boundaries, and CI. There are no product features, business tables or user data yet (those start in Phase 1b).

## Workspace

| Package | What it is | Can reach the database? |
|---|---|---|
| `apps/api` (`@business-os/api`) | Cloud API: Next.js route handlers under `/api/v1`, Prisma, auth and tenant isolation (later). Deployed to Vercel `iad1` | **Yes, the only one** |
| `apps/desktop` (`@business-os/desktop`) | Tauri 2 desktop app for Windows and macOS | No |
| `apps/web` (`@business-os/web`) | Companion browser app (static Vite build) | No |
| `packages/app` (`@business-os/app`) | Shared React client: Home, Zones (later), typed API client | No |
| `packages/ui` (`@business-os/ui`) | Shared design system: tokens, Tailwind theme, components | No |
| `packages/contracts` (`@business-os/contracts`) | API contracts: endpoint definitions and zod schemas | No |

Clients talk to the API over HTTPS only and receive just one public setting, `VITE_API_BASE_URL`. These rules are enforced by `pnpm boundaries` and the architecture tests, not by convention.

## Local setup

Requires Node.js 22 (see `.nvmrc`), pnpm 10 (`corepack enable`) and Docker. The desktop app also needs Rust (stable) and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS (WebView2 is built into Windows 10/11; macOS needs the Xcode command line tools).

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
cp apps/desktop/.env.example apps/desktop/.env
pnpm install          # also generates the Prisma client
pnpm db:setup         # starts PostgreSQL 16 in Docker and creates the roles
pnpm dev:api          # API on http://localhost:3000 (try /api/v1/health)
pnpm dev:web          # browser app on http://localhost:5173
pnpm dev:desktop      # desktop app in a native window (first run compiles the Rust shell)
```

The client apps show whether the API answers. With the API stopped they say so; nothing is faked.

The database init script (`docker/init/01-roles.sql`) runs only when the Docker volume is first created. After changing it, run `pnpm db:reset` (this deletes local data). The credentials in `apps/api/.env.example` are for local development and CI only; never deploy them.

The API validates its environment at startup (`apps/api/src/core/config/schema.ts`). With missing or invalid values it refuses to serve and logs which variables are wrong. It also refuses to run if `REGION` and `DATABASE_REGION` differ, if Vercel reports the function running in a region other than `REGION`, or if `CORS_ALLOWED_ORIGINS` contains anything but exact origins.

## Checks

| Command | What it checks |
|---|---|
| `pnpm typecheck` | TypeScript in every package, `strict` and `noUncheckedIndexedAccess` |
| `pnpm lint` | ESLint (Next.js rules for the API; React and no-`process.env` rules for the clients) |
| `pnpm boundaries` | dependency-cruiser (`.dependency-cruiser.cjs`): package layering, clients never importing the API or database/server packages, module public APIs, database access only in `core/db`, no vendor SDKs in modules, no cycles; plus source rules (`scripts/check-boundaries.mjs`): `businessId` only in core, no hard-coded regions, no server imports or database config in client code |
| `pnpm test` | Unit, contract and architecture tests, including a fixture test for every boundary rule and the desktop security checks (crates, CSP, capabilities) |
| `pnpm test:integration` | Against the Docker database: runtime and owner role privileges |
| `pnpm contracts:check` | The published API JSON Schema (`packages/contracts/schema/api-v1.json`) matches the contracts (`pnpm contracts:generate` updates it) |
| `pnpm db:check-migrations` | `apps/api/prisma/schema` has no changes without a migration |
| `pnpm build` | API, browser app and desktop frontend production builds (needs `VITE_API_BASE_URL`) |
| `pnpm build:desktop` | Native desktop app (Tauri) for the current OS |

CI runs all of them on every pull request, with PostgreSQL as a service container, and builds the desktop app on Windows and macOS (compile check on Linux).

## Database roles

| Role | Used for | Key properties |
|---|---|---|
| `bos_owner` | Migrations (`MIGRATION_DATABASE_URL`, migration tooling only; never set on the running API) | Creates tables; no superuser, no `BYPASSRLS` |
| `bos_app` | The running API (`DATABASE_URL`) | Cannot create objects; no superuser, no `BYPASSRLS`; not a member of `bos_owner` |

The remaining roles from `docs/data-model.md` §5.1 (`bos_auth`, `bos_jobs`, `bos_definer`, `bos_maint`) arrive with the features that need them in Phase 1b and 1e.

## Deployment

See `docs/deployment.md`. The Vercel project for the API uses root directory `apps/api`; `apps/api/vercel.json` pins functions to `iad1` (us-east-1), colocated with the database (ADR 0002). Desktop builds are unsigned until signing and notarisation are decided (ADR 0005, D9c).

## Documentation

Architecture, data model, implementation plan and decisions: `docs/architecture.md`, `docs/data-model.md`, `docs/implementation-plan.md`, `docs/adr/`. The move from the original single Next.js app to this workspace is described in `docs/migration-desktop-first.md`.
