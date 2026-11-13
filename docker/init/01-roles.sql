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
