# Deployment: Neon (PostgreSQL), Vercel and the client apps

Region: **AWS us-east-1 (N. Virginia)** for both the database and the API functions (ADR 0002). Only the API (`apps/api`) is deployed with server credentials; the browser and desktop apps receive just the public API URL (ADR 0005). Secrets are never committed. They live only in the Vercel project's environment variables (Preview and Production) and in each developer's local, git-ignored `.env`.

## 1. Neon project

1. Confirm in the Neon console that the project's region is **AWS US East (N. Virginia)** (`aws-us-east-1`). If it is not, create a new project in that region; a project's region cannot be changed.
2. Use PostgreSQL 16 or later.
3. Record the **backup and point-in-time-recovery region** and retention in ADR 0002 (Phase 1a acceptance criterion). If backups are stored outside us-east-1, note it in the residency table.

## 2. Database roles

Neon's default owner role is a convenience login for provisioning; the app must not use it. Create the two roles from `docker/init/01-roles.sql` with **strong, unique passwords**, connected as the Neon owner role (direct, non-pooled endpoint):

```bash
psql "$NEON_OWNER_DIRECT_URL" -v ON_ERROR_STOP=1 \
  -v owner_pw="$(openssl rand -base64 32)" -v app_pw="$(openssl rand -base64 32)"
```

```sql
-- Same attributes as local development; only the passwords differ.
CREATE ROLE bos_owner LOGIN PASSWORD :'owner_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE bos_app   LOGIN PASSWORD :'app_pw'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE neondb TO bos_owner, bos_app;      -- use your database name
GRANT USAGE, CREATE ON SCHEMA public TO bos_owner;
GRANT USAGE ON SCHEMA public TO bos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app;
```

Save the two passwords straight into the Vercel environment variables (below); do not paste them into chat, issues or commits. The shadow database in the local script is not needed in production.

## 2a. Privileged database objects (Phase 1b)

After `prisma migrate deploy` (as `bos_owner`), apply `apps/api/prisma/privileged/*.sql` with an **administrative** role (the Neon project owner), which also records the deployment region:

```bash
ADMIN_DATABASE_URL="$NEON_OWNER_DIRECT_URL" DEPLOYMENT_REGION=us-east-1 pnpm --filter @business-os/api db:privileged
```

This creates the `app_private` schema and the pre-tenant `SECURITY DEFINER` functions owned by `bos_definer` (the script grants itself `bos_definer` only while creating them, then revokes it). It needs the roles `bos_auth`, `bos_jobs`, `bos_definer` and `bos_maint` (same attributes as `docker/init/01-roles.sql`).

## 3. Connection strings and environment variables

| Variable | Role | Neon endpoint | Notes |
|---|---|---|---|
| `DATABASE_URL` | `bos_app` | **Pooled** (host contains `-pooler`) | Runtime traffic; transaction-mode pooling (ADR 0004 spike S6, S12 must pass against it) |
| `MIGRATION_DATABASE_URL` | `bos_owner` | **Direct** (no `-pooler`) | **Migration tooling only (CI or a developer machine). Not set in Vercel.** Never on the runtime path |
| `REGION` | | | `us-east-1` |
| `DATABASE_REGION` | | | `us-east-1` |
| `APP_BASE_URL` | | | The deployment's public URL |
| `CORS_ALLOWED_ORIGINS` | | | Comma-separated exact origins allowed to call the API: the browser app's origin, plus `tauri://localhost,http://tauri.localhost` for the desktop app. No wildcards; empty means no cross-origin access |

Both URLs need `sslmode=require`. The app refuses to start if either variable is missing or invalid, or if `REGION` and `DATABASE_REGION` differ.

**Runtime and migration configuration are separate.** The running API reads only the runtime variables above (`apps/api/src/core/config/schema.ts`). `MIGRATION_DATABASE_URL` and `SHADOW_DATABASE_URL` are read only by migration tooling (`core/config/migration.ts`, `prisma.config.ts`, the migration check) and **must not be set in the Vercel project** (Preview or Production). This is tested: the API's unit tests, a source rule (`runtime-owner-credentials`) and a CI step that starts the built API with no owner credentials and checks `/api/v1/health`. Run migrations from CI or a developer machine with the owner URL set there.

## 4. Vercel (API)

1. Import `reganwagteveld/business-os`; production branch `main`; framework Next.js; **Root Directory `apps/api`** (enable "Include files outside the root directory" so the workspace packages are available). Install command `pnpm install --frozen-lockfile` (Vercel detects the workspace from the lockfile).
2. `apps/api/vercel.json` pins functions to `iad1`. Confirm under Project Settings → Functions.
3. Add the variables above for Preview and Production.
4. Deploy and check `GET /api/v1/health` returns `{"status":"ok","service":"business-os-api","apiVersion":"v1"}` with `Cache-Control: private, no-store`; a mismatched function region fails the check at startup.

## 4a. Browser app (same origin as the API, D9b)

A second Vercel project, `business-os-web`, with Root Directory `apps/web` (framework Vite, output `dist`, settings in `apps/web/vercel.json`). Its public origin is the origin of the whole product: the browser app and `/api/*` are served from it, so the session cookie is first-party and host-only (ADR 0005 addendum).

- `vercel.json` rewrites `/api/*` to the API project's deployment and every other path to `index.html` (client-side routes such as `/sign-in`, `/reset-password`, `/invite`). It also sets the browser app's security headers, including a CSP whose `connect-src` is `'self'` only.
- Variable for the web project: `VITE_API_BASE_URL` = the web project's own public origin (public value, no secrets).
- API project: `APP_BASE_URL` must equal that same origin. It drives the cookie, the Origin check on auth requests and the links in emails. Changing it signs everyone out.
- The desktop app calls the API cross-origin, so the API project needs `CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost` (exact origins only).
- A custom domain (for example `app.pixakova.com`) can be added later: attach it to the web project and update `APP_BASE_URL` and `VITE_API_BASE_URL` to it.

## 4b. Desktop app

Built, not deployed. `pnpm --filter @business-os/desktop tauri:build` with `VITE_API_BASE_URL` set to the API URL; the build script writes a Content Security Policy whose `connect-src` is only that origin. CI builds unsigned Windows and macOS apps on every PR as a check. Signing, notarisation, the application identifier and auto-updates are decided before any build is given to anyone outside the team (ADR 0005, D9c and D9d).

## 5. Phase 1a vendor verification (record the answers in ADR 0002)

Status and the automated check (`pnpm verify:vendor`): [phase-1a-verification.md](./phase-1a-verification.md).

Run against the real Neon project, as `bos_owner`/`bos_app`:

- [ ] Roles above can be created with `NOBYPASSRLS`; `bos_app` cannot create objects in `public`.
- [ ] `ALTER TABLE ... FORCE ROW LEVEL SECURITY` and `CREATE POLICY ... TO bos_app` work.
- [ ] A `SECURITY DEFINER` function owned by a `NOLOGIN` role can be created, and `ALTER FUNCTION ... SET search_path` works.
- [ ] Transaction-local `set_config` and the queries stay on one connection through the pooled endpoint (spike S1, S4, S6).
- [ ] Backups and PITR stay in us-east-1.
