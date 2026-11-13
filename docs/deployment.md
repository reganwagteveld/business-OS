# Deployment: Neon (PostgreSQL) and Vercel

Region: **AWS us-east-1 (N. Virginia)** for both the database and the functions (ADR 0002). Secrets are never committed. They live only in the Vercel project's environment variables (Preview and Production) and in each developer's local, git-ignored `.env`.

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

## 3. Connection strings and environment variables

| Variable | Role | Neon endpoint | Notes |
|---|---|---|---|
| `DATABASE_URL` | `bos_app` | **Pooled** (host contains `-pooler`) | Runtime traffic; transaction-mode pooling (ADR 0004 spike S6, S12 must pass against it) |
| `MIGRATION_DATABASE_URL` | `bos_owner` | **Direct** (no `-pooler`) | Migrations and `prisma migrate`; never on the runtime path |
| `REGION` | | | `us-east-1` |
| `DATABASE_REGION` | | | `us-east-1` |
| `APP_BASE_URL` | | | The deployment's public URL |

Both URLs need `sslmode=require`. The app refuses to start if either variable is missing or invalid, or if `REGION` and `DATABASE_REGION` differ.

`MIGRATION_DATABASE_URL` is only needed where migrations run (CI/release step or a developer's machine). Consider leaving it out of the Vercel runtime environment so the running app never holds owner credentials.

## 4. Vercel

1. Import `reganwagteveld/business-os`; production branch `main`; framework Next.js.
2. `vercel.json` pins functions to `iad1`. Confirm under Project Settings → Functions.
3. Add the variables above for Preview and Production.
4. Deploy and check `/health` returns `{"status":"ok"}`; a mismatched function region fails the check at startup.

## 5. Phase 1a vendor verification (record the answers in ADR 0002)

Run against the real Neon project, as `bos_owner`/`bos_app`:

- [ ] Roles above can be created with `NOBYPASSRLS`; `bos_app` cannot create objects in `public`.
- [ ] `ALTER TABLE ... FORCE ROW LEVEL SECURITY` and `CREATE POLICY ... TO bos_app` work.
- [ ] A `SECURITY DEFINER` function owned by a `NOLOGIN` role can be created, and `ALTER FUNCTION ... SET search_path` works.
- [ ] Transaction-local `set_config` and the queries stay on one connection through the pooled endpoint (spike S1, S4, S6).
- [ ] Backups and PITR stay in us-east-1.
