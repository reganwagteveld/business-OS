-- Projects Zone foundation (docs/projects-data-model.md): projects and their tasks. Additive only:
-- new types and tables; no existing table, column or row is changed.

-- CreateEnum
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ProjectTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNED',
    "priority" "WorkPriority" NOT NULL DEFAULT 'MEDIUM',
    "customer_id" UUID,
    "owner_user_id" UUID,
    "start_date" DATE,
    "due_date" DATE,
    "completed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_tasks" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectTaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "WorkPriority" NOT NULL DEFAULT 'MEDIUM',
    "assignee_user_id" UUID,
    "due_date" DATE,
    "position" INTEGER NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_business_id_created_at_id_idx" ON "projects"("business_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "projects_business_id_status_idx" ON "projects"("business_id", "status");

-- CreateIndex
CREATE INDEX "projects_business_id_customer_id_idx" ON "projects"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "projects_business_id_owner_user_id_idx" ON "projects"("business_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "projects_business_id_archived_at_idx" ON "projects"("business_id", "archived_at");

-- CreateIndex
CREATE INDEX "projects_business_id_due_date_id_idx" ON "projects"("business_id", "due_date", "id");

-- CreateIndex
CREATE UNIQUE INDEX "projects_business_id_id_key" ON "projects"("business_id", "id");

-- CreateIndex
CREATE INDEX "project_tasks_business_id_project_id_position_id_idx" ON "project_tasks"("business_id", "project_id", "position", "id");

-- CreateIndex
CREATE INDEX "project_tasks_business_id_project_id_status_idx" ON "project_tasks"("business_id", "project_id", "status");

-- CreateIndex
CREATE INDEX "project_tasks_business_id_assignee_user_id_idx" ON "project_tasks"("business_id", "assignee_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_tasks_business_id_id_key" ON "project_tasks"("business_id", "id");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_fkey" FOREIGN KEY ("business_id", "owner_user_id") REFERENCES "memberships"("business_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_fkey" FOREIGN KEY ("business_id", "project_id") REFERENCES "projects"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_assignee_fkey" FOREIGN KEY ("business_id", "assignee_user_id") REFERENCES "memberships"("business_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;



-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes.
ALTER TABLE "projects"
  ADD CONSTRAINT projects_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 200),
  ADD CONSTRAINT projects_description_length CHECK ("description" IS NULL OR char_length("description") <= 5000),
  -- A due date never comes before the start date.
  ADD CONSTRAINT projects_dates_ordered CHECK ("start_date" IS NULL OR "due_date" IS NULL OR "due_date" >= "start_date"),
  -- A completed project always has a completion time; any other status never does.
  ADD CONSTRAINT projects_completed_consistent CHECK (("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)),
  ADD CONSTRAINT projects_version_positive CHECK ("version" >= 1);
ALTER TABLE "project_tasks"
  ADD CONSTRAINT project_tasks_title_length CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT project_tasks_description_length CHECK ("description" IS NULL OR char_length("description") <= 5000),
  ADD CONSTRAINT project_tasks_position CHECK ("position" >= 0),
  -- A done task always has a completion time; any other status never does.
  ADD CONSTRAINT project_tasks_completed_consistent CHECK (("status" = 'DONE') = ("completed_at" IS NOT NULL)),
  ADD CONSTRAINT project_tasks_version_positive CHECK ("version" >= 1);

-- ---------------------------------------------------------------------------------------------
-- Least privilege for tenant code. No DELETE: projects and tasks are archived, never deleted, so
-- archiving or "removing" never loses history, and a project can never lose its tasks. bos_owner's
-- default privileges are revoked first. Other runtime roles get nothing.
REVOKE ALL ON "projects", "project_tasks" FROM bos_app;
GRANT SELECT, INSERT, UPDATE ON "projects", "project_tasks" TO bos_app;

-- Tenant policy template (data-model §5.2), forced so the table owner is subject to it too.
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "projects" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "projects" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE "project_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "project_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "project_tasks" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);
