-- AlterTable
ALTER TABLE "finance_documents" ADD COLUMN     "credit_applied_total" DECIMAL(18,4) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "finance_credit_applications" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "credit_note_id" UUID NOT NULL,
    "credit_note_kind" "FinanceDocumentKind" NOT NULL DEFAULT 'CREDIT_NOTE',
    "invoice_id" UUID NOT NULL,
    "invoice_kind" "FinanceDocumentKind" NOT NULL DEFAULT 'INVOICE',
    "customer_id" UUID NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "created_by_id" UUID,
    "reversed_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ,

    CONSTRAINT "finance_credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_credit_applications_business_id_invoice_id_idx" ON "finance_credit_applications"("business_id", "invoice_id");

-- CreateIndex
CREATE INDEX "finance_credit_applications_business_id_credit_note_id_idx" ON "finance_credit_applications"("business_id", "credit_note_id");

-- CreateIndex
CREATE UNIQUE INDEX "finance_credit_applications_business_id_id_key" ON "finance_credit_applications"("business_id", "id");

-- AddForeignKey
ALTER TABLE "finance_credit_applications" ADD CONSTRAINT "finance_credit_applications_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_credit_applications" ADD CONSTRAINT "finance_credit_applications_credit_note_fkey" FOREIGN KEY ("business_id", "credit_note_id", "credit_note_kind", "currency_code", "customer_id") REFERENCES "finance_documents"("business_id", "id", "kind", "currency_code", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "finance_credit_applications" ADD CONSTRAINT "finance_credit_applications_invoice_fkey" FOREIGN KEY ("business_id", "invoice_id", "invoice_kind", "currency_code", "customer_id") REFERENCES "finance_documents"("business_id", "id", "kind", "currency_code", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;





-- =============================================================================================
-- Hand-written part (Finance F2: payments, allocations, credit applications, reconciliation;
-- docs/finance-data-model.md §18). Additive: one new table, one new database-owned counter column,
-- new CHECKs, two new trigger functions, and a replacement of finance_guard_document whose only
-- changes are the new counter (frozen for clients, mutable for its trigger) and the void rule for
-- documents with credit applications. No existing row, column or constraint changes meaning.
--
-- New error codes (class FN, continuing 20261115000000_finance):
--   FN014 document has credit applications (void refused)
--   FN015 not applicable (credit note or invoice state for a credit application)
-- =============================================================================================

-- ---------------------------------------------------------------------------------------------
-- Settlement. An invoice is settled by payment allocations (allocated_total) and credit applications
-- (credit_applied_total) together, never above its total. A credit note's credit_applied_total is
-- the part of it applied to invoices, never above its own total. Quotes hold neither. A void
-- document holds no applied credit (as it holds no allocations).
ALTER TABLE "finance_documents"
  ADD CONSTRAINT finance_documents_credit_applied CHECK (
    "credit_applied_total" >= 0 AND "credit_applied_total" = round("credit_applied_total", "currency_scale")
    AND ("kind" <> 'QUOTE' OR "credit_applied_total" = 0)
    AND ("kind" <> 'CREDIT_NOTE' OR "credit_applied_total" <= "total")),
  ADD CONSTRAINT finance_documents_settled CHECK ("kind" <> 'INVOICE' OR "allocated_total" + "credit_applied_total" <= "total"),
  ADD CONSTRAINT finance_documents_void_unapplied CHECK ("status" <> 'VOID' OR "credit_applied_total" = 0);

-- A payment reversal always says why (F2 brief D). The reason is still accepted only in the reversal
-- (finance_guard_payment) and fixed afterwards.
ALTER TABLE "finance_payments"
  ADD CONSTRAINT finance_payments_reversal_reason_required CHECK ("status" <> 'REVERSED' OR char_length(btrim(coalesce("reversal_reason", ''))) >= 1);

ALTER TABLE "finance_credit_applications"
  ADD CONSTRAINT finance_credit_applications_amount CHECK ("amount" > 0),
  ADD CONSTRAINT finance_credit_applications_credit_note_kind CHECK ("credit_note_kind" = 'CREDIT_NOTE'),
  ADD CONSTRAINT finance_credit_applications_invoice_kind CHECK ("invoice_kind" = 'INVOICE'),
  ADD CONSTRAINT finance_credit_applications_currency_format CHECK ("currency_code" ~ '^[A-Z]{3}$');

-- One live application per credit note and invoice: a double submission is refused (23505).
CREATE UNIQUE INDEX "finance_credit_applications_active_key" ON "finance_credit_applications" ("business_id", "credit_note_id", "invoice_id") WHERE "reversed_at" IS NULL;
-- Reporting and reconciliation read payments and allocations by state.
CREATE INDEX "finance_payments_business_id_status_customer_idx" ON "finance_payments" ("business_id", "customer_id", "currency_code") WHERE "status" = 'RECORDED';

-- ---------------------------------------------------------------------------------------------
-- Documents guard, replaced (F1's function plus the credit-application counter and void rule).
CREATE OR REPLACE FUNCTION finance_guard_document() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  -- Columns that may change after a document leaves DRAFT. Everything else is frozen; a column added
  -- later is frozen too unless it is listed here (a reviewed migration).
  mutable_after_issue text[] := ARRAY['status', 'allocated_total', 'credit_applied_total', 'status_changed_at', 'status_changed_by_id', 'voided_at', 'voided_by_id',
                                      'void_reason', 'version', 'updated_at', 'updated_by_id'];
  sums record;
  series record;
  inv record;
  credited numeric;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.allocated_total <> 0 OR NEW.credit_applied_total <> 0 OR NEW.number_value IS NOT NULL OR NEW.number IS NOT NULL
       OR NEW.content_sha256 IS NOT NULL OR NEW.issued_at IS NOT NULL OR NEW.issued_by_id IS NOT NULL
       OR NEW.status_changed_at IS NOT NULL OR NEW.status_changed_by_id IS NOT NULL
       OR NEW.voided_at IS NOT NULL OR NEW.voided_by_id IS NOT NULL OR NEW.void_reason IS NOT NULL THEN
      RAISE EXCEPTION 'documents are created as unnumbered drafts' USING ERRCODE = 'FN010';
    END IF;
    -- Millisecond precision, so the (created_at, id) list cursor round-trips exactly through JavaScript.
    NEW.created_at := date_trunc('milliseconds', now());
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
  -- F2: so is the credit-application counter (finance_apply_credit_application, one level deeper).
  IF NEW.credit_applied_total IS DISTINCT FROM OLD.credit_applied_total AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'credit_applied_total is maintained by the database' USING ERRCODE = 'FN010';
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
    -- F2: an invoice that received credit, or a credit note whose credit is applied, cannot be voided
    -- until those applications are reversed. The CHECK finance_documents_void_unapplied backs this.
    IF NEW.status = 'VOID' AND OLD.credit_applied_total <> 0 THEN
      RAISE EXCEPTION 'document has credit applications' USING ERRCODE = 'FN014';
    END IF;
  ELSIF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void documents are final' USING ERRCODE = 'FN001';
  END IF;
  RETURN NEW;
END $$;
-- (The trigger finance_guard_document from 20261115000000_finance keeps calling this function.)

-- ---------------------------------------------------------------------------------------------
-- Credit applications maintain both documents' credit_applied_total. Lock order: documents by id
-- (ADR 0007 §3; services lock both FOR NO KEY UPDATE first), so the two counter updates run in id
-- order here too. An application needs an ISSUED credit note and an ISSUED invoice; its reversal
-- only needs them to exist (a document with applied credit cannot be voided, CHECK above). The
-- CHECKs on the counters make over-application impossible under any concurrency.
CREATE FUNCTION finance_apply_credit_application() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE delta numeric; scale smallint; first_id uuid; second_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL OR NEW.reversed_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'credit applications are created live' USING ERRCODE = 'FN010';
    END IF;
    delta := NEW.amount;
  ELSE
    IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL THEN
      RAISE EXCEPTION 'credit application reversal is one way' USING ERRCODE = 'FN001';
    END IF;
    delta := -OLD.amount;
  END IF;
  IF NEW.credit_note_id < NEW.invoice_id THEN first_id := NEW.credit_note_id; second_id := NEW.invoice_id;
  ELSE first_id := NEW.invoice_id; second_id := NEW.credit_note_id; END IF;
  UPDATE public.finance_documents d SET credit_applied_total = d.credit_applied_total + delta
   WHERE d.business_id = NEW.business_id AND d.id = first_id AND (delta < 0 OR d.status = 'ISSUED')
   RETURNING d.currency_scale INTO scale;
  IF NOT FOUND THEN RAISE EXCEPTION 'document is not open for credit' USING ERRCODE = 'FN015'; END IF;
  UPDATE public.finance_documents d SET credit_applied_total = d.credit_applied_total + delta
   WHERE d.business_id = NEW.business_id AND d.id = second_id AND (delta < 0 OR d.status = 'ISSUED');
  IF NOT FOUND THEN RAISE EXCEPTION 'document is not open for credit' USING ERRCODE = 'FN015'; END IF;
  IF NEW.amount <> round(NEW.amount, scale) THEN RAISE EXCEPTION 'amount exceeds the currency precision' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
-- Times are the database's: created_at at insert, reversed_at at reversal (finance_stamp_allocation
-- works on any table with those two columns).
CREATE TRIGGER finance_stamp_credit_application BEFORE INSERT OR UPDATE ON "finance_credit_applications" FOR EACH ROW EXECUTE FUNCTION finance_stamp_allocation();
CREATE TRIGGER finance_apply_credit_application_insert AFTER INSERT ON "finance_credit_applications" FOR EACH ROW EXECUTE FUNCTION finance_apply_credit_application();
CREATE TRIGGER finance_apply_credit_application_reversal AFTER UPDATE ON "finance_credit_applications" FOR EACH ROW EXECUTE FUNCTION finance_apply_credit_application();

REVOKE ALL ON FUNCTION finance_guard_document(), finance_apply_credit_application() FROM PUBLIC;

-- ---------------------------------------------------------------------------------------------
-- Least privilege: insert and one-way reversal only; never edited or deleted. Forced RLS.
REVOKE ALL ON "finance_credit_applications" FROM bos_app;
GRANT SELECT, INSERT ON "finance_credit_applications" TO bos_app;
GRANT UPDATE ("reversed_at", "reversed_by_id") ON "finance_credit_applications" TO bos_app;
-- finance_documents keeps F1's grants: credit_applied_total, like allocated_total, is refused to
-- direct writes by the guard (FN010), because bos_app needs UPDATE on documents for drafts.

-- Tenant policy template (data-model §5.2), forced so the table owner is subject to it too.
ALTER TABLE "finance_credit_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "finance_credit_applications" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "finance_credit_applications" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);
