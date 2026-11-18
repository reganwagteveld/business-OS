-- S-CFG-1: Sales pipeline and stage configuration (docs/sales-pipeline-configuration-scfg.md v1.3 §7, §5).
-- NOT APPLIED ANYWHERE BUT LOCAL/CI DATABASES. Production needs the §8.1 read-only preflight (every
-- "must be 0" count at 0, per-business sums reconciled with global totals), a validated
-- pre-sales-configuration-migration recovery branch, the required §8.2 rehearsal and an
-- APPROVED — EXECUTE: MIGRATION verdict naming this file (docs/agent-task-protocol.md "Production migrations").
--
-- Additive: one column with a constant default (catalog-only change), one CHECK, two partial unique indexes,
-- two SECURITY INVOKER trigger functions and three triggers. No existing row changes, nothing is dropped, no
-- grant, policy or extension changes, no privileged SQL. Runs as bos_owner.
--
-- Fails closed on data: U1/U2 fail if active duplicate names exist (the preflight counts them first; a fix
-- is a data change that escalates to Regan, never part of this migration).

-- One transaction: a failure leaves nothing behind (docs/migration-readiness.md §7).
BEGIN;
-- ADD COLUMN takes ACCESS EXCLUSIVE on sales_pipelines (catalog only), the index builds take SHARE on
-- sales_stages and sales_pipelines, CREATE TRIGGER takes SHARE ROW EXCLUSIVE on sales_stages and
-- opportunities, all held until COMMIT. Fail fast rather than queue behind a long transaction.
--
-- Lock window. Prisma sends a migration one statement per round trip, so every statement after the first
-- table lock adds a client round trip to the time Sales is blocked (measured: about 3 s from the Mac to
-- us-east-1 with the statements in sequence). So the two functions, which take no table lock, are created
-- first, and every table-locking statement runs inside ONE DO block, followed only by COMMIT: the locks are
-- held for the server time of that block plus one round trip.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- ---- G1. Stage guard (BEFORE UPDATE ON sales_stages) ------------------------------------------------------
-- * A stage never changes business or pipeline (SA004).
-- * Archiving (archived_at NULL -> NOT NULL): first lock the stage's pipeline row FOR NO KEY UPDATE (L4), so
--   every stage archive of one pipeline is serialized in the database, through the service or not (I15). Then,
--   with a fresh READ COMMITTED snapshot taken after that lock (P5): another active stage must remain (SA003),
--   and no OPEN, non-archived opportunity may still reference the stage (SA002). The row lock on the stage is
--   already held when this runs (P4), and every path that puts an OPEN opportunity into a stage takes that
--   stage FOR SHARE first (G2), so the count is exact. In product use the service has already moved the open
--   opportunities (§5.3 step 6) and this is the backstop; for direct SQL it is the only check.
-- Restore, add, rename and reorder never reduce the active count, so they take no pipeline lock here.
CREATE FUNCTION sales_stages_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.business_id <> OLD.business_id OR NEW.pipeline_id <> OLD.pipeline_id THEN
    RAISE EXCEPTION 'a stage never changes business or pipeline' USING ERRCODE = 'SA004';
  END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    PERFORM 1 FROM sales_pipelines WHERE business_id = NEW.business_id AND id = NEW.pipeline_id FOR NO KEY UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM sales_stages
      WHERE business_id = NEW.business_id AND pipeline_id = NEW.pipeline_id AND archived_at IS NULL AND id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'a pipeline keeps at least one active stage' USING ERRCODE = 'SA003';
    END IF;
    IF EXISTS (
      SELECT 1 FROM opportunities
      WHERE business_id = NEW.business_id AND pipeline_id = NEW.pipeline_id AND stage_id = NEW.id
        AND status = 'OPEN' AND archived_at IS NULL
    ) THEN
      RAISE EXCEPTION 'the stage still holds open opportunities' USING ERRCODE = 'SA002';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION sales_stages_guard() FROM PUBLIC;

-- ---- G2. Opportunity stage guard (BEFORE INSERT, BEFORE UPDATE OF stage_id, pipeline_id, status, archived_at)
-- Only when the resulting row is OPEN and not archived and, on UPDATE, one of those columns actually changed:
-- take the target stage FOR SHARE (L2; already held on the product path, so no new wait) and refuse an archived
-- stage or an archived pipeline (SA001). Closing (WON/LOST), closed history and archived rows never fail
-- because a stage was archived later. A stage that is not found is left to the composite foreign key.
CREATE FUNCTION opportunities_stage_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE
  stage_archived timestamptz;
  pipeline_archived timestamptz;
  found_stage boolean;
BEGIN
  IF NEW.status <> 'OPEN' OR NEW.archived_at IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.stage_id = OLD.stage_id AND NEW.pipeline_id = OLD.pipeline_id
     AND NEW.status = OLD.status AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    RETURN NEW;
  END IF;
  SELECT archived_at, true INTO stage_archived, found_stage
    FROM sales_stages WHERE business_id = NEW.business_id AND id = NEW.stage_id FOR SHARE;
  IF NOT coalesce(found_stage, false) THEN
    RETURN NEW;
  END IF;
  SELECT archived_at INTO pipeline_archived
    FROM sales_pipelines WHERE business_id = NEW.business_id AND id = NEW.pipeline_id;
  IF stage_archived IS NOT NULL OR pipeline_archived IS NOT NULL THEN
    RAISE EXCEPTION 'an open opportunity needs an active stage of an active pipeline' USING ERRCODE = 'SA001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opportunities_stage_guard() FROM PUBLIC;

-- ---- Table locks: one statement (see "Lock window" above) -----------------------------------------------
DO $lock$
BEGIN
  -- ---- C. Concurrency token for configuration edits (§6.1 "config_version lifecycle") ----------------------
  -- Starts at 1 on every creation path (column default); the configuration service bumps it exactly once per
  -- committed configuration mutation. Opportunity writes never change it.
  ALTER TABLE "sales_pipelines"
    ADD COLUMN "config_version" INTEGER NOT NULL DEFAULT 1,
    ADD CONSTRAINT sales_pipelines_config_version_positive CHECK ("config_version" >= 1);

  -- ---- U1, U2. Active names unique, case- and surrounding-whitespace-insensitive (§4.3, D-SCFG-3) ----------
  -- Partial expression indexes: they do not make name or archived_at key columns (§5.1 P2). Mapped to
  -- 409 name_taken by the API. Archived rows are excluded, so an archived "Proposal" never blocks a new one.
  CREATE UNIQUE INDEX "sales_stages_active_name_key"
    ON "sales_stages" ("business_id", "pipeline_id", lower(btrim("name"))) WHERE "archived_at" IS NULL;
  CREATE UNIQUE INDEX "sales_pipelines_active_name_key"
    ON "sales_pipelines" ("business_id", lower(btrim("name"))) WHERE "archived_at" IS NULL;

  -- G1 and G2 triggers (functions above).
  CREATE TRIGGER sales_stages_guard BEFORE UPDATE ON "sales_stages"
    FOR EACH ROW EXECUTE FUNCTION sales_stages_guard();
  CREATE TRIGGER opportunities_stage_guard_insert BEFORE INSERT ON "opportunities"
    FOR EACH ROW EXECUTE FUNCTION opportunities_stage_guard();
  CREATE TRIGGER opportunities_stage_guard_update BEFORE UPDATE OF "stage_id", "pipeline_id", "status", "archived_at" ON "opportunities"
    FOR EACH ROW EXECUTE FUNCTION opportunities_stage_guard();
END $lock$;

COMMIT;
