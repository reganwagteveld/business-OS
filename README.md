# Business OS

**One platform. One interface. One source of truth.**

Phase 1a foundation: an empty Next.js app with enforced architectural boundaries, local PostgreSQL with separate owner and runtime roles, and CI. There are no product features, business tables or user data yet (those start in Phase 1b).

## Local setup

Requires Node.js 22 (see `.nvmrc`), pnpm 10 (`corepack enable`) and Docker.

```bash
cp .env.example .env
pnpm install          # also generates the Prisma client
pnpm db:setup         # starts PostgreSQL 16 in Docker and creates the roles
pnpm dev
```

Open http://localhost:3000 and http://localhost:3000/health.

The database init script (`docker/init/01-roles.sql`) runs only when the Docker volume is first created. After changing it, run `pnpm db:reset` (this deletes local data). The credentials in `.env.example` are for local development and CI only; never deploy them.

The app validates its environment at startup (`src/core/config/schema.ts`). With missing or invalid values it refuses to serve and logs which variables are wrong. It also refuses to run if `REGION` and `DATABASE_REGION` differ, or if Vercel reports the function running in a region other than `REGION`.

## Checks

| Command | What it checks |
|---|---|
| `pnpm typecheck` | TypeScript, `strict` and `noUncheckedIndexedAccess` |
| `pnpm lint` | ESLint (Next.js rules) |
| `pnpm boundaries` | dependency-cruiser rules in `.dependency-cruiser.cjs` (module public APIs, layer rules, database access only in `core/db`, no vendor SDKs in modules, no cycles) and source rules in `scripts/check-boundaries.mjs` (client components importing server code, `businessId` read outside core, hard-coded regions) |
| `pnpm test` | Unit tests, including a fixture test for every boundary rule |
| `pnpm test:integration` | Against the Docker database: runtime and owner role privileges |
| `pnpm db:check-migrations` | `prisma/schema` has no changes without a migration |
| `pnpm build` | Production build |

CI runs all of them on every pull request, with PostgreSQL as a service container.

## Database roles

| Role | Used for | Key properties |
|---|---|---|
| `bos_owner` | Migrations (`MIGRATION_DATABASE_URL`) | Creates tables; no superuser, no `BYPASSRLS` |
| `bos_app` | The running app (`DATABASE_URL`) | Cannot create objects; no superuser, no `BYPASSRLS`; not a member of `bos_owner` |

The remaining roles from `docs/data-model.md` §5.1 (`bos_auth`, `bos_jobs`, `bos_definer`, `bos_maint`) arrive with the features that need them in Phase 1b and 1e.

## Deployment

`vercel.json` pins server functions to `iad1` (us-east-1), colocated with the database (ADR 0002). Preview deployment and database-vendor verification need the project's Vercel and database accounts and are tracked in the Phase 1a acceptance criteria.

## Documentation

Architecture, data model, implementation plan and decisions: `docs/architecture.md`, `docs/data-model.md`, `docs/implementation-plan.md`, `docs/adr/`.
