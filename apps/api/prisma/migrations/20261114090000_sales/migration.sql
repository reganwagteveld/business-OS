-- Sales Zone foundation (docs/sales-data-model.md): pipelines, stages and opportunities.
-- Additive only: new types and tables; no existing table or row is changed.

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateTable
CREATE TABLE "sales_pipelines" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "default_slot" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "sales_pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_stages" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "pipeline_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "default_probability" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "sales_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunities" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "customer_id" UUID,
    "contact_id" UUID,
    "pipeline_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "amount" DECIMAL(18,4),
    "currency_code" CHAR(3) NOT NULL,
    "probability" INTEGER,
    "expected_close_date" DATE,
    "owner_user_id" UUID,
    "description" TEXT,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'OPEN',
    "loss_reason" TEXT,
    "closed_at" TIMESTAMPTZ,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "opportunities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_pipelines_business_id_position_id_idx" ON "sales_pipelines"("business_id", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_pipelines_business_id_id_key" ON "sales_pipelines"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_pipelines_business_id_default_slot_key" ON "sales_pipelines"("business_id", "default_slot");

-- CreateIndex
CREATE INDEX "sales_stages_business_id_pipeline_id_position_id_idx" ON "sales_stages"("business_id", "pipeline_id", "position", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_stages_business_id_id_key" ON "sales_stages"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_stages_business_id_pipeline_id_id_key" ON "sales_stages"("business_id", "pipeline_id", "id");

-- CreateIndex
CREATE INDEX "opportunities_business_id_status_created_at_id_idx" ON "opportunities"("business_id", "status", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "opportunities_business_id_pipeline_id_stage_id_idx" ON "opportunities"("business_id", "pipeline_id", "stage_id");

-- CreateIndex
CREATE INDEX "opportunities_business_id_customer_id_idx" ON "opportunities"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "opportunities_business_id_owner_user_id_idx" ON "opportunities"("business_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "opportunities_business_id_archived_at_idx" ON "opportunities"("business_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "opportunities_business_id_id_key" ON "opportunities"("business_id", "id");

-- AddForeignKey
ALTER TABLE "sales_pipelines" ADD CONSTRAINT "sales_pipelines_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_stages" ADD CONSTRAINT "sales_stages_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_stages" ADD CONSTRAINT "sales_stages_pipeline_fkey" FOREIGN KEY ("business_id", "pipeline_id") REFERENCES "sales_pipelines"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_customer_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_contact_fkey" FOREIGN KEY ("business_id", "contact_id") REFERENCES "contacts"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_pipeline_fkey" FOREIGN KEY ("business_id", "pipeline_id") REFERENCES "sales_pipelines"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_stage_fkey" FOREIGN KEY ("business_id", "pipeline_id", "stage_id") REFERENCES "sales_stages"("business_id", "pipeline_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_owner_fkey" FOREIGN KEY ("business_id", "owner_user_id") REFERENCES "memberships"("business_id", "user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes.
ALTER TABLE "sales_pipelines"
  ADD CONSTRAINT sales_pipelines_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 100),
  -- One default per business: 'default' on it, NULL elsewhere (the unique index does the rest).
  ADD CONSTRAINT sales_pipelines_default_slot CHECK ("default_slot" IS NULL OR "default_slot" = 'default'),
  ADD CONSTRAINT sales_pipelines_default_active CHECK ("default_slot" IS NULL OR "archived_at" IS NULL);
ALTER TABLE "sales_stages"
  ADD CONSTRAINT sales_stages_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 60),
  ADD CONSTRAINT sales_stages_position CHECK ("position" >= 0),
  ADD CONSTRAINT sales_stages_probability CHECK ("default_probability" IS NULL OR "default_probability" BETWEEN 0 AND 100);
ALTER TABLE "opportunities"
  ADD CONSTRAINT opportunities_title_length CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
  ADD CONSTRAINT opportunities_currency_format CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT opportunities_amount_nonnegative CHECK ("amount" IS NULL OR "amount" >= 0),
  ADD CONSTRAINT opportunities_probability CHECK ("probability" IS NULL OR "probability" BETWEEN 0 AND 100),
  ADD CONSTRAINT opportunities_description_length CHECK ("description" IS NULL OR char_length("description") <= 5000),
  ADD CONSTRAINT opportunities_loss_reason_length CHECK ("loss_reason" IS NULL OR char_length("loss_reason") <= 500),
  -- An open opportunity has no close date; a won or lost one always has one.
  ADD CONSTRAINT opportunities_closed_consistent CHECK (("status" = 'OPEN') = ("closed_at" IS NULL)),
  -- Only a lost opportunity carries a loss reason.
  ADD CONSTRAINT opportunities_loss_reason_status CHECK ("loss_reason" IS NULL OR "status" = 'LOST');

-- ---------------------------------------------------------------------------------------------
-- Least privilege for tenant code. No DELETE: pipelines and stages are archived, never deleted, so
-- no opportunity can lose its stage; opportunities are archived and restored. bos_owner's default
-- privileges are revoked first. Other runtime roles get nothing.
REVOKE ALL ON "sales_pipelines", "sales_stages", "opportunities" FROM bos_app;
GRANT SELECT, INSERT, UPDATE ON "sales_pipelines", "sales_stages", "opportunities" TO bos_app;

-- Tenant policy template (data-model §5.2), forced so the table owner is subject to it too.
ALTER TABLE "sales_pipelines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_pipelines" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_pipelines" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE "sales_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales_stages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sales_stages" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE "opportunities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "opportunities" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "opportunities" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);
