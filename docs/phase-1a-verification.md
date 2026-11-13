# Phase 1a verification status

Last updated 2026-11-13 on PR #2. **Verified** means a command, test or CI job was run and its result is recorded here. **Outstanding (manual)** means it needs the project's Vercel or Neon account and has not been done; nothing in that column is claimed as verified. Acceptance criteria are in [implementation-plan.md](./implementation-plan.md#phase-1a-foundation).

## Verified (automated, run in CI and locally)

| Criterion | Evidence |
|---|---|
| Workspace structure matches architecture §4; `pnpm typecheck` strict across all packages | CI "Workspace checks" |
| Clients cannot import server code or database packages; package layering; desktop crate, CSP and capabilities | `pnpm boundaries`, `tests/architecture/*` (every rule proven by a fixture), CI |
| Only `core/db` imports Prisma/`pg`; module, layer and cycle rules; `businessId` only in core; no hard-coded regions | `pnpm boundaries`, CI |
| API validates its environment; region colocation check | `apps/api/tests/unit/env.test.ts`, CI |
| **Runtime needs no owner credentials** (runtime and migration config separated) | `env.test.ts` (runtime parse and `register()` succeed without `MIGRATION_DATABASE_URL`; owner values are never exposed), source rule `runtime-owner-credentials`, CI step "API boots and answers without owner credentials", local run `evidence/api-boots-without-owner-credentials.txt` |
| CORS exact allowlist | `apps/api/tests/unit/cors.test.ts`, local run `api-health-cors.txt` |
| API contracts: response validated against contract; every contract has a route; JSON Schema snapshot current | `health-contract.test.ts`, `clients.test.ts`, `pnpm contracts:check`, CI |
| Owner and app roles exist in local and CI databases; app role has no `BYPASSRLS` | `pnpm test:integration` against Postgres 16.10 (Docker and CI service) |
| `prisma migrate diff` check | `pnpm db:check-migrations`, CI |
| API, browser app and desktop frontend build; client bundles contain no server configuration | CI "Build" and "Client bundles" steps |
| Desktop shell builds on Windows, macOS, Linux | CI "Desktop shell" jobs (unsigned) |
| Desktop shell runs and shows real API state; browser app likewise | Screenshots `desktop-shell.png`, `web-connected.png` (Linux, local API) |
| Vendor capability checks pass on **local Postgres 16** (not Neon) | `pnpm verify:vendor`, `evidence/verify-vendor-local-docker.txt` (8 of 8) |
| Vercel build succeeds with Root Directory `apps/api` and `framework: nextjs` | Vercel preview status "Ready" on d7e87b5 |

## Outstanding (manual: needs the Vercel and Neon accounts)

| Item | How to do it | Result |
|---|---|---|
| Vercel preview serves `GET /api/v1/health` with the expected body and `Cache-Control: private, no-store` | Open the preview URL while signed in to Vercel (it is behind login protection), or use a protection-bypass token | **Not verified** |
| Functions run in `iad1` | Vercel deployment → Functions region; the API also refuses to start if `VERCEL_REGION` and `REGION` disagree | **Not verified** |
| Vercel runtime has no owner credentials | Confirm `MIGRATION_DATABASE_URL` and `SHADOW_DATABASE_URL` are **not** set in Preview or Production | **Not verified** |
| Neon connectivity as `bos_app` through the pooled endpoint | `pnpm verify:vendor` (below) | **Not verified** |
| Neon supports `NOBYPASSRLS` roles, `FORCE ROW LEVEL SECURITY`, policies `TO <role>`, `SECURITY DEFINER` owned by a `NOLOGIN` role with fixed `search_path` | `pnpm verify:vendor` (below) | **Not verified** |
| Transaction-local `set_config` holds through Neon's pooled (transaction-mode) endpoint (spike S1, S4, S6) | `pnpm verify:vendor` covers the basic case; the full spike runs in Phase 1b | **Not verified** |
| Neon project region is AWS `us-east-1` | Neon console → project settings | **Not verified** |
| **Backups and point-in-time recovery stay in us-east-1** | Neon console / Neon documentation for the plan in use; record the answer in ADR 0002's residency table | **Not verified** |
| ADR 0002 vendor status Proposed → Accepted | Only after all of the above | Pending |

### Running the Neon checks

From a machine with the Neon credentials, in a shell where the values are set **locally** (never commit or paste them):

```bash
export VERIFY_ADMIN_URL='<direct (non-pooled) URL of the Neon default owner role>'
export VERIFY_APP_URL='<pooled URL of bos_app>'   # the same value as the API's DATABASE_URL
pnpm install && pnpm verify:vendor
```

The script creates its test objects in one transaction and rolls it back, prints PASS/FAIL per capability and never prints connection strings. Paste only its PASS/FAIL output into the PR. `bos_app` must exist first (docs/deployment.md §2).

## Not part of Phase 1a

Desktop and browser sign-in (D9a, D9b), application identifier, signing and updates (D9c, D9d), and everything in Phase 1b.
