-- Scheduling S0 spike fixture (docs/scheduling-data-model.md, ADR 0006). Applied by
-- tests/isolation/scheduling-spike.test.ts as an ADMINISTRATIVE role to the spike database. It is NOT an
-- application migration: the S1 migration must reproduce these tables, constraints, grants, policies and
-- guards exactly, and this suite then moves to the real tables.
--
-- Everything lives in its own schemas (scheduling_spike, scheduling_spike_private), so this fixture and
-- the Phase 1b fixture (spike-schema.sql, public schema) never touch each other's tables.
-- The tenancy, customer and project tables are cut down to the columns scheduling depends on, with the
-- production names, types, composite keys and the standard tenant policy.

-- Privileged pre-step (ADR 0006 §3): extensions are installed by an administrative role BEFORE any
-- migration, because bos_owner has no CREATE privilege on the database. Production: privileged
-- 000_extensions.sql, applied only with the owner's approval.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DROP SCHEMA IF EXISTS scheduling_spike_private CASCADE;
DROP SCHEMA IF EXISTS scheduling_spike CASCADE;
CREATE SCHEMA scheduling_spike AUTHORIZATION bos_owner;
CREATE SCHEMA scheduling_spike_private AUTHORIZATION bos_owner;
REVOKE ALL ON SCHEMA scheduling_spike, scheduling_spike_private FROM PUBLIC;
GRANT USAGE ON SCHEMA scheduling_spike TO bos_app, bos_maint;
GRANT USAGE ON SCHEMA scheduling_spike_private TO bos_app;

SET ROLE bos_owner;
SET search_path = scheduling_spike;

-- The migration asserts the pre-step ran: as bos_owner this succeeds only because the extension exists.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------------------------
-- Dependencies (cut down)
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER');
CREATE TABLE businesses (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, time_zone text NOT NULL DEFAULT 'America/New_York');
-- Identity tables as in the identity migration: tenant code (bos_app) has no access to them at all.
CREATE TABLE users (id uuid PRIMARY KEY, email_verified boolean NOT NULL DEFAULT false, deactivated_at timestamptz);
CREATE TABLE sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL, revoked_at timestamptz);
CREATE TABLE audit_events (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, actor_user_id uuid NOT NULL,
  action text NOT NULL, target_type text NOT NULL, target_id uuid NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE memberships (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, user_id uuid NOT NULL,
  role "MembershipRole" NOT NULL DEFAULT 'MEMBER',
  status "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
  CONSTRAINT memberships_business_id_user_id_key UNIQUE (business_id, user_id),
  CONSTRAINT memberships_business_id_id_key UNIQUE (business_id, id));
CREATE TABLE customers (id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, display_name text NOT NULL,
  CONSTRAINT customers_business_id_id_key UNIQUE (business_id, id));
CREATE TABLE contacts (id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, customer_id uuid, display_name text NOT NULL,
  CONSTRAINT contacts_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT contacts_customer_fkey FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id));
CREATE TABLE projects (id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, name text NOT NULL,
  archived_at timestamptz, CONSTRAINT projects_business_id_id_key UNIQUE (business_id, id));
CREATE TABLE project_tasks (id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, project_id uuid NOT NULL, title text NOT NULL,
  CONSTRAINT project_tasks_business_id_id_key UNIQUE (business_id, id),
  -- Additive in S1: lets an event link a task only together with its own project.
  CONSTRAINT project_tasks_business_id_project_id_id_key UNIQUE (business_id, project_id, id),
  CONSTRAINT project_tasks_project_fkey FOREIGN KEY (business_id, project_id) REFERENCES projects(business_id, id));

-- ---------------------------------------------------------------------------------------------
-- Scheduling
CREATE TYPE "ScheduleResourceKind" AS ENUM ('MEMBER', 'PLACE', 'EQUIPMENT');
CREATE TYPE "ScheduleEventKind" AS ENUM ('APPOINTMENT', 'JOB', 'RESERVATION', 'INTERNAL', 'TIME_OFF');
CREATE TYPE "ScheduleEventStatus" AS ENUM ('TENTATIVE', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE "ScheduleVisibility" AS ENUM ('STANDARD', 'PRIVATE');
CREATE TYPE "ScheduleAssignmentRole" AS ENUM ('REQUIRED', 'OPTIONAL');
CREATE TYPE "ScheduleRemovalReason" AS ENUM ('EDITED', 'DECLINED', 'MEMBER_REMOVED', 'REASSIGNED');

CREATE TABLE schedule_resources (
  id          uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind        "ScheduleResourceKind" NOT NULL,
  user_id     uuid,
  name        text NOT NULL,
  exclusive   boolean NOT NULL DEFAULT true,
  version     integer NOT NULL DEFAULT 1,
  archived_at timestamptz,
  CONSTRAINT schedule_resources_name_length CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  -- A non-member never has a user; a member always has one unless archived (a removed member's
  -- resource keeps its history with user_id cleared, so the membership can be deleted).
  CONSTRAINT schedule_resources_member_user CHECK ((kind = 'MEMBER' OR user_id IS NULL) AND (kind <> 'MEMBER' OR user_id IS NOT NULL OR archived_at IS NOT NULL)),
  CONSTRAINT schedule_resources_user_fkey FOREIGN KEY (business_id, user_id) REFERENCES memberships(business_id, user_id),
  CONSTRAINT schedule_resources_business_id_id_key UNIQUE (business_id, id),
  -- Target of the assignments' copy FK for `exclusive`.
  CONSTRAINT schedule_resources_exclusive_key UNIQUE (business_id, id, exclusive)
);
CREATE UNIQUE INDEX schedule_resources_business_id_user_id_key ON schedule_resources (business_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE schedule_events (
  id                uuid PRIMARY KEY,
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind              "ScheduleEventKind" NOT NULL,
  status            "ScheduleEventStatus" NOT NULL DEFAULT 'CONFIRMED',
  visibility        "ScheduleVisibility" NOT NULL DEFAULT 'STANDARD',
  organizer_user_id uuid,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  time_zone         text NOT NULL,
  blocks_time       boolean NOT NULL DEFAULT true,
  during            tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  occupying         boolean GENERATED ALWAYS AS (blocks_time AND status <> 'CANCELLED') STORED,
  version           integer NOT NULL DEFAULT 1,
  CONSTRAINT schedule_events_order CHECK (ends_at > starts_at),
  CONSTRAINT schedule_events_max_length CHECK (ends_at - starts_at <= interval '31 days'),
  CONSTRAINT schedule_events_organizer_fkey FOREIGN KEY (business_id, organizer_user_id) REFERENCES memberships(business_id, user_id),
  CONSTRAINT schedule_events_business_id_id_key UNIQUE (business_id, id),
  -- Target of the assignments' copy FK for the range and occupancy.
  CONSTRAINT schedule_events_occupancy_key UNIQUE (business_id, id, during, occupying)
);
CREATE INDEX schedule_events_business_id_during_idx ON schedule_events USING gist (business_id, during);
CREATE INDEX schedule_events_business_id_starts_at_id_idx ON schedule_events (business_id, starts_at, id);

CREATE TABLE schedule_event_details (
  business_id     uuid NOT NULL,
  event_id        uuid NOT NULL,
  title           text NOT NULL,
  description     text,
  location        text,
  customer_id     uuid,
  contact_id      uuid,
  project_id      uuid,
  project_task_id uuid,
  cancel_reason   text,
  CONSTRAINT schedule_event_details_pkey PRIMARY KEY (business_id, event_id),
  CONSTRAINT schedule_event_details_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT schedule_event_details_task_needs_project CHECK (project_task_id IS NULL OR project_id IS NOT NULL),
  CONSTRAINT schedule_event_details_event_fkey FOREIGN KEY (business_id, event_id) REFERENCES schedule_events(business_id, id),
  CONSTRAINT schedule_event_details_customer_fkey FOREIGN KEY (business_id, customer_id) REFERENCES customers(business_id, id),
  CONSTRAINT schedule_event_details_contact_fkey FOREIGN KEY (business_id, contact_id) REFERENCES contacts(business_id, id),
  CONSTRAINT schedule_event_details_project_fkey FOREIGN KEY (business_id, project_id) REFERENCES projects(business_id, id),
  CONSTRAINT schedule_event_details_task_fkey FOREIGN KEY (business_id, project_id, project_task_id) REFERENCES project_tasks(business_id, project_id, id)
);

CREATE TABLE schedule_event_resources (
  id             uuid PRIMARY KEY,
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE ON UPDATE CASCADE,
  event_id       uuid NOT NULL,
  resource_id    uuid NOT NULL,
  role           "ScheduleAssignmentRole" NOT NULL DEFAULT 'REQUIRED',
  during         tstzrange NOT NULL,
  occupying      boolean NOT NULL,
  exclusive      boolean NOT NULL,
  removed_at     timestamptz,
  removed_by_id  uuid,
  removal_reason "ScheduleRemovalReason",
  CONSTRAINT schedule_event_resources_removal CHECK ((removed_at IS NULL) = (removal_reason IS NULL)),
  -- Copies kept equal to their sources by the database (variant A, ADR 0006 §2).
  CONSTRAINT schedule_event_resources_event_fkey FOREIGN KEY (business_id, event_id, during, occupying)
    REFERENCES schedule_events(business_id, id, during, occupying) ON UPDATE CASCADE,
  CONSTRAINT schedule_event_resources_resource_fkey FOREIGN KEY (business_id, resource_id, exclusive)
    REFERENCES schedule_resources(business_id, id, exclusive) ON UPDATE CASCADE,
  CONSTRAINT schedule_no_double_booking EXCLUDE USING gist (business_id WITH =, resource_id WITH =, during WITH &&)
    WHERE (occupying AND exclusive AND role = 'REQUIRED' AND removed_at IS NULL)
);
CREATE UNIQUE INDEX schedule_event_resources_active_key ON schedule_event_resources (business_id, event_id, resource_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- Least privilege. No DELETE anywhere for tenant code; assignment copies are never writable.
REVOKE ALL ON ALL TABLES IN SCHEMA scheduling_spike FROM bos_app;
GRANT SELECT, INSERT, UPDATE ON businesses, memberships, customers, contacts, projects, project_tasks TO bos_app;
-- users and sessions: nothing for bos_app. audit_events: read only (writes here come from the erasure function).
GRANT SELECT ON audit_events TO bos_app;
GRANT SELECT, INSERT, UPDATE ON schedule_resources, schedule_events, schedule_event_details TO bos_app;
GRANT SELECT, INSERT ON schedule_event_resources TO bos_app;
GRANT UPDATE (removed_at, removed_by_id, removal_reason) ON schedule_event_resources TO bos_app;

-- Standard tenant policy on every table (businesses by id).
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses FOR ALL TO bos_app
  USING (id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.business_id', true), '')::uuid);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','audit_events','customers','contacts','projects','project_tasks','schedule_resources','schedule_events','schedule_event_details','schedule_event_resources'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I FOR ALL TO bos_app
      USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
      WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Privacy (ADR 0006 §4). Who may see a private entry's details: its organizer and the members assigned
-- to it (not removed). Evaluated as the caller (SECURITY INVOKER), so it only ever sees the current
-- tenant's rows through their own RLS.
CREATE FUNCTION may_see_details(p_business uuid, p_event uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, scheduling_spike AS $$
  SELECT EXISTS (
    SELECT 1 FROM scheduling_spike.schedule_events e
    WHERE e.business_id = p_business AND e.id = p_event
      AND (e.visibility = 'STANDARD'
        OR e.organizer_user_id = nullif(current_setting('app.user_id', true), '')::uuid
        OR EXISTS (
          SELECT 1 FROM scheduling_spike.schedule_event_resources r
          JOIN scheduling_spike.schedule_resources s ON s.business_id = r.business_id AND s.id = r.resource_id
          WHERE r.business_id = e.business_id AND r.event_id = e.id AND r.removed_at IS NULL
            AND s.user_id = nullif(current_setting('app.user_id', true), '')::uuid)))
$$;
REVOKE ALL ON FUNCTION may_see_details(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION may_see_details(uuid, uuid) TO bos_app;

-- Restrictive: ANDed with tenant_isolation, for reads AND writes.
CREATE POLICY private_details ON schedule_event_details AS RESTRICTIVE FOR ALL TO bos_app
  USING (scheduling_spike.may_see_details(business_id, event_id))
  WITH CHECK (scheduling_spike.may_see_details(business_id, event_id));

-- Escalation guards (ADR 0006 §5). Any change that could WIDEN who sees a private entry's details is
-- allowed only to someone who can already see them. Narrowing changes are always allowed.
CREATE FUNCTION guard_event_privacy() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, scheduling_spike AS $$
DECLARE me uuid := nullif(current_setting('app.user_id', true), '')::uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A new entry's organizer is its creator (or nobody, for system-created entries).
    IF NEW.organizer_user_id IS NOT NULL AND NEW.organizer_user_id IS DISTINCT FROM me THEN
      RAISE EXCEPTION 'organizer must be the creator' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.visibility = 'PRIVATE'
     AND (NEW.visibility <> 'PRIVATE'
          OR (NEW.organizer_user_id IS NOT NULL AND NEW.organizer_user_id IS DISTINCT FROM OLD.organizer_user_id))
     AND NOT scheduling_spike.may_see_details(OLD.business_id, OLD.id) THEN
    RAISE EXCEPTION 'private_escalation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_event_privacy BEFORE INSERT OR UPDATE OF visibility, organizer_user_id ON schedule_events
  FOR EACH ROW EXECUTE FUNCTION guard_event_privacy();

CREATE FUNCTION guard_assignment_privacy() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, scheduling_spike AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Removal is one-way: a removed assignment is history and is never revived (re-adding inserts a new row).
    IF OLD.removed_at IS NOT NULL THEN RAISE EXCEPTION 'assignment_removed' USING ERRCODE = '42501'; END IF;
    RETURN NEW;
  END IF;
  -- Adding a MEMBER to a private entry gives that member its details, so only someone who can see them may do it.
  IF EXISTS (SELECT 1 FROM scheduling_spike.schedule_resources s WHERE s.business_id = NEW.business_id AND s.id = NEW.resource_id AND s.user_id IS NOT NULL)
     AND EXISTS (SELECT 1 FROM scheduling_spike.schedule_events e WHERE e.business_id = NEW.business_id AND e.id = NEW.event_id AND e.visibility = 'PRIVATE')
     AND NOT scheduling_spike.may_see_details(NEW.business_id, NEW.event_id) THEN
    RAISE EXCEPTION 'private_escalation' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_assignment_privacy BEFORE INSERT OR UPDATE ON schedule_event_resources
  FOR EACH ROW EXECUTE FUNCTION guard_assignment_privacy();

CREATE FUNCTION guard_resource_user() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, scheduling_spike AS $$
BEGIN
  -- A member resource is never re-pointed at another person (that would hand them its private history).
  IF NEW.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'member_resource_relink' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_resource_user BEFORE UPDATE OF user_id ON schedule_resources
  FOR EACH ROW EXECUTE FUNCTION guard_resource_user();

REVOKE ALL ON FUNCTION guard_event_privacy(), guard_assignment_privacy(), guard_resource_user() FROM PUBLIC;

RESET ROLE;

-- ---------------------------------------------------------------------------------------------
-- Privileged erasure (ADR 0006 §6). The one path that can change private details its caller cannot see.
--
-- Trust model. app.business_id and app.user_id are set by withTenant from a verified session, but
-- any code running as bos_app can call set_config and change them, so they scope RLS and are never
-- AUTHORITY for an irreversible operation. Authority comes from the caller's raw session token, verified
-- in the database exactly like the pre-tenant trusted paths (privileged/001, ADR 0004): only a holder
-- of a live OWNER or ADMIN session can erase. bos_app can neither read sessions nor forge a token.
--
-- Two functions, two owners, least privilege:
--   scheduling_spike_private.erasure_actor(token, business)  owner bos_definer (already trusted to verify
--       sessions). Returns the verified user id if the session is live, the user active and verified, and
--       their membership in that business ACTIVE with role OWNER or ADMIN (the roles that hold
--       customers:delete in ROLE_PERMISSIONS; S1 adds a unit test that keeps the two in sync). Executable
--       by bos_maint only.
--   scheduling_spike_private.scrub_event_details(token, subject, id)  owner bos_maint. Executable by
--       bos_app. Calls erasure_actor; refuses unless it returns a user and that user equals app.user_id
--       (a mismatch means the context was tampered with); scrubs named columns in the CURRENT business
--       only; writes its own audit row as the verified user (the API cannot skip or forge it); returns a count.

-- bos_definer: read exactly what verification needs. Policies are per role; tenant code gets nothing.
GRANT USAGE ON SCHEMA scheduling_spike TO bos_definer;
GRANT SELECT (id, user_id, token_hash, expires_at, revoked_at) ON scheduling_spike.sessions TO bos_definer;
GRANT SELECT (id, email_verified, deactivated_at) ON scheduling_spike.users TO bos_definer;
GRANT SELECT (business_id, user_id, role, status) ON scheduling_spike.memberships TO bos_definer;
CREATE POLICY definer_verify ON scheduling_spike.sessions FOR SELECT TO bos_definer USING (revoked_at IS NULL AND expires_at > now());
CREATE POLICY definer_verify ON scheduling_spike.users FOR SELECT TO bos_definer USING (deactivated_at IS NULL);
CREATE POLICY definer_verify ON scheduling_spike.memberships FOR SELECT TO bos_definer USING (status = 'ACTIVE' AND role IN ('OWNER', 'ADMIN'));

-- bos_maint: change only the scrubbed columns of the current business, and append its audit row.
GRANT SELECT ON scheduling_spike.schedule_event_details TO bos_maint;
GRANT UPDATE (title, description, location, cancel_reason, customer_id, contact_id) ON scheduling_spike.schedule_event_details TO bos_maint;
CREATE POLICY maint_scrub ON scheduling_spike.schedule_event_details FOR ALL TO bos_maint
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
GRANT INSERT ON scheduling_spike.audit_events TO bos_maint;
CREATE POLICY maint_audit ON scheduling_spike.audit_events FOR INSERT TO bos_maint
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid AND action = 'schedule.details.scrubbed');

CREATE FUNCTION scheduling_spike_private.erasure_actor(p_session_token text, p_business uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id
  FROM scheduling_spike.sessions s
  JOIN scheduling_spike.users u ON u.id = s.user_id
  JOIN scheduling_spike.memberships m ON m.user_id = u.id AND m.business_id = p_business
  WHERE s.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_session_token, ''), 'UTF8')), 'hex')
    AND s.expires_at > pg_catalog.now() AND s.revoked_at IS NULL
    AND u.deactivated_at IS NULL AND u.email_verified
    AND m.status = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN')
$$;

CREATE FUNCTION scheduling_spike_private.scrub_event_details(p_session_token text, p_subject text, p_subject_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  b uuid := nullif(current_setting('app.business_id', true), '')::uuid;
  ctx_user uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  actor uuid;
  n integer;
BEGIN
  IF b IS NULL THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  actor := scheduling_spike_private.erasure_actor(p_session_token, b);
  -- One generic failure for every reason: no session, wrong role, other business, or a tampered context.
  IF actor IS NULL OR ctx_user IS DISTINCT FROM actor THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_subject = 'contact' THEN
    UPDATE scheduling_spike.schedule_event_details d
       SET title = 'Appointment', description = NULL, location = NULL, cancel_reason = NULL, contact_id = NULL
     WHERE d.business_id = b AND d.contact_id = p_subject_id;
  ELSIF p_subject = 'customer' THEN
    UPDATE scheduling_spike.schedule_event_details d
       SET title = 'Appointment', description = NULL, location = NULL, cancel_reason = NULL, contact_id = NULL, customer_id = NULL
     WHERE d.business_id = b AND d.customer_id = p_subject_id;
  ELSE
    RAISE EXCEPTION 'unknown subject' USING ERRCODE = '22023';
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO scheduling_spike.audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (pg_catalog.gen_random_uuid(), b, actor, 'schedule.details.scrubbed', p_subject, p_subject_id, pg_catalog.jsonb_build_object('count', n));
  RETURN n;
END $$;

-- Ownership changes as privileged/001 does: the admin role joins the owner role, and the owner holds
-- CREATE on the schema, only for the change (a superuser skips the CREATE check; Neon does not).
GRANT bos_definer, bos_maint TO CURRENT_USER;
GRANT CREATE ON SCHEMA scheduling_spike_private TO bos_definer, bos_maint;
GRANT USAGE ON SCHEMA scheduling_spike_private TO bos_definer, bos_maint;
ALTER FUNCTION scheduling_spike_private.erasure_actor(text, uuid) OWNER TO bos_definer;
ALTER FUNCTION scheduling_spike_private.scrub_event_details(text, text, uuid) OWNER TO bos_maint;
-- Execute rights are set while the admin role still belongs to the owners (it may grant on their behalf).
REVOKE ALL ON FUNCTION scheduling_spike_private.erasure_actor(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling_spike_private.erasure_actor(text, uuid) TO bos_maint;
REVOKE ALL ON FUNCTION scheduling_spike_private.scrub_event_details(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling_spike_private.scrub_event_details(text, text, uuid) TO bos_app;
REVOKE CREATE ON SCHEMA scheduling_spike_private FROM bos_definer, bos_maint;
REVOKE bos_definer, bos_maint FROM CURRENT_USER;
