-- Finance F0 spike fixture (docs/finance-data-model.md, ADR 0007). Applied by
-- tests/isolation/finance-spike.test.ts as an ADMINISTRATIVE role to the spike database. It is NOT an
-- application migration. It proves the shape F1 must migrate: tables, composite keys, CHECKs, grants,
-- policies and guard triggers. F1 re-derives the migration from docs/finance-data-model.md and moves
-- this suite to the real tables; anything this fixture leaves out (authorship columns, indexes for
-- lists, audit wiring) is specified in the document, not here.
--
-- Everything lives in its own schema (finance_spike), so this fixture never touches the Phase 1b
-- fixture (public) or the scheduling fixture (scheduling_spike*). The tenancy, customer, sales and
-- project tables are cut down to the columns Finance depends on, with the production names, composite
-- keys and the standard tenant policy. No extension and no SECURITY DEFINER function is needed, so F1
-- needs no privileged SQL step.

DROP SCHEMA IF EXISTS finance_spike CASCADE;
CREATE SCHEMA finance_spike AUTHORIZATION bos_owner;
REVOKE ALL ON SCHEMA finance_spike FROM PUBLIC;
GRANT USAGE ON SCHEMA finance_spike TO bos_app;

SET ROLE bos_owner;
SET search_path = finance_spike;

-- ---------------------------------------------------------------------------------------------
-- Dependencies (cut down)
CREATE TABLE businesses (
  id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, legal_name text NOT NULL,
  currency char(3) NOT NULL, time_zone text NOT NULL DEFAULT 'UTC');
CREATE TABLE memberships (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, user_id uuid NOT NULL,
  CONSTRAINT memberships_business_id_user_id_key UNIQUE (business_id, user_id));
CREATE TABLE customers (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  display_name text NOT NULL, billing_address text, tax_id text,
  CONSTRAINT customers_business_id_id_key UNIQUE (business_id, id));
CREATE TABLE contacts (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, customer_id uuid,
  display_name text NOT NULL,
  CONSTRAINT contacts_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT contacts_customer_fkey FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id));
CREATE TABLE opportunities (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, customer_id uuid NOT NULL,
  title text NOT NULL,
  CONSTRAINT opportunities_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT opportunities_customer_fkey FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id));
CREATE TABLE projects (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, name text NOT NULL,
  CONSTRAINT projects_business_id_id_key UNIQUE (business_id, id));

-- ---------------------------------------------------------------------------------------------
-- Finance
CREATE TYPE "FinanceDocumentKind" AS ENUM ('QUOTE', 'INVOICE', 'CREDIT_NOTE');
CREATE TYPE "FinanceDocumentStatus" AS ENUM ('DRAFT', 'ISSUED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID');
CREATE TYPE "FinancePaymentStatus" AS ENUM ('RECORDED', 'REVERSED');
CREATE TYPE "FinancePaymentMethod" AS ENUM ('BANK_TRANSFER', 'CASH', 'CARD', 'CHEQUE', 'OTHER');
CREATE TYPE "FinanceExpenseStatus" AS ENUM ('DRAFT', 'RECORDED', 'VOID');

-- One numbering series per business and document kind. next_value only ever moves by +1, and only
-- from the issue trigger (guard_number_series), so numbers are assigned by the database, never by a
-- client, and are gapless across committed transactions (a rolled-back issue returns its number).
CREATE TABLE finance_number_series (
  id          uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  kind        "FinanceDocumentKind" NOT NULL,
  prefix      text NOT NULL DEFAULT '',
  min_digits  smallint NOT NULL DEFAULT 4,
  next_value  bigint NOT NULL DEFAULT 1,
  CONSTRAINT finance_number_series_prefix_length CHECK (char_length(prefix) <= 20),
  CONSTRAINT finance_number_series_min_digits CHECK (min_digits BETWEEN 1 AND 12),
  CONSTRAINT finance_number_series_next_value CHECK (next_value >= 1),
  CONSTRAINT finance_number_series_business_id_kind_key UNIQUE (business_id, kind),
  CONSTRAINT finance_number_series_business_id_id_key UNIQUE (business_id, id)
);

-- Tax rates are referenced for convenience only. A line snapshots the name and percentage it used, so
-- the rate can be renamed or archived, and its percentage is never writable after creation (grants).
CREATE TABLE finance_tax_rates (
  id           uuid PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  name         text NOT NULL,
  rate_percent numeric(7,4) NOT NULL,
  archived_at  timestamptz,
  CONSTRAINT finance_tax_rates_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT finance_tax_rates_rate CHECK (rate_percent >= 0 AND rate_percent <= 100),
  CONSTRAINT finance_tax_rates_business_id_id_key UNIQUE (business_id, id)
);

-- Quotes, invoices and credit notes share one table: one numbering, snapshot, sealing and
-- immutability mechanism. Kind-specific links use composite FKs that include the target's kind.
CREATE TABLE finance_documents (
  id                    uuid PRIMARY KEY,
  business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  kind                  "FinanceDocumentKind" NOT NULL,
  status                "FinanceDocumentStatus" NOT NULL DEFAULT 'DRAFT',
  customer_id           uuid NOT NULL,
  contact_id            uuid,
  opportunity_id        uuid,
  project_id            uuid,
  -- Invoice created from a quote (kind fixed to QUOTE by CHECK and FK).
  source_quote_id       uuid,
  source_quote_kind     "FinanceDocumentKind" NOT NULL DEFAULT 'QUOTE',
  -- Credit note for an invoice: same customer and currency, enforced by the FK.
  credited_invoice_id   uuid,
  credited_invoice_kind "FinanceDocumentKind" NOT NULL DEFAULT 'INVOICE',
  currency_code         char(3) NOT NULL,
  currency_scale        smallint NOT NULL,
  issue_date            date,
  due_date              date,
  valid_until           date,
  number_value          bigint,
  number                text,
  seller_snapshot       jsonb,
  bill_to_snapshot      jsonb,
  subtotal              numeric(18,4) NOT NULL DEFAULT 0,
  tax_total             numeric(18,4) NOT NULL DEFAULT 0,
  total                 numeric(18,4) NOT NULL DEFAULT 0,
  allocated_total       numeric(18,4) NOT NULL DEFAULT 0,
  content_sha256        text,
  notes                 text,
  issued_at             timestamptz,
  status_changed_at     timestamptz,
  voided_at             timestamptz,
  void_reason           text,
  version               integer NOT NULL DEFAULT 1,
  CONSTRAINT finance_documents_currency_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT finance_documents_currency_scale CHECK (currency_scale BETWEEN 0 AND 4),
  CONSTRAINT finance_documents_status_for_kind CHECK (kind = 'QUOTE' OR status IN ('DRAFT', 'ISSUED', 'VOID')),
  CONSTRAINT finance_documents_quote_link CHECK (source_quote_id IS NULL OR kind = 'INVOICE'),
  CONSTRAINT finance_documents_source_quote_kind CHECK (source_quote_kind = 'QUOTE'),
  CONSTRAINT finance_documents_credit_link CHECK ((kind = 'CREDIT_NOTE') = (credited_invoice_id IS NOT NULL)),
  CONSTRAINT finance_documents_credited_kind CHECK (credited_invoice_kind = 'INVOICE'),
  CONSTRAINT finance_documents_amounts CHECK (subtotal >= 0 AND tax_total >= 0 AND total = subtotal + tax_total),
  CONSTRAINT finance_documents_amount_scale CHECK (
    subtotal = round(subtotal, currency_scale) AND tax_total = round(tax_total, currency_scale) AND total = round(total, currency_scale)),
  -- The settlement counter: maintained only by the allocation triggers, never above the total.
  CONSTRAINT finance_documents_allocated CHECK (allocated_total >= 0 AND allocated_total <= total AND (kind = 'INVOICE' OR allocated_total = 0)),
  CONSTRAINT finance_documents_void_unsettled CHECK (status <> 'VOID' OR allocated_total = 0),
  CONSTRAINT finance_documents_void_fields CHECK ((status = 'VOID') = (voided_at IS NOT NULL)),
  CONSTRAINT finance_documents_draft_unnumbered CHECK (status <> 'DRAFT' OR (number_value IS NULL AND issued_at IS NULL)),
  CONSTRAINT finance_documents_numbered_together CHECK ((number_value IS NULL) = (number IS NULL) AND (number_value IS NULL) = (issued_at IS NULL)),
  CONSTRAINT finance_documents_issued_sealed CHECK (
    status IN ('DRAFT', 'VOID')
    OR (number_value IS NOT NULL AND issue_date IS NOT NULL AND seller_snapshot IS NOT NULL AND bill_to_snapshot IS NOT NULL AND content_sha256 IS NOT NULL)),
  CONSTRAINT finance_documents_invoice_due CHECK (due_date IS NULL OR issue_date IS NULL OR due_date >= issue_date),
  CONSTRAINT finance_documents_notes_length CHECK (notes IS NULL OR char_length(notes) <= 5000),
  CONSTRAINT finance_documents_void_reason_length CHECK (void_reason IS NULL OR char_length(void_reason) <= 500),
  CONSTRAINT finance_documents_business_id_id_key UNIQUE (business_id, id),
  -- Target of kind-, customer- and currency-constrained composite FKs (allocations, credit notes, conversions).
  CONSTRAINT finance_documents_link_key UNIQUE (business_id, id, kind, currency_code, customer_id),
  CONSTRAINT finance_documents_kind_key UNIQUE (business_id, id, kind),
  -- Backstop for the database-assigned numbers.
  CONSTRAINT finance_documents_number_value_key UNIQUE (business_id, kind, number_value),
  CONSTRAINT finance_documents_number_key UNIQUE (business_id, kind, number),
  CONSTRAINT finance_documents_customer_fkey FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  CONSTRAINT finance_documents_contact_fkey FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id),
  CONSTRAINT finance_documents_opportunity_fkey FOREIGN KEY (business_id, opportunity_id) REFERENCES opportunities(business_id, id),
  CONSTRAINT finance_documents_project_fkey FOREIGN KEY (business_id, project_id) REFERENCES projects(business_id, id),
  CONSTRAINT finance_documents_source_quote_fkey FOREIGN KEY (business_id, source_quote_id, source_quote_kind)
    REFERENCES finance_documents(business_id, id, kind),
  CONSTRAINT finance_documents_credited_invoice_fkey FOREIGN KEY (business_id, credited_invoice_id, credited_invoice_kind, currency_code, customer_id)
    REFERENCES finance_documents(business_id, id, kind, currency_code, customer_id)
);
CREATE INDEX finance_documents_business_id_kind_status_idx ON finance_documents (business_id, kind, status);
CREATE INDEX finance_documents_business_id_customer_id_idx ON finance_documents (business_id, customer_id);
CREATE INDEX finance_documents_business_id_project_id_idx ON finance_documents (business_id, project_id);
CREATE INDEX finance_documents_credited_invoice_idx ON finance_documents (business_id, credited_invoice_id) WHERE credited_invoice_id IS NOT NULL;

CREATE TABLE finance_document_lines (
  id               uuid PRIMARY KEY,
  business_id      uuid NOT NULL,
  document_id      uuid NOT NULL,
  position         integer NOT NULL,
  description      text NOT NULL,
  quantity         numeric(18,6) NOT NULL,
  unit_price       numeric(18,6) NOT NULL,
  discount_amount  numeric(18,4) NOT NULL DEFAULT 0,
  tax_rate_id      uuid,
  tax_name         text,
  tax_rate_percent numeric(7,4) NOT NULL DEFAULT 0,
  line_net         numeric(18,4) NOT NULL,
  line_tax         numeric(18,4) NOT NULL,
  CONSTRAINT finance_document_lines_description_length CHECK (char_length(btrim(description)) BETWEEN 1 AND 1000),
  CONSTRAINT finance_document_lines_values CHECK (quantity > 0 AND unit_price >= 0 AND discount_amount >= 0 AND line_net >= 0 AND line_tax >= 0),
  CONSTRAINT finance_document_lines_tax CHECK (tax_rate_percent >= 0 AND tax_rate_percent <= 100 AND (tax_rate_percent = 0 OR tax_name IS NOT NULL)),
  CONSTRAINT finance_document_lines_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT finance_document_lines_document_fkey FOREIGN KEY (business_id, document_id) REFERENCES finance_documents(business_id, id),
  CONSTRAINT finance_document_lines_tax_rate_fkey FOREIGN KEY (business_id, tax_rate_id) REFERENCES finance_tax_rates(business_id, id)
);
CREATE INDEX finance_document_lines_document_idx ON finance_document_lines (business_id, document_id, position, id);

-- Manual payment records. A payment is money received; allocations say which invoices it settles.
CREATE TABLE finance_payments (
  id              uuid PRIMARY KEY,
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  customer_id     uuid NOT NULL,
  currency_code   char(3) NOT NULL,
  currency_scale  smallint NOT NULL,
  amount          numeric(18,4) NOT NULL,
  received_on     date NOT NULL,
  method          "FinancePaymentMethod" NOT NULL,
  reference       text,
  status          "FinancePaymentStatus" NOT NULL DEFAULT 'RECORDED',
  allocated_total numeric(18,4) NOT NULL DEFAULT 0,
  reversed_at     timestamptz,
  reversal_reason text,
  idempotency_key text,
  request_hash    text,
  version         integer NOT NULL DEFAULT 1,
  CONSTRAINT finance_payments_currency_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT finance_payments_currency_scale CHECK (currency_scale BETWEEN 0 AND 4),
  CONSTRAINT finance_payments_amount CHECK (amount > 0 AND amount = round(amount, currency_scale)),
  CONSTRAINT finance_payments_allocated CHECK (allocated_total >= 0 AND allocated_total <= amount),
  CONSTRAINT finance_payments_reversal CHECK ((status = 'REVERSED') = (reversed_at IS NOT NULL) AND (status <> 'REVERSED' OR allocated_total = 0)),
  CONSTRAINT finance_payments_reference_length CHECK (reference IS NULL OR char_length(reference) <= 200),
  CONSTRAINT finance_payments_idempotency CHECK ((idempotency_key IS NULL) = (request_hash IS NULL) AND (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 200)),
  CONSTRAINT finance_payments_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT finance_payments_link_key UNIQUE (business_id, id, customer_id, currency_code),
  CONSTRAINT finance_payments_customer_fkey FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id)
);
CREATE UNIQUE INDEX finance_payments_idempotency_key ON finance_payments (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Allocation of a payment to an invoice. Same business, customer and currency on both sides, and the
-- target must be an INVOICE: all enforced by the two composite FKs sharing those columns.
CREATE TABLE finance_payment_allocations (
  id            uuid PRIMARY KEY,
  business_id   uuid NOT NULL,
  payment_id    uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  invoice_kind  "FinanceDocumentKind" NOT NULL DEFAULT 'INVOICE',
  customer_id   uuid NOT NULL,
  currency_code char(3) NOT NULL,
  amount        numeric(18,4) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reversed_at   timestamptz,
  CONSTRAINT finance_payment_allocations_amount CHECK (amount > 0),
  CONSTRAINT finance_payment_allocations_kind CHECK (invoice_kind = 'INVOICE'),
  CONSTRAINT finance_payment_allocations_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT finance_payment_allocations_payment_fkey FOREIGN KEY (business_id, payment_id, customer_id, currency_code)
    REFERENCES finance_payments(business_id, id, customer_id, currency_code),
  CONSTRAINT finance_payment_allocations_invoice_fkey FOREIGN KEY (business_id, invoice_id, invoice_kind, currency_code, customer_id)
    REFERENCES finance_documents(business_id, id, kind, currency_code, customer_id)
);
-- One live allocation per payment and invoice: a double-submitted allocation is refused (23505).
CREATE UNIQUE INDEX finance_payment_allocations_active_key ON finance_payment_allocations (business_id, payment_id, invoice_id) WHERE reversed_at IS NULL;
CREATE INDEX finance_payment_allocations_invoice_idx ON finance_payment_allocations (business_id, invoice_id);

CREATE TABLE finance_expense_categories (
  id          uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  name        text NOT NULL,
  archived_at timestamptz,
  CONSTRAINT finance_expense_categories_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  CONSTRAINT finance_expense_categories_business_id_id_key UNIQUE (business_id, id)
);

CREATE TABLE finance_expenses (
  id                uuid PRIMARY KEY,
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  status            "FinanceExpenseStatus" NOT NULL DEFAULT 'DRAFT',
  category_id       uuid NOT NULL,
  category_name     text,
  project_id        uuid,
  description       text NOT NULL,
  supplier_name     text,
  incurred_on       date NOT NULL,
  currency_code     char(3) NOT NULL,
  currency_scale    smallint NOT NULL,
  amount            numeric(18,4) NOT NULL,
  tax_amount        numeric(18,4) NOT NULL DEFAULT 0,
  receipt_reference text,
  recorded_at       timestamptz,
  voided_at         timestamptz,
  void_reason       text,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT finance_expenses_currency_format CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT finance_expenses_currency_scale CHECK (currency_scale BETWEEN 0 AND 4),
  CONSTRAINT finance_expenses_amounts CHECK (
    amount > 0 AND tax_amount >= 0 AND tax_amount <= amount
    AND amount = round(amount, currency_scale) AND tax_amount = round(tax_amount, currency_scale)),
  CONSTRAINT finance_expenses_description_length CHECK (char_length(btrim(description)) BETWEEN 1 AND 500),
  CONSTRAINT finance_expenses_supplier_length CHECK (supplier_name IS NULL OR char_length(supplier_name) <= 200),
  CONSTRAINT finance_expenses_receipt_length CHECK (receipt_reference IS NULL OR char_length(receipt_reference) <= 500),
  CONSTRAINT finance_expenses_recorded CHECK (status <> 'RECORDED' OR (recorded_at IS NOT NULL AND category_name IS NOT NULL)),
  CONSTRAINT finance_expenses_void CHECK ((status = 'VOID') = (voided_at IS NOT NULL)),
  CONSTRAINT finance_expenses_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT finance_expenses_category_fkey FOREIGN KEY (business_id, category_id) REFERENCES finance_expense_categories(business_id, id),
  CONSTRAINT finance_expenses_project_fkey FOREIGN KEY (business_id, project_id) REFERENCES projects(business_id, id)
);
CREATE INDEX finance_expenses_business_id_incurred_on_idx ON finance_expenses (business_id, incurred_on, id);
CREATE INDEX finance_expenses_business_id_project_id_idx ON finance_expenses (business_id, project_id);

-- ---------------------------------------------------------------------------------------------
-- Integrity functions and guards. All SECURITY INVOKER: they run as bos_app under its own RLS, so they
-- only ever see and change the current tenant's rows.

-- The canonical content of a document: what the hash seals at issue. jsonb's text form is deterministic
-- (keys are ordered), and lines are ordered by (position, id).
CREATE FUNCTION document_content(d finance_documents) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
  SELECT jsonb_build_object(
    'kind', d.kind, 'number', d.number, 'issueDate', d.issue_date, 'dueDate', d.due_date, 'validUntil', d.valid_until,
    'currency', d.currency_code, 'subtotal', d.subtotal::text, 'taxTotal', d.tax_total::text, 'total', d.total::text,
    'customerId', d.customer_id, 'creditedInvoiceId', d.credited_invoice_id, 'seller', d.seller_snapshot, 'billTo', d.bill_to_snapshot,
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'description', l.description, 'quantity', l.quantity::text, 'unitPrice', l.unit_price::text,
        'discount', l.discount_amount::text, 'taxName', l.tax_name, 'taxRatePercent', l.tax_rate_percent::text,
        'net', l.line_net::text, 'tax', l.line_tax::text) ORDER BY l.position, l.id)
      FROM finance_spike.finance_document_lines l WHERE l.business_id = d.business_id AND l.document_id = d.id), '[]'::jsonb))
$$;

CREATE FUNCTION content_hash(d finance_documents) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
  SELECT encode(sha256(convert_to(finance_spike.document_content(d)::text, 'UTF8')), 'hex')
$$;

-- Documents: the lifecycle, sealing at issue, and immutability afterwards.
CREATE FUNCTION guard_document() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
DECLARE
  -- Columns that may change after a document leaves DRAFT. Everything else is frozen (deny by default:
  -- a column added later is frozen too unless it is listed here).
  mutable_after_issue text[] := ARRAY['status', 'allocated_total', 'status_changed_at', 'voided_at', 'void_reason', 'version'];
  bad_lines integer;
  sums record;
  series record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.allocated_total <> 0 OR NEW.number_value IS NOT NULL OR NEW.content_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'documents are created as unnumbered drafts' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- The settlement counter belongs to the allocation triggers (they run one trigger level deeper).
  IF NEW.allocated_total IS DISTINCT FROM OLD.allocated_total AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'allocated_total is maintained by the database' USING ERRCODE = '42501';
  END IF;

  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'DRAFT' THEN
      IF NEW.number_value IS NOT NULL OR NEW.content_sha256 IS NOT NULL OR NEW.issued_at IS NOT NULL THEN
        RAISE EXCEPTION 'drafts are unnumbered' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    ELSIF NEW.status = 'VOID' THEN
      RETURN NEW; -- a discarded draft: never numbered, kept as history
    ELSIF NEW.status <> 'ISSUED' THEN
      RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;

    -- DRAFT -> ISSUED: seal. The client supplies dates and snapshots; the database checks the arithmetic,
    -- assigns the number and computes the content hash, overwriting anything the client sent for them.
    IF NEW.kind = 'CREDIT_NOTE' THEN
      -- The credited invoice must be issued (not void). FOR SHARE: a concurrent void waits for this
      -- transaction and then sees the credit note (guard below), or it went first and this one fails.
      PERFORM 1 FROM finance_spike.finance_documents i
        WHERE i.business_id = NEW.business_id AND i.id = NEW.credited_invoice_id AND i.status = 'ISSUED' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'credited invoice is not issued' USING ERRCODE = '55000'; END IF;
    END IF;
    SELECT count(*) FILTER (WHERE l.line_net <> round(l.quantity * l.unit_price, NEW.currency_scale) - l.discount_amount
                               OR l.line_tax <> round(l.line_net * l.tax_rate_percent / 100, NEW.currency_scale)) AS bad,
           count(*) AS n, coalesce(sum(l.line_net), 0) AS net, coalesce(sum(l.line_tax), 0) AS tax
      INTO sums
      FROM finance_spike.finance_document_lines l WHERE l.business_id = NEW.business_id AND l.document_id = NEW.id;
    bad_lines := sums.bad;
    IF sums.n = 0 THEN RAISE EXCEPTION 'a document needs at least one line' USING ERRCODE = '23514'; END IF;
    IF bad_lines > 0 OR NEW.subtotal <> sums.net OR NEW.tax_total <> sums.tax THEN
      RAISE EXCEPTION 'totals do not match the lines' USING ERRCODE = '23514';
    END IF;
    -- Lock order: the document (this row) first, then its series. Rolling back returns the number.
    UPDATE finance_spike.finance_number_series s SET next_value = s.next_value + 1
     WHERE s.business_id = NEW.business_id AND s.kind = NEW.kind
     RETURNING s.next_value - 1 AS n, s.prefix, s.min_digits INTO series;
    IF NOT FOUND THEN RAISE EXCEPTION 'no numbering series for %', NEW.kind USING ERRCODE = '55000'; END IF;
    NEW.number_value := series.n;
    -- lpad truncates, so pad only when the number is shorter than min_digits.
    NEW.number := series.prefix || CASE WHEN length(series.n::text) >= series.min_digits THEN series.n::text
                                        ELSE lpad(series.n::text, series.min_digits, '0') END;
    NEW.issued_at := now();
    NEW.status_changed_at := now();
    NEW.content_sha256 := finance_spike.content_hash(NEW);
    RETURN NEW;
  END IF;

  -- Issued (or later): nothing outside mutable_after_issue may change.
  IF (to_jsonb(NEW) - mutable_after_issue) IS DISTINCT FROM (to_jsonb(OLD) - mutable_after_issue) THEN
    RAISE EXCEPTION 'issued documents are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.kind = 'QUOTE' AND OLD.status = 'ISSUED' AND NEW.status IN ('ACCEPTED', 'DECLINED', 'EXPIRED', 'VOID'))
      OR (OLD.kind = 'QUOTE' AND OLD.status = 'ACCEPTED' AND NEW.status = 'VOID')
      OR (OLD.kind <> 'QUOTE' AND OLD.status = 'ISSUED' AND NEW.status = 'VOID')) THEN
      RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'VOID' AND OLD.kind = 'INVOICE' AND EXISTS (
        SELECT 1 FROM finance_spike.finance_documents c
        WHERE c.business_id = OLD.business_id AND c.credited_invoice_id = OLD.id AND c.status <> 'VOID') THEN
      RAISE EXCEPTION 'invoice has credit notes' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'VOID' THEN
    RAISE EXCEPTION 'void documents are final' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_document BEFORE INSERT OR UPDATE ON finance_documents FOR EACH ROW EXECUTE FUNCTION guard_document();

-- Lines may be written or deleted only while their document is a DRAFT. FOR SHARE on the document:
-- a line write that races an issue either commits first (and the issue, which locks the document and
-- then reads the lines, includes it) or waits and is then refused. Services lock the draft
-- FOR NO KEY UPDATE first (lock order: document, then lines), so this is a safety net, not the plan.
CREATE FUNCTION guard_line() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
DECLARE b uuid; doc uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN b := OLD.business_id; doc := OLD.document_id; ELSE b := NEW.business_id; doc := NEW.document_id; END IF;
  PERFORM 1 FROM finance_spike.finance_documents d
    WHERE d.business_id = b AND d.id = doc AND d.status = 'DRAFT' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lines of an issued document are immutable' USING ERRCODE = '42501'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.document_id <> OLD.document_id) THEN
    RAISE EXCEPTION 'lines do not move between documents' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_line BEFORE INSERT OR UPDATE OR DELETE ON finance_document_lines FOR EACH ROW EXECUTE FUNCTION guard_line();

-- Numbering series: next_value moves only from the issue trigger, by exactly one.
CREATE FUNCTION guard_number_series() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
BEGIN
  IF NEW.next_value IS DISTINCT FROM OLD.next_value AND (pg_trigger_depth() < 2 OR NEW.next_value <> OLD.next_value + 1) THEN
    RAISE EXCEPTION 'numbers are assigned by the database' USING ERRCODE = '42501';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN RAISE EXCEPTION 'series kind is fixed' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_number_series BEFORE UPDATE ON finance_number_series FOR EACH ROW EXECUTE FUNCTION guard_number_series();

-- Payments: amounts and parties are frozen; RECORDED -> REVERSED is the only transition, one way.
CREATE FUNCTION guard_payment() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
DECLARE mutable text[] := ARRAY['status', 'allocated_total', 'reversed_at', 'reversal_reason', 'reference', 'version'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'RECORDED' OR NEW.allocated_total <> 0 THEN
      RAISE EXCEPTION 'payments are created recorded and unallocated' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.allocated_total IS DISTINCT FROM OLD.allocated_total AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'allocated_total is maintained by the database' USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'recorded payments are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'REVERSED' THEN RAISE EXCEPTION 'reversed payments are final' USING ERRCODE = '42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_payment BEFORE INSERT OR UPDATE ON finance_payments FOR EACH ROW EXECUTE FUNCTION guard_payment();

-- Allocations maintain both counters, payment first, then invoice (the global lock order). The CHECKs
-- on those counters make over-allocation and over-settlement impossible under any concurrency: each
-- increment is an UPDATE of one row, so concurrent increments serialise on the row lock and the
-- second re-evaluates against the first's committed value.
CREATE FUNCTION apply_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
DECLARE delta numeric; scale smallint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL THEN RAISE EXCEPTION 'allocations are created live' USING ERRCODE = '42501'; END IF;
    delta := NEW.amount;
  ELSE
    IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL THEN
      RAISE EXCEPTION 'allocation reversal is one way' USING ERRCODE = '42501';
    END IF;
    delta := -OLD.amount;
  END IF;
  UPDATE finance_spike.finance_payments p SET allocated_total = p.allocated_total + delta
   WHERE p.business_id = NEW.business_id AND p.id = NEW.payment_id AND (delta < 0 OR p.status = 'RECORDED')
   RETURNING p.currency_scale INTO scale;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment is not allocatable' USING ERRCODE = '55000'; END IF;
  IF NEW.amount <> round(NEW.amount, scale) THEN RAISE EXCEPTION 'amount exceeds the currency precision' USING ERRCODE = '23514'; END IF;
  UPDATE finance_spike.finance_documents d SET allocated_total = d.allocated_total + delta
   WHERE d.business_id = NEW.business_id AND d.id = NEW.invoice_id AND d.status = 'ISSUED';
  IF NOT FOUND THEN RAISE EXCEPTION 'invoice is not open' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER apply_allocation_insert AFTER INSERT ON finance_payment_allocations FOR EACH ROW EXECUTE FUNCTION apply_allocation();
CREATE TRIGGER apply_allocation_reversal AFTER UPDATE ON finance_payment_allocations FOR EACH ROW EXECUTE FUNCTION apply_allocation();

-- Expenses: DRAFT is editable; recording snapshots the category name; RECORDED -> VOID only.
CREATE FUNCTION guard_expense() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, finance_spike AS $$
DECLARE mutable text[] := ARRAY['status', 'voided_at', 'void_reason', 'version'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' OR NEW.recorded_at IS NOT NULL THEN
      RAISE EXCEPTION 'expenses are created as drafts' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'DRAFT' THEN
    IF NEW.status = 'RECORDED' THEN
      SELECT c.name INTO NEW.category_name FROM finance_spike.finance_expense_categories c
       WHERE c.business_id = NEW.business_id AND c.id = NEW.category_id;
      NEW.recorded_at := now();
    ELSIF NEW.status = 'DRAFT' AND (NEW.recorded_at IS NOT NULL OR NEW.category_name IS NOT NULL) THEN
      RAISE EXCEPTION 'drafts are unrecorded' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'recorded expenses are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'VOID' OR (NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'VOID') THEN
    RAISE EXCEPTION 'invalid transition % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_expense BEFORE INSERT OR UPDATE ON finance_expenses FOR EACH ROW EXECUTE FUNCTION guard_expense();

REVOKE ALL ON FUNCTION guard_document(), guard_line(), guard_number_series(), guard_payment(), apply_allocation(), guard_expense() FROM PUBLIC;
REVOKE ALL ON FUNCTION document_content(finance_documents), content_hash(finance_documents) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION document_content(finance_documents), content_hash(finance_documents) TO bos_app;

-- ---------------------------------------------------------------------------------------------
-- Least privilege. No DELETE on any finance table, except draft lines (guarded above). Counters,
-- numbers and hashes are column-granted where possible; the rest is held by the guards.
REVOKE ALL ON ALL TABLES IN SCHEMA finance_spike FROM bos_app;
GRANT SELECT, INSERT, UPDATE ON businesses, memberships, customers, contacts, opportunities, projects TO bos_app;
GRANT SELECT, INSERT, UPDATE ON finance_documents, finance_payments, finance_expenses, finance_expense_categories TO bos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_document_lines TO bos_app;
GRANT SELECT, INSERT ON finance_number_series, finance_tax_rates, finance_payment_allocations TO bos_app;
GRANT UPDATE (prefix, min_digits, next_value) ON finance_number_series TO bos_app; -- next_value: guarded, trigger only
GRANT UPDATE (name, archived_at) ON finance_tax_rates TO bos_app;
GRANT UPDATE (reversed_at) ON finance_payment_allocations TO bos_app;

-- Standard tenant policy on every table (businesses by id).
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses FOR ALL TO bos_app
  USING (id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.business_id', true), '')::uuid);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','customers','contacts','opportunities','projects',
      'finance_number_series','finance_tax_rates','finance_documents','finance_document_lines','finance_payments',
      'finance_payment_allocations','finance_expense_categories','finance_expenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO bos_app
      USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
      WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

RESET ROLE;
