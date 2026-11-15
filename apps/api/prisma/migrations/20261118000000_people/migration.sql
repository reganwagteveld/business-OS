-- People P1: Workforce Foundation (docs/people-data-model.md). Additive only: new types, tables,
-- functions and triggers; no existing table, column or row is changed.

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('PENDING', 'ACTIVE', 'ON_LEAVE', 'TERMINATED');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACTOR', 'TEMPORARY', 'OTHER');

-- CreateTable
CREATE TABLE "people_departments" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "people_departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people_locations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "people_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people_employees" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "employee_number" TEXT,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "preferred_name" TEXT,
    "job_title" TEXT,
    "employment_type" "EmploymentType",
    "work_email" TEXT,
    "work_phone" TEXT,
    "status" "EmploymentStatus" NOT NULL DEFAULT 'PENDING',
    "start_date" DATE,
    "end_date" DATE,
    "location_id" UUID,
    "user_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "people_employees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people_employee_personal_details" (
    "employee_id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "personal_email" TEXT,
    "personal_phone" TEXT,
    "home_address" TEXT,
    "emergency_contact_name" TEXT,
    "emergency_contact_relationship" TEXT,
    "emergency_contact_phone" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "people_employee_personal_details_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "people_department_assignments" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_by_id" UUID,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "people_department_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people_manager_assignments" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "manager_employee_id" UUID NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_by_id" UUID,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "people_manager_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "people_employment_status_history" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "from_status" "EmploymentStatus",
    "to_status" "EmploymentStatus" NOT NULL,
    "effective_date" DATE NOT NULL,
    "reason" TEXT,
    "recorded_by_id" UUID,
    "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "people_employment_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "people_departments_business_id_name_id_idx" ON "people_departments"("business_id", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "people_departments_business_id_id_key" ON "people_departments"("business_id", "id");

-- CreateIndex
CREATE INDEX "people_locations_business_id_name_id_idx" ON "people_locations"("business_id", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "people_locations_business_id_id_key" ON "people_locations"("business_id", "id");

-- CreateIndex
CREATE INDEX "people_employees_business_id_family_name_given_name_id_idx" ON "people_employees"("business_id", "family_name", "given_name", "id");

-- CreateIndex
CREATE INDEX "people_employees_business_id_created_at_id_idx" ON "people_employees"("business_id", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "people_employees_business_id_status_idx" ON "people_employees"("business_id", "status");

-- CreateIndex
CREATE INDEX "people_employees_business_id_location_id_idx" ON "people_employees"("business_id", "location_id");

-- CreateIndex
CREATE UNIQUE INDEX "people_employees_business_id_id_key" ON "people_employees"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "people_employee_personal_details_business_id_employee_id_key" ON "people_employee_personal_details"("business_id", "employee_id");

-- CreateIndex
CREATE INDEX "people_department_assignments_business_id_employee_id_start_idx" ON "people_department_assignments"("business_id", "employee_id", "starts_on");

-- CreateIndex
CREATE INDEX "people_department_assignments_business_id_department_id_idx" ON "people_department_assignments"("business_id", "department_id");

-- CreateIndex
CREATE UNIQUE INDEX "people_department_assignments_business_id_id_key" ON "people_department_assignments"("business_id", "id");

-- CreateIndex
CREATE INDEX "people_manager_assignments_business_id_employee_id_starts_o_idx" ON "people_manager_assignments"("business_id", "employee_id", "starts_on");

-- CreateIndex
CREATE INDEX "people_manager_assignments_business_id_manager_employee_id_idx" ON "people_manager_assignments"("business_id", "manager_employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "people_manager_assignments_business_id_id_key" ON "people_manager_assignments"("business_id", "id");

-- CreateIndex
CREATE INDEX "people_employment_status_history_business_id_employee_id_re_idx" ON "people_employment_status_history"("business_id", "employee_id", "recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "people_employment_status_history_business_id_id_key" ON "people_employment_status_history"("business_id", "id");

-- AddForeignKey
ALTER TABLE "people_departments" ADD CONSTRAINT "people_departments_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_locations" ADD CONSTRAINT "people_locations_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_employees" ADD CONSTRAINT "people_employees_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_employees" ADD CONSTRAINT "people_employees_location_fkey" FOREIGN KEY ("business_id", "location_id") REFERENCES "people_locations"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "people_employees" ADD CONSTRAINT "people_employees_user_fkey" FOREIGN KEY ("business_id", "user_id") REFERENCES "memberships"("business_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "people_employee_personal_details" ADD CONSTRAINT "people_personal_details_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_employee_personal_details" ADD CONSTRAINT "people_personal_details_employee_fkey" FOREIGN KEY ("business_id", "employee_id") REFERENCES "people_employees"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "people_department_assignments" ADD CONSTRAINT "people_department_assignments_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_department_assignments" ADD CONSTRAINT "people_department_assignments_employee_fkey" FOREIGN KEY ("business_id", "employee_id") REFERENCES "people_employees"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "people_department_assignments" ADD CONSTRAINT "people_department_assignments_department_fkey" FOREIGN KEY ("business_id", "department_id") REFERENCES "people_departments"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "people_manager_assignments" ADD CONSTRAINT "people_manager_assignments_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_manager_assignments" ADD CONSTRAINT "people_manager_assignments_employee_fkey" FOREIGN KEY ("business_id", "employee_id") REFERENCES "people_employees"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "people_manager_assignments" ADD CONSTRAINT "people_manager_assignments_manager_fkey" FOREIGN KEY ("business_id", "manager_employee_id") REFERENCES "people_employees"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "people_employment_status_history" ADD CONSTRAINT "people_status_history_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "people_employment_status_history" ADD CONSTRAINT "people_status_history_employee_fkey" FOREIGN KEY ("business_id", "employee_id") REFERENCES "people_employees"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;




-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes.
ALTER TABLE "people_departments"
  ADD CONSTRAINT people_departments_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT people_departments_description_length CHECK ("description" IS NULL OR char_length("description") <= 2000),
  ADD CONSTRAINT people_departments_version_positive CHECK ("version" >= 1);
ALTER TABLE "people_locations"
  ADD CONSTRAINT people_locations_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 120),
  ADD CONSTRAINT people_locations_address_length CHECK ("address" IS NULL OR char_length("address") <= 500),
  ADD CONSTRAINT people_locations_version_positive CHECK ("version" >= 1);
ALTER TABLE "people_employees"
  ADD CONSTRAINT people_employees_number_format CHECK ("employee_number" IS NULL OR (char_length("employee_number") BETWEEN 1 AND 30 AND "employee_number" = btrim("employee_number"))),
  ADD CONSTRAINT people_employees_given_name_length CHECK (char_length(btrim("given_name")) BETWEEN 1 AND 100),
  ADD CONSTRAINT people_employees_family_name_length CHECK (char_length(btrim("family_name")) BETWEEN 1 AND 100),
  ADD CONSTRAINT people_employees_preferred_name_length CHECK ("preferred_name" IS NULL OR char_length("preferred_name") <= 100),
  ADD CONSTRAINT people_employees_job_title_length CHECK ("job_title" IS NULL OR char_length("job_title") <= 150),
  ADD CONSTRAINT people_employees_work_email_format CHECK ("work_email" IS NULL OR (char_length("work_email") <= 254 AND "work_email" LIKE '%_@_%')),
  ADD CONSTRAINT people_employees_work_phone_length CHECK ("work_phone" IS NULL OR char_length("work_phone") <= 40),
  -- Anyone working or on leave has a start date (a pending hire, or one withdrawn before starting, may
  -- not); the end date is set exactly while terminated.
  ADD CONSTRAINT people_employees_start_required CHECK ("status" IN ('PENDING', 'TERMINATED') OR "start_date" IS NOT NULL),
  ADD CONSTRAINT people_employees_end_consistent CHECK (("status" = 'TERMINATED') = ("end_date" IS NOT NULL)),
  ADD CONSTRAINT people_employees_dates_ordered CHECK ("start_date" IS NULL OR "end_date" IS NULL OR "end_date" >= "start_date"),
  ADD CONSTRAINT people_employees_version_positive CHECK ("version" >= 1);
ALTER TABLE "people_employee_personal_details"
  ADD CONSTRAINT people_personal_email_format CHECK ("personal_email" IS NULL OR (char_length("personal_email") <= 254 AND "personal_email" LIKE '%_@_%')),
  ADD CONSTRAINT people_personal_phone_length CHECK ("personal_phone" IS NULL OR char_length("personal_phone") <= 40),
  ADD CONSTRAINT people_personal_address_length CHECK ("home_address" IS NULL OR char_length("home_address") <= 500),
  ADD CONSTRAINT people_personal_emergency_name_length CHECK ("emergency_contact_name" IS NULL OR char_length("emergency_contact_name") <= 200),
  ADD CONSTRAINT people_personal_emergency_relationship_length CHECK ("emergency_contact_relationship" IS NULL OR char_length("emergency_contact_relationship") <= 100),
  ADD CONSTRAINT people_personal_emergency_phone_length CHECK ("emergency_contact_phone" IS NULL OR char_length("emergency_contact_phone") <= 40),
  ADD CONSTRAINT people_personal_version_positive CHECK ("version" >= 1);
ALTER TABLE "people_department_assignments"
  ADD CONSTRAINT people_department_assignments_range CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
  ADD CONSTRAINT people_department_assignments_ended CHECK (("ends_on" IS NULL) = ("ended_at" IS NULL));
ALTER TABLE "people_manager_assignments"
  ADD CONSTRAINT people_manager_assignments_range CHECK ("ends_on" IS NULL OR "ends_on" >= "starts_on"),
  ADD CONSTRAINT people_manager_assignments_ended CHECK (("ends_on" IS NULL) = ("ended_at" IS NULL)),
  -- Nobody manages themselves.
  ADD CONSTRAINT people_manager_assignments_not_self CHECK ("employee_id" <> "manager_employee_id");
ALTER TABLE "people_employment_status_history"
  ADD CONSTRAINT people_status_history_changes CHECK ("from_status" IS NULL OR "from_status" <> "to_status"),
  ADD CONSTRAINT people_status_history_reason_length CHECK ("reason" IS NULL OR char_length("reason") <= 1000);

-- Employee numbers: unique per business, case-insensitive, across every employee ever (rows are never
-- deleted). One employee per linked user per business. Active org names unique per business.
-- At most one open department and one open manager assignment per employee.
CREATE UNIQUE INDEX "people_employees_number_key" ON "people_employees" ("business_id", lower("employee_number")) WHERE "employee_number" IS NOT NULL;
CREATE UNIQUE INDEX "people_employees_user_key" ON "people_employees" ("business_id", "user_id") WHERE "user_id" IS NOT NULL;
CREATE UNIQUE INDEX "people_departments_active_name_key" ON "people_departments" ("business_id", lower(btrim("name"))) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "people_locations_active_name_key" ON "people_locations" ("business_id", lower(btrim("name"))) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "people_department_assignments_open_key" ON "people_department_assignments" ("business_id", "employee_id") WHERE "ends_on" IS NULL;
CREATE UNIQUE INDEX "people_manager_assignments_open_key" ON "people_manager_assignments" ("business_id", "employee_id") WHERE "ends_on" IS NULL;
CREATE INDEX "people_manager_assignments_open_manager_idx" ON "people_manager_assignments" ("business_id", "manager_employee_id") WHERE "ends_on" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Guards (database backstops behind the service checks). SQLSTATE class PE, one code per refusal,
-- mapped to stable API errors in apps/api/src/app/api/_lib/routes.ts. All SECURITY INVOKER with a
-- fixed search_path, so they run as bos_app under Row-Level Security: they can only ever see rows of
-- the current business.
--   PE001 invalid status transition       PE005 terminating someone who still has direct reports
--   PE002 reporting line would be a cycle  PE006 assignment for a terminated employee
--   PE003 manager is terminated            PE007 department or location is archived
--   PE004 immutable field or history row   PE008 archiving a department or location that is in use

-- Serialises reporting-line changes and terminations within one business (transaction-scoped, so it
-- is safe behind a transaction-mode pooler and released at commit or rollback).
CREATE OR REPLACE FUNCTION people_lock_reporting() RETURNS boolean
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  b text := nullif(current_setting('app.business_id', true), '');
BEGIN
  IF b IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('people.reporting:' || b, 0));
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION people_lock_reporting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION people_lock_reporting() TO bos_app;

CREATE OR REPLACE FUNCTION people_guard_employee() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'ACTIVE') THEN
      RAISE EXCEPTION 'employees start as pending or active' USING ERRCODE = 'PE001';
    END IF;
  ELSE
    IF NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR NEW.created_at <> OLD.created_at
       OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
      RAISE EXCEPTION 'employee identity is fixed' USING ERRCODE = 'PE004';
    END IF;
    IF NEW.status <> OLD.status THEN
      IF NOT ((OLD.status, NEW.status) IN (
        ('PENDING', 'ACTIVE'), ('PENDING', 'TERMINATED'), ('ACTIVE', 'ON_LEAVE'), ('ACTIVE', 'TERMINATED'),
        ('ON_LEAVE', 'ACTIVE'), ('ON_LEAVE', 'TERMINATED'), ('TERMINATED', 'PENDING'), ('TERMINATED', 'ACTIVE')
      )) THEN
        RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = 'PE001';
      END IF;
      IF NEW.status = 'TERMINATED' THEN
        PERFORM people_lock_reporting();
        IF EXISTS (SELECT 1 FROM people_manager_assignments
                   WHERE business_id = NEW.business_id AND manager_employee_id = NEW.id AND ends_on IS NULL) THEN
          RAISE EXCEPTION 'employee still has direct reports' USING ERRCODE = 'PE005';
        END IF;
      END IF;
    END IF;
  END IF;
  IF NEW.location_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.location_id IS DISTINCT FROM OLD.location_id) THEN
    -- FOR SHARE conflicts with the lock an archive takes, so an archive and an assignment cannot cross.
    PERFORM 1 FROM people_locations WHERE business_id = NEW.business_id AND id = NEW.location_id AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'location is archived' USING ERRCODE = 'PE007'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION people_guard_employee() FROM PUBLIC;
CREATE TRIGGER people_guard_employee BEFORE INSERT OR UPDATE ON "people_employees" FOR EACH ROW EXECUTE FUNCTION people_guard_employee();

-- Assignment rows are created open and may be closed exactly once; nothing else ever changes.
CREATE OR REPLACE FUNCTION people_guard_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  manager_status text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.ends_on IS NOT NULL OR NEW.ends_on IS NULL
       OR (to_jsonb(NEW) - ARRAY['ends_on', 'ended_at', 'ended_by_id']) <> (to_jsonb(OLD) - ARRAY['ends_on', 'ended_at', 'ended_by_id']) THEN
      RAISE EXCEPTION 'assignments are closed once and otherwise immutable' USING ERRCODE = 'PE004';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.ends_on IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.ended_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'assignments are created open' USING ERRCODE = 'PE004';
  END IF;
  IF TG_TABLE_NAME = 'people_manager_assignments' THEN
    PERFORM people_lock_reporting();
  END IF;
  IF EXISTS (SELECT 1 FROM people_employees WHERE business_id = NEW.business_id AND id = NEW.employee_id AND status = 'TERMINATED') THEN
    RAISE EXCEPTION 'employee is terminated' USING ERRCODE = 'PE006';
  END IF;
  IF TG_TABLE_NAME = 'people_department_assignments' THEN
    PERFORM 1 FROM people_departments WHERE business_id = NEW.business_id AND id = (to_jsonb(NEW) ->> 'department_id')::uuid AND archived_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'department is archived' USING ERRCODE = 'PE007'; END IF;
  ELSE
    SELECT status::text INTO manager_status FROM people_employees
      WHERE business_id = NEW.business_id AND id = (to_jsonb(NEW) ->> 'manager_employee_id')::uuid;
    IF manager_status = 'TERMINATED' THEN RAISE EXCEPTION 'manager is terminated' USING ERRCODE = 'PE003'; END IF;
    -- Walk up from the new manager through open reporting lines; reaching the employee means a cycle.
    -- UNION (not UNION ALL) stops on any existing loop.
    IF EXISTS (
      WITH RECURSIVE chain(id) AS (
        SELECT (to_jsonb(NEW) ->> 'manager_employee_id')::uuid
        UNION
        SELECT m.manager_employee_id FROM people_manager_assignments m JOIN chain c ON m.employee_id = c.id
        WHERE m.business_id = NEW.business_id AND m.ends_on IS NULL
      )
      SELECT 1 FROM chain WHERE id = NEW.employee_id
    ) THEN
      RAISE EXCEPTION 'reporting line would form a cycle' USING ERRCODE = 'PE002';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION people_guard_assignment() FROM PUBLIC;
CREATE TRIGGER people_guard_assignment BEFORE INSERT OR UPDATE ON "people_department_assignments" FOR EACH ROW EXECUTE FUNCTION people_guard_assignment();
CREATE TRIGGER people_guard_assignment BEFORE INSERT OR UPDATE ON "people_manager_assignments" FOR EACH ROW EXECUTE FUNCTION people_guard_assignment();

-- Status history is append-only (bos_app has no UPDATE or DELETE either; this also holds for the owner).
CREATE OR REPLACE FUNCTION people_guard_history() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'employment history is append-only' USING ERRCODE = 'PE004';
END $$;
REVOKE ALL ON FUNCTION people_guard_history() FROM PUBLIC;
CREATE TRIGGER people_guard_history BEFORE UPDATE OR DELETE ON "people_employment_status_history" FOR EACH ROW EXECUTE FUNCTION people_guard_history();

-- Archiving a department or location is refused while anyone is currently in it. The row lock the
-- UPDATE holds conflicts with the FOR SHARE an assignment takes, so the check sees every assignment.
CREATE OR REPLACE FUNCTION people_guard_org_unit() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identity is fixed' USING ERRCODE = 'PE004';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    IF TG_TABLE_NAME = 'people_departments' THEN
      IF EXISTS (SELECT 1 FROM people_department_assignments WHERE business_id = NEW.business_id AND department_id = NEW.id AND ends_on IS NULL) THEN
        RAISE EXCEPTION 'department is in use' USING ERRCODE = 'PE008';
      END IF;
    ELSIF EXISTS (SELECT 1 FROM people_employees WHERE business_id = NEW.business_id AND location_id = NEW.id) THEN
      RAISE EXCEPTION 'location is in use' USING ERRCODE = 'PE008';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION people_guard_org_unit() FROM PUBLIC;
CREATE TRIGGER people_guard_org_unit BEFORE UPDATE ON "people_departments" FOR EACH ROW EXECUTE FUNCTION people_guard_org_unit();
CREATE TRIGGER people_guard_org_unit BEFORE UPDATE ON "people_locations" FOR EACH ROW EXECUTE FUNCTION people_guard_org_unit();

-- ---------------------------------------------------------------------------------------------
-- Least privilege for tenant code. No DELETE anywhere: nothing in People is ever deleted. Identity
-- columns are not updatable (column grants); assignments may only be closed; history is insert-only.
-- bos_owner's default privileges are revoked first. bos_jobs and bos_auth get nothing.
REVOKE ALL ON "people_departments", "people_locations", "people_employees", "people_employee_personal_details",
  "people_department_assignments", "people_manager_assignments", "people_employment_status_history" FROM bos_app;
GRANT SELECT, INSERT ON "people_departments", "people_locations", "people_employees", "people_employee_personal_details",
  "people_department_assignments", "people_manager_assignments", "people_employment_status_history" TO bos_app;
GRANT UPDATE ("name", "description", "version", "updated_by_id", "updated_at", "archived_at") ON "people_departments" TO bos_app;
GRANT UPDATE ("name", "address", "version", "updated_by_id", "updated_at", "archived_at") ON "people_locations" TO bos_app;
GRANT UPDATE ("employee_number", "given_name", "family_name", "preferred_name", "job_title", "employment_type", "work_email", "work_phone",
  "status", "start_date", "end_date", "location_id", "user_id", "version", "updated_by_id", "updated_at") ON "people_employees" TO bos_app;
GRANT UPDATE ("personal_email", "personal_phone", "home_address", "emergency_contact_name", "emergency_contact_relationship",
  "emergency_contact_phone", "version", "updated_by_id", "updated_at") ON "people_employee_personal_details" TO bos_app;
GRANT UPDATE ("ends_on", "ended_at", "ended_by_id") ON "people_department_assignments", "people_manager_assignments" TO bos_app;

-- Tenant policy template (data-model §5.2), forced so the table owner is subject to it too.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['people_departments', 'people_locations', 'people_employees', 'people_employee_personal_details',
    'people_department_assignments', 'people_manager_assignments', 'people_employment_status_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO bos_app
      USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
      WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
