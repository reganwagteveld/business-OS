-- Administration A2-B: membership lifecycle and invitations (docs/administration-a2.md §3.5–3.11, §4, §6).
-- Forward-only and additive: two nullable columns, a partial unique index, replaced trigger functions
-- and one column grant. Row-Level Security on memberships and invitations is unchanged. Runs as bos_owner.
-- The member-email function is in prisma/privileged/005_member_emails.sql (needs an administrative role).

-- One transaction: a failure leaves nothing behind (docs/migration-readiness.md §7).
BEGIN;

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "suspended_at" TIMESTAMPTZ,
ADD COLUMN     "suspended_by" UUID;

-- Suspension details are present exactly while the membership is suspended (status stays the source
-- of truth; my_memberships already ignores SUSPENDED rows).
ALTER TABLE "memberships"
  ADD CONSTRAINT memberships_suspension_consistent CHECK (
    ("status" = 'SUSPENDED' AND "suspended_at" IS NOT NULL)
    OR ("status" = 'ACTIVE' AND "suspended_at" IS NULL AND "suspended_by" IS NULL));

GRANT UPDATE ("suspended_at", "suspended_by") ON "memberships" TO bos_app;

-- Status stays the source of truth: a change to SUSPENDED that does not say when gets the database
-- time, and a change back to ACTIVE clears both fields, so the CHECK above holds for every writer
-- (including administrative tooling that only sets the status). The API sets both itself.
CREATE FUNCTION public.memberships_stamp_suspension() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.status = 'SUSPENDED' AND OLD.status IS DISTINCT FROM 'SUSPENDED' AND NEW.suspended_at IS NULL THEN
    NEW.suspended_at := pg_catalog.now();
  ELSIF NEW.status = 'ACTIVE' THEN
    NEW.suspended_at := NULL;
    NEW.suspended_by := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER memberships_stamp_suspension BEFORE UPDATE OF "status" ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION public.memberships_stamp_suspension();

-- ---------------------------------------------------------------------------------------------
-- G3 / D-A2-7: at most one OPEN invitation per email per business. Expired rows cannot be excluded
-- by a partial-index predicate (now() is not immutable), so createInvitation revokes an expired open
-- row for the same address in the same transaction before inserting. A concurrent duplicate fails
-- here with 23505 and the API answers 409 invitation_exists.
CREATE UNIQUE INDEX "invitations_open_email_key" ON "invitations" ("business_id", "email")
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Actor rules on memberships, enforced in the database as well as in modules/tenancy (§6.3).
-- Applies whenever a session user is set (every tenant request). Without one, bos_app may not touch an
-- owner membership or promote anyone to OWNER (no tenant code path does so); administrative roles
-- (migrations, support) are not restricted here.
--
--  * Self: nobody changes their own status (G14), and the only self role change is an OWNER stepping
--    down to ADMIN (§3.7; the last-owner trigger below still applies at commit).
--  * Invariant 2: only an ACTIVE OWNER may make someone an OWNER.
--  * Only an ACTIVE OWNER may change or delete an OWNER membership, except an owner leaving or stepping
--    down themself.
CREATE OR REPLACE FUNCTION public.memberships_no_self_role_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_actor uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  v_self boolean;
  v_actor_is_owner boolean;
BEGIN
  IF v_actor IS NULL THEN
    IF current_user = 'bos_app' AND (OLD.role = 'OWNER' OR (TG_OP = 'UPDATE' AND NEW.role = 'OWNER')) THEN
      RAISE EXCEPTION 'membership role change not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_self := OLD.user_id = v_actor;
  SELECT EXISTS (SELECT 1 FROM public.memberships m
                  WHERE m.business_id = OLD.business_id AND m.user_id = v_actor AND m.role = 'OWNER' AND m.status = 'ACTIVE')
    INTO v_actor_is_owner;
  IF TG_OP = 'UPDATE' THEN
    IF v_self AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'membership status change not allowed' USING ERRCODE = '42501';
    END IF;
    IF v_self AND NEW.role IS DISTINCT FROM OLD.role
       AND NOT (OLD.role = 'OWNER' AND NEW.role = 'ADMIN' AND OLD.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'membership role change not allowed' USING ERRCODE = '42501';
    END IF;
    IF NEW.role = 'OWNER' AND OLD.role IS DISTINCT FROM 'OWNER' AND NOT v_actor_is_owner THEN
      RAISE EXCEPTION 'membership role change not allowed' USING ERRCODE = '42501';
    END IF;
    IF OLD.role = 'OWNER' AND NOT v_self AND NOT v_actor_is_owner
       AND (NEW.role IS DISTINCT FROM OLD.role OR NEW.status IS DISTINCT FROM OLD.status) THEN
      RAISE EXCEPTION 'membership role change not allowed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE: an owner leaves themself, or another active owner removes them.
  IF OLD.role = 'OWNER' AND NOT v_self AND NOT v_actor_is_owner THEN
    RAISE EXCEPTION 'membership role change not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END $$;
-- Same function, now also before DELETE.
DROP TRIGGER memberships_no_self_role_change ON "memberships";
CREATE TRIGGER memberships_no_self_role_change BEFORE UPDATE OR DELETE ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION public.memberships_no_self_role_change();

-- ---------------------------------------------------------------------------------------------
-- G1: last-owner write skew. Before, two transactions that each removed, demoted or suspended a
-- different owner both ran this check at commit, each still seeing the other's owner as ACTIVE
-- (READ COMMITTED), and both committed: zero owners. Now the check first takes a transaction-scoped
-- advisory lock for the business, so these checks run one at a time; the count after the lock is a
-- new statement with a new snapshot (plpgsql, READ COMMITTED), and the lock is released only after
-- the holder's commit is visible. So the second transaction sees the first one's change and fails.
--
-- An advisory lock (as in Projects and Scheduling) rather than a row lock on businesses: it needs no
-- privilege on businesses for whatever role deletes the membership, and it does not wait behind the
-- KEY SHARE locks every tenant insert takes on the business row, or behind profile edits.
--
-- REPEATABLE READ would count with the transaction's old snapshot and could miss a concurrent change,
-- so an owner change under it is refused (no code path uses it; tenant work is READ COMMITTED and
-- SERIALIZABLE is protected by SSI).
CREATE OR REPLACE FUNCTION public.memberships_keep_an_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.role = 'OWNER' AND OLD.status = 'ACTIVE' THEN
    IF current_setting('transaction_isolation') = 'repeatable read' THEN
      RAISE EXCEPTION 'owner changes need READ COMMITTED or SERIALIZABLE' USING ERRCODE = '0A000';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('memberships.owners:' || OLD.business_id::text, 0));
    IF EXISTS (SELECT 1 FROM public.businesses b WHERE b.id = OLD.business_id AND b.archived_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.memberships m
                       WHERE m.business_id = OLD.business_id AND m.role = 'OWNER' AND m.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'a business must keep at least one owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;

COMMIT;
