-- Reporting R1 (docs/reporting-r1.md): saved report configurations. Additive only: one new table; no
-- existing table, column, index, policy, grant or row is changed. No extension, no function, no trigger
-- and no privileged step. Reporting stores configuration only, never results, snapshots or copies of
-- source data (no materialised view, no ETL).
--
-- Ordering: depends only on 20261113150000_tenancy (businesses) and the bos_app role. It references no
-- finance, sales, customers, people, scheduling or communications object, so it is independent of every
-- other Zone migration, including the open 20261120000000_finance_documents and
-- 20261121000000_communications_providers. It sorts after both, so whichever merges first, the fresh-
-- database order and the production order are the same.
--
-- Wrapped in one transaction (docs/migration-readiness.md §7, STAB-M6): a failure leaves nothing behind.
BEGIN;

-- CreateTable
CREATE TABLE "reporting_saved_views" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "report_type" TEXT NOT NULL DEFAULT 'metrics',
    "config" JSONB NOT NULL,
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "visibility" TEXT NOT NULL DEFAULT 'PRIVATE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reporting_saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reporting_saved_views_business_id_owner_user_id_updated_at__idx" ON "reporting_saved_views"("business_id", "owner_user_id", "updated_at" DESC, "id");

-- CreateIndex
CREATE INDEX "reporting_saved_views_business_id_visibility_updated_at_id_idx" ON "reporting_saved_views"("business_id", "visibility", "updated_at" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "reporting_saved_views_business_id_id_key" ON "reporting_saved_views"("business_id", "id");

-- AddForeignKey
ALTER TABLE "reporting_saved_views" ADD CONSTRAINT "reporting_saved_views_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes (hand-written).
ALTER TABLE "reporting_saved_views"
  ADD CONSTRAINT reporting_saved_views_title_length CHECK (char_length(btrim("title")) BETWEEN 1 AND 120),
  ADD CONSTRAINT reporting_saved_views_description_length CHECK ("description" IS NULL OR char_length("description") <= 1000),
  ADD CONSTRAINT reporting_saved_views_report_type_values CHECK ("report_type" IN ('metrics')),
  ADD CONSTRAINT reporting_saved_views_visibility_values CHECK ("visibility" IN ('PRIVATE', 'BUSINESS')),
  -- Configuration, not data: an object of bounded size. The API validates its shape on every write and run.
  ADD CONSTRAINT reporting_saved_views_config_object CHECK (jsonb_typeof("config") = 'object'),
  ADD CONSTRAINT reporting_saved_views_config_size CHECK (pg_column_size("config") <= 16384),
  ADD CONSTRAINT reporting_saved_views_config_version_positive CHECK ("config_version" >= 1),
  ADD CONSTRAINT reporting_saved_views_version_positive CHECK ("version" >= 1);

-- ---------------------------------------------------------------------------------------------
-- Least privilege for tenant code (hand-written). bos_owner's default privileges are revoked first.
-- The owner, business and creation time are fixed at insert: UPDATE is granted on the editable columns
-- only. DELETE is granted because a saved view is a personal configuration, not a business record
-- (deletions are written to the audit log). Other runtime roles (bos_auth, bos_jobs) get nothing.
REVOKE ALL ON "reporting_saved_views" FROM bos_app;
GRANT SELECT, INSERT, DELETE ON "reporting_saved_views" TO bos_app;
GRANT UPDATE ("title", "description", "config", "config_version", "visibility", "version", "updated_by_id", "updated_at") ON "reporting_saved_views" TO bos_app;

-- ---------------------------------------------------------------------------------------------
-- Row-level security (hand-written). The tenant policy template (data-model §5.2), forced so the table
-- owner is subject to it too, plus RESTRICTIVE policies that back the service's own checks: a PRIVATE
-- view is invisible to everyone but its owner, only the owner inserts or changes a view, and a view can
-- be deleted by its owner or, when shared, by someone the service has checked holds reporting:manage.
ALTER TABLE "reporting_saved_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reporting_saved_views" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reporting_saved_views" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);
CREATE POLICY owner_or_shared_read ON "reporting_saved_views" AS RESTRICTIVE FOR SELECT TO bos_app
  USING ("visibility" = 'BUSINESS' OR "owner_user_id" = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_inserts ON "reporting_saved_views" AS RESTRICTIVE FOR INSERT TO bos_app
  WITH CHECK ("owner_user_id" = nullif(current_setting('app.user_id', true), '')::uuid
          AND "updated_by_id" = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_updates ON "reporting_saved_views" AS RESTRICTIVE FOR UPDATE TO bos_app
  USING      ("owner_user_id" = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK ("owner_user_id" = nullif(current_setting('app.user_id', true), '')::uuid
          AND "updated_by_id" = nullif(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY owner_or_shared_deletes ON "reporting_saved_views" AS RESTRICTIVE FOR DELETE TO bos_app
  USING ("visibility" = 'BUSINESS' OR "owner_user_id" = nullif(current_setting('app.user_id', true), '')::uuid);

COMMIT;
