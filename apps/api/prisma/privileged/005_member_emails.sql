-- Administration A2-B: member email addresses for the people who invite (docs/administration-a2.md §3.9,
-- decision D-A2-11). Applied by an ADMINISTRATIVE role with `pnpm db:privileged`, after `prisma migrate
-- deploy` (migration 20261205000000_membership_lifecycle). Idempotent.
--
-- bos_app may read users (id, name, image_url) only; email is not granted, and that grant stays as it
-- is. This SECURITY DEFINER function returns (user_id, email) for the memberships (active or suspended)
-- of the CURRENT business only, read from app.business_id (never a parameter), and only when the
-- session user (app.user_id) is an ACTIVE OWNER, ADMIN or MANAGER of that business: the holders of
-- members:invite in the §5 matrix (MEMBER gets nothing). The API checks members:invite first; this is
-- the database backstop. Deactivated users' emails stay hidden (definer_users_read).

DO $$
BEGIN
  IF NOT has_column_privilege('bos_definer', 'public.users', 'email', 'SELECT') THEN
    RAISE EXCEPTION 'bos_definer cannot read public.users(email): apply 001_trusted_paths.sql first';
  END IF;
  IF NOT has_column_privilege('bos_definer', 'public.memberships', 'business_id', 'SELECT') THEN
    RAISE EXCEPTION 'bos_definer cannot read public.memberships: apply 001_trusted_paths.sql first';
  END IF;
END $$;

-- definer_member_read (001) shows bos_definer ACTIVE memberships only. Suspended members of the
-- CURRENT business must be listed too; this permissive policy adds exactly those rows, and only
-- inside a unit of work that has a business context (pre-tenant calls such as my_memberships and
-- create_business run without one, so they see what they saw before).
DROP POLICY IF EXISTS definer_member_emails_read ON public.memberships;
CREATE POLICY definer_member_emails_read ON public.memberships FOR SELECT TO bos_definer
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

GRANT bos_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA app_private TO bos_definer;
SET ROLE bos_definer;

CREATE OR REPLACE FUNCTION app_private.member_emails()
RETURNS TABLE (user_id uuid, email text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH ctx AS (
    SELECT nullif(current_setting('app.business_id', true), '')::uuid AS business_id,
           nullif(current_setting('app.user_id', true), '')::uuid AS user_id
  )
  SELECT m.user_id, u.email
    FROM ctx
    JOIN public.memberships m ON m.business_id = ctx.business_id
    JOIN public.users u ON u.id = m.user_id
   WHERE EXISTS (SELECT 1 FROM public.memberships a
                  WHERE a.business_id = ctx.business_id AND a.user_id = ctx.user_id
                    AND a.status = 'ACTIVE' AND a.role IN ('OWNER', 'ADMIN', 'MANAGER'))
   ORDER BY m.user_id
$$;

REVOKE ALL ON FUNCTION app_private.member_emails() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.member_emails() TO bos_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM bos_definer;
REVOKE bos_definer FROM CURRENT_USER;
