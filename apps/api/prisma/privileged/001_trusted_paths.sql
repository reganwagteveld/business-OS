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
CREATE POLICY definer_invite_read ON public.invitations FOR SELECT TO bos_definer
  USING (accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now());
DROP POLICY IF EXISTS definer_invite_accept ON public.invitations;
CREATE POLICY definer_invite_accept ON public.invitations FOR UPDATE TO bos_definer
  USING (accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
  WITH CHECK (accepted_at IS NOT NULL);
DROP POLICY IF EXISTS definer_audit_write ON public.audit_events;
CREATE POLICY definer_audit_write ON public.audit_events FOR INSERT TO bos_definer
  WITH CHECK (business_id IS NOT NULL AND action IN ('business.created', 'invitation.accepted'));

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
  IF v_user IS NULL OR v_verified IS NOT TRUE THEN
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
-- Every failure raises the same generic error.
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
BEGIN
  v_user := app_private.session_user_id(p_session_token);
  SELECT u.email, u.email_verified INTO v_email, v_verified FROM public.users u WHERE u.id = v_user;
  SELECT i.id, i.business_id, i.email, i.role INTO v_invite
  FROM public.invitations i
  WHERE i.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_invite_token, ''), 'UTF8')), 'hex')
  FOR UPDATE;
  SELECT b.slug INTO v_slug FROM public.businesses b WHERE b.id = v_invite.business_id;
  IF v_user IS NULL OR v_verified IS NOT TRUE OR v_invite.id IS NULL OR v_slug IS NULL
     OR pg_catalog.lower(v_email) <> v_invite.email THEN
    RAISE EXCEPTION 'invitation not valid' USING ERRCODE = '42501';
  END IF;
  BEGIN
    INSERT INTO public.memberships (id, business_id, user_id, role, status)
    VALUES (pg_catalog.gen_random_uuid(), v_invite.business_id, v_user, v_invite.role, 'ACTIVE');
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'invitation not valid' USING ERRCODE = '42501';
  END;
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
