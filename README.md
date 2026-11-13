# Business OS

**One platform. One interface. One source of truth.**

## Phase 1a developer preview

Requires Node.js 22+, pnpm 10 and Docker Desktop.

```bash
cp .env.example .env
pnpm install
pnpm setup
pnpm dev
```

Open http://localhost:3000 and http://localhost:3000/health. `pnpm setup` starts Docker PostgreSQL and generates the Prisma client; **no business tables or user data exist yet**. The owner and runtime database roles use local-only credentials. Never deploy these credentials.

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `pnpm test`.

This is the **first implementation slice**, not a completed Phase 1a. Pending: multi-file schema models and migrations, real role/permission integration tests, CI with PostgreSQL and migration drift checks, dependency-cruiser, hardened boundary lint rules, shadcn/ui initialization, preview deployment and database-vendor verification.

Architecture and decisions: `docs/architecture.md`, `docs/data-model.md`, `docs/implementation-plan.md`, `docs/adr/`.
