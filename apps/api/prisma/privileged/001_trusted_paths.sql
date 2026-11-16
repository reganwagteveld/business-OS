-- Pre-tenant trusted paths (data-model §5.5) and their privileges. Applied by an ADMINISTRATIVE role
-- (local/CI: the postgres superuser; Neon: the project's owner role) with `pnpm db:privileged`,
-- AFTER `prisma migrate deploy`. Idempotent: safe to re-run after any change to this file.
--
-- Why not a normal migration: the functions must be owned by bos_definer, a NOLOGIN role that no
-- login role is a member of, and creating the app_private schema needs CREATE on the database.
-- bos_owner has neither, by design.

CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION bos_owner;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO bos_app, bos_definer;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Deployment region, written once at provisioning (the app checks REGION against it).
CREATE TABLE IF NOT EXISTS app_private.deployment_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  region text NOT NULL CHECK (region ~ '^[a-z0-9-]{2,32}$')
);
CREATE TABLE IF NOT EXISTS app_private.reserved_slugs (slug text PRIMARY KEY);
INSERT INTO app_private.reserved_slugs (slug) VALUES
  ('admin'), ('api'), ('app'), ('auth'), ('b'), ('billing'), ('dashboard'), ('help'), ('invite'),
  ('login'), ('logout'), ('me'), ('new'), ('reset-password'), ('settings'), ('sign-in'), ('sign-up'),
  ('signin'), ('signup'), ('static'), ('status'), ('support'), ('www')
ON CONFLICT DO NOTHING;
REVOKE ALL ON app_private.deployment_config, app_private.reserved_slugs FROM PUBLIC;
GRANT SELECT ON app_private.deployment_config, app_private.reserved_slugs TO bos_definer;

-- Table privileges for bos_definer (column-limited), and its row policies: a second layer that
-- limits what any function could touch even with a bug in its body.
GRANT USAGE ON SCHEMA public TO bos_definer;
GRANT SELECT ("id", "token_hash", "user_id", "expires_at", "revoked_at") ON public.sessions TO bos_definer;
GRANT SELECT ("id", "email", "email_verified", "deactivated_at") ON public.users TO bos_definer;
GRANT SELECT ("id", "slug", "name", "archived_at"), INSERT ON public.businesses TO bos_definer;
GRANT SELECT ("id", "business_id", "user_id", "role", "status", "created_at"), INSERT ON public.memberships TO bos_definer;
GRANT SELECT ("id", "business_id", "email", "role", "token_hash", "expires_at", "accepted_at", "revoked_at"),
      UPDATE ("accepted_at") ON public.invitations TO bos_definer;
GRANT INSERT ON public.audit_events TO bos_definer;

DROP POLICY IF EXISTS definer_sessions_read ON public.sessions;
CREATE POLICY definer_sessions_read ON public.sessions FOR SELECT TO bos_definer
  USING (expires_at > now() AND revoked_at IS NULL);
DROP POLICY IF EXISTS definer_users_read ON public.users;
CREATE POLICY definer_users_read ON public.users FOR SELECT TO bos_definer
  USING (deactivated_at IS NULL);
DROP POLICY IF EXISTS definer_business_read ON public.businesses;
CREATE POLICY definer_business_read ON public.businesses FOR SELECT TO bos_definer
  USING (archived_at IS NULL);
DROP POLICY IF EXISTS definer_business_create ON public.businesses;
CREATE POLICY definer_business_create ON public.businesses FOR INSERT TO bos_definer
  WITH CHECK (archived_at IS NULL);
DROP POLICY IF EXISTS definer_member_read ON public.memberships;
CREATE POLICY definer_member_read ON public.memberships FOR SELECT TO bos_definer
  USING (status = 'ACTIVE');
DROP POLICY IF EXISTS definer_member_create ON public.memberships;
CREATE POLICY definer_member_create ON public.memberships FOR INSERT TO bos_definer
  WITH CHECK (status = 'ACTIVE');
DROP POLICY IF EXISTS definer_invite_read ON public.invitations;
-- Accepted rows stay readable so the accepting UPDATE's new row passes the SELECT policy (PostgreSQL
-- checks it when the UPDATE reads the table). Single use is enforced by the UPDATE policy below and
-- by accept_invitation, which only takes rows with accepted_at IS NULL.
CREATE POLICY definer_invite_read ON public.invitations FOR SELECT TO bos_definer
  USING (revoked_at IS NULL AND expires_at > now());
DROP POLICY IF EXISTS definer_invite_accept ON public.invitations;
CREATE POLICY definer_invite_accept ON public.invitations FOR UPDATE TO bos_definer
  USING (accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
  WITH CHECK (accepted_at IS NOT NULL);
DROP POLICY IF EXISTS definer_audit_write ON public.audit_events;
CREATE POLICY definer_audit_write ON public.audit_events FOR INSERT TO bos_definer
  WITH CHECK (business_id IS NOT NULL AND action IN ('business.created', 'invitation.accepted'));

-- Private beta admission (docs/private-beta-lockdown.md). Platform access and business-creation
-- authorisation are separate: an admission lets a user reach the businesses they are members of;
-- only an explicit operator grant (can_create_business) lets them create a business. Nothing is
-- seeded automatically: the initial roster is set with the operator functions below.
CREATE TABLE IF NOT EXISTS app_private.beta_admissions (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  admitted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz, source text NOT NULL
);
ALTER TABLE app_private.beta_admissions ADD COLUMN IF NOT EXISTS can_create_business boolean NOT NULL DEFAULT false;
ALTER TABLE app_private.beta_admissions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE app_private.beta_admissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.beta_admissions FROM PUBLIC, bos_app, bos_auth;
GRANT SELECT, INSERT ON app_private.beta_admissions TO bos_definer;
DROP POLICY IF EXISTS definer_admission_read ON app_private.beta_admissions;
CREATE POLICY definer_admission_read ON app_private.beta_admissions FOR SELECT TO bos_definer USING (true);
-- The only admission a definer function may write: redeeming an invitation, never with creation rights.
DROP POLICY IF EXISTS definer_admission_by_invitation ON app_private.beta_admissions;
CREATE POLICY definer_admission_by_invitation ON app_private.beta_admissions FOR INSERT TO bos_definer
  WITH CHECK (source = 'invitation' AND can_create_business = false AND revoked_at IS NULL);

-- Append-only audit trail of every admission change (operator or invitation). Not tied to a tenant,
-- so it lives here rather than in public.audit_events (which requires a business id).
CREATE TABLE IF NOT EXISTS app_private.beta_admission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('admitted', 'reinstated', 'revoked', 'business_creation_granted',
    'business_creation_withdrawn', 'admitted_by_invitation')),
  operator text NOT NULL CHECK (char_length(operator) BETWEEN 1 AND 100),
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beta_admission_events_user ON app_private.beta_admission_events (user_id, occurred_at);
ALTER TABLE app_private.beta_admission_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.beta_admission_events FROM PUBLIC, bos_app, bos_auth;
GRANT INSERT ON app_private.beta_admission_events TO bos_definer;
DROP POLICY IF EXISTS definer_admission_event ON app_private.beta_admission_events;
CREATE POLICY definer_admission_event ON app_private.beta_admission_events FOR INSERT TO bos_definer
  WITH CHECK (action = 'admitted_by_invitation' AND operator = 'invitation');
CREATE OR REPLACE FUNCTION app_private.beta_admission_events_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$ BEGIN RAISE EXCEPTION 'beta admission history is append-only' USING ERRCODE = '42501'; END $$;
REVOKE ALL ON FUNCTION app_private.beta_admission_events_immutable() FROM PUBLIC;
DROP TRIGGER IF EXISTS beta_admission_events_no_change ON app_private.beta_admission_events;
CREATE TRIGGER beta_admission_events_no_change BEFORE UPDATE OR DELETE ON app_private.beta_admission_events
  FOR EACH ROW EXECUTE FUNCTION app_private.beta_admission_events_immutable();
DROP TRIGGER IF EXISTS beta_admission_events_no_truncate ON app_private.beta_admission_events;
CREATE TRIGGER beta_admission_events_no_truncate BEFORE TRUNCATE ON app_private.beta_admission_events
  FOR EACH STATEMENT EXECUTE FUNCTION app_private.beta_admission_events_immutable();

-- Operator functions: owned by the administrative role that applies this file, executable by nobody
-- else (no grants to any runtime role). Use them through `pnpm db:beta-admission`
-- (scripts/beta-admission.mjs), never from the application. Each change is audited with the
-- operator's name and a reason, and admission never implies business creation.
CREATE OR REPLACE FUNCTION app_private.operator_check_input(p_operator text, p_reason text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_operator IS NULL OR char_length(btrim(p_operator)) NOT BETWEEN 1 AND 100
     OR p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'operator and reason are required' USING ERRCODE = '22023';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_private.operator_admit_user(p_user uuid, p_operator text, p_reason text)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_row app_private.beta_admissions%ROWTYPE;
BEGIN
  PERFORM app_private.operator_check_input(p_operator, p_reason);
  PERFORM 1 FROM public.users u WHERE u.id = p_user AND u.deactivated_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no active user with that id' USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_row FROM app_private.beta_admissions a WHERE a.user_id = p_user FOR UPDATE;
  IF FOUND AND v_row.revoked_at IS NULL THEN RETURN 'already_admitted'; END IF;
  IF FOUND THEN
    UPDATE app_private.beta_admissions SET revoked_at = NULL, can_create_business = false, updated_at = now()
      WHERE user_id = p_user;
    INSERT INTO app_private.beta_admission_events (user_id, action, operator, reason)
      VALUES (p_user, 'reinstated', btrim(p_operator), btrim(p_reason));
    RETURN 'reinstated';
  END IF;
  INSERT INTO app_private.beta_admissions (user_id, source) VALUES (p_user, 'operator');
  INSERT INTO app_private.beta_admission_events (user_id, action, operator, reason)
    VALUES (p_user, 'admitted', btrim(p_operator), btrim(p_reason));
  RETURN 'admitted';
END $$;

CREATE OR REPLACE FUNCTION app_private.operator_revoke_user(p_user uuid, p_operator text, p_reason text)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM app_private.operator_check_input(p_operator, p_reason);
  -- Revocation also withdraws business creation; reinstating never restores it implicitly.
  UPDATE app_private.beta_admissions SET revoked_at = now(), can_create_business = false, updated_at = now()
    WHERE user_id = p_user AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN 'not_admitted'; END IF;
  INSERT INTO app_private.beta_admission_events (user_id, action, operator, reason)
    VALUES (p_user, 'revoked', btrim(p_operator), btrim(p_reason));
  RETURN 'revoked';
END $$;

CREATE OR REPLACE FUNCTION app_private.operator_set_business_creation(p_user uuid, p_allowed boolean, p_operator text, p_reason text)
RETURNS text LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_current boolean;
BEGIN
  PERFORM app_private.operator_check_input(p_operator, p_reason);
  IF p_allowed IS NULL THEN RAISE EXCEPTION 'allowed must be true or false' USING ERRCODE = '22023'; END IF;
  SELECT a.can_create_business INTO v_current FROM app_private.beta_admissions a
    WHERE a.user_id = p_user AND a.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'user is not admitted' USING ERRCODE = '22023'; END IF;
  IF v_current = p_allowed THEN RETURN 'unchanged'; END IF;
  UPDATE app_private.beta_admissions SET can_create_business = p_allowed, updated_at = now() WHERE user_id = p_user;
  INSERT INTO app_private.beta_admission_events (user_id, action, operator, reason)
    VALUES (p_user, CASE WHEN p_allowed THEN 'business_creation_granted' ELSE 'business_creation_withdrawn' END,
      btrim(p_operator), btrim(p_reason));
  RETURN CASE WHEN p_allowed THEN 'granted' ELSE 'withdrawn' END;
END $$;

REVOKE ALL ON FUNCTION app_private.operator_check_input(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.operator_admit_user(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.operator_revoke_user(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.operator_set_business_creation(uuid, boolean, text, text) FROM PUBLIC;

-- Functions are created as bos_definer so it owns them. The administrative role needs membership in
-- bos_definer only for this block; it is revoked again at the end (schema test checks pg_auth_members).
GRANT bos_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA app_private TO bos_definer;
SET ROLE bos_definer;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- Resolves a raw session token to a live, verified-or-not user. Internal helper: not executable by
-- any login role; only the functions below (same owner) call it. No function takes a user id.
CREATE OR REPLACE FUNCTION app_private.session_user_id(p_session_token text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT s.user_id
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id
  WHERE s.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_session_token, 'UTF8')), 'hex')
    AND s.expires_at > pg_catalog.now()
    AND s.revoked_at IS NULL
    AND u.deactivated_at IS NULL
$$;

-- Admission is independent of membership and cannot be supplied by a client.
CREATE OR REPLACE FUNCTION app_private.beta_user_admitted(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM app_private.beta_admissions a JOIN public.users u ON u.id = a.user_id
    WHERE a.user_id = p_user AND a.revoked_at IS NULL AND u.deactivated_at IS NULL)
$$;

-- Registration eligibility is not admission: verify the email and redeem the token first.
CREATE OR REPLACE FUNCTION app_private.beta_can_register(p_email text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.invitations i JOIN public.businesses b ON b.id = i.business_id
    WHERE i.email = pg_catalog.lower(pg_catalog.btrim(p_email))
      AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > pg_catalog.now()
      AND b.archived_at IS NULL)
$$;

-- A pending invite permits a session for redemption only. Revocation overrides pending invites.
CREATE OR REPLACE FUNCTION app_private.beta_can_sign_in(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user AND u.deactivated_at IS NULL
    AND (app_private.beta_user_admitted(u.id) OR
      (NOT EXISTS (SELECT 1 FROM app_private.beta_admissions a WHERE a.user_id = u.id)
       AND app_private.beta_can_register(u.email))))
$$;
CREATE OR REPLACE FUNCTION app_private.beta_session_admitted(p_token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT app_private.beta_user_admitted(app_private.session_user_id(p_token)) $$;

-- Business creation is a separate, explicit platform grant on top of admission.
CREATE OR REPLACE FUNCTION app_private.beta_user_can_create_business(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT app_private.beta_user_admitted(p_user) AND EXISTS (SELECT 1 FROM app_private.beta_admissions a
    WHERE a.user_id = p_user AND a.revoked_at IS NULL AND a.can_create_business)
$$;
CREATE OR REPLACE FUNCTION app_private.beta_session_can_create_business(p_token text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT app_private.beta_user_can_create_business(app_private.session_user_id(p_token)) $$;

REVOKE ALL ON FUNCTION app_private.beta_user_admitted(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.beta_can_register(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.beta_can_sign_in(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.beta_session_admitted(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.beta_user_can_create_business(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.beta_session_can_create_business(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.beta_can_register(text), app_private.beta_can_sign_in(uuid),
  app_private.beta_session_admitted(text), app_private.beta_session_can_create_business(text) TO bos_app;

-- The caller's active memberships in unarchived businesses (switcher and tenant resolution).
CREATE OR REPLACE FUNCTION app_private.my_memberships(p_session_token text)
RETURNS TABLE (business_id uuid, slug text, name text, role public."MembershipRole", membership_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT b.id, b.slug, b.name, m.role, m.id
  FROM public.memberships m
  JOIN public.businesses b ON b.id = m.business_id
  WHERE m.user_id = app_private.session_user_id(p_session_token)
    AND app_private.beta_session_admitted(p_session_token)
    AND m.status = 'ACTIVE'
    AND b.archived_at IS NULL
  ORDER BY b.name, b.id
$$;

-- Creates a business, the caller's OWNER membership and an audit event in one statement. The region
-- is never a parameter: it comes from deployment_config.
CREATE OR REPLACE FUNCTION app_private.create_business(
  p_session_token text, p_name text, p_slug text, p_country_code text, p_time_zone text, p_locale text, p_currency text)
RETURNS TABLE (business_id uuid, slug text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_verified boolean;
  v_region text;
  v_business uuid := pg_catalog.gen_random_uuid();
BEGIN
  v_user := app_private.session_user_id(p_session_token);
  SELECT u.email_verified INTO v_verified FROM public.users u WHERE u.id = v_user;
  IF v_user IS NULL OR v_verified IS NOT TRUE OR NOT app_private.beta_user_can_create_business(v_user) THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  SELECT c.region INTO v_region FROM app_private.deployment_config c;
  IF v_region IS NULL THEN
    RAISE EXCEPTION 'deployment region not configured' USING ERRCODE = '55000';
  END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 200
     OR p_slug IS NULL OR p_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'
     OR EXISTS (SELECT 1 FROM app_private.reserved_slugs r WHERE r.slug = p_slug)
     OR p_country_code IS NULL OR p_country_code !~ '^[A-Z]{2}$'
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$'
     OR p_locale IS NULL OR p_locale !~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'
     OR p_time_zone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names t WHERE t.name = p_time_zone) THEN
    RAISE EXCEPTION 'invalid business details' USING ERRCODE = '22023';
  END IF;
  -- At most 5 businesses created per user per 24 hours (in addition to app-layer limits).
  IF (SELECT count(*) FROM public.memberships m
      WHERE m.user_id = v_user AND m.role = 'OWNER' AND m.created_at > pg_catalog.now() - interval '24 hours') >= 5 THEN
    RAISE EXCEPTION 'too many businesses created' USING ERRCODE = '54000';
  END IF;
  BEGIN
    INSERT INTO public.businesses (id, name, slug, country_code, time_zone, locale, currency, home_region)
    VALUES (v_business, btrim(p_name), p_slug, p_country_code, p_time_zone, p_locale, p_currency, v_region);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'slug unavailable' USING ERRCODE = '23505';
  END;
  INSERT INTO public.memberships (id, business_id, user_id, role, status)
  VALUES (pg_catalog.gen_random_uuid(), v_business, v_user, 'OWNER', 'ACTIVE');
  INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id)
  VALUES (pg_catalog.gen_random_uuid(), v_business, v_user, 'business.created', 'business', v_business);
  RETURN QUERY SELECT v_business, p_slug;
END $$;

-- Accepts an invitation for the caller, whose VERIFIED email must equal the invitation email.
-- Every failure raises the same generic error. The row lock makes acceptance and revocation (a
-- conditional UPDATE on the same row, modules/tenancy) mutually exclusive: whichever locks first
-- wins, and the other re-checks the committed row (A2-B, docs/administration-a2.md §6.2). The open
-- conditions are stated here as well as in the bos_definer row policies.
CREATE OR REPLACE FUNCTION app_private.accept_invitation(p_session_token text, p_invite_token text)
RETURNS TABLE (business_id uuid, slug text, role public."MembershipRole")
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_email text;
  v_verified boolean;
  v_invite record;
  v_slug text;
  v_admitted integer;
BEGIN
  v_user := app_private.session_user_id(p_session_token);
  SELECT u.email, u.email_verified INTO v_email, v_verified FROM public.users u WHERE u.id = v_user;
  SELECT i.id, i.business_id, i.email, i.role INTO v_invite
  FROM public.invitations i
  WHERE i.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_invite_token, ''), 'UTF8')), 'hex')
    AND i.accepted_at IS NULL
    AND i.revoked_at IS NULL
    AND i.expires_at > pg_catalog.now()
  FOR UPDATE;
  SELECT b.slug INTO v_slug FROM public.businesses b WHERE b.id = v_invite.business_id;
  IF v_user IS NULL OR v_verified IS NOT TRUE OR v_invite.id IS NULL OR v_slug IS NULL
     OR pg_catalog.lower(v_email) <> v_invite.email
     OR EXISTS (SELECT 1 FROM app_private.beta_admissions a WHERE a.user_id = v_user AND a.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'invitation not valid' USING ERRCODE = '42501';
  END IF;
  BEGIN
    INSERT INTO public.memberships (id, business_id, user_id, role, status)
    VALUES (pg_catalog.gen_random_uuid(), v_invite.business_id, v_user, v_invite.role, 'ACTIVE');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'invitation not valid' USING ERRCODE = '42501';
  END;
  -- Redemption admits the user to the platform (never with business creation) and records it.
  INSERT INTO app_private.beta_admissions (user_id, source) VALUES (v_user, 'invitation')
    ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS v_admitted = ROW_COUNT;
  IF v_admitted = 1 THEN
    INSERT INTO app_private.beta_admission_events (user_id, action, operator, reason)
    VALUES (v_user, 'admitted_by_invitation', 'invitation', 'invitation ' || v_invite.id::text);
  END IF;
  UPDATE public.invitations SET accepted_at = pg_catalog.now() WHERE id = v_invite.id;
  INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id)
  VALUES (pg_catalog.gen_random_uuid(), v_invite.business_id, v_user, 'invitation.accepted', 'invitation', v_invite.id);
  RETURN QUERY SELECT v_invite.business_id, v_slug, v_invite.role;
END $$;

-- Execute rights (set as the owner): only bos_app may call the three public functions; nobody
-- calls the helper directly.
REVOKE ALL ON FUNCTION app_private.session_user_id(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.my_memberships(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.create_business(text, text, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.accept_invitation(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.my_memberships(text) TO bos_app;
GRANT EXECUTE ON FUNCTION app_private.create_business(text, text, text, text, text, text, text) TO bos_app;
GRANT EXECUTE ON FUNCTION app_private.accept_invitation(text, text) TO bos_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM bos_definer;
REVOKE bos_definer FROM CURRENT_USER;
