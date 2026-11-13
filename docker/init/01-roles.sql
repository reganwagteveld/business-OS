-- Development-only credentials. Production roles are provisioned separately.
CREATE ROLE bos_owner LOGIN PASSWORD 'bos_local_owner_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE bos_app LOGIN PASSWORD 'bos_local_app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE business_os TO bos_owner, bos_app;
GRANT USAGE, CREATE ON SCHEMA public TO bos_owner;
GRANT USAGE ON SCHEMA public TO bos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app;

-- Shadow database for `prisma migrate diff --from-migrations` and `migrate dev`.
-- bos_owner has no CREATEDB, so the shadow database is provisioned here.
CREATE DATABASE business_os_shadow OWNER bos_owner;

-- Phase 1b roles (docs/data-model.md §5.1, §7.1). Development and CI credentials only.
CREATE ROLE bos_jobs LOGIN PASSWORD 'bos_local_jobs_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE bos_definer NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE bos_maint NOLOGIN NOSUPERUSER NOBYPASSRLS;

-- RLS spike database (data-model §5.4). Isolated from the application database; the spike suite
-- rebuilds its fixture schema here on every run.
CREATE DATABASE business_os_spike OWNER bos_owner;
GRANT CONNECT ON DATABASE business_os_spike TO bos_app, bos_jobs;
