-- Scheduling S1 (docs/scheduling-s1.md): business calendars and their events. Additive only: one new enum
-- and two new tables; no existing table, column, index or row is changed. No extension and no privileged step.

-- CreateEnum
CREATE TYPE "SchedulingEventStatus" AS ENUM ('SCHEDULED', 'CANCELLED');

-- CreateTable
CREATE TABLE "scheduling_calendars" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "colour" TEXT,
    "time_zone" TEXT NOT NULL,
    "default_slot" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "scheduling_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduling_events" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "calendar_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "status" "SchedulingEventStatus" NOT NULL DEFAULT 'SCHEDULED',
    "blocks_availability" BOOLEAN NOT NULL DEFAULT true,
    "customer_id" UUID,
    "cancelled_at" TIMESTAMPTZ,
    "cancelled_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID NOT NULL,
    "updated_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "scheduling_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheduling_calendars_business_id_archived_at_name_id_idx" ON "scheduling_calendars"("business_id", "archived_at", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduling_calendars_business_id_id_key" ON "scheduling_calendars"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduling_calendars_business_id_default_slot_key" ON "scheduling_calendars"("business_id", "default_slot");

-- CreateIndex
CREATE INDEX "scheduling_events_business_id_calendar_id_start_at_id_idx" ON "scheduling_events"("business_id", "calendar_id", "start_at", "id");

-- CreateIndex
CREATE INDEX "scheduling_events_business_id_start_at_id_idx" ON "scheduling_events"("business_id", "start_at", "id");

-- CreateIndex
CREATE INDEX "scheduling_events_business_id_customer_id_idx" ON "scheduling_events"("business_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheduling_events_business_id_id_key" ON "scheduling_events"("business_id", "id");

-- AddForeignKey
ALTER TABLE "scheduling_calendars" ADD CONSTRAINT "scheduling_calendars_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduling_events" ADD CONSTRAINT "scheduling_events_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduling_events" ADD CONSTRAINT "scheduling_events_calendar_fkey" FOREIGN KEY ("business_id", "calendar_id") REFERENCES "scheduling_calendars"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduling_events" ADD CONSTRAINT "scheduling_events_customer_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes.
ALTER TABLE "scheduling_calendars"
  ADD CONSTRAINT scheduling_calendars_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 100),
  ADD CONSTRAINT scheduling_calendars_description_length CHECK ("description" IS NULL OR char_length("description") <= 1000),
  ADD CONSTRAINT scheduling_calendars_colour_format CHECK ("colour" IS NULL OR "colour" ~ '^#[0-9A-Fa-f]{6}$'),
  -- Shape only: whether the zone exists is checked by the API (IANA list of the runtime), which is
  -- what interprets it.
  ADD CONSTRAINT scheduling_calendars_time_zone_format CHECK ("time_zone" ~ '^[A-Za-z][A-Za-z0-9_+\-]*(/[A-Za-z0-9_+\-]+)*$' AND char_length("time_zone") <= 64),
  -- One default per business: 'default' on it, NULL elsewhere (the unique index does the rest), and
  -- the default is never archived.
  ADD CONSTRAINT scheduling_calendars_default_slot CHECK ("default_slot" IS NULL OR "default_slot" = 'default'),
  ADD CONSTRAINT scheduling_calendars_default_active CHECK ("default_slot" IS NULL OR "archived_at" IS NULL),
  ADD CONSTRAINT scheduling_calendars_version_positive CHECK ("version" >= 1);

ALTER TABLE "scheduling_events"
  ADD CONSTRAINT scheduling_events_title_length CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT scheduling_events_description_length CHECK ("description" IS NULL OR char_length("description") <= 5000),
  ADD CONSTRAINT scheduling_events_location_length CHECK ("location" IS NULL OR char_length("location") <= 500),
  -- Half-open interval [start_at, end_at): the end is strictly after the start (no zero-length events),
  -- and an event lasts at most 31 days, which also bounds every range scan on (calendar_id, start_at).
  ADD CONSTRAINT scheduling_events_interval CHECK ("end_at" > "start_at"),
  ADD CONSTRAINT scheduling_events_max_duration CHECK ("end_at" - "start_at" <= interval '31 days'),
  -- A cancelled event always records when; any other status never does.
  ADD CONSTRAINT scheduling_events_cancelled_consistent CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
  ADD CONSTRAINT scheduling_events_version_positive CHECK ("version" >= 1);

-- ---------------------------------------------------------------------------------------------
-- Least privilege for tenant code. No DELETE: calendars and events are archived, events cancelled,
-- so no ordinary operation can remove scheduling history. bos_owner's default privileges are revoked
-- first. Other runtime roles get nothing.
REVOKE ALL ON "scheduling_calendars", "scheduling_events" FROM bos_app;
GRANT SELECT, INSERT, UPDATE ON "scheduling_calendars", "scheduling_events" TO bos_app;

-- Tenant policy template (data-model §5.2), forced so the table owner is subject to it too.
ALTER TABLE "scheduling_calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduling_calendars" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scheduling_calendars" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE "scheduling_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "scheduling_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scheduling_events" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);
