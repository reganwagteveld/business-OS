-- Finance Zone F1 (docs/finance-data-model.md, ADR 0007): quotes, invoices, credit notes, finance settings,
-- numbering series and tax rates, plus the payment, allocation and expense tables of the approved F0
-- model (their services come in F2 and F3). Additive only: new types, tables, functions, triggers, grants
-- and policies; no existing table, column or row is changed. No privileged SQL.

-- CreateEnum
CREATE TYPE "FinanceDocumentKind" AS ENUM ('QUOTE', 'INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "FinanceDocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID');

-- CreateEnum
CREATE TYPE "FinanceTaxMode" AS ENUM ('EXCLUSIVE');

-- CreateEnum
CREATE TYPE "FinancePaymentStatus" AS ENUM ('RECORDED', 'REVERSED');

-- CreateEnum
CREATE TYPE "FinancePaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'CARD', 'CHEQUE', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceExpenseStatus" AS ENUM ('DRAFT', 'RECORDED', 'VOID');

-- CreateTable
CREATE TABLE "finance_settings" (
    "business_id" UUID NOT NULL,
    "seller_legal_name" TEXT,
    "seller_address" TEXT,
    "seller_email" TEXT,
    "seller_phone" TEXT,
    "seller_identifiers" JSONB NOT NULL DEFAULT '[]',
    "payment_instructions" TEXT,
    "default_payment_terms_days" SMALLINT,
    "default_quote_validity_days" SMALLINT,
    "default_tax_rate_id" UUID,
    "retention_years" SMALLINT NOT NULL DEFAULT 7,
    "legal_hold" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_settings_pkey" PRIMARY KEY ("business_id")
);

-- CreateTable
CREATE TABLE "finance_number_series" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "kind" "FinanceDocumentKind" NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "min_digits" SMALLINT NOT NULL DEFAULT 4,
    "starting_value" BIGINT NOT NULL DEFAULT 1,
    "next_value" BIGINT NOT NULL DEFAULT 1,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_number_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_tax_rates" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rate_percent" DECIMAL(7,4) NOT NULL,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "finance_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_documents" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "kind" "FinanceDocumentKind" NOT NULL,
    "status" "FinanceDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "customer_id" UUID NOT NULL,
    "contact_id" UUID,
    "opportunity_id" UUID,
    "project_id" UUID,
    "source_quote_id" UUID,
    "source_quote_kind" "FinanceDocumentKind" NOT NULL DEFAULT 'QUOTE',
    "credited_invoice_id" UUID,
    "credited_invoice_kind" "FinanceDocumentKind" NOT NULL DEFAULT 'INVOICE',
    "currency_code" CHAR(3) NOT NULL,
    "currency_scale" SMALLINT NOT NULL,
    "tax_mode" "FinanceTaxMode" NOT NULL DEFAULT 'EXCLUSIVE',
    "issue_date" DATE,
    "due_date" DATE,
    "valid_until" DATE,
    "number_value" BIGINT,
    "number" TEXT,
    "seller_snapshot" JSONB,
    "bill_to_snapshot" JSONB,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "allocated_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "content_sha256" TEXT,
    "notes" TEXT,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "issued_at" TIMESTAMPTZ,
    "status_changed_at" TIMESTAMPTZ,
    "voided_at" TIMESTAMPTZ,
    "void_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "issued_by_id" UUID,
    "status_changed_by_id" UUID,
    "voided_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_document_lines" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unit_price" DECIMAL(18,6) NOT NULL,
    "discount_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "tax_rate_id" UUID,
    "tax_name" TEXT,
    "tax_rate_percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "line_net" DECIMAL(18,4) NOT NULL,
    "line_tax" DECIMAL(18,4) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_payments" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "currency_scale" SMALLINT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "received_on" DATE NOT NULL,
    "method" "FinancePaymentMethod" NOT NULL,
    "reference" TEXT,
    "status" "FinancePaymentStatus" NOT NULL DEFAULT 'RECORDED',
    "allocated_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reversed_at" TIMESTAMPTZ,
    "reversal_reason" TEXT,
    "idempotency_key" TEXT,
    "request_hash" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "recorded_by_id" UUID,
    "reversed_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_payment_allocations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "invoice_kind" "FinanceDocumentKind" NOT NULL DEFAULT 'INVOICE',
    "customer_id" UUID NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "created_by_id" UUID,
    "reversed_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ,

    CONSTRAINT "finance_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_expense_categories" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "finance_expense_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_expenses" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "status" "FinanceExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "category_id" UUID NOT NULL,
    "category_name" TEXT,
    "project_id" UUID,
    "description" TEXT NOT NULL,
    "supplier_name" TEXT,
    "incurred_on" DATE NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "currency_scale" SMALLINT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "tax_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "receipt_reference" TEXT,
    "recorded_at" TIMESTAMPTZ,
    "voided_at" TIMESTAMPTZ,
    "void_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finance_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finance_number_series_business_id_kind_key" ON "finance_number_series"("business_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "finance_number_series_business_id_id_key" ON "finance_number_series"("business_id", "id");

-- CreateIndex
CREATE INDEX "finance_tax_rates_business_id_archived_at_name_idx" ON "finance_tax_rates"("business_id", "archived_at", "name");

-- CreateIndex
CREATE UNIQUE INDEX "finance_tax_rates_business_id_id_key" ON "finance_tax_rates"("business_id", "id");

-- CreateIndex
CREATE INDEX "finance_documents_business_id_kind_status_issue_date_idx" ON "finance_documents"("business_id", "kind", "status", "issue_date");

-- CreateIndex
CREATE INDEX "finance_documents_business_id_kind_created_at_id_idx" ON "finance_documents"("business_id", "kind", "created_at" DESC, "id");

-- CreateIndex
CREATE INDEX "finance_documents_business_id_customer_id_idx" ON "finance_documents"("business_id", "customer_id");

-- CreateIndex
CREATE INDEX "finance_documents_business_id_project_id_idx" ON "finance_documents"("business_id", "project_id");

-- CreateIndex
CREATE INDEX "finance_documents_business_id_opportunity_id_idx" ON "finance_documents"("business_id", "opportunity_id");

-- CreateIndex
CREATE INDEX "finance_documents_business_id_source_quote_id_idx" ON "finance_documents"("business_id", "source_quote_id");

-- CreateIndex
CREATE INDEX "finance_documents_business_id_credited_invoice_id_idx" ON "finance_documents"("business_id", "credited_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_documents_business_id_id_key" ON "finance_documents"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_documents_kind_key" ON "finance_documents"("business_id", "id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "finance_documents_link_key" ON "finance_documents"("business_id", "id", "kind", "currency_code", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_documents_business_id_kind_number_value_key" ON "finance_documents"("business_id", "kind", "number_value");

-- CreateIndex
CREATE UNIQUE INDEX "finance_documents_business_id_kind_number_key" ON "finance_documents"("business_id", "kind", "number");

-- CreateIndex
CREATE INDEX "finance_document_lines_business_id_tax_rate_id_idx" ON "finance_document_lines"("business_id", "tax_rate_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_document_lines_business_id_id_key" ON "finance_document_lines"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_document_lines_business_id_document_id_position_key" ON "finance_document_lines"("business_id", "document_id", "position");

-- CreateIndex
CREATE INDEX "finance_payments_business_id_received_on_id_idx" ON "finance_payments"("business_id", "received_on", "id");

-- CreateIndex
CREATE INDEX "finance_payments_business_id_customer_id_idx" ON "finance_payments"("business_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_payments_business_id_id_key" ON "finance_payments"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_payments_link_key" ON "finance_payments"("business_id", "id", "customer_id", "currency_code");

-- CreateIndex
CREATE INDEX "finance_payment_allocations_business_id_invoice_id_idx" ON "finance_payment_allocations"("business_id", "invoice_id");

-- CreateIndex
CREATE INDEX "finance_payment_allocations_business_id_payment_id_idx" ON "finance_payment_allocations"("business_id", "payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_payment_allocations_business_id_id_key" ON "finance_payment_allocations"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_expense_categories_business_id_id_key" ON "finance_expense_categories"("business_id", "id");

-- CreateIndex
CREATE INDEX "finance_expenses_business_id_incurred_on_id_idx" ON "finance_expenses"("business_id", "incurred_on", "id");

-- CreateIndex
CREATE INDEX "finance_expenses_business_id_project_id_idx" ON "finance_expenses"("business_id", "project_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_expenses_business_id_id_key" ON "finance_expenses"("business_id", "id");

-- AddForeignKey
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_default_tax_rate_fkey" FOREIGN KEY ("business_id", "default_tax_rate_id") REFERENCES "finance_tax_rates"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_number_series" ADD CONSTRAINT "finance_number_series_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_tax_rates" ADD CONSTRAINT "finance_tax_rates_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_customer_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_contact_fkey" FOREIGN KEY ("business_id", "contact_id") REFERENCES "contacts"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_opportunity_fkey" FOREIGN KEY ("business_id", "opportunity_id") REFERENCES "opportunities"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_project_fkey" FOREIGN KEY ("business_id", "project_id") REFERENCES "projects"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_source_quote_fkey" FOREIGN KEY ("business_id", "source_quote_id", "source_quote_kind") REFERENCES "finance_documents"("business_id", "id", "kind") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_credited_invoice_fkey" FOREIGN KEY ("business_id", "credited_invoice_id", "credited_invoice_kind", "currency_code", "customer_id") REFERENCES "finance_documents"("business_id", "id", "kind", "currency_code", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_document_lines" ADD CONSTRAINT "finance_document_lines_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_document_lines" ADD CONSTRAINT "finance_document_lines_document_fkey" FOREIGN KEY ("business_id", "document_id") REFERENCES "finance_documents"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_document_lines" ADD CONSTRAINT "finance_document_lines_tax_rate_fkey" FOREIGN KEY ("business_id", "tax_rate_id") REFERENCES "finance_tax_rates"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_payments" ADD CONSTRAINT "finance_payments_customer_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_payment_allocations" ADD CONSTRAINT "finance_payment_allocations_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_payment_allocations" ADD CONSTRAINT "finance_payment_allocations_payment_fkey" FOREIGN KEY ("business_id", "payment_id", "customer_id", "currency_code") REFERENCES "finance_payments"("business_id", "id", "customer_id", "currency_code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_payment_allocations" ADD CONSTRAINT "finance_payment_allocations_invoice_fkey" FOREIGN KEY ("business_id", "invoice_id", "invoice_kind", "currency_code", "customer_id") REFERENCES "finance_documents"("business_id", "id", "kind", "currency_code", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_expense_categories" ADD CONSTRAINT "finance_expense_categories_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_category_fkey" FOREIGN KEY ("business_id", "category_id") REFERENCES "finance_expense_categories"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_project_fkey" FOREIGN KEY ("business_id", "project_id") REFERENCES "projects"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;




-- =============================================================================================
-- Hand-written part: everything Prisma cannot express. Re-derived from the F0 spike fixture
-- (tests/isolation/fixtures/finance-spike-schema.sql), with F1's owner decisions FD-L1, FD-L2, FD-L3,
-- FD-T1, FD-T2 and FD-P1 applied (docs/finance-data-model.md §14).
--
-- Error codes: every guard raises its own SQLSTATE in the custom class FN (FN001-FN099), so an
-- integrity refusal is never confused with an RLS refusal (42501) and the API can map each one to a
-- stable error code without forwarding any database detail. Class FN is not used by PostgreSQL.
--   FN001 immutable record or field       FN002 invalid lifecycle transition
--   FN003 totals do not match the lines   FN004 document has no lines
--   FN005 credited invoice is not issued  FN006 invoice has live credit notes
--   FN007 invoice has payment allocations FN008 numbering is database-assigned / start fixed once used
--   FN009 no numbering series             FN010 database-owned field written directly
--   FN011 unsupported tax mode            FN012 credit notes would exceed the invoice total
--   FN013 not allocatable (payment or invoice state)
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Integrity checks that hold whatever code writes.
ALTER TABLE "finance_settings"
  ADD CONSTRAINT finance_settings_seller_legal_name_length CHECK ("seller_legal_name" IS NULL OR char_length("seller_legal_name") <= 200),
  ADD CONSTRAINT finance_settings_seller_address_length CHECK ("seller_address" IS NULL OR char_length("seller_address") <= 1000),
  ADD CONSTRAINT finance_settings_seller_email_length CHECK ("seller_email" IS NULL OR char_length("seller_email") <= 254),
  ADD CONSTRAINT finance_settings_seller_phone_length CHECK ("seller_phone" IS NULL OR char_length("seller_phone") <= 50),
  ADD CONSTRAINT finance_settings_seller_identifiers CHECK (jsonb_typeof("seller_identifiers") = 'array' AND jsonb_array_length("seller_identifiers") <= 10),
  ADD CONSTRAINT finance_settings_payment_instructions_length CHECK ("payment_instructions" IS NULL OR char_length("payment_instructions") <= 2000),
  ADD CONSTRAINT finance_settings_payment_terms CHECK ("default_payment_terms_days" IS NULL OR "default_payment_terms_days" BETWEEN 0 AND 365),
  ADD CONSTRAINT finance_settings_quote_validity CHECK ("default_quote_validity_days" IS NULL OR "default_quote_validity_days" BETWEEN 1 AND 365),
  -- FD-L3: seven years is the floor of the retention policy; a jurisdiction may need longer.
  ADD CONSTRAINT finance_settings_retention_years CHECK ("retention_years" BETWEEN 7 AND 100),
  ADD CONSTRAINT finance_settings_version_positive CHECK ("version" >= 1);

ALTER TABLE "finance_number_series"
  ADD CONSTRAINT finance_number_series_starting_value CHECK ("starting_value" BETWEEN 1 AND 999999999999),
  ADD CONSTRAINT finance_number_series_prefix_length CHECK (char_length("prefix") <= 20 AND "prefix" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT finance_number_series_min_digits CHECK ("min_digits" BETWEEN 1 AND 12),
  ADD CONSTRAINT finance_number_series_next_value CHECK ("next_value" >= "starting_value" AND "next_value" <= 1000000000000),
  ADD CONSTRAINT finance_number_series_version_positive CHECK ("version" >= 1);

ALTER TABLE "finance_tax_rates"
  ADD CONSTRAINT finance_tax_rates_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 100),
  ADD CONSTRAINT finance_tax_rates_rate CHECK ("rate_percent" >= 0 AND "rate_percent" <= 100);

ALTER TABLE "finance_documents"
  ADD CONSTRAINT finance_documents_currency_format CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT finance_documents_currency_scale CHECK ("currency_scale" BETWEEN 0 AND 4),
  ADD CONSTRAINT finance_documents_status_for_kind CHECK ("kind" = 'QUOTE' OR "status" IN ('DRAFT', 'ISSUED', 'VOID')),
  ADD CONSTRAINT finance_documents_quote_link CHECK ("source_quote_id" IS NULL OR "kind" = 'INVOICE'),
  ADD CONSTRAINT finance_documents_source_quote_kind CHECK ("source_quote_kind" = 'QUOTE'),
  ADD CONSTRAINT finance_documents_credit_link CHECK (("kind" = 'CREDIT_NOTE') = ("credited_invoice_id" IS NOT NULL)),
  ADD CONSTRAINT finance_documents_credited_kind CHECK ("credited_invoice_kind" = 'INVOICE'),
  -- Dates by kind: due dates belong to invoices, validity to quotes; an issued invoice has a due date.
  ADD CONSTRAINT finance_documents_due_date_kind CHECK ("due_date" IS NULL OR "kind" = 'INVOICE'),
  ADD CONSTRAINT finance_documents_valid_until_kind CHECK ("valid_until" IS NULL OR "kind" = 'QUOTE'),
  ADD CONSTRAINT finance_documents_invoice_due CHECK ("due_date" IS NULL OR "issue_date" IS NULL OR "due_date" >= "issue_date"),
  ADD CONSTRAINT finance_documents_quote_valid CHECK ("valid_until" IS NULL OR "issue_date" IS NULL OR "valid_until" >= "issue_date"),
  ADD CONSTRAINT finance_documents_invoice_due_required CHECK ("kind" <> 'INVOICE' OR "number_value" IS NULL OR "due_date" IS NOT NULL),
  ADD CONSTRAINT finance_documents_amounts CHECK ("subtotal" >= 0 AND "tax_total" >= 0 AND "total" = "subtotal" + "tax_total"),
  ADD CONSTRAINT finance_documents_amount_scale CHECK (
    "subtotal" = round("subtotal", "currency_scale") AND "tax_total" = round("tax_total", "currency_scale") AND "total" = round("total", "currency_scale")),
  -- The settlement counter: maintained only by the allocation triggers, never above the total.
  ADD CONSTRAINT finance_documents_allocated CHECK ("allocated_total" >= 0 AND "allocated_total" <= "total" AND ("kind" = 'INVOICE' OR "allocated_total" = 0)),
  ADD CONSTRAINT finance_documents_void_unsettled CHECK ("status" <> 'VOID' OR "allocated_total" = 0),
  ADD CONSTRAINT finance_documents_void_fields CHECK (("status" = 'VOID') = ("voided_at" IS NOT NULL)),
  ADD CONSTRAINT finance_documents_draft_unnumbered CHECK ("status" <> 'DRAFT' OR ("number_value" IS NULL AND "issued_at" IS NULL)),
  ADD CONSTRAINT finance_documents_numbered_together CHECK (
    ("number_value" IS NULL) = ("number" IS NULL) AND ("number_value" IS NULL) = ("issued_at" IS NULL) AND ("number_value" IS NULL) = ("content_sha256" IS NULL)),
  ADD CONSTRAINT finance_documents_issued_sealed CHECK (
    "status" IN ('DRAFT', 'VOID')
    OR ("number_value" IS NOT NULL AND "issue_date" IS NOT NULL AND "seller_snapshot" IS NOT NULL AND "bill_to_snapshot" IS NOT NULL AND "content_sha256" IS NOT NULL)),
  ADD CONSTRAINT finance_documents_snapshots_objects CHECK (
    ("seller_snapshot" IS NULL OR jsonb_typeof("seller_snapshot") = 'object') AND ("bill_to_snapshot" IS NULL OR jsonb_typeof("bill_to_snapshot") = 'object')),
  ADD CONSTRAINT finance_documents_notes_length CHECK ("notes" IS NULL OR char_length("notes") <= 5000),
  ADD CONSTRAINT finance_documents_void_reason_length CHECK ("void_reason" IS NULL OR ("status" = 'VOID' AND char_length("void_reason") <= 500)),
  ADD CONSTRAINT finance_documents_idempotency CHECK (
    ("idempotency_key" IS NULL) = ("request_hash" IS NULL) AND ("idempotency_key" IS NULL OR char_length("idempotency_key") BETWEEN 1 AND 200)),
  ADD CONSTRAINT finance_documents_version_positive CHECK ("version" >= 1);

ALTER TABLE "finance_document_lines"
  ADD CONSTRAINT finance_document_lines_description_length CHECK (char_length(btrim("description")) BETWEEN 1 AND 1000),
  ADD CONSTRAINT finance_document_lines_position CHECK ("position" >= 0),
  ADD CONSTRAINT finance_document_lines_values CHECK ("quantity" > 0 AND "unit_price" >= 0 AND "discount_amount" >= 0 AND "line_net" >= 0 AND "line_tax" >= 0),
  -- FD-T1: one tax per line, always through a rate whose name and percentage the line snapshots.
  ADD CONSTRAINT finance_document_lines_tax CHECK (
    "tax_rate_percent" >= 0 AND "tax_rate_percent" <= 100
    AND ("tax_rate_id" IS NULL) = ("tax_name" IS NULL) AND ("tax_rate_id" IS NOT NULL OR "tax_rate_percent" = 0));

ALTER TABLE "finance_payments"
  ADD CONSTRAINT finance_payments_currency_format CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT finance_payments_currency_scale CHECK ("currency_scale" BETWEEN 0 AND 4),
  ADD CONSTRAINT finance_payments_amount CHECK ("amount" > 0 AND "amount" = round("amount", "currency_scale")),
  ADD CONSTRAINT finance_payments_allocated CHECK ("allocated_total" >= 0 AND "allocated_total" <= "amount"),
  ADD CONSTRAINT finance_payments_reversal CHECK (("status" = 'REVERSED') = ("reversed_at" IS NOT NULL) AND ("status" <> 'REVERSED' OR "allocated_total" = 0)),
  ADD CONSTRAINT finance_payments_reversal_reason CHECK ("reversal_reason" IS NULL OR ("status" = 'REVERSED' AND char_length("reversal_reason") <= 500)),
  ADD CONSTRAINT finance_payments_reference_length CHECK ("reference" IS NULL OR char_length("reference") <= 200),
  ADD CONSTRAINT finance_payments_idempotency CHECK (
    ("idempotency_key" IS NULL) = ("request_hash" IS NULL) AND ("idempotency_key" IS NULL OR char_length("idempotency_key") BETWEEN 1 AND 200)),
  ADD CONSTRAINT finance_payments_version_positive CHECK ("version" >= 1);

ALTER TABLE "finance_payment_allocations"
  ADD CONSTRAINT finance_payment_allocations_amount CHECK ("amount" > 0),
  ADD CONSTRAINT finance_payment_allocations_kind CHECK ("invoice_kind" = 'INVOICE');

ALTER TABLE "finance_expense_categories"
  ADD CONSTRAINT finance_expense_categories_name_length CHECK (char_length(btrim("name")) BETWEEN 1 AND 100);

ALTER TABLE "finance_expenses"
  ADD CONSTRAINT finance_expenses_currency_format CHECK ("currency_code" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT finance_expenses_currency_scale CHECK ("currency_scale" BETWEEN 0 AND 4),
  ADD CONSTRAINT finance_expenses_amounts CHECK (
    "amount" > 0 AND "tax_amount" >= 0 AND "tax_amount" <= "amount"
    AND "amount" = round("amount", "currency_scale") AND "tax_amount" = round("tax_amount", "currency_scale")),
  ADD CONSTRAINT finance_expenses_description_length CHECK (char_length(btrim("description")) BETWEEN 1 AND 500),
  ADD CONSTRAINT finance_expenses_supplier_length CHECK ("supplier_name" IS NULL OR char_length("supplier_name") <= 200),
  ADD CONSTRAINT finance_expenses_receipt_length CHECK ("receipt_reference" IS NULL OR char_length("receipt_reference") <= 500),
  ADD CONSTRAINT finance_expenses_recorded CHECK ("status" <> 'RECORDED' OR ("recorded_at" IS NOT NULL AND "category_name" IS NOT NULL)),
  ADD CONSTRAINT finance_expenses_void CHECK (("status" = 'VOID') = ("voided_at" IS NOT NULL) AND ("void_reason" IS NULL OR ("status" = 'VOID' AND char_length("void_reason") <= 500))),
  ADD CONSTRAINT finance_expenses_version_positive CHECK ("version" >= 1);

-- Partial unique indexes (Prisma cannot express them).
-- A repeated create request with the same key finds the first draft (FD idempotency, §6.4).
CREATE UNIQUE INDEX "finance_documents_idempotency_key" ON "finance_documents" ("business_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE UNIQUE INDEX "finance_payments_idempotency_key" ON "finance_payments" ("business_id", "idempotency_key") WHERE "idempotency_key" IS NOT NULL;
-- One live allocation per payment and invoice: a double-submitted allocation is refused (23505).
CREATE UNIQUE INDEX "finance_payment_allocations_active_key" ON "finance_payment_allocations" ("business_id", "payment_id", "invoice_id") WHERE "reversed_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Content hash. The canonical content of an issued document: header, snapshots and lines (ordered by
-- position, id), as jsonb, whose text form is deterministic. Computed by the issue guard; recomputing
-- it later proves the stored content is what was issued. Not a signature (FD-L5).
CREATE FUNCTION finance_document_content(d "finance_documents") RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'kind', d.kind, 'number', d.number, 'issueDate', d.issue_date, 'dueDate', d.due_date, 'validUntil', d.valid_until,
    'currency', d.currency_code, 'currencyScale', d.currency_scale, 'taxMode', d.tax_mode,
    'subtotal', d.subtotal::text, 'taxTotal', d.tax_total::text, 'total', d.total::text,
    'customerId', d.customer_id, 'sourceQuoteId', d.source_quote_id, 'creditedInvoiceId', d.credited_invoice_id,
    'seller', d.seller_snapshot, 'billTo', d.bill_to_snapshot,
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'description', l.description, 'quantity', l.quantity::text, 'unitPrice', l.unit_price::text,
        'discount', l.discount_amount::text, 'taxName', l.tax_name, 'taxRatePercent', l.tax_rate_percent::text,
        'net', l.line_net::text, 'tax', l.line_tax::text) ORDER BY l.position, l.id)
      FROM public.finance_document_lines l WHERE l.business_id = d.business_id AND l.document_id = d.id), '[]'::jsonb))
$$;

CREATE FUNCTION finance_content_hash(d "finance_documents") RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT encode(sha256(convert_to(public.finance_document_content(d)::text, 'UTF8')), 'hex')
$$;

-- ---------------------------------------------------------------------------------------------
-- Guards. All SECURITY INVOKER: they run as bos_app under its own forced RLS, so they only ever see
-- and change the current tenant's rows. No SECURITY DEFINER, no extension, no privileged step.

-- Documents: lifecycle, sealing at issue, and immutability afterwards (deny by default).
CREATE FUNCTION finance_guard_document() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  -- Columns that may change after a document leaves DRAFT. Everything else is frozen; a column added
  -- later is frozen too unless it is listed here (a reviewed migration).
  mutable_after_issue text[] := ARRAY['status', 'allocated_total', 'status_changed_at', 'status_changed_by_id', 'voided_at', 'voided_by_id',
                                      'void_reason', 'version', 'updated_at', 'updated_by_id'];
  sums record;
  series record;
  inv record;
  credited numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.allocated_total <> 0 OR NEW.number_value IS NOT NULL OR NEW.number IS NOT NULL
       OR NEW.content_sha256 IS NOT NULL OR NEW.issued_at IS NOT NULL OR NEW.issued_by_id IS NOT NULL
       OR NEW.status_changed_at IS NOT NULL OR NEW.status_changed_by_id IS NOT NULL
       OR NEW.voided_at IS NOT NULL OR NEW.voided_by_id IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
      RAISE EXCEPTION 'documents are created as unnumbered drafts' USING ERRCODE = 'FN010';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  NEW.updated_at := now();

  -- Identity and provenance never change, not even on a draft.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.request_hash IS DISTINCT FROM OLD.request_hash THEN
    RAISE EXCEPTION 'document identity is fixed' USING ERRCODE = 'FN001';
  END IF;

  -- The settlement counter belongs to the allocation triggers (they run one trigger level deeper).
  IF NEW.allocated_total IS DISTINCT FROM OLD.allocated_total AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'allocated_total is maintained by the database' USING ERRCODE = 'FN010';
  END IF;

  -- Transition metadata belongs to the database (§4.4). A status change stamps status_changed_at (and
  -- voided_at when voiding) with the transaction time, overwriting anything the client sent; the void
  -- reason and voider can be given only in the void transition, the issuer only in the issue. Without
  -- a status change none of them may change, so they can never be fabricated, cleared or rewritten.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.status_changed_at := now();
    IF NEW.status = 'VOID' THEN
      NEW.voided_at := now();
    ELSIF NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.voided_by_id IS DISTINCT FROM OLD.voided_by_id
          OR NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
      RAISE EXCEPTION 'void metadata belongs to the void transition' USING ERRCODE = 'FN010';
    END IF;
    IF NEW.issued_by_id IS DISTINCT FROM OLD.issued_by_id AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'ISSUED') THEN
      RAISE EXCEPTION 'the issuer is recorded only at issue' USING ERRCODE = 'FN010';
    END IF;
  ELSIF NEW.status_changed_at IS DISTINCT FROM OLD.status_changed_at OR NEW.status_changed_by_id IS DISTINCT FROM OLD.status_changed_by_id
        OR NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.voided_by_id IS DISTINCT FROM OLD.voided_by_id
        OR NEW.void_reason IS DISTINCT FROM OLD.void_reason OR NEW.issued_by_id IS DISTINCT FROM OLD.issued_by_id THEN
    RAISE EXCEPTION 'transition metadata is set only by its transition' USING ERRCODE = 'FN010';
  END IF;

  IF OLD.status = 'DRAFT' THEN
    IF NEW.status IN ('DRAFT', 'VOID') THEN
      -- A draft, or a discarded draft, is never numbered or sealed.
      IF NEW.number_value IS NOT NULL OR NEW.number IS NOT NULL OR NEW.content_sha256 IS NOT NULL OR NEW.issued_at IS NOT NULL THEN
        RAISE EXCEPTION 'drafts are unnumbered' USING ERRCODE = 'FN008';
      END IF;
      RETURN NEW;
    ELSIF NEW.status <> 'ISSUED' THEN
      RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = 'FN002';
    END IF;

    -- DRAFT -> ISSUED: seal. The client supplies dates and snapshots; the database checks the
    -- arithmetic, assigns the number and computes the content hash, overwriting anything sent for them.
    -- FD-T1: only tax-exclusive prices have formulas here; any other mode is refused, never guessed.
    IF NEW.tax_mode::text <> 'EXCLUSIVE' THEN
      RAISE EXCEPTION 'unsupported tax mode %', NEW.tax_mode USING ERRCODE = 'FN011';
    END IF;
    IF NEW.kind = 'CREDIT_NOTE' THEN
      -- The credited invoice must be issued (not void), and all its issued credit notes together may
      -- not exceed its total. Locking it FOR NO KEY UPDATE (lock order: this document, then the one it
      -- references) serialises concurrent credit-note issues for one invoice and a concurrent void,
      -- which then sees this credit note (guard below) or went first and makes this one fail.
      SELECT i.status, i.total INTO inv FROM public.finance_documents i
        WHERE i.business_id = NEW.business_id AND i.id = NEW.credited_invoice_id FOR NO KEY UPDATE;
      IF NOT FOUND OR inv.status <> 'ISSUED' THEN
        RAISE EXCEPTION 'credited invoice is not issued' USING ERRCODE = 'FN005';
      END IF;
      SELECT coalesce(sum(c.total), 0) INTO credited FROM public.finance_documents c
        WHERE c.business_id = NEW.business_id AND c.credited_invoice_id = NEW.credited_invoice_id AND c.status = 'ISSUED' AND c.id <> NEW.id;
      IF credited + NEW.total > inv.total THEN
        RAISE EXCEPTION 'credit notes would exceed the invoice total' USING ERRCODE = 'FN012';
      END IF;
    END IF;
    -- FD-T2: line-level rounding, half away from zero (PostgreSQL round(numeric, int)), at the
    -- currency's snapshotted scale, recomputed here; any difference refuses the issue.
    SELECT count(*) FILTER (WHERE l.line_net <> round(l.quantity * l.unit_price, NEW.currency_scale) - l.discount_amount
                               OR l.line_tax <> round(l.line_net * l.tax_rate_percent / 100, NEW.currency_scale)) AS bad,
           count(*) AS n, coalesce(sum(l.line_net), 0) AS net, coalesce(sum(l.line_tax), 0) AS tax
      INTO sums
      FROM public.finance_document_lines l WHERE l.business_id = NEW.business_id AND l.document_id = NEW.id;
    IF sums.n = 0 THEN RAISE EXCEPTION 'a document needs at least one line' USING ERRCODE = 'FN004'; END IF;
    IF sums.bad > 0 OR NEW.subtotal <> sums.net OR NEW.tax_total <> sums.tax OR NEW.total <> sums.net + sums.tax THEN
      RAISE EXCEPTION 'totals do not match the lines' USING ERRCODE = 'FN003';
    END IF;
    -- FD-L1: the next number of this business's series for the kind, taken in the issuing transaction
    -- (not a PostgreSQL sequence), so a rolled-back issue returns its number and committed numbers
    -- have no gaps. Lock order: the document (this row) first, then the series row, last.
    UPDATE public.finance_number_series s SET next_value = s.next_value + 1
     WHERE s.business_id = NEW.business_id AND s.kind = NEW.kind
     RETURNING s.next_value - 1 AS n, s.prefix, s.min_digits INTO series;
    IF NOT FOUND THEN RAISE EXCEPTION 'no numbering series for %', NEW.kind USING ERRCODE = 'FN009'; END IF;
    NEW.number_value := series.n;
    -- lpad truncates, so pad only when the number is shorter than min_digits.
    NEW.number := series.prefix || CASE WHEN length(series.n::text) >= series.min_digits THEN series.n::text
                                        ELSE lpad(series.n::text, series.min_digits, '0') END;
    NEW.issued_at := now();
    NEW.status_changed_at := now();
    NEW.content_sha256 := public.finance_content_hash(NEW);
    RETURN NEW;
  END IF;

  -- Issued (or later): nothing outside mutable_after_issue may change.
  IF (to_jsonb(NEW) - mutable_after_issue) IS DISTINCT FROM (to_jsonb(OLD) - mutable_after_issue) THEN
    RAISE EXCEPTION 'issued documents are immutable' USING ERRCODE = 'FN001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.kind = 'QUOTE' AND OLD.status = 'ISSUED' AND NEW.status IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID'))
      OR (OLD.kind = 'QUOTE' AND OLD.status = 'ACCEPTED' AND NEW.status = 'VOID')
      OR (OLD.kind <> 'QUOTE' AND OLD.status = 'ISSUED' AND NEW.status = 'VOID')) THEN
      RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = 'FN002';
    END IF;
    -- FD-L2: an issued invoice may be voided only while nothing is allocated to it and no live
    -- (non-void) credit note points at it. The CHECK finance_documents_void_unsettled backs the first.
    IF NEW.status = 'VOID' AND OLD.kind = 'INVOICE' THEN
      IF OLD.allocated_total <> 0 THEN
        RAISE EXCEPTION 'invoice has payment allocations' USING ERRCODE = 'FN007';
      END IF;
      IF EXISTS (SELECT 1 FROM public.finance_documents c
                 WHERE c.business_id = OLD.business_id AND c.credited_invoice_id = OLD.id AND c.status <> 'VOID') THEN
        RAISE EXCEPTION 'invoice has credit notes' USING ERRCODE = 'FN006';
      END IF;
    END IF;
  ELSIF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void documents are final' USING ERRCODE = 'FN001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_document BEFORE INSERT OR UPDATE ON "finance_documents" FOR EACH ROW EXECUTE FUNCTION finance_guard_document();

-- Lines may be written or deleted only while their document is a DRAFT. FOR SHARE on the document:
-- a line write that races an issue either commits first (and the issue, which locks the document and
-- then reads the lines, includes it) or waits and is then refused. Services lock the draft FOR NO KEY
-- UPDATE first (lock order: document, then lines), so this is a safety net, not the plan.
-- The tax name and percentage are the database's copy of the referenced rate (FD-T1).
CREATE FUNCTION finance_guard_line() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE b uuid; doc uuid; rate record;
BEGIN
  IF TG_OP = 'DELETE' THEN b := OLD.business_id; doc := OLD.document_id; ELSE b := NEW.business_id; doc := NEW.document_id; END IF;
  PERFORM 1 FROM public.finance_documents d WHERE d.business_id = b AND d.id = doc AND d.status = 'DRAFT' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lines of an issued document are immutable' USING ERRCODE = 'FN001'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.document_id IS DISTINCT FROM OLD.document_id OR NEW.business_id IS DISTINCT FROM OLD.business_id
                           OR NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'lines do not move between documents' USING ERRCODE = 'FN001';
  END IF;
  IF TG_OP = 'INSERT' THEN NEW.created_at := now(); END IF;
  IF NEW.tax_rate_id IS NULL THEN
    NEW.tax_name := NULL;
    NEW.tax_rate_percent := 0;
  ELSE
    SELECT r.name, r.rate_percent INTO rate FROM public.finance_tax_rates r WHERE r.business_id = NEW.business_id AND r.id = NEW.tax_rate_id;
    IF FOUND THEN
      NEW.tax_name := rate.name;
      NEW.tax_rate_percent := rate.rate_percent;
    END IF; -- otherwise the composite FK refuses the row
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_line BEFORE INSERT OR UPDATE OR DELETE ON "finance_document_lines" FOR EACH ROW EXECUTE FUNCTION finance_guard_line();

-- Numbering series (FD-L1). Created unused (next_value = starting_value). next_value then moves only
-- from the issue trigger, by exactly one. starting_value may change only while the series is unused
-- (no number has been committed: next_value = starting_value), and next_value follows it; once a
-- number has been issued it is fixed in both directions, so a series can never be reset or moved back.
CREATE FUNCTION finance_guard_number_series() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.next_value IS DISTINCT FROM NEW.starting_value THEN
      RAISE EXCEPTION 'a series starts unused at its starting value' USING ERRCODE = 'FN008';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION 'series identity is fixed' USING ERRCODE = 'FN001';
  END IF;
  IF NEW.next_value IS DISTINCT FROM OLD.next_value AND (pg_trigger_depth() < 2 OR NEW.next_value <> OLD.next_value + 1) THEN
    RAISE EXCEPTION 'numbers are assigned by the database' USING ERRCODE = 'FN008';
  END IF;
  IF NEW.starting_value IS DISTINCT FROM OLD.starting_value THEN
    IF OLD.next_value <> OLD.starting_value OR pg_trigger_depth() >= 2 THEN
      RAISE EXCEPTION 'the starting value is fixed once a number has been issued' USING ERRCODE = 'FN008';
    END IF;
    NEW.next_value := NEW.starting_value;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_number_series BEFORE INSERT OR UPDATE ON "finance_number_series" FOR EACH ROW EXECUTE FUNCTION finance_guard_number_series();

-- Payments (F2 services): amounts and parties are frozen; RECORDED -> REVERSED is the only transition.
CREATE FUNCTION finance_guard_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE mutable text[] := ARRAY['status', 'allocated_total', 'reversed_at', 'reversed_by_id', 'reversal_reason', 'reference', 'version', 'updated_at'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RECORDED' OR NEW.allocated_total <> 0 OR NEW.reversed_at IS NOT NULL OR NEW.reversed_by_id IS NOT NULL OR NEW.reversal_reason IS NOT NULL THEN
      RAISE EXCEPTION 'payments are created recorded and unallocated' USING ERRCODE = 'FN010';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  IF NEW.allocated_total IS DISTINCT FROM OLD.allocated_total AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'allocated_total is maintained by the database' USING ERRCODE = 'FN010';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'recorded payments are immutable' USING ERRCODE = 'FN001';
  END IF;
  -- Reversal metadata: reversed_at is stamped in the reversal; the reason and reverser are given only there.
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.reversed_at := now();
  ELSIF NEW.reversed_at IS DISTINCT FROM OLD.reversed_at OR NEW.reversal_reason IS DISTINCT FROM OLD.reversal_reason
        OR NEW.reversed_by_id IS DISTINCT FROM OLD.reversed_by_id THEN
    RAISE EXCEPTION 'reversal metadata belongs to the reversal' USING ERRCODE = 'FN010';
  END IF;
  IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'reversed payments are final' USING ERRCODE = 'FN001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_payment BEFORE INSERT OR UPDATE ON "finance_payments" FOR EACH ROW EXECUTE FUNCTION finance_guard_payment();

-- Allocations maintain both counters, payment first, then invoice (the global lock order). The CHECKs
-- on those counters make over-allocation and over-settlement impossible under any concurrency.
CREATE FUNCTION finance_apply_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE delta numeric; scale smallint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by_id IS NOT NULL THEN RAISE EXCEPTION 'allocations are created live' USING ERRCODE = 'FN010'; END IF;
    delta := NEW.amount;
  ELSE
    IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL THEN
      RAISE EXCEPTION 'allocation reversal is one way' USING ERRCODE = 'FN001';
    END IF;
    delta := -OLD.amount;
  END IF;
  UPDATE public.finance_payments p SET allocated_total = p.allocated_total + delta
   WHERE p.business_id = NEW.business_id AND p.id = NEW.payment_id AND (delta < 0 OR p.status = 'RECORDED')
   RETURNING p.currency_scale INTO scale;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment is not allocatable' USING ERRCODE = 'FN013'; END IF;
  IF NEW.amount <> round(NEW.amount, scale) THEN RAISE EXCEPTION 'amount exceeds the currency precision' USING ERRCODE = '23514'; END IF;
  UPDATE public.finance_documents d SET allocated_total = d.allocated_total + delta
   WHERE d.business_id = NEW.business_id AND d.id = NEW.invoice_id AND d.status = 'ISSUED';
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice is not open' USING ERRCODE = 'FN013'; END IF;
  RETURN NEW;
END $$;
-- Allocation times are the database's: created_at at insert, reversed_at at reversal (transaction time).
CREATE FUNCTION finance_stamp_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSIF OLD.reversed_at IS NULL AND NEW.reversed_at IS NOT NULL THEN
    NEW.reversed_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_stamp_allocation BEFORE INSERT OR UPDATE ON "finance_payment_allocations" FOR EACH ROW EXECUTE FUNCTION finance_stamp_allocation();
CREATE TRIGGER finance_apply_allocation_insert AFTER INSERT ON "finance_payment_allocations" FOR EACH ROW EXECUTE FUNCTION finance_apply_allocation();
CREATE TRIGGER finance_apply_allocation_reversal AFTER UPDATE ON "finance_payment_allocations" FOR EACH ROW EXECUTE FUNCTION finance_apply_allocation();

-- Expenses (F3 services): DRAFT is editable; recording snapshots the category name; RECORDED -> VOID.
CREATE FUNCTION finance_guard_expense() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE mutable text[] := ARRAY['status', 'voided_at', 'void_reason', 'version', 'updated_at', 'updated_by_id'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.recorded_at IS NOT NULL OR NEW.category_name IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
      RAISE EXCEPTION 'expenses are created as drafts' USING ERRCODE = 'FN010';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  NEW.updated_at := now();
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
    RAISE EXCEPTION 'expense identity is fixed' USING ERRCODE = 'FN001';
  END IF;
  -- Void metadata: voided_at is stamped by the database when voiding; the reason is given only there.
  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'VOID' THEN
    NEW.voided_at := now();
  ELSIF NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
    RAISE EXCEPTION 'void metadata belongs to the void transition' USING ERRCODE = 'FN010';
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'RECORDED' THEN
      SELECT c.name INTO NEW.category_name FROM public.finance_expense_categories c
       WHERE c.business_id = NEW.business_id AND c.id = NEW.category_id;
      NEW.recorded_at := now();
    ELSIF NEW.recorded_at IS NOT NULL OR NEW.category_name IS NOT NULL THEN -- a draft, or a discarded draft
      RAISE EXCEPTION 'drafts are unrecorded' USING ERRCODE = 'FN010';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'recorded expenses are immutable' USING ERRCODE = 'FN001';
  END IF;
  IF OLD.status = 'VOID' OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'VOID') THEN
    RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = 'FN002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_expense BEFORE INSERT OR UPDATE ON "finance_expenses" FOR EACH ROW EXECUTE FUNCTION finance_guard_expense();

-- Settings, tax rates and categories: database-owned timestamps.
CREATE FUNCTION finance_stamp_times() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSIF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at is fixed' USING ERRCODE = 'FN001';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER finance_stamp_times BEFORE INSERT OR UPDATE ON "finance_settings" FOR EACH ROW EXECUTE FUNCTION finance_stamp_times();
CREATE TRIGGER finance_stamp_times BEFORE INSERT OR UPDATE ON "finance_tax_rates" FOR EACH ROW EXECUTE FUNCTION finance_stamp_times();
CREATE TRIGGER finance_stamp_times BEFORE INSERT OR UPDATE ON "finance_expense_categories" FOR EACH ROW EXECUTE FUNCTION finance_stamp_times();

REVOKE ALL ON FUNCTION finance_guard_document(), finance_guard_line(), finance_guard_number_series(), finance_guard_payment(),
  finance_apply_allocation(), finance_stamp_allocation(), finance_guard_expense(), finance_stamp_times() FROM PUBLIC;
REVOKE ALL ON FUNCTION finance_document_content("finance_documents"), finance_content_hash("finance_documents") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION finance_document_content("finance_documents"), finance_content_hash("finance_documents") TO bos_app;

-- ---------------------------------------------------------------------------------------------
-- Least privilege for tenant code. bos_owner's default privileges are revoked first. No DELETE on any
-- finance table, except lines of a draft (guarded above): financial history is never deleted by tenant
-- code (FD-L3). Counters, numbers, hashes and rate percentages are held by column grants where
-- possible and by the guards otherwise. Other runtime roles get nothing.
REVOKE ALL ON "finance_settings", "finance_number_series", "finance_tax_rates", "finance_documents", "finance_document_lines",
  "finance_payments", "finance_payment_allocations", "finance_expense_categories", "finance_expenses" FROM bos_app;
GRANT SELECT, INSERT ON "finance_settings", "finance_number_series", "finance_tax_rates", "finance_payment_allocations" TO bos_app;
GRANT UPDATE ("seller_legal_name", "seller_address", "seller_email", "seller_phone", "seller_identifiers", "payment_instructions",
  "default_payment_terms_days", "default_quote_validity_days", "default_tax_rate_id", "retention_years", "legal_hold",
  "version", "updated_by_id", "updated_at") ON "finance_settings" TO bos_app;
-- Guarded: starting_value only while unused, next_value only by the issue trigger.
GRANT UPDATE ("prefix", "min_digits", "starting_value", "next_value", "version", "updated_by_id", "updated_at") ON "finance_number_series" TO bos_app;
-- A rate's percentage never changes (I18): only its name and archive state.
GRANT UPDATE ("name", "archived_at", "updated_by_id", "updated_at") ON "finance_tax_rates" TO bos_app;
GRANT UPDATE ("reversed_at", "reversed_by_id") ON "finance_payment_allocations" TO bos_app;
GRANT SELECT, INSERT, UPDATE ON "finance_documents", "finance_payments", "finance_expense_categories", "finance_expenses" TO bos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "finance_document_lines" TO bos_app;

-- Tenant policy template (data-model §5.2), forced so the table owner is subject to it too.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_settings', 'finance_number_series', 'finance_tax_rates', 'finance_documents', 'finance_document_lines',
      'finance_payments', 'finance_payment_allocations', 'finance_expense_categories', 'finance_expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO bos_app
      USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
      WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
