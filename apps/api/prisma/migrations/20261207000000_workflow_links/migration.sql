-- WF-1B-1: cross-Zone workflow links between Sales, Projects and Finance (docs/cross-zone-workflows-wf1.md
-- §5, §10.1; W1 invariant I1, W1-D3, W1-D6, W1-D10, W1-D13; D-WF1-07, D-WF1-08, D-WF1-12).
-- Additive only: two unique keys implied by primary keys, three nullable project columns, five foreign keys,
-- one guard trigger and one infrastructure table. No existing row changes; no issued Finance document is
-- touched (finance_guard_document, mutable_after_issue and the content hash are unchanged). Runs as bos_owner.
-- No privileged SQL. Production: read-only preflight first (§10.2), exact-count I1 queries must return 0.

-- One transaction: a failure leaves nothing behind (docs/migration-readiness.md §7).
BEGIN;

-- ---- 1. Finance key referenced by the source-quote FK (implied by the primary key, cannot fail) -------
CREATE UNIQUE INDEX "finance_documents_kind_customer_key" ON "finance_documents"("business_id", "id", "kind", "customer_id");

-- ---- 2. Projects key referenced by the I1 FKs (implied by the primary key, cannot fail) --------------
CREATE UNIQUE INDEX "projects_customer_key" ON "projects"("business_id", "id", "customer_id");

-- ---- 3. Project provenance columns (all start NULL, so nothing below can fail on existing rows) ------
ALTER TABLE "projects" ADD COLUMN     "source_opportunity_id" UUID,
ADD COLUMN     "source_quote_id" UUID,
ADD COLUMN     "source_quote_kind" "FinanceDocumentKind" NOT NULL DEFAULT 'QUOTE';

ALTER TABLE "projects"
  -- The FK can then name the kind, so a source quote is always a QUOTE.
  ADD CONSTRAINT projects_source_quote_kind CHECK ("source_quote_kind" = 'QUOTE'),
  -- MATCH SIMPLE skips the source-quote FK when customer_id is NULL, so a customerless project may never
  -- have a source quote (a quote always has a customer).
  ADD CONSTRAINT projects_source_quote_customer CHECK ("source_quote_id" IS NULL OR "customer_id" IS NOT NULL);

CREATE INDEX "projects_business_id_source_opportunity_id_idx" ON "projects"("business_id", "source_opportunity_id");

-- ---- 4. Project links: same tenant (and, for the quote, same kind and customer); one project per quote -
-- One project per quote (W1-D10). A customer change on a quote-linked project fails the FK below (23503).
CREATE UNIQUE INDEX "projects_source_quote_key" ON "projects"("business_id", "source_quote_id");

ALTER TABLE "projects" ADD CONSTRAINT "projects_source_opportunity_fkey" FOREIGN KEY ("business_id", "source_opportunity_id") REFERENCES "opportunities"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "projects" ADD CONSTRAINT "projects_source_quote_fkey" FOREIGN KEY ("business_id", "source_quote_id", "source_quote_kind", "customer_id") REFERENCES "finance_documents"("business_id", "id", "kind", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---- 5. W1 invariant I1: a record with a customer links only a project of the same customer ---------
-- MATCH SIMPLE: a record without a customer (an internal expense) may link any project; documents and
-- recurring templates always have one. Referenced side ON UPDATE NO ACTION: a project cannot change or
-- lose its customer while any such record links it, in any status (W1-D6).
-- Added NOT VALID and then validated: validation runs PostgreSQL's own FK check over existing rows (not
-- subject to RLS) and fails this whole migration if any row violates I1, so the apply fails closed even if
-- a row appeared after the read-only preflight (§10.2).
ALTER TABLE "finance_documents" ADD CONSTRAINT "finance_documents_project_customer_fkey" FOREIGN KEY ("business_id", "project_id", "customer_id") REFERENCES "projects"("business_id", "id", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "finance_expenses" ADD CONSTRAINT "finance_expenses_project_customer_fkey" FOREIGN KEY ("business_id", "project_id", "customer_id") REFERENCES "projects"("business_id", "id", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;
ALTER TABLE "finance_recurring_templates" ADD CONSTRAINT "finance_recurring_templates_project_customer_fkey" FOREIGN KEY ("business_id", "project_id", "customer_id") REFERENCES "projects"("business_id", "id", "customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION NOT VALID;

ALTER TABLE "finance_documents" VALIDATE CONSTRAINT "finance_documents_project_customer_fkey";
ALTER TABLE "finance_expenses" VALIDATE CONSTRAINT "finance_expenses_project_customer_fkey";
ALTER TABLE "finance_recurring_templates" VALIDATE CONSTRAINT "finance_recurring_templates_project_customer_fkey";

-- ---- 6. Guard trigger projects_guard_links (§5.4) ------------------------------------------------------
-- SECURITY INVOKER: it runs as bos_app under forced RLS (the Finance guard pattern), so it only ever sees
-- the current tenant's rows. It reads finance_documents from a Projects trigger (a documented cross-Zone
-- dependency, WF-1 R-5). Fires on INSERT and on changes to the two link columns only, never on a plain
-- customer edit (customer drift is caught by the FKs alone).
--
--  WF001 source quote set once: a value never changes to another value or back to NULL (D-WF1-08, D-WF1-09).
--  WF002 the quote is not an ACCEPTED quote of this business (W1-D2).
--  WF003 the quote was drafted for another project.
--  WF004 the project's opportunity disagrees with the source quote's opportunity.
--
-- H1: when the source quote becomes non-null the quote row is read FOR SHARE. The FK alone takes only
-- FOR KEY SHARE, which does not conflict with the FOR NO KEY UPDATE every quote transition takes
-- (lockDocuments); FOR SHARE does. So a link and a void of the same quote are ordered: a void that
-- committed first is seen (VOID, refused), a void in flight makes the link wait, a link that locked first
-- makes the void wait. Guarantee: the source quote was ACCEPTED when the link committed, in commit order
-- with every quote transition (not "still accepted now": a later void is the defined lifecycle, §8).
CREATE FUNCTION projects_guard_links() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  q record;
  q_opportunity uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.source_quote_id IS NOT NULL AND NEW.source_quote_id IS DISTINCT FROM OLD.source_quote_id THEN
    RAISE EXCEPTION 'source quote is fixed' USING ERRCODE = 'WF001';
  END IF;

  IF NEW.source_quote_id IS NOT NULL AND (TG_OP = 'INSERT' OR OLD.source_quote_id IS NULL) THEN
    SELECT d.kind, d.status, d.project_id, d.opportunity_id INTO q
      FROM public.finance_documents d
     WHERE d.business_id = NEW.business_id AND d.id = NEW.source_quote_id
       FOR SHARE;
    IF NOT FOUND OR q.kind <> 'QUOTE' OR q.status <> 'ACCEPTED' THEN
      RAISE EXCEPTION 'source quote must be an accepted quote' USING ERRCODE = 'WF002';
    END IF;
    IF q.project_id IS NOT NULL AND q.project_id <> NEW.id THEN
      RAISE EXCEPTION 'quote belongs to another project' USING ERRCODE = 'WF003';
    END IF;
  END IF;

  IF NEW.source_quote_id IS NOT NULL AND (
       TG_OP = 'INSERT'
       OR NEW.source_quote_id IS DISTINCT FROM OLD.source_quote_id
       OR NEW.source_opportunity_id IS DISTINCT FROM OLD.source_opportunity_id) THEN
    -- The quote's opportunity_id is frozen after issue (finance_guard_document), so no lock is needed here.
    SELECT d.opportunity_id INTO q_opportunity
      FROM public.finance_documents d
     WHERE d.business_id = NEW.business_id AND d.id = NEW.source_quote_id;
    IF q_opportunity IS NOT NULL AND NEW.source_opportunity_id IS DISTINCT FROM q_opportunity THEN
      RAISE EXCEPTION 'opportunity must match the source quote' USING ERRCODE = 'WF004';
    END IF;
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION projects_guard_links() FROM PUBLIC;

CREATE TRIGGER projects_guard_links BEFORE INSERT OR UPDATE OF "source_quote_id", "source_opportunity_id" ON "projects"
  FOR EACH ROW EXECUTE FUNCTION projects_guard_links();

-- ---- 7. workflow_requests (W1-D13, §5.5) ---------------------------------------------------------------
-- The workflows module's idempotency ledger (used from WF-1B-2). Inserted in the action's transaction.
CREATE TABLE "workflow_requests" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "result_type" TEXT NOT NULL,
    "result_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "workflow_requests_business_id_created_at_idx" ON "workflow_requests"("business_id", "created_at");
CREATE UNIQUE INDEX "workflow_requests_business_id_id_key" ON "workflow_requests"("business_id", "id");
CREATE UNIQUE INDEX "workflow_requests_key" ON "workflow_requests"("business_id", "operation", "idempotency_key");

ALTER TABLE "workflow_requests" ADD CONSTRAINT "workflow_requests_business_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "workflow_requests"
  ADD CONSTRAINT workflow_requests_operation CHECK ("operation" IN ('project.from_opportunity', 'project.from_quote')),
  ADD CONSTRAINT workflow_requests_result_type CHECK ("result_type" = 'project'),
  ADD CONSTRAINT workflow_requests_idempotency_key CHECK (char_length("idempotency_key") BETWEEN 1 AND 200),
  ADD CONSTRAINT workflow_requests_request_hash CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

-- Least privilege: a recorded key is never changed or removed by tenant code (retention is a separate,
-- not yet approved, administrative cleanup; D-WF1-12).
REVOKE ALL ON "workflow_requests" FROM bos_app;
GRANT SELECT, INSERT ON "workflow_requests" TO bos_app;

ALTER TABLE "workflow_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workflow_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "workflow_requests" FOR ALL TO bos_app
  USING      ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK ("business_id" = nullif(current_setting('app.business_id', true), '')::uuid);
-- The recorded actor is the session user (no client-chosen author).
CREATE POLICY actor_is_session_user ON "workflow_requests" AS RESTRICTIVE FOR INSERT TO bos_app
  WITH CHECK ("actor_user_id" = nullif(current_setting('app.user_id', true), '')::uuid);

COMMIT;
