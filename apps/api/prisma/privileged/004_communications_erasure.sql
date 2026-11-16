-- Communications E1 erasure pathway (docs/communications-e1.md §5-§9). Applied by an ADMINISTRATIVE role with
-- `pnpm db:privileged`, after `prisma migrate deploy` has run 20261129000000_communications_erasure.
-- Idempotent: safe to re-run.
--
-- Why privileged: message history is read-only for the application (no UPDATE/DELETE grant for bos_app,
-- triggers CM001/CM002). Removing content is the one change that must still be possible, so it is done by
-- functions owned by bos_maint, a NOLOGIN role that no login role is a member of. The table triggers let
-- bos_maint (and only bos_maint) turn a row into an erasure tombstone once. Every privilege below is
-- column-limited and has a tenant row policy, so even a bug in a function body cannot reach another business.
--
-- Two kinds of authority:
--   * Request-based erasure, hold release and an early retention reduction need a LIVE OWNER/ADMIN session
--     (OWNER only for the reduction), verified here from the raw session token (never from app.user_id,
--     which bos_app can set), and a single-use authorisation code created for exactly that operation and
--     target by the same user within the last 5 minutes (replay protection, D-E1-4).
--   * The worker (no user) can only (a) continue a request that was created through that path and
--     (b) erase copies the database itself computes as past their retention period and not held. It cannot
--     choose what to erase.
-- Functions return ids, codes and counts only, never content.

DO $$
BEGIN
  IF NOT has_column_privilege('bos_definer', 'public.sessions', 'token_hash', 'SELECT') THEN
    RAISE EXCEPTION 'apply 001_trusted_paths.sql first';
  END IF;
  IF to_regclass('public.communications_erasures') IS NULL THEN
    RAISE EXCEPTION 'apply migration 20261129000000_communications_erasure first';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app_private TO bos_maint;

-- ---- bos_definer: verify the session, list due businesses (ids only) --------------------------------------
GRANT SELECT ("business_id", "kind", "status", "next_attempt_at") ON public.communications_erasures TO bos_definer;
GRANT SELECT ("business_id", "retention_category", "occurred_at", "recorded_at", "erased_at") ON public.messages TO bos_definer;
GRANT SELECT ("business_id", "ordinary_retention_days", "previous_retention_days", "shortening_effective_at") ON public.mail_retention_settings TO bos_definer;
GRANT SELECT ("business_id", "scope", "released_at") ON public.communications_legal_holds TO bos_definer;
GRANT EXECUTE ON FUNCTION public.mail_effective_ordinary_days(integer, integer, timestamptz),
  public.mail_retention_due_at(text, timestamptz, timestamptz, integer) TO bos_definer;
DROP POLICY IF EXISTS definer_erasure_due_read ON public.communications_erasures;
CREATE POLICY definer_erasure_due_read ON public.communications_erasures FOR SELECT TO bos_definer
  USING (kind = 'REQUEST' AND status IN ('PENDING', 'DEFERRED'));
DROP POLICY IF EXISTS definer_retention_due_read ON public.messages;
CREATE POLICY definer_retention_due_read ON public.messages FOR SELECT TO bos_definer
  USING (erased_at IS NULL AND retention_category IS NOT NULL);
DROP POLICY IF EXISTS definer_retention_due_read ON public.mail_retention_settings;
CREATE POLICY definer_retention_due_read ON public.mail_retention_settings FOR SELECT TO bos_definer USING (true);
DROP POLICY IF EXISTS definer_retention_due_read ON public.communications_legal_holds;
CREATE POLICY definer_retention_due_read ON public.communications_legal_holds FOR SELECT TO bos_definer
  USING (released_at IS NULL AND scope = 'BUSINESS');

GRANT bos_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA app_private TO bos_definer;
SET ROLE bos_definer;

-- The verified OWNER/ADMIN (OWNER only when p_owner_only) of the CURRENT business behind a raw session token,
-- or NULL. Same session rules as app_private.session_user_id, plus a verified email, an ACTIVE membership and
-- an unarchived business. Executable by bos_maint only (the erasure functions); bos_app cannot call it.
CREATE OR REPLACE FUNCTION app_private.communications_erasure_actor(p_session_token text, p_owner_only boolean)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id
    FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
    JOIN public.memberships m ON m.user_id = u.id
    JOIN public.businesses b ON b.id = m.business_id
   WHERE s.token_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_session_token, 'UTF8')), 'hex')
     AND s.expires_at > pg_catalog.now() AND s.revoked_at IS NULL
     AND u.deactivated_at IS NULL AND u.email_verified IS TRUE
     AND m.business_id = nullif(pg_catalog.current_setting('app.business_id', true), '')::uuid
     AND m.status = 'ACTIVE'
     AND (m.role = 'OWNER' OR (m.role = 'ADMIN' AND NOT coalesce(p_owner_only, true)))
     AND b.archived_at IS NULL
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app_private.communications_erasure_actor(text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.communications_erasure_actor(text, boolean) TO bos_maint;

-- Businesses (not archived) with erasure work: an open request whose next attempt is due, or a categorised,
-- unerased copy past its retention, with no business-wide hold. Ids only. p_limit clamped to 1..500.
CREATE OR REPLACE FUNCTION app_private.communications_erasure_due(p_limit integer)
RETURNS TABLE (business_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH due AS (
    SELECT e.business_id, pg_catalog.min(e.next_attempt_at) AS due_at
      FROM public.communications_erasures e
     WHERE e.kind = 'REQUEST' AND e.status IN ('PENDING', 'DEFERRED') AND e.next_attempt_at <= pg_catalog.now()
     GROUP BY e.business_id
    UNION ALL
    SELECT m.business_id, pg_catalog.min(m.occurred_at)
      FROM public.messages m
      LEFT JOIN public.mail_retention_settings r ON r.business_id = m.business_id
     WHERE m.erased_at IS NULL AND m.retention_category IS NOT NULL
       AND public.mail_retention_due_at(m.retention_category, m.occurred_at, m.recorded_at,
             public.mail_effective_ordinary_days(r.ordinary_retention_days, r.previous_retention_days, r.shortening_effective_at)) <= pg_catalog.now()
       AND NOT EXISTS (SELECT 1 FROM public.communications_legal_holds h WHERE h.business_id = m.business_id AND h.scope = 'BUSINESS' AND h.released_at IS NULL)
     GROUP BY m.business_id
  )
  SELECT d.business_id
    FROM due d
    JOIN public.businesses b ON b.id = d.business_id
   GROUP BY d.business_id
   ORDER BY pg_catalog.min(d.due_at), d.business_id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;
REVOKE ALL ON FUNCTION app_private.communications_erasure_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.communications_erasure_due(integer) TO bos_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM bos_definer;
REVOKE bos_definer FROM CURRENT_USER;

-- ---- bos_maint: column-limited rights and tenant row policies ----------------------------------------------
-- Reads are limited to what selection needs; contacts.email and participants.address are read only to match a
-- contact's own address (never returned). Updates are limited to the content and marker columns.
GRANT SELECT ("id", "business_id", "conversation_id", "retention_category", "occurred_at", "recorded_at", "erased_at",
              "external_source", "external_message_id") ON public.messages TO bos_maint;
GRANT UPDATE ("subject", "body", "external_source", "external_message_id", "content_hash", "erased_at") ON public.messages TO bos_maint;
GRANT SELECT ("id", "business_id", "message_id", "role", "address", "contact_id", "user_id", "erased_at") ON public.message_participants TO bos_maint;
GRANT UPDATE ("display_name", "address", "erased_at") ON public.message_participants TO bos_maint;
GRANT SELECT ("id", "business_id", "contact_id", "external_source", "external_thread_id", "erased_at") ON public.conversations TO bos_maint;
GRANT UPDATE ("subject", "external_source", "external_thread_id", "erased_at", "updated_at") ON public.conversations TO bos_maint;
GRANT SELECT ("id", "business_id", "type", "contact_id", "erased_at", "subject", "body") ON public.activities TO bos_maint;
GRANT UPDATE ("subject", "body", "erased_at", "updated_at") ON public.activities TO bos_maint;
GRANT SELECT ("id", "business_id", "email") ON public.contacts TO bos_maint;
GRANT SELECT ("id", "business_id", "scope", "contact_id", "connection_id", "released_at") ON public.communications_legal_holds TO bos_maint;
GRANT UPDATE ("released_at", "released_by_id") ON public.communications_legal_holds TO bos_maint;
GRANT SELECT ("business_id", "ordinary_retention_days", "previous_retention_days", "shortening_effective_at") ON public.mail_retention_settings TO bos_maint;
GRANT UPDATE ("previous_retention_days", "shortening_effective_at", "updated_at") ON public.mail_retention_settings TO bos_maint;
GRANT SELECT, INSERT, UPDATE ON public.communications_erasures TO bos_maint;
GRANT SELECT, INSERT ON public.communications_erasure_items TO bos_maint;
GRANT SELECT, INSERT, UPDATE ("expires_at"), DELETE ON public.communications_erased_references TO bos_maint;
GRANT SELECT, INSERT ON public.communications_erasure_keys TO bos_maint;
GRANT SELECT, INSERT, UPDATE ("consumed_at"), DELETE ON public.communications_privileged_grants TO bos_maint;
GRANT INSERT ON public.audit_events TO bos_maint;
GRANT EXECUTE ON FUNCTION public.mail_effective_ordinary_days(integer, integer, timestamptz),
  public.mail_retention_due_at(text, timestamptz, timestamptz, integer),
  public.communications_message_held(uuid, uuid), public.communications_contact_held(uuid, uuid) TO bos_maint;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages', 'message_participants', 'conversations', 'activities', 'contacts', 'communications_legal_holds',
    'mail_retention_settings', 'communications_erasures', 'communications_erasure_items', 'communications_erased_references',
    'communications_erasure_keys', 'communications_privileged_grants'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS maint_tenant ON public.%I', t);
    EXECUTE format($p$CREATE POLICY maint_tenant ON public.%I FOR ALL TO bos_maint
      USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
      WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Erasure audit events: only this action family, only for the current business. Requests carry the verified
-- actor; worker events carry none. bos_app is barred from the family by audit_no_app_erasure_events.
DROP POLICY IF EXISTS maint_erasure_audit ON public.audit_events;
CREATE POLICY maint_erasure_audit ON public.audit_events FOR INSERT TO bos_maint
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid AND action LIKE 'communications.erasure.%');

GRANT bos_maint TO CURRENT_USER;
GRANT CREATE ON SCHEMA app_private TO bos_maint;
SET ROLE bos_maint;

-- The business of the unit of work (set by withTenant). Every function works on it alone.
CREATE OR REPLACE FUNCTION app_private.communications_business()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v uuid := nullif(pg_catalog.current_setting('app.business_id', true), '')::uuid;
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;
  RETURN v;
END $$;

-- 32 random bytes as 64 hex characters (gen_random_uuid is a CSPRNG; two v4 uuids give 244 random bits).
CREATE OR REPLACE FUNCTION app_private.communications_random_hex()
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '') || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')
$$;

-- The business's reference key, created on first use. Never leaves the database.
CREATE OR REPLACE FUNCTION app_private.communications_reference_key(p_business uuid)
RETURNS bytea LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v bytea;
BEGIN
  SELECT k.secret INTO v FROM public.communications_erasure_keys k WHERE k.business_id = p_business;
  IF v IS NULL THEN
    INSERT INTO public.communications_erasure_keys (business_id, secret)
    VALUES (p_business, pg_catalog.decode(app_private.communications_random_hex(), 'hex'))
    ON CONFLICT (business_id) DO NOTHING;
    SELECT k.secret INTO v FROM public.communications_erasure_keys k WHERE k.business_id = p_business;
  END IF;
  RETURN v;
END $$;

-- HMAC-SHA256(key, kind:source:identifier) in hex: keyed and one-way, so an erased provider id cannot be
-- recovered from the marker, and markers of different businesses cannot be correlated (D-E1-2).
CREATE OR REPLACE FUNCTION app_private.communications_reference_digest(p_business uuid, p_kind text, p_source text, p_identifier text)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_key bytea := app_private.communications_reference_key(p_business);
  v_ipad bytea := ''::bytea;
  v_opad bytea := ''::bytea;
  i integer;
BEGIN
  v_key := v_key || pg_catalog.decode(pg_catalog.repeat('00', 32), 'hex');  -- pad the 32-byte key to the 64-byte block
  FOR i IN 0..63 LOOP
    v_ipad := v_ipad || pg_catalog.set_byte('\x00'::bytea, 0, pg_catalog.get_byte(v_key, i) # 54);
    v_opad := v_opad || pg_catalog.set_byte('\x00'::bytea, 0, pg_catalog.get_byte(v_key, i) # 92);
  END LOOP;
  RETURN pg_catalog.encode(pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad ||
    pg_catalog.convert_to(p_kind || ':' || p_source || ':' || p_identifier, 'UTF8'))), 'hex');
END $$;

-- Marker expiry (D-E1-2, docs/communications-e1.md §6): a marker exists to stop the same provider item being
-- imported or synced again. Providers re-deliver at most the approved backfill window (365 days, D-C2-7), so a
-- marker is kept until 395 days after the message's own date, and at least 30 days after erasure.
CREATE OR REPLACE FUNCTION app_private.communications_reference_expiry(p_occurred_at timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT greatest(pg_catalog.now() + interval '30 days', coalesce(p_occurred_at, pg_catalog.now()) + interval '395 days')
$$;

CREATE OR REPLACE FUNCTION app_private.communications_remember_reference(p_business uuid, p_kind text, p_source text, p_identifier text, p_occurred_at timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_source IS NULL OR p_identifier IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO public.communications_erased_references (business_id, kind, digest, expires_at)
  VALUES (p_business, p_kind, app_private.communications_reference_digest(p_business, p_kind, p_source, p_identifier),
          app_private.communications_reference_expiry(p_occurred_at))
  ON CONFLICT (business_id, kind, digest) DO UPDATE SET expires_at = greatest(public.communications_erased_references.expires_at, EXCLUDED.expires_at);
END $$;

-- Tombstones one message: subject, body and provider ids removed, a content hash that no longer derives from
-- the content, every participant's name and address removed. Returns the participants changed, or -1 if the
-- message was already erased (idempotent). The caller holds the row lock.
CREATE OR REPLACE FUNCTION app_private.communications_tombstone_message(p_business uuid, p_message uuid, p_erasure uuid)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_source text;
  v_external text;
  v_occurred timestamptz;
  v_parts integer;
BEGIN
  SELECT m.external_source, m.external_message_id, m.occurred_at INTO v_source, v_external, v_occurred
    FROM public.messages m WHERE m.business_id = p_business AND m.id = p_message AND m.erased_at IS NULL;
  IF NOT FOUND THEN
    RETURN -1;
  END IF;
  PERFORM app_private.communications_remember_reference(p_business, 'MESSAGE', v_source, v_external, v_occurred);
  UPDATE public.messages m
     SET subject = NULL, body = NULL, external_source = NULL, external_message_id = NULL, erased_at = pg_catalog.now(),
         content_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('erased:' || m.id::text, 'UTF8')), 'hex')
   WHERE m.business_id = p_business AND m.id = p_message;
  INSERT INTO public.communications_erasure_items (business_id, erasure_id, entity_type, entity_id, action)
  VALUES (p_business, p_erasure, 'MESSAGE', p_message, 'ERASED') ON CONFLICT DO NOTHING;
  WITH changed AS (
    UPDATE public.message_participants p SET display_name = NULL, address = NULL, erased_at = pg_catalog.now()
     WHERE p.business_id = p_business AND p.message_id = p_message AND p.erased_at IS NULL
    RETURNING p.id
  ), logged AS (
    INSERT INTO public.communications_erasure_items (business_id, erasure_id, entity_type, entity_id, action)
    SELECT p_business, p_erasure, 'PARTICIPANT', c.id, 'ERASED' FROM changed c ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT pg_catalog.count(*) INTO v_parts FROM changed;
  RETURN v_parts;
END $$;

CREATE OR REPLACE FUNCTION app_private.communications_tombstone_conversation(p_business uuid, p_conversation uuid, p_erasure uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_source text;
  v_thread text;
BEGIN
  SELECT c.external_source, c.external_thread_id INTO v_source, v_thread
    FROM public.conversations c WHERE c.business_id = p_business AND c.id = p_conversation AND c.erased_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM app_private.communications_remember_reference(p_business, 'THREAD', v_source, v_thread, NULL);
  UPDATE public.conversations c SET subject = NULL, external_source = NULL, external_thread_id = NULL, erased_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE c.business_id = p_business AND c.id = p_conversation;
  INSERT INTO public.communications_erasure_items (business_id, erasure_id, entity_type, entity_id, action)
  VALUES (p_business, p_erasure, 'CONVERSATION', p_conversation, 'ERASED') ON CONFLICT DO NOTHING;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION app_private.communications_tombstone_activity(p_business uuid, p_activity uuid, p_erasure uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.activities a SET subject = NULL, body = NULL, erased_at = pg_catalog.now(), updated_at = pg_catalog.now()
   WHERE a.business_id = p_business AND a.id = p_activity AND a.erased_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.communications_erasure_items (business_id, erasure_id, entity_type, entity_id, action)
  VALUES (p_business, p_erasure, 'ACTIVITY', p_activity, 'ERASED') ON CONFLICT DO NOTHING;
  RETURN true;
END $$;

-- What a request still has to do with messages, in id order, non-deferred first (docs/communications-e1.md §5).
--   MESSAGE / CONVERSATION target: every unerased message, FULL.
--   CONTACT target (T-C2-3 with Regan's safeguards, D-E1-6): a participant row "matches" the contact by contact
--   link or by the contact's own email address. A message is in scope if a participant matches or its
--   conversation is filed under the contact. FULL (content removed) when the contact wrote it, or when there is
--   no other non-member participant. Otherwise PARTIAL: only the contact's participant rows are scrubbed, the
--   body is kept for the other people in it and the message is listed for review (quoted text may remain).
--   A message under a legal hold, or classified as a retained record, is reported with a deferral reason and
--   is not touched.
CREATE OR REPLACE FUNCTION app_private.communications_erasure_plan(p_business uuid, p_type text, p_target uuid, p_only uuid[], p_limit integer)
RETURNS TABLE (message_id uuid, conversation_id uuid, mode text, deferred_reason text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH tgt AS (
    SELECT pg_catalog.lower(ct.email) AS email FROM public.contacts ct
     WHERE p_type = 'CONTACT' AND ct.business_id = p_business AND ct.id = p_target
  ), scope AS (
    SELECT m.id, m.conversation_id, m.retention_category
      FROM public.messages m
      JOIN public.conversations c ON c.business_id = m.business_id AND c.id = m.conversation_id
     WHERE m.business_id = p_business AND m.erased_at IS NULL
       AND (p_only IS NULL OR m.id = ANY (p_only))
       AND CASE p_type
             WHEN 'MESSAGE' THEN m.id = p_target
             WHEN 'CONVERSATION' THEN m.conversation_id = p_target
             WHEN 'CONTACT' THEN (c.contact_id = p_target OR EXISTS (
               SELECT 1 FROM public.message_participants p
                WHERE p.business_id = p_business AND p.message_id = m.id
                  AND (p.contact_id = p_target OR (p.address IS NOT NULL AND pg_catalog.lower(p.address) = (SELECT email FROM tgt)))))
             ELSE false
           END
  ), classified AS (
    SELECT s.id, s.conversation_id,
      CASE
        WHEN p_type <> 'CONTACT' THEN 'FULL'
        WHEN EXISTS (SELECT 1 FROM public.message_participants p
                      WHERE p.business_id = p_business AND p.message_id = s.id AND p.role = 'FROM'
                        AND (p.contact_id = p_target OR (p.address IS NOT NULL AND pg_catalog.lower(p.address) = (SELECT email FROM tgt)))) THEN 'FULL'
        WHEN NOT EXISTS (SELECT 1 FROM public.message_participants p
                          WHERE p.business_id = p_business AND p.message_id = s.id AND p.user_id IS NULL
                            AND p.contact_id IS DISTINCT FROM p_target
                            AND NOT (p.address IS NOT NULL AND pg_catalog.lower(p.address) IS NOT DISTINCT FROM (SELECT email FROM tgt))) THEN 'FULL'
        ELSE 'PARTIAL'
      END AS mode,
      CASE
        WHEN public.communications_message_held(p_business, s.id) THEN 'LEGAL_HOLD'
        WHEN s.retention_category = 'RETAINED_RECORD' THEN 'RETAINED_RECORD'
      END AS deferred_reason
    FROM scope s
  )
  SELECT k.id, k.conversation_id, k.mode, k.deferred_reason
    FROM classified k
   WHERE k.mode = 'FULL' OR EXISTS (
     SELECT 1 FROM public.message_participants p
      WHERE p.business_id = p_business AND p.message_id = k.id AND p.erased_at IS NULL
        AND (p.contact_id = p_target OR (p.address IS NOT NULL AND pg_catalog.lower(p.address) = (SELECT email FROM tgt))))
   ORDER BY (k.deferred_reason IS NOT NULL), k.id
   LIMIT least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;

-- Issues a single-use authorisation for one high-risk operation on one target, bound to the verified caller,
-- valid for 5 minutes. Returns the code once; only its SHA-256 is stored. The caller must present it with the
-- operation itself, so a replayed or forged request (or a request built from a stolen session alone, after the
-- code was used) is refused (D-E1-4).
CREATE OR REPLACE FUNCTION app_private.communications_authorize(p_session_token text, p_operation text, p_target_id uuid)
RETURNS TABLE (code text, expires_at timestamptz)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_actor uuid;
  v_code text := app_private.communications_random_hex();
  v_expires timestamptz := pg_catalog.now() + interval '5 minutes';
BEGIN
  IF p_operation IS NULL OR p_operation NOT IN ('ERASE_CONTACT', 'ERASE_CONVERSATION', 'ERASE_MESSAGE', 'RELEASE_LEGAL_HOLD', 'APPLY_RETENTION_REDUCTION') THEN
    RAISE EXCEPTION 'invalid operation' USING ERRCODE = '22023';
  END IF;
  v_actor := app_private.communications_erasure_actor(p_session_token, p_operation = 'APPLY_RETENTION_REDUCTION');
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  IF (p_operation = 'APPLY_RETENTION_REDUCTION') <> (p_target_id IS NULL) THEN
    RAISE EXCEPTION 'invalid target' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.communications_privileged_grants (id, business_id, user_id, operation, target_id, code_hash, created_at, expires_at)
  VALUES (pg_catalog.gen_random_uuid(), v_business, v_actor, p_operation, p_target_id,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex'), pg_catalog.now(), v_expires);
  code := v_code;
  expires_at := v_expires;
  RETURN NEXT;
END $$;

-- Verifies the live session again and consumes the matching grant in one statement. Returns the actor.
-- Internal: executable by no login role (called by the functions below, same owner).
CREATE OR REPLACE FUNCTION app_private.communications_consume_grant(p_session_token text, p_code text, p_operation text, p_target_id uuid)
RETURNS uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_actor uuid := app_private.communications_erasure_actor(p_session_token, p_operation = 'APPLY_RETENTION_REDUCTION');
BEGIN
  IF v_actor IS NULL OR v_actor IS DISTINCT FROM nullif(pg_catalog.current_setting('app.user_id', true), '')::uuid
     OR p_code IS NULL OR p_code !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  UPDATE public.communications_privileged_grants g SET consumed_at = pg_catalog.now()
   WHERE g.business_id = v_business
     AND g.code_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code, 'UTF8')), 'hex')
     AND g.user_id = v_actor AND g.operation = p_operation AND g.target_id IS NOT DISTINCT FROM p_target_id
     AND g.consumed_at IS NULL AND g.expires_at > pg_catalog.now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501';
  END IF;
  RETURN v_actor;
END $$;

-- Records an erasure request (idempotent per open target). The work itself is done by
-- communications_erasure_step, by the worker or right after this call.
CREATE OR REPLACE FUNCTION app_private.communications_request_erasure(
  p_session_token text, p_code text, p_target_type text, p_target_id uuid, p_reason text)
RETURNS TABLE (erasure_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_actor uuid;
  v_id uuid := pg_catalog.gen_random_uuid();
  v_existing uuid;
  v_found boolean;
BEGIN
  IF p_target_type IS NULL OR p_target_type NOT IN ('CONTACT', 'CONVERSATION', 'MESSAGE')
     OR p_reason IS NULL OR p_reason NOT IN ('DATA_SUBJECT_REQUEST', 'BUSINESS_REQUEST', 'LEGAL_OBLIGATION') OR p_target_id IS NULL THEN
    RAISE EXCEPTION 'invalid erasure request' USING ERRCODE = '22023';
  END IF;
  v_actor := app_private.communications_consume_grant(p_session_token, p_code, 'ERASE_' || p_target_type, p_target_id);
  v_found := CASE p_target_type
       WHEN 'CONTACT' THEN EXISTS (SELECT 1 FROM public.contacts c WHERE c.business_id = v_business AND c.id = p_target_id)
       WHEN 'CONVERSATION' THEN EXISTS (SELECT 1 FROM public.conversations c WHERE c.business_id = v_business AND c.id = p_target_id)
       ELSE EXISTS (SELECT 1 FROM public.messages m WHERE m.business_id = v_business AND m.id = p_target_id)
     END;
  IF NOT v_found THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT e.id INTO v_existing FROM public.communications_erasures e
   WHERE e.business_id = v_business AND e.kind = 'REQUEST' AND e.status <> 'COMPLETED' AND e.target_type = p_target_type
     AND coalesce(e.contact_id, e.conversation_id, e.message_id) = p_target_id;
  IF v_existing IS NOT NULL THEN
    erasure_id := v_existing; created := false; RETURN NEXT; RETURN;
  END IF;
  BEGIN
    INSERT INTO public.communications_erasures (id, business_id, kind, target_type, contact_id, conversation_id, message_id, reason_code, requested_by_id)
    VALUES (v_id, v_business, 'REQUEST', p_target_type,
            CASE WHEN p_target_type = 'CONTACT' THEN p_target_id END,
            CASE WHEN p_target_type = 'CONVERSATION' THEN p_target_id END,
            CASE WHEN p_target_type = 'MESSAGE' THEN p_target_id END,
            p_reason, v_actor);
  EXCEPTION WHEN unique_violation THEN
    SELECT e.id INTO v_existing FROM public.communications_erasures e
     WHERE e.business_id = v_business AND e.kind = 'REQUEST' AND e.status <> 'COMPLETED' AND e.target_type = p_target_type
       AND coalesce(e.contact_id, e.conversation_id, e.message_id) = p_target_id;
    erasure_id := v_existing; created := false; RETURN NEXT; RETURN;
  END;
  INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (pg_catalog.gen_random_uuid(), v_business, v_actor, 'communications.erasure.requested', 'erasure', v_id,
          pg_catalog.jsonb_build_object('targetType', p_target_type, 'reason', p_reason));
  erasure_id := v_id; created := true;
  RETURN NEXT;
END $$;

-- One bounded, atomic step of a request. Lock order (docs/communications-e1.md §9): the request row (SKIP
-- LOCKED, so two workers never run the same request at once), the business's hold lock (shared), the
-- conversations involved (id order), the messages (id order), then activities (id order). Everything this
-- step changes commits or rolls back together; an interrupted step leaves nothing half done.
-- outcome: 'progress' (more to do), 'deferred', 'completed', 'busy' (another worker holds it).
CREATE OR REPLACE FUNCTION app_private.communications_erasure_step(p_erasure_id uuid, p_batch integer)
RETURNS TABLE (outcome text, processed integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_batch integer := least(greatest(coalesce(p_batch, 100), 1), 500);
  r record;
  p record;
  v_target uuid;
  v_email text;
  v_ids uuid[];
  v_convs uuid[];
  v_n integer;
  v_msgs integer := 0; v_parts integer := 0; v_acts integer := 0; v_cvs integer := 0; v_review integer := 0;
  v_remaining boolean;
  v_deferred integer;
  v_held boolean;
BEGIN
  SELECT e.id, e.status, e.target_type, e.contact_id, e.conversation_id, e.message_id INTO r
    FROM public.communications_erasures e
   WHERE e.business_id = v_business AND e.id = p_erasure_id AND e.kind = 'REQUEST'
   FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.communications_erasures e WHERE e.business_id = v_business AND e.id = p_erasure_id AND e.kind = 'REQUEST') THEN
      outcome := 'busy'; processed := 0; RETURN NEXT; RETURN;
    END IF;
    RAISE EXCEPTION 'erasure not found' USING ERRCODE = 'P0002';
  END IF;
  IF r.status = 'COMPLETED' THEN
    outcome := 'completed'; processed := 0; RETURN NEXT; RETURN;
  END IF;
  v_target := coalesce(r.contact_id, r.conversation_id, r.message_id);
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext('communications.legal_hold'), pg_catalog.hashtext(v_business::text));
  IF r.target_type = 'CONTACT' THEN
    SELECT pg_catalog.lower(c.email) INTO v_email FROM public.contacts c WHERE c.business_id = v_business AND c.id = v_target;
  END IF;

  -- 1. choose this step's messages (no locks yet), and every conversation this step may touch.
  v_ids := ARRAY(SELECT x.message_id FROM app_private.communications_erasure_plan(v_business, r.target_type, v_target, NULL, v_batch) x
                  WHERE x.deferred_reason IS NULL);
  v_convs := ARRAY(
    SELECT DISTINCT cid FROM (
      SELECT m.conversation_id AS cid FROM public.messages m WHERE m.business_id = v_business AND m.id = ANY (v_ids)
      UNION ALL SELECT r.conversation_id WHERE r.target_type = 'CONVERSATION'
      UNION ALL (SELECT c.id FROM public.conversations c
                  WHERE r.target_type = 'CONTACT' AND c.business_id = v_business AND c.contact_id = v_target AND c.erased_at IS NULL
                  ORDER BY c.id LIMIT v_batch)
    ) s WHERE cid IS NOT NULL);
  -- 2. lock: conversations, then messages, each in id order. A racing insert into one of these conversations
  -- waits here and, once this commits, sees its erased_at (CM011) if the conversation was erased.
  PERFORM 1 FROM public.conversations c WHERE c.business_id = v_business AND c.id = ANY (v_convs) ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.messages m WHERE m.business_id = v_business AND m.id = ANY (v_ids) ORDER BY m.id FOR UPDATE;

  -- 3. re-plan the locked messages (their state may have changed while we waited) and apply.
  FOR p IN SELECT * FROM app_private.communications_erasure_plan(v_business, r.target_type, v_target, v_ids, v_batch) LOOP
    CONTINUE WHEN p.deferred_reason IS NOT NULL;
    IF p.mode = 'FULL' THEN
      v_n := app_private.communications_tombstone_message(v_business, p.message_id, p_erasure_id);
      IF v_n >= 0 THEN v_msgs := v_msgs + 1; v_parts := v_parts + v_n; END IF;
    ELSE
      WITH changed AS (
        UPDATE public.message_participants mp SET display_name = NULL, address = NULL, erased_at = pg_catalog.now()
         WHERE mp.business_id = v_business AND mp.message_id = p.message_id AND mp.erased_at IS NULL
           AND (mp.contact_id = v_target OR (mp.address IS NOT NULL AND pg_catalog.lower(mp.address) = v_email))
        RETURNING mp.id
      ), logged AS (
        INSERT INTO public.communications_erasure_items (business_id, erasure_id, entity_type, entity_id, action)
        SELECT v_business, p_erasure_id, 'PARTICIPANT', c.id, 'ERASED' FROM changed c ON CONFLICT DO NOTHING RETURNING 1
      )
      SELECT pg_catalog.count(*) INTO v_n FROM changed;
      v_parts := v_parts + v_n;
      INSERT INTO public.communications_erasure_items (business_id, erasure_id, entity_type, entity_id, action)
      VALUES (v_business, p_erasure_id, 'MESSAGE', p.message_id, 'REVIEW_REQUIRED') ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_review := v_review + v_n;
    END IF;
  END LOOP;

  -- 4. conversations. A conversation's subject goes only when every message in it is erased and it is not held;
  -- a conversation filed under the contact that still holds other people's messages is listed for review.
  FOR p IN SELECT c.id, c.contact_id FROM public.conversations c
            WHERE c.business_id = v_business AND c.id = ANY (v_convs) AND c.erased_at IS NULL
              AND (r.target_type = 'CONVERSATION' OR (r.target_type = 'CONTACT' AND c.contact_id = v_target))
            ORDER BY c.id LOOP
    v_held := p.contact_id IS NOT NULL AND public.communications_contact_held(v_business, p.contact_id)
              OR public.communications_contact_held(v_business, NULL);
    CONTINUE WHEN v_held;
    IF NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.business_id = v_business AND m.conversation_id = p.id AND m.erased_at IS NULL) THEN
      IF app_private.communications_tombstone_conversation(v_business, p.id, p_erasure_id) THEN v_cvs := v_cvs + 1; END IF;
    ELSIF r.target_type = 'CONTACT'
          AND NOT EXISTS (SELECT 1 FROM app_private.communications_erasure_plan(v_business, 'CONTACT', v_target, NULL, 1000) y
                           WHERE y.deferred_reason IS NULL AND y.conversation_id = p.id) THEN
      INSERT INTO public.communications_erasure_items (business_id, erasure_id, entity_type, entity_id, action)
      VALUES (v_business, p_erasure_id, 'CONVERSATION', p.id, 'REVIEW_REQUIRED') ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      v_review := v_review + v_n;
    END IF;
  END LOOP;

  -- 5. the contact's own timeline entries (notes, calls, meetings, emails, interactions; removed ones too).
  -- System entries carry ids only and message entries no content, so they are left as they are.
  IF r.target_type = 'CONTACT' AND NOT public.communications_contact_held(v_business, v_target) THEN
    FOR p IN SELECT a.id FROM public.activities a
              WHERE a.business_id = v_business AND a.contact_id = v_target AND a.erased_at IS NULL
                AND position('.' in a.type) = 0 AND (a.subject IS NOT NULL OR a.body IS NOT NULL)
              ORDER BY a.id LIMIT v_batch FOR UPDATE LOOP
      IF app_private.communications_tombstone_activity(v_business, p.id, p_erasure_id) THEN v_acts := v_acts + 1; END IF;
    END LOOP;
  END IF;

  -- 6. anything left that is not deferred?
  v_remaining := EXISTS (SELECT 1 FROM app_private.communications_erasure_plan(v_business, r.target_type, v_target, NULL, 1) x WHERE x.deferred_reason IS NULL)
    OR (r.target_type = 'CONTACT' AND NOT public.communications_contact_held(v_business, v_target) AND EXISTS (
          SELECT 1 FROM public.activities a WHERE a.business_id = v_business AND a.contact_id = v_target AND a.erased_at IS NULL
             AND position('.' in a.type) = 0 AND (a.subject IS NOT NULL OR a.body IS NOT NULL)))
    OR EXISTS (
          SELECT 1 FROM public.conversations c
           WHERE c.business_id = v_business AND c.erased_at IS NULL
             AND ((r.target_type = 'CONVERSATION' AND c.id = v_target) OR (r.target_type = 'CONTACT' AND c.contact_id = v_target))
             AND NOT (c.contact_id IS NOT NULL AND public.communications_contact_held(v_business, c.contact_id))
             AND NOT public.communications_contact_held(v_business, NULL)
             AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.business_id = v_business AND m.conversation_id = c.id AND m.erased_at IS NULL));

  processed := v_msgs + v_parts + v_acts + v_cvs + v_review;
  IF v_remaining THEN
    UPDATE public.communications_erasures e
       SET status = 'PENDING', deferred_reason = NULL, next_attempt_at = pg_catalog.now(), last_error_code = NULL,
           messages_erased = e.messages_erased + v_msgs, participants_erased = e.participants_erased + v_parts,
           activities_erased = e.activities_erased + v_acts, conversations_erased = e.conversations_erased + v_cvs,
           review_required = e.review_required + v_review
     WHERE e.business_id = v_business AND e.id = p_erasure_id;
    outcome := 'progress'; RETURN NEXT; RETURN;
  END IF;

  SELECT pg_catalog.count(*) INTO v_deferred
    FROM app_private.communications_erasure_plan(v_business, r.target_type, v_target, NULL, 1000) x WHERE x.deferred_reason IS NOT NULL;
  v_held := EXISTS (SELECT 1 FROM app_private.communications_erasure_plan(v_business, r.target_type, v_target, NULL, 1000) x WHERE x.deferred_reason = 'LEGAL_HOLD')
    OR (r.target_type = 'CONTACT' AND public.communications_contact_held(v_business, v_target)
        AND (EXISTS (SELECT 1 FROM public.activities a WHERE a.business_id = v_business AND a.contact_id = v_target AND a.erased_at IS NULL
                      AND position('.' in a.type) = 0 AND (a.subject IS NOT NULL OR a.body IS NOT NULL))
             OR EXISTS (SELECT 1 FROM public.conversations c WHERE c.business_id = v_business AND c.contact_id = v_target AND c.erased_at IS NULL)))
    OR (r.target_type = 'CONVERSATION' AND EXISTS (SELECT 1 FROM public.conversations c WHERE c.business_id = v_business AND c.id = v_target AND c.erased_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.business_id = v_business AND m.conversation_id = v_target AND m.erased_at IS NULL));
  IF v_held THEN
    v_deferred := greatest(v_deferred, 1);
  END IF;

  IF v_deferred > 0 THEN
    UPDATE public.communications_erasures e
       SET status = 'DEFERRED', deferred_reason = CASE WHEN v_held THEN 'LEGAL_HOLD' ELSE 'RETAINED_RECORD' END,
           next_attempt_at = pg_catalog.now() + interval '1 day', last_error_code = NULL, deferred_count = v_deferred,
           messages_erased = e.messages_erased + v_msgs, participants_erased = e.participants_erased + v_parts,
           activities_erased = e.activities_erased + v_acts, conversations_erased = e.conversations_erased + v_cvs,
           review_required = e.review_required + v_review
     WHERE e.business_id = v_business AND e.id = p_erasure_id;
    IF r.status <> 'DEFERRED' THEN
      INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
      VALUES (pg_catalog.gen_random_uuid(), v_business, NULL, 'communications.erasure.deferred', 'erasure', p_erasure_id,
              pg_catalog.jsonb_build_object('reason', CASE WHEN v_held THEN 'LEGAL_HOLD' ELSE 'RETAINED_RECORD' END, 'deferred', v_deferred::text));
    END IF;
    outcome := 'deferred'; RETURN NEXT; RETURN;
  END IF;

  UPDATE public.communications_erasures e
     SET status = 'COMPLETED', deferred_reason = NULL, completed_at = pg_catalog.now(), last_error_code = NULL, deferred_count = 0,
         messages_erased = e.messages_erased + v_msgs, participants_erased = e.participants_erased + v_parts,
         activities_erased = e.activities_erased + v_acts, conversations_erased = e.conversations_erased + v_cvs,
         review_required = e.review_required + v_review
   WHERE e.business_id = v_business AND e.id = p_erasure_id
  RETURNING e.messages_erased, e.participants_erased, e.activities_erased, e.conversations_erased, e.review_required
    INTO v_msgs, v_parts, v_acts, v_cvs, v_review;
  INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (pg_catalog.gen_random_uuid(), v_business, NULL, 'communications.erasure.completed', 'erasure', p_erasure_id,
          pg_catalog.jsonb_build_object('messages', v_msgs::text, 'participants', v_parts::text, 'activities', v_acts::text,
                                        'conversations', v_cvs::text, 'reviewRequired', v_review::text));
  outcome := 'completed'; RETURN NEXT;
END $$;

-- Records a failed step (the step itself rolled back): retry with backoff 30 s x 2^attempts, capped at 1 hour.
-- A request is never abandoned; last_error_code shows why it is waiting.
CREATE OR REPLACE FUNCTION app_private.communications_erasure_failed(p_erasure_id uuid, p_code text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.communications_erasures e
     SET attempts = e.attempts + 1,
         last_error_code = CASE WHEN p_code ~ '^[a-z][a-z_]{0,63}$' THEN p_code ELSE 'unexpected' END,
         next_attempt_at = pg_catalog.now() + least(interval '1 hour', interval '30 seconds' * power(2, least(e.attempts, 12)))
   WHERE e.business_id = app_private.communications_business() AND e.id = p_erasure_id AND e.kind = 'REQUEST' AND e.status <> 'COMPLETED';
END $$;

-- One bounded retention purge batch: unerased categorised copies past their computed expiry and not held.
-- The ordinary period is read FOR SHARE (a concurrent change waits), holds are excluded under the shared hold
-- lock, rows are locked conversations-first like a request step, and eligibility is re-checked after locking.
-- Returns one row (the ledger entry) or none when nothing was due.
CREATE OR REPLACE FUNCTION app_private.communications_retention_purge(p_batch integer)
RETURNS TABLE (erasure_id uuid, messages integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_batch integer := least(greatest(coalesce(p_batch, 200), 1), 500);
  v_days integer;
  v_ids uuid[];
  v_convs uuid[];
  v_close uuid[];
  v_id uuid := pg_catalog.gen_random_uuid();
  v_parts integer;
  m record;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtext('communications.legal_hold'), pg_catalog.hashtext(v_business::text));
  SELECT public.mail_effective_ordinary_days(s.ordinary_retention_days, s.previous_retention_days, s.shortening_effective_at) INTO v_days
    FROM public.mail_retention_settings s WHERE s.business_id = v_business FOR SHARE;
  v_ids := ARRAY(
    SELECT x.id FROM public.messages x
     WHERE x.business_id = v_business AND x.erased_at IS NULL AND x.retention_category IS NOT NULL
       AND public.mail_retention_due_at(x.retention_category, x.occurred_at, x.recorded_at, v_days) <= pg_catalog.now()
       AND NOT public.communications_message_held(v_business, x.id)
     ORDER BY x.id LIMIT v_batch);
  IF pg_catalog.cardinality(v_ids) = 0 THEN
    RETURN;
  END IF;
  v_convs := ARRAY(SELECT DISTINCT x.conversation_id FROM public.messages x WHERE x.business_id = v_business AND x.id = ANY (v_ids));
  PERFORM 1 FROM public.conversations c WHERE c.business_id = v_business AND c.id = ANY (v_convs) ORDER BY c.id FOR UPDATE;
  PERFORM 1 FROM public.messages x WHERE x.business_id = v_business AND x.id = ANY (v_ids) ORDER BY x.id FOR UPDATE;
  v_ids := ARRAY(
    SELECT x.id FROM public.messages x
     WHERE x.business_id = v_business AND x.id = ANY (v_ids) AND x.erased_at IS NULL
       AND public.mail_retention_due_at(x.retention_category, x.occurred_at, x.recorded_at, v_days) <= pg_catalog.now()
       AND NOT public.communications_message_held(v_business, x.id)
     ORDER BY x.id);
  IF pg_catalog.cardinality(v_ids) = 0 THEN
    RETURN;
  END IF;
  -- Conversations left with no live message after this batch lose their subject too (unless held).
  v_close := ARRAY(
    SELECT c.id FROM public.conversations c
     WHERE c.business_id = v_business AND c.id = ANY (v_convs) AND c.erased_at IS NULL
       AND NOT (c.contact_id IS NOT NULL AND public.communications_contact_held(v_business, c.contact_id))
       AND NOT EXISTS (SELECT 1 FROM public.messages x WHERE x.business_id = v_business AND x.conversation_id = c.id
                          AND x.erased_at IS NULL AND NOT (x.id = ANY (v_ids)))
     ORDER BY c.id);
  SELECT pg_catalog.count(*) INTO v_parts FROM public.message_participants p
   WHERE p.business_id = v_business AND p.message_id = ANY (v_ids) AND p.erased_at IS NULL;
  INSERT INTO public.communications_erasures (id, business_id, kind, reason_code, status, completed_at, messages_erased, participants_erased,
                                              conversations_erased)
  VALUES (v_id, v_business, 'RETENTION', 'RETENTION_EXPIRED', 'COMPLETED', pg_catalog.now(), pg_catalog.cardinality(v_ids), v_parts,
          pg_catalog.cardinality(v_close));
  FOR m IN SELECT unnest(v_ids) AS id LOOP
    PERFORM app_private.communications_tombstone_message(v_business, m.id, v_id);
  END LOOP;
  FOR m IN SELECT unnest(v_close) AS id LOOP
    PERFORM app_private.communications_tombstone_conversation(v_business, m.id, v_id);
  END LOOP;
  INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (pg_catalog.gen_random_uuid(), v_business, NULL, 'communications.erasure.retention_purged', 'erasure', v_id,
          pg_catalog.jsonb_build_object('messages', pg_catalog.cardinality(v_ids)::text, 'participants', v_parts::text,
                                        'conversations', pg_catalog.cardinality(v_close)::text));
  erasure_id := v_id;
  messages := pg_catalog.cardinality(v_ids);
  RETURN NEXT;
END $$;

-- Releases a legal hold: verified OWNER/ADMIN with a single-use code for this hold. Audited. Returns false if it
-- was already released (idempotent), P0002 if there is no such hold in this business.
CREATE OR REPLACE FUNCTION app_private.communications_release_legal_hold(p_session_token text, p_code text, p_hold_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_actor uuid := app_private.communications_consume_grant(p_session_token, p_code, 'RELEASE_LEGAL_HOLD', p_hold_id);
  v_scope text;
BEGIN
  SELECT h.scope INTO v_scope FROM public.communications_legal_holds h WHERE h.business_id = v_business AND h.id = p_hold_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.communications_legal_holds h SET released_at = pg_catalog.now(), released_by_id = v_actor
   WHERE h.business_id = v_business AND h.id = p_hold_id AND h.released_at IS NULL;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (pg_catalog.gen_random_uuid(), v_business, v_actor, 'communications.erasure.hold_released', 'legal_hold', p_hold_id,
          pg_catalog.jsonb_build_object('scope', v_scope));
  RETURN true;
END $$;

-- The audited exception to the 30-day delay (D-E1-3): an OWNER, with a single-use code and a stated reason
-- code, makes a pending reduction apply now. It never shortens anything that is not already pending.
CREATE OR REPLACE FUNCTION app_private.communications_apply_retention_reduction(p_session_token text, p_code text, p_reason text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_actor uuid;
  v_days integer;
  v_previous integer;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('LEGAL_OBLIGATION', 'DATA_MINIMISATION', 'OTHER') THEN
    RAISE EXCEPTION 'invalid reason' USING ERRCODE = '22023';
  END IF;
  v_actor := app_private.communications_consume_grant(p_session_token, p_code, 'APPLY_RETENTION_REDUCTION', NULL);
  SELECT s.ordinary_retention_days, s.previous_retention_days INTO v_days, v_previous
    FROM public.mail_retention_settings s WHERE s.business_id = v_business FOR UPDATE;
  IF v_previous IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.mail_retention_settings s SET previous_retention_days = NULL, shortening_effective_at = NULL, updated_at = pg_catalog.now()
   WHERE s.business_id = v_business;
  INSERT INTO public.audit_events (id, business_id, actor_user_id, action, target_type, target_id, metadata)
  VALUES (pg_catalog.gen_random_uuid(), v_business, v_actor, 'communications.erasure.retention_reduction_applied', 'business', v_business,
          pg_catalog.jsonb_build_object('ordinaryRetentionDays', v_days::text, 'previousDays', v_previous::text, 'reason', p_reason));
  RETURN true;
END $$;

-- Which of these provider identifiers were erased here (unexpired markers)? Lets an import refuse to bring an
-- erased message back without the database keeping the identifier (D-E1-2). Returns the matching inputs.
CREATE OR REPLACE FUNCTION app_private.communications_erased_matches(p_kind text, p_source text, p_identifiers text[])
RETURNS text[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
BEGIN
  IF p_kind NOT IN ('MESSAGE', 'THREAD') OR pg_catalog.cardinality(p_identifiers) > 1000 THEN
    RAISE EXCEPTION 'invalid input' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.communications_erased_references r WHERE r.business_id = v_business AND r.kind = p_kind) THEN
    RETURN ARRAY[]::text[];
  END IF;
  RETURN ARRAY(
    SELECT i FROM pg_catalog.unnest(p_identifiers) AS i
     WHERE EXISTS (SELECT 1 FROM public.communications_erased_references r
                    WHERE r.business_id = v_business AND r.kind = p_kind AND r.expires_at > pg_catalog.now()
                      AND r.digest = app_private.communications_reference_digest(v_business, p_kind, p_source, i)));
END $$;

-- Housekeeping for the current business: expired markers and spent or expired authorisation codes.
CREATE OR REPLACE FUNCTION app_private.communications_erasure_housekeeping(p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business uuid := app_private.communications_business();
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_a integer;
  v_b integer;
BEGIN
  DELETE FROM public.communications_erased_references r
   WHERE r.business_id = v_business AND (r.kind, r.digest) IN (
     SELECT x.kind, x.digest FROM public.communications_erased_references x
      WHERE x.business_id = v_business AND x.expires_at <= pg_catalog.now() LIMIT v_limit);
  GET DIAGNOSTICS v_a = ROW_COUNT;
  DELETE FROM public.communications_privileged_grants g
   WHERE g.business_id = v_business AND g.id IN (
     SELECT x.id FROM public.communications_privileged_grants x
      WHERE x.business_id = v_business AND x.expires_at < pg_catalog.now() - interval '1 day' LIMIT v_limit);
  GET DIAGNOSTICS v_b = ROW_COUNT;
  RETURN v_a + v_b;
END $$;

-- Ledger replay (docs/communications-e1.md §10): after a restore of the content tables, re-applies every
-- erasure the ledger records whose row came back with content. Run by the administrative role during the
-- restore procedure, before the restored database serves traffic; no runtime role may execute it.
CREATE OR REPLACE FUNCTION app_private.communications_erasure_replay(p_business uuid, p_limit integer)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 100000);
  v_n integer := 0;
  i record;
BEGIN
  PERFORM pg_catalog.set_config('app.business_id', p_business::text, true);
  FOR i IN SELECT it.erasure_id, it.entity_type, it.entity_id FROM public.communications_erasure_items it
            WHERE it.business_id = p_business AND it.action = 'ERASED' ORDER BY it.entity_type, it.entity_id LIMIT v_limit LOOP
    IF i.entity_type = 'MESSAGE' THEN
      PERFORM 1 FROM public.messages m WHERE m.business_id = p_business AND m.id = i.entity_id AND m.erased_at IS NULL FOR UPDATE;
      IF FOUND AND app_private.communications_tombstone_message(p_business, i.entity_id, i.erasure_id) >= 0 THEN v_n := v_n + 1; END IF;
    ELSIF i.entity_type = 'PARTICIPANT' THEN
      UPDATE public.message_participants p SET display_name = NULL, address = NULL, erased_at = pg_catalog.now()
       WHERE p.business_id = p_business AND p.id = i.entity_id AND p.erased_at IS NULL;
      IF FOUND THEN v_n := v_n + 1; END IF;
    ELSIF i.entity_type = 'ACTIVITY' THEN
      IF app_private.communications_tombstone_activity(p_business, i.entity_id, i.erasure_id) THEN v_n := v_n + 1; END IF;
    ELSIF i.entity_type = 'CONVERSATION' THEN
      IF app_private.communications_tombstone_conversation(p_business, i.entity_id, i.erasure_id) THEN v_n := v_n + 1; END IF;
    END IF;
  END LOOP;
  RETURN v_n;
END $$;

DO $$
DECLARE
  f text;
BEGIN
  -- Internal helpers and the replay: no runtime role.
  FOREACH f IN ARRAY ARRAY[
    'app_private.communications_business()', 'app_private.communications_random_hex()', 'app_private.communications_reference_key(uuid)',
    'app_private.communications_reference_digest(uuid, text, text, text)', 'app_private.communications_reference_expiry(timestamptz)',
    'app_private.communications_remember_reference(uuid, text, text, text, timestamptz)',
    'app_private.communications_tombstone_message(uuid, uuid, uuid)', 'app_private.communications_tombstone_conversation(uuid, uuid, uuid)',
    'app_private.communications_tombstone_activity(uuid, uuid, uuid)', 'app_private.communications_erasure_plan(uuid, text, uuid, uuid[], integer)',
    'app_private.communications_consume_grant(text, text, text, uuid)', 'app_private.communications_erasure_replay(uuid, integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  END LOOP;
  -- The application's entry points.
  FOREACH f IN ARRAY ARRAY[
    'app_private.communications_authorize(text, text, uuid)', 'app_private.communications_request_erasure(text, text, text, uuid, text)',
    'app_private.communications_erasure_step(uuid, integer)', 'app_private.communications_erasure_failed(uuid, text)',
    'app_private.communications_retention_purge(integer)', 'app_private.communications_release_legal_hold(text, text, uuid)',
    'app_private.communications_apply_retention_reduction(text, text, text)', 'app_private.communications_erased_matches(text, text, text[])',
    'app_private.communications_erasure_housekeeping(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO bos_app', f);
  END LOOP;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM bos_maint;
REVOKE bos_maint FROM CURRENT_USER;
