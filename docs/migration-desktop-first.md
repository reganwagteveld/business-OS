# Migration: from a single Next.js app to the desktop-first workspace

- Date: 2026-11-13
- Decision: [ADR 0005](./adr/0005-desktop-first-client-architecture.md) (desktop-first, Tauri 2, shared React client, Next.js as API)
- Where: PR #2 (Phase 1a), on top of the original Phase 1a scaffold

## Why

Phase 1a first scaffolded one Next.js app that rendered the UI and accessed the database in the same process. Business OS is now desktop-first, with a companion browser app. A desktop app is shipped to customers' machines, so it must contain no server code and no database access. The repository was therefore split into a pnpm workspace where the API is a separate package that no client can depend on.

No product code, tables or data existed yet, so nothing had to be migrated at runtime. This was a code-layout and tooling change.

## What was preserved unchanged

- **Security architecture and tenant isolation:** the seven layers in architecture §7.3, ADR 0004 (RLS, least-privilege roles, `SECURITY DEFINER` rules, spike S1 to S13), the database roles and their tests (`bos_owner`, `bos_app`, `docker/init/01-roles.sql`).
- **Accepted data-model decisions:** data-model.md is unchanged apart from wording that named Server Actions or cookies as the only session transport.
- **Modular domain boundaries:** `modules`, `core` and their rules, now inside `apps/api/src`; every original boundary rule still exists and is still proven by a fixture test.
- **Region and colocation (ADR 0002):** `vercel.json` (now `apps/api/vercel.json`) still pins functions to `iad1`; boot-time checks for region mismatch are unchanged.
- **Prisma 7 setup:** multi-file schema, driver adapter, generated client location (now under `apps/api`), migration check.

## What moved where

| Before | After | Notes |
|---|---|---|
| `src/app/health/route.ts` | `apps/api/src/app/api/v1/health/route.ts` | Path is now `/api/v1/health`; body follows the contract (`status`, `service`, `apiVersion`); adds CORS and `private, no-store` |
| `src/app/page.tsx`, `src/app/layout.tsx`, `postcss.config.mjs` | removed | The API renders no UI; the client UI lives in `packages/app` |
| `src/app/globals.css` | `packages/ui/src/styles.css` | Design tokens only; each client's entry CSS imports Tailwind, then the tokens |
| `src/core/**` | `apps/api/src/core/**` | Plus new `core/http` (CORS, API headers) |
| `src/modules/**` | `apps/api/src/modules/**` | |
| `src/instrumentation.ts` | `apps/api/src/instrumentation.ts` | Boot-time env validation unchanged |
| `src/ui/lib/utils.ts`, `src/ui/README.md`, `components.json` | `packages/ui/src/lib/utils.ts`, `packages/ui/README.md`, `packages/ui/components.json` | shadcn aliases now point at `@business-os/ui` |
| `src/zones/README.md` | `packages/app/src/zones/README.md` | Zones are a client concern; data via the API |
| `prisma/`, `prisma.config.ts` | `apps/api/prisma/`, `apps/api/prisma.config.ts` | |
| `next.config.ts`, `next-env.d.ts`, `vercel.json`, `.env.example`, `tsconfig.json` | `apps/api/…` | `.env.example` gains `CORS_ALLOWED_ORIGINS` |
| `vitest.config.ts`, `vitest.integration.config.ts`, `tests/unit/env.test.ts`, `tests/unit/deployment-config.test.ts`, `tests/integration/**`, `tests/stubs/**` | `apps/api/…` | |
| `scripts/check-migrations.mjs` | `apps/api/scripts/check-migrations.mjs` | |
| `tests/unit/boundaries.test.ts` | `tests/architecture/boundaries.test.ts` | Fixtures now use workspace paths; new client and package rules |
| (new) | `packages/contracts` | Endpoint definitions, zod schemas, JSON Schema snapshot |
| (new) | `packages/app` | Shared React client and typed API client |
| (new) | `apps/web` | Companion browser app (Vite) |
| (new) | `apps/desktop` | Tauri 2 shell: `src-tauri` (Rust, config, capabilities, icons), per-build CSP script |
| (new) | `tests/architecture/clients.test.ts` | Client manifests, Tauri crates, CSP, capabilities, contract coverage |
| (new) | `tsconfig.base.json`, `pnpm-workspace.yaml`, `tooling/eslint-client.mjs` | Shared workspace configuration |

## Command changes

| Before | After |
|---|---|
| `cp .env.example .env` | `cp apps/api/.env.example apps/api/.env` (and the two client `.env.example` files) |
| `pnpm dev` | `pnpm dev:api`, `pnpm dev:web`, `pnpm dev:desktop` |
| `GET /health` | `GET /api/v1/health` |
| `pnpm build` (one app) | `pnpm build` (API, browser app, desktop frontend); `pnpm build:desktop` (native app) |
| `pnpm db:setup`, `db:migrate`, `db:check-migrations`, `test:integration` | Same names, delegated to `@business-os/api` |
| (new) | `pnpm contracts:check`, `pnpm contracts:generate` |

## Configuration changes for deployments

- Vercel project for the API: set **Root Directory** to `apps/api` (docs/deployment.md §4). The health-check URL becomes `/api/v1/health`.
- New API variable `CORS_ALLOWED_ORIGINS` (optional, defaults to none). Set it once a browser app is deployed and for desktop builds that call that API.
- Client builds need `VITE_API_BASE_URL`. No other variable is passed to a client.

## Security checks before and after

| Check | Before | After |
|---|---|---|
| Module public API, `modules` → `app`, `core` kernel, no cycles | dependency-cruiser | Same rules, scoped to `apps/api/src` |
| Prisma/`pg` only in `core/db` | dependency-cruiser | Same, and now also forbidden anywhere in the clients |
| No vendor SDKs in modules | dependency-cruiser | Unchanged |
| Client code importing server-only code | `'use client'` files in one app | Replaced by a package boundary: clients cannot import `apps/api`, `server-only`, `next`, Prisma or database drivers at all (dependency-cruiser + source rules + manifest test); the API may not contain client components |
| `businessId` only in `core/tenant`, `core/db` | source rule | Unchanged |
| No hard-coded regions | source rule on `src/` | API and every client source tree |
| Env validation and region colocation | boot check + tests | Unchanged, plus CORS origin validation |
| Database roles without `BYPASSRLS` | integration test | Unchanged |
| (new) Desktop cannot reach PostgreSQL | | Crate deny list, `core:default` permissions only, `withGlobalTauri: false`, CSP `connect-src` = API origin, bundle scan |
| (new) API contracts | | Response validated against contract; every contract has a route; JSON Schema snapshot current |
