# Full-stack golden-path E2E suite (WP-T1)

Dev and CI only. Nothing here is built, bundled or shipped.

It answers one question the other suites cannot: **does the production build of the API, run as the runtime database role against a freshly migrated PostgreSQL, carry a business from sign-up to a settled invoice, and refuse what it must refuse?**

## How it differs from the existing suites

| Suite | Runs the API as | Database | What it adds that this suite does not |
|---|---|---|---|
| `apps/api/tests/integration` (incl. `cross-zone.test.ts`) | route handlers called in-process | shared dev/CI database | Breadth: every route, role and Zone rule |
| `apps/api/tests/isolation` | no API: SQL | spike database, behind PgBouncer | RLS and pooler semantics in depth |
| **`tooling/e2e` (this)** | **the built server (`next build` + `next start`) over real HTTP** | **a disposable `e2e_<hex>` database with random per-run role passwords** | Depth on one connected journey; read-back of what was persisted |

It deliberately does **not** repeat the per-route matrices. It covers the journey once, the failure paths that protect money, and tenant isolation checked from outside (HTTP) and from the runtime role (SQL).

## What it covers

| File | Covers |
|---|---|
| `golden-path.e2e.test.ts` | Sign-up, business creation, invitations with roles, customer and contact, opportunity, project and task, quote (issue, accept), Sales win, quote to invoice conversion keeping the cross-Zone links, invoice issue, two payments with an idempotent replay, settlement state at each step, customer balances, and read-back of the persisted ledger (allocations equal invoice equals payments, one tenant only), timeline and audit trail |
| `finance-failure-paths.e2e.test.ts` | Over-allocation, cross-customer allocation, missing and conflicting idempotency keys, two simultaneous payments (exactly one wins), credit note larger than the invoice, stale version, immutable issued invoice, draft/declined quotes not convertible, repeated conversion makes one invoice, void rules, malformed input (400, nothing leaked), unknown ids, role limits, anonymous and forged sessions. Each refusal checks that the stored state did not change |
| `tenant-isolation.e2e.test.ts` | A second business cannot read, list, change, link to or pay A's records over HTTP; one person in two businesses; every tenant table has RLS enabled and forced; the runtime role sees nothing without tenant context, only its own rows with it, cannot update or insert across tenants, cannot rewrite an issued invoice and cannot read `app_private` |
| `http-surface.e2e.test.ts` | Health without configuration leaks, CORS for an unlisted origin, `HttpOnly` session cookie, identical login failures, invite-only admission and the business-creation grant |
| `harness-guard.e2e.test.ts` | The harness refuses non-loopback databases, non-disposable database names and any production, owner, email or payment variable in the API environment |

## Running it locally

Needs Node 22, pnpm, PostgreSQL 16 on loopback and `pnpm install`. **Do not point it at your normal dev database**: it creates the application roles with fresh random passwords and a throwaway database, and drops that database afterwards.

```sh
# 1. A disposable cluster (once). With Docker:
docker run -d --name bos-e2e-pg -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16.10
#    or without Docker, using local PostgreSQL binaries:
#    initdb -D /tmp/e2e-pg -A trust -U postgres && pg_ctl -D /tmp/e2e-pg -o '-p 55432' -l /tmp/e2e-pg.log start

# 2. Run everything: provision, migrate, build, serve, test, drop.
pnpm --filter @business-os/e2e e2e
```

| Variable | Default | Meaning |
|---|---|---|
| `E2E_ADMIN_URL` | `postgresql://postgres:postgres@127.0.0.1:55432/postgres` | Superuser on a **loopback** cluster. Any other host is refused |
| `E2E_SKIP_BUILD=1` | off | Reuse the last `apps/api/.next` build (repeat runs) |
| `E2E_KEEP_DB=1` | off | Keep the `e2e_<hex>` database for inspection |

Extra arguments go to vitest: `pnpm --filter @business-os/e2e e2e tests/golden-path.e2e.test.ts`.

## What it does, in order

1. Refuses to start if `apps/api` or this package holds `.env*` files with any variable the harness does not itself set (Next.js and Prisma would load them into the build, server and migration, whatever the clean environment says). Values are never printed. Then connects to the loopback cluster, using an explicit driver configuration built from a URL that must have no query options or fragment (`?host=` and similar override the checked host); refuses if `bos_*` roles exist that this harness did not create. There is no override for that: use a dedicated cluster.
2. Creates the roles with random passwords, then database `e2e_<16 hex>` owned by `bos_owner`.
3. `prisma migrate deploy` as the owner role, then `db:privileged` as the administrative role (production order).
4. `next build`, then `next start` on a free loopback port. The server environment is built from scratch: `bos_app` and `bos_auth` URLs, a random `AUTH_SECRET`, `EMAIL_TRANSPORT=log`. No owner, admin, email-provider, payment, Vercel or Neon variable can be present (`scripts/guard.mjs`, self-tested).
5. Runs vitest against the server. Test files run one after another; each creates its own businesses and users with unique slugs and emails.
6. Stops the server and drops the database.

## Test fixtures that are not API calls

Only these touch the database directly, and each stands in for something that cannot happen over HTTP here: an invitation row and the business-creation grant (beta admission is an operator action), `email_verified` (no email is sent), and a known invitation token hash (the real token only exists in an email). Everything else, including sign-up, sign-in, invitations being accepted and every business record, goes through the API. Assertions read the database as a superuser; the API never uses that connection.

## Writing tests here

- No substring checks against random UUIDs (a hex run can contain any short string, a known flake pattern). Compare id arrays with `ids()` and `toContain`.
- Every refusal test reads the database afterwards and proves nothing changed.
- Do not change feature behaviour to make a test pass; if behaviour looks wrong, report it.
- Not a substitute for the desktop-shell, pooler (PgBouncer) or production smoke checks.

## CI

`.github/workflows/e2e.yml` runs the suite on pull requests that touch the API, contracts, migrations, lockfile or this package, and on demand, against a PostgreSQL service container. It is **non-gating**: it is separate from `CI gate`, changes no existing job or script, and must not become a required check until it has a documented flake rate and Regan decides to promote it. `pnpm test` never starts it (this package has no `test` script); `pnpm typecheck` and `pnpm lint` cover its code.
