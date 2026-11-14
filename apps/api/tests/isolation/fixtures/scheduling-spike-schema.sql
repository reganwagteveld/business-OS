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
CREATE TABLE businesses (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, time_zone text NOT NULL DEFAULT 'America/New_York');
CREATE TABLE memberships (
  id uuid PRIMARY KEY, business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE, user_id uuid NOT NULL,
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
GRANT SELECT, INSERT, UPDATE ON schedule_resources, schedule_events, schedule_event_details TO bos_app;
GRANT SELECT, INSERT ON schedule_event_resources TO bos_app;
GRANT UPDATE (removed_at, removed_by_id, removal_reason) ON schedule_event_resources TO bos_app;

-- Standard tenant policy on every table (businesses by id).
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON businesses FOR ALL TO bos_app
  USING (id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.business_id', true), '')::uuid);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['memberships','customers','contacts','projects','project_tasks','schedule_resources','schedule_events','schedule_event_details','schedule_event_resources'] LOOP
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
-- Owned by bos_maint (NOLOGIN, no login role is a member), SECURITY DEFINER, fixed search_path, limited
-- to the CURRENT tenant, scrubs named columns only and returns a count, never content. bos_maint has its
-- own tenant-limited policy: without it a definer under FORCE RLS silently matches 0 rows (finding F2).
GRANT SELECT ON scheduling_spike.schedule_event_details TO bos_maint;
GRANT UPDATE (title, description, location, cancel_reason, customer_id, contact_id) ON scheduling_spike.schedule_event_details TO bos_maint;
CREATE POLICY maint_scrub ON scheduling_spike.schedule_event_details FOR ALL TO bos_maint
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

CREATE FUNCTION scheduling_spike_private.scrub_event_details(p_subject text, p_subject_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  b uuid := nullif(current_setting('app.business_id', true), '')::uuid;
  n integer;
BEGIN
  IF b IS NULL OR nullif(current_setting('app.user_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
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
  RETURN n;
END $$;
-- Hand the function to bos_maint the way privileged/001 hands functions to bos_definer: the admin role
-- (Neon's owner role is not a superuser) joins bos_maint only for the ownership change.
-- A new owner needs CREATE on the function's schema, so bos_maint holds it only for the change (as
-- bos_definer does on app_private in privileged/001). Found on Neon: a superuser skips this check.
GRANT bos_maint TO CURRENT_USER;
GRANT CREATE ON SCHEMA scheduling_spike_private TO bos_maint;
ALTER FUNCTION scheduling_spike_private.scrub_event_details(text, uuid) OWNER TO bos_maint;
REVOKE CREATE ON SCHEMA scheduling_spike_private FROM bos_maint;
REVOKE bos_maint FROM CURRENT_USER;
REVOKE ALL ON FUNCTION scheduling_spike_private.scrub_event_details(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scheduling_spike_private.scrub_event_details(text, uuid) TO bos_app;
GRANT USAGE ON SCHEMA scheduling_spike_private TO bos_maint;
