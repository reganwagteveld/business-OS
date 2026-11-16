-- Scheduling S2 (docs/scheduling-s2.md): resources and their assignments to events. Additive only: two
-- new enums and two new tables; no existing table, column, index or row is changed. No extension and no
-- privileged step. Conflicts stay lock-enforced (docs/scheduling-s2.md §5), not constraint-enforced, so
-- an overlap accepted on purpose (enforceConflicts = false, S1) remains possible. Wrapped in one transaction (docs/migration-readiness.md §7, STAB-M6).
BEGIN;

-- CreateEnum
CREATE TYPE "SchedulingResourceType" AS ENUM ('PERSON', 'ROOM', 'EQUIPMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "SchedulingResourceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "scheduling_resources" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "resource_type" "SchedulingResourceType" NOT NULL,
    "status" "SchedulingResourceStatus" NOT NULL DEFAULT 'ACTIVE',
    "colour" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "scheduling_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduling_event_resources" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,
    "removed_by_id" UUID,

    CONSTRAINT "scheduling_event_resources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduling_resources_business_id_status_name_id_idx" ON "scheduling_resources"("business_id", "status", "name", "id");

-- CreateIndex
CREATE INDEX "scheduling_resources_business_id_name_id_idx" ON "scheduling_resources"("business_id", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduling_resources_business_id_id_key" ON "scheduling_resources"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduling_event_resources_business_id_id_key" ON "scheduling_event_resources"("business_id", "id");

-- AddForeignKey
ALTER TABLE "scheduling_resources" ADD CONSTRAINT "scheduling_resources_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduling_event_resources" ADD CONSTRAINT "scheduling_event_resources_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduling_event_resources" ADD CONSTRAINT "scheduling_event_resources_event_fkey" FOREIGN KEY ("business_id", "event_id") REFERENCES "scheduling_events"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduling_event_resources" ADD CONSTRAINT "scheduling_event_resources_resource_fkey" FOREIGN KEY ("business_id", "resource_id") REFERENCES "scheduling_resources"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- ---------------------------------------------------------------------------------------------
-- Assignments: at most one live row per (event, resource). A removed row is history; re-adding the
-- resource inserts a new row. Partial indexes (Prisma cannot express them) serve the resource conflict
-- check (resource -> live assignments -> events) and an event's resource list.
CREATE UNIQUE INDEX "scheduling_event_resources_live_key" ON "scheduling_event_resources" ("business_id", "event_id", "resource_id") WHERE "removed_at" IS NULL;
CREATE INDEX "scheduling_event_resources_live_resource_idx" ON "scheduling_event_resources" ("business_id", "resource_id", "event_id") WHERE "removed_at" IS NULL;
CREATE INDEX "scheduling_event_resources_live_event_idx" ON "scheduling_event_resources" ("business_id", "event_id") WHERE "removed_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes.
ALTER TABLE "scheduling_resources"
  ADD CONSTRAINT scheduling_resources_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 100),
  ADD CONSTRAINT scheduling_resources_description_length CHECK ("description" IS NULL OR char_length("description") <= 1000),
  ADD CONSTRAINT scheduling_resources_colour_format CHECK ("colour" IS NULL OR "colour" ~ '^#[0-9A-Fa-f]{6}$'),
  -- An archived resource always records when; any other status never does.
  ADD CONSTRAINT scheduling_resources_archived_consistent CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL)),
  ADD CONSTRAINT scheduling_resources_version_positive CHECK ("version" >= 1);

ALTER TABLE "scheduling_event_resources"
  -- Removal records who and when, together.
  ADD CONSTRAINT scheduling_event_resources_removed_consistent CHECK (("removed_at" IS NULL) = ("removed_by_id" IS NULL)),
  ADD CONSTRAINT scheduling_event_resources_removed_after_created CHECK ("removed_at" IS NULL OR "removed_at" >= "created_at");

-- ---------------------------------------------------------------------------------------------
-- Least privilege for tenant code. No DELETE on either table: resources are archived, assignments are
-- soft-removed. bos_app may update only the removal columns of an assignment, so an assignment can
-- never be re-pointed at another event or resource, and its author never rewritten. bos_owner's default
-- privileges are revoked first. Other runtime roles get nothing.
REVOKE ALL ON "scheduling_resources", "scheduling_event_resources" FROM bos_app;
GRANT SELECT, INSERT, UPDATE ON "scheduling_resources" TO bos_app;
GRANT SELECT, INSERT ON "scheduling_event_resources" TO bos_app;
GRANT UPDATE ("removed_at", "removed_by_id") ON "scheduling_event_resources" TO bos_app;

-- Tenant policy template (data-model §5.2), forced so the table owner is subject to it too.
ALTER TABLE "scheduling_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduling_resources" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scheduling_resources" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE "scheduling_event_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduling_event_resources" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scheduling_event_resources" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);

COMMIT;
