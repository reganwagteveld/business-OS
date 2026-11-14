-- CreateEnum
CREATE TYPE "FinancePaymentDirection" AS ENUM ('RECEIVED', 'PAID');
-- CreateEnum
CREATE TYPE "FinanceExpenseTaxTreatment" AS ENUM ('NO_TAX', 'TAX_EXCLUSIVE', 'TAX_INCLUSIVE');
-- AlterTable
ALTER TABLE "finance_expense_categories" ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "system_key" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
-- AlterTable
ALTER TABLE "finance_expenses" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "due_date" DATE,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "paid_total" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "recorded_by_id" UUID,
ADD COLUMN     "reference_number" TEXT,
ADD COLUMN     "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN     "tax_name" TEXT,
ADD COLUMN     "tax_rate_id" UUID,
ADD COLUMN     "tax_rate_percent" DECIMAL(7,4) NOT NULL DEFAULT 0,
ADD COLUMN     "tax_treatment" "FinanceExpenseTaxTreatment" NOT NULL DEFAULT 'NO_TAX',
ADD COLUMN     "voided_by_id" UUID;
-- AlterTable
ALTER TABLE "finance_payments" ADD COLUMN     "direction" "FinancePaymentDirection" NOT NULL DEFAULT 'RECEIVED',
ADD COLUMN     "payee_name" TEXT,
ALTER COLUMN "customer_id" DROP NOT NULL;
-- CreateTable
CREATE TABLE "finance_expense_allocations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "payment_direction" "FinancePaymentDirection" NOT NULL DEFAULT 'PAID',
    "expense_id" UUID NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "created_by_id" UUID,
    "reversed_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ,
    CONSTRAINT "finance_expense_allocations_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "finance_expense_receipts" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_status" TEXT NOT NULL DEFAULT 'PENDING',
    "storage_key" TEXT,
    "created_by_id" UUID,
    "removed_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,
    CONSTRAINT "finance_expense_receipts_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "finance_expense_allocations_business_id_payment_id_idx" ON "finance_expense_allocations"("business_id", "payment_id");
-- CreateIndex
CREATE INDEX "finance_expense_allocations_business_id_expense_id_idx" ON "finance_expense_allocations"("business_id", "expense_id");
-- CreateIndex
CREATE UNIQUE INDEX "finance_expense_allocations_business_id_id_key" ON "finance_expense_allocations"("business_id", "id");
-- CreateIndex
CREATE INDEX "finance_expense_receipts_business_id_expense_id_idx" ON "finance_expense_receipts"("business_id", "expense_id");
-- CreateIndex
CREATE UNIQUE INDEX "finance_expense_receipts_business_id_id_key" ON "finance_expense_receipts"("business_id", "id");
-- CreateIndex
CREATE INDEX "finance_expense_categories_business_id_archived_at_position_idx" ON "finance_expense_categories"("business_id", "archived_at", "position");
-- CreateIndex
CREATE UNIQUE INDEX "finance_expense_categories_business_id_system_key_key" ON "finance_expense_categories"("business_id", "system_key");
-- CreateIndex
CREATE INDEX "finance_expenses_business_id_customer_id_idx" ON "finance_expenses"("business_id", "customer_id");
-- CreateIndex
CREATE INDEX "finance_expenses_business_id_category_id_idx" ON "finance_expenses"("business_id", "category_id");
-- CreateIndex
CREATE INDEX "finance_expenses_business_id_status_due_date_idx" ON "finance_expenses"("business_id", "status", "due_date");
-- CreateIndex
CREATE UNIQUE INDEX "finance_expenses_link_key" ON "finance_expenses"("business_id", "id", "currency_code");
-- CreateIndex
CREATE UNIQUE INDEX "finance_payments_direction_link_key" ON "finance_payments"("business_id", "id", "direction", "currency_code");
-- AddForeignKey
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_customer_fkey" FOREIGN KEY ("business_id", "customer_id") REFERENCES "customers"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_tax_rate_fkey" FOREIGN KEY ("business_id", "tax_rate_id") REFERENCES "finance_tax_rates"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "finance_expense_allocations" ADD CONSTRAINT "finance_expense_allocations_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "finance_expense_allocations" ADD CONSTRAINT "finance_expense_allocations_payment_fkey" FOREIGN KEY ("business_id", "payment_id", "payment_direction", "currency_code") REFERENCES "finance_payments"("business_id", "id", "direction", "currency_code") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "finance_expense_allocations" ADD CONSTRAINT "finance_expense_allocations_expense_fkey" FOREIGN KEY ("business_id", "expense_id", "currency_code") REFERENCES "finance_expenses"("business_id", "id", "currency_code") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- AddForeignKey
ALTER TABLE "finance_expense_receipts" ADD CONSTRAINT "finance_expense_receipts_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "finance_expense_receipts" ADD CONSTRAINT "finance_expense_receipts_expense_fkey" FOREIGN KEY ("business_id", "expense_id") REFERENCES "finance_expenses"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- =============================================================================================
-- Hand-written part (Finance F3: expenses, categories, outgoing payments, receipt metadata;
-- docs/finance-data-model.md §19). Additive: two enum types, two tables, new columns, CHECKs and
-- indexes, one new trigger function, and replacements of finance_guard_expense (F1) and the
-- category grants. finance_payments gains a direction: existing rows are RECEIVED, and every F1/F2
-- rule on them is unchanged (customer_id stays required for RECEIVED by CHECK). No privileged SQL.
--
-- Precondition: finance_expenses holds no rows (no service wrote expenses before F3). The new
-- subtotal CHECK is validated against existing rows (constraint validation ignores RLS), so the
-- migration fails whole rather than mis-state an existing expense.
--
-- New error codes (class FN, continuing 20261116000000_finance_payments):
--   FN016 expense has payments (void refused while paid_total <> 0)
--   FN017 category archived (recording, or newly linking, an archived category)
--   FN018 expense not payable (allocation to an expense that is not RECORDED)
--   FN019 receipt metadata is fixed / removable only while the expense is a draft
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Payments: one ledger, two directions. RECEIVED rows are F2's (customer required, settle invoices
-- through finance_payment_allocations, whose FK carries customer_id, so a PAID row with no customer
-- can never be allocated to an invoice). PAID rows settle expenses through finance_expense_allocations.
ALTER TABLE "finance_payments"
  ADD CONSTRAINT finance_payments_direction_party CHECK (
    ("direction" = 'RECEIVED' AND "customer_id" IS NOT NULL AND "payee_name" IS NULL)
    OR ("direction" = 'PAID' AND "customer_id" IS NULL)),
  ADD CONSTRAINT finance_payments_payee_length CHECK ("payee_name" IS NULL OR char_length(btrim("payee_name")) BETWEEN 1 AND 200);

-- ---------------------------------------------------------------------------------------------
-- Categories. One active category per name (case-insensitive) per business; archived names may be
-- reused. Defaults carry a system_key so seeding is idempotent; it never changes (column grants).
ALTER TABLE "finance_expense_categories"
  ADD CONSTRAINT finance_expense_categories_position CHECK ("position" BETWEEN 0 AND 100000),
  ADD CONSTRAINT finance_expense_categories_system_key CHECK ("system_key" IS NULL OR "system_key" ~ '^[a-z][a-z0-9_]{0,39}$'),
  ADD CONSTRAINT finance_expense_categories_version_positive CHECK ("version" >= 1);
CREATE UNIQUE INDEX "finance_expense_categories_active_name_key" ON "finance_expense_categories" ("business_id", lower(btrim("name"))) WHERE "archived_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Expenses. Amounts: subtotal + tax = total, all at the currency's scale, tax as the treatment's
-- formula over the snapshotted rate (rounding half away from zero, PostgreSQL round(numeric, int)).
-- paid_total is maintained only by the expense-allocation triggers and never exceeds the total; only
-- a recorded expense holds payments, so a draft or a void one holds none.
ALTER TABLE "finance_expenses"
  ADD CONSTRAINT finance_expenses_subtotal CHECK (
    "subtotal" >= 0 AND "subtotal" = round("subtotal", "currency_scale") AND "subtotal" + "tax_amount" = "amount"),
  ADD CONSTRAINT finance_expenses_tax_treatment CHECK (
    ("tax_treatment" = 'NO_TAX' AND "tax_rate_id" IS NULL AND "tax_amount" = 0)
    OR ("tax_treatment" = 'TAX_EXCLUSIVE' AND "tax_rate_id" IS NOT NULL
        AND "tax_amount" = round("subtotal" * "tax_rate_percent" / 100, "currency_scale"))
    OR ("tax_treatment" = 'TAX_INCLUSIVE' AND "tax_rate_id" IS NOT NULL
        AND "tax_amount" = round("amount" * "tax_rate_percent" / (100 + "tax_rate_percent"), "currency_scale"))),
  ADD CONSTRAINT finance_expenses_tax_snapshot CHECK (
    ("tax_rate_id" IS NULL AND "tax_name" IS NULL AND "tax_rate_percent" = 0)
    OR ("tax_rate_id" IS NOT NULL AND "tax_name" IS NOT NULL AND "tax_rate_percent" BETWEEN 0 AND 100)),
  ADD CONSTRAINT finance_expenses_paid CHECK (
    "paid_total" >= 0 AND "paid_total" <= "amount" AND "paid_total" = round("paid_total", "currency_scale")
    AND ("status" = 'RECORDED' OR "paid_total" = 0)),
  ADD CONSTRAINT finance_expenses_dates CHECK ("due_date" IS NULL OR "due_date" >= "incurred_on"),
  ADD CONSTRAINT finance_expenses_reference_length CHECK ("reference_number" IS NULL OR char_length("reference_number") BETWEEN 1 AND 100),
  ADD CONSTRAINT finance_expenses_notes_length CHECK ("notes" IS NULL OR char_length("notes") <= 5000),
  ADD CONSTRAINT finance_expenses_recorded_by CHECK ("recorded_by_id" IS NULL OR "status" <> 'DRAFT'),
  ADD CONSTRAINT finance_expenses_voided_by CHECK ("voided_by_id" IS NULL OR "status" = 'VOID');

-- Payables and lists read recorded expenses by state and due date.
CREATE INDEX "finance_expenses_business_id_open_idx" ON "finance_expenses" ("business_id", "currency_code", "due_date") WHERE "status" = 'RECORDED';

-- ---------------------------------------------------------------------------------------------
-- Expense allocations: PAID payment -> RECORDED expense, same business and currency (composite FKs),
-- direction pinned to PAID. One live allocation per pair. Never edited or deleted.
ALTER TABLE "finance_expense_allocations"
  ADD CONSTRAINT finance_expense_allocations_amount CHECK ("amount" > 0),
  ADD CONSTRAINT finance_expense_allocations_direction CHECK ("payment_direction" = 'PAID'),
  ADD CONSTRAINT finance_expense_allocations_currency_format CHECK ("currency_code" ~ '^[A-Z]{3}$');
CREATE UNIQUE INDEX "finance_expense_allocations_active_key" ON "finance_expense_allocations" ("business_id", "payment_id", "expense_id") WHERE "reversed_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Receipt metadata. No URL, no path: a declared name, an allow-listed type, a bounded size and the
-- SHA-256 of the bytes. STORED rows (a later PR) carry an opaque provider key.
ALTER TABLE "finance_expense_receipts"
  ADD CONSTRAINT finance_expense_receipts_file_name CHECK (
    char_length(btrim("file_name")) BETWEEN 1 AND 200 AND "file_name" !~ '[/\\]' AND "file_name" !~ '[[:cntrl:]]' AND "file_name" NOT IN ('.', '..')),
  ADD CONSTRAINT finance_expense_receipts_content_type CHECK ("content_type" IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  ADD CONSTRAINT finance_expense_receipts_size CHECK ("size_bytes" BETWEEN 1 AND 10485760),
  ADD CONSTRAINT finance_expense_receipts_sha256 CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT finance_expense_receipts_storage CHECK (
    ("storage_status" = 'PENDING' AND "storage_key" IS NULL) OR ("storage_status" = 'STORED' AND char_length("storage_key") BETWEEN 1 AND 500)),
  ADD CONSTRAINT finance_expense_receipts_removed CHECK (("removed_at" IS NULL) = ("removed_by_id" IS NULL));
CREATE UNIQUE INDEX "finance_expense_receipts_active_hash_key" ON "finance_expense_receipts" ("business_id", "expense_id", "sha256") WHERE "removed_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Expense guard, replaced. F1's rules are kept (created as drafts, identity fixed, DRAFT editable,
-- category name snapshotted at record, RECORDED immutable except voiding, VOID final, void metadata
-- only in the void transition). F3 adds: the tax-rate snapshot (as finance_guard_line does), the
-- paid_total counter (database-owned, mutable after recording only through its trigger), the
-- recorder and voider (only in their transitions), FN016 (no void while paid) and FN017 (no
-- recording into an archived category).
CREATE OR REPLACE FUNCTION finance_guard_expense() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  mutable text[] := ARRAY['status', 'paid_total', 'voided_at', 'voided_by_id', 'void_reason', 'version', 'updated_at', 'updated_by_id'];
  rate record;
  cat record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.recorded_at IS NOT NULL OR NEW.category_name IS NOT NULL OR NEW.voided_at IS NOT NULL OR NEW.void_reason IS NOT NULL
       OR NEW.paid_total <> 0 OR NEW.recorded_by_id IS NOT NULL OR NEW.voided_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'expenses are created as drafts' USING ERRCODE = 'FN010';
    END IF;
    NEW.created_at := date_trunc('milliseconds', now());
    NEW.updated_at := now();
  ELSE
    NEW.updated_at := now();
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.business_id IS DISTINCT FROM OLD.business_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_id IS DISTINCT FROM OLD.created_by_id THEN
      RAISE EXCEPTION 'expense identity is fixed' USING ERRCODE = 'FN001';
    END IF;
    -- The payment counter belongs to the expense-allocation triggers (one trigger level deeper).
    IF NEW.paid_total IS DISTINCT FROM OLD.paid_total AND pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'paid_total is maintained by the database' USING ERRCODE = 'FN010';
    END IF;
    -- Void metadata: stamped by the database when voiding; the reason and voider are given only there.
    IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'VOID' THEN
      NEW.voided_at := now();
    ELSIF NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason
          OR NEW.voided_by_id IS DISTINCT FROM OLD.voided_by_id THEN
      RAISE EXCEPTION 'void metadata belongs to the void transition' USING ERRCODE = 'FN010';
    END IF;
    IF NEW.recorded_by_id IS DISTINCT FROM OLD.recorded_by_id AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'RECORDED') THEN
      RAISE EXCEPTION 'the recorder is set only when recording' USING ERRCODE = 'FN010';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' OR OLD.status = 'DRAFT' THEN
    -- Draft writes (and the record transition itself): the tax snapshot is the database's copy of the
    -- referenced rate, so a client cannot state a percentage the rate does not have.
    IF NEW.tax_rate_id IS NULL THEN
      NEW.tax_name := NULL;
      NEW.tax_rate_percent := 0;
    ELSE
      SELECT r.name, r.rate_percent INTO rate FROM public.finance_tax_rates r WHERE r.business_id = NEW.business_id AND r.id = NEW.tax_rate_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'tax rate not found' USING ERRCODE = '23503'; END IF;
      NEW.tax_name := rate.name;
      NEW.tax_rate_percent := rate.rate_percent;
    END IF;
    IF TG_OP = 'INSERT' THEN RETURN NEW; END IF;
    IF NEW.status = 'RECORDED' THEN
      SELECT c.name, c.archived_at INTO cat FROM public.finance_expense_categories c
       WHERE c.business_id = NEW.business_id AND c.id = NEW.category_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'category not found' USING ERRCODE = '23503'; END IF;
      IF cat.archived_at IS NOT NULL THEN RAISE EXCEPTION 'category is archived' USING ERRCODE = 'FN017'; END IF;
      NEW.category_name := cat.name;
      NEW.recorded_at := now();
    ELSIF NEW.status IN ('DRAFT', 'VOID') THEN -- a draft, or a discarded draft
      IF NEW.recorded_at IS NOT NULL OR NEW.category_name IS NOT NULL THEN
        RAISE EXCEPTION 'drafts are unrecorded' USING ERRCODE = 'FN010';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'recorded expenses are immutable' USING ERRCODE = 'FN001';
  END IF;
  IF OLD.status = 'VOID' OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'VOID') THEN
    RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = 'FN002';
  END IF;
  -- An expense with live payments cannot be voided: its allocations are reversed first (kept as
  -- history). The CHECK finance_expenses_paid backs this.
  IF NEW.status = 'VOID' AND OLD.paid_total <> 0 THEN
    RAISE EXCEPTION 'expense has payments' USING ERRCODE = 'FN016';
  END IF;
  RETURN NEW;
END $$;

-- Expense allocations maintain both counters, payment first, then expense (the global lock order:
-- payments, then expenses). The CHECKs make over-allocation and over-payment impossible under any
-- concurrency, exactly as finance_apply_allocation does for invoices.
CREATE FUNCTION finance_apply_expense_allocation() RETURNS trigger
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
   WHERE p.business_id = NEW.business_id AND p.id = NEW.payment_id AND p.direction = 'PAID' AND (delta < 0 OR p.status = 'RECORDED')
   RETURNING p.currency_scale INTO scale;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment is not allocatable' USING ERRCODE = 'FN013'; END IF;
  IF NEW.amount <> round(NEW.amount, scale) THEN RAISE EXCEPTION 'amount exceeds the currency precision' USING ERRCODE = '23514'; END IF;
  UPDATE public.finance_expenses e SET paid_total = e.paid_total + delta
   WHERE e.business_id = NEW.business_id AND e.id = NEW.expense_id AND e.status = 'RECORDED';
  IF NOT FOUND THEN RAISE EXCEPTION 'expense is not payable' USING ERRCODE = 'FN018'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER finance_stamp_allocation BEFORE INSERT OR UPDATE ON "finance_expense_allocations" FOR EACH ROW EXECUTE FUNCTION finance_stamp_allocation();
CREATE TRIGGER finance_apply_expense_allocation_insert AFTER INSERT ON "finance_expense_allocations" FOR EACH ROW EXECUTE FUNCTION finance_apply_expense_allocation();
CREATE TRIGGER finance_apply_expense_allocation_reversal AFTER UPDATE ON "finance_expense_allocations" FOR EACH ROW EXECUTE FUNCTION finance_apply_expense_allocation();

-- Receipt metadata: created_at stamped; nothing but the one-way removal may change, and only while the
-- expense is a draft (FOR SHARE on the expense, as line writes take their document).
CREATE FUNCTION finance_guard_expense_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.removed_at IS NOT NULL OR NEW.removed_by_id IS NOT NULL THEN RAISE EXCEPTION 'receipts are created present' USING ERRCODE = 'FN010'; END IF;
    PERFORM 1 FROM public.finance_expenses e WHERE e.business_id = NEW.business_id AND e.id = NEW.expense_id AND e.status <> 'VOID' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'expense is void' USING ERRCODE = 'FN019'; END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - ARRAY['removed_at', 'removed_by_id']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['removed_at', 'removed_by_id'])
     OR OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL THEN
    RAISE EXCEPTION 'receipt metadata is fixed' USING ERRCODE = 'FN019';
  END IF;
  PERFORM 1 FROM public.finance_expenses e WHERE e.business_id = NEW.business_id AND e.id = NEW.expense_id AND e.status = 'DRAFT' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'receipts of a recorded expense are kept' USING ERRCODE = 'FN019'; END IF;
  NEW.removed_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER finance_guard_expense_receipt BEFORE INSERT OR UPDATE ON "finance_expense_receipts" FOR EACH ROW EXECUTE FUNCTION finance_guard_expense_receipt();

REVOKE ALL ON FUNCTION finance_apply_expense_allocation(), finance_guard_expense_receipt() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Least privilege. Categories: identity and system_key are fixed (column grants replace F1's table
-- UPDATE). New tables: no DELETE, one-way columns only.
REVOKE UPDATE ON "finance_expense_categories" FROM bos_app;
GRANT UPDATE ("name", "position", "archived_at", "version", "updated_by_id", "updated_at") ON "finance_expense_categories" TO bos_app;
REVOKE ALL ON "finance_expense_allocations", "finance_expense_receipts" FROM bos_app;
GRANT SELECT, INSERT ON "finance_expense_allocations", "finance_expense_receipts" TO bos_app;
GRANT UPDATE ("reversed_at", "reversed_by_id") ON "finance_expense_allocations" TO bos_app;
GRANT UPDATE ("removed_at", "removed_by_id") ON "finance_expense_receipts" TO bos_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['finance_expense_allocations', 'finance_expense_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO bos_app
      USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
      WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
