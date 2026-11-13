-- RLS spike fixture (docs/data-model.md §5.2, §5.4, §7.1). Applied by tests/isolation/db-context.test.ts
-- to the dedicated business_os_spike database as an administrative role. It is NOT an application
-- migration: the real tenancy tables arrive with the Phase 1b tenancy migrations and must use the
-- same policy template, grants and composite foreign keys that this fixture proves.
--
-- The tables keep only the columns the spike needs, with the production names and types.

DROP SCHEMA IF EXISTS app_private CASCADE;
DROP TABLE IF EXISTS public.contacts, public.customers, public.businesses CASCADE;

SET ROLE bos_owner;

CREATE TABLE public.businesses (
  id          uuid PRIMARY KEY,
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  archived_at timestamptz
);

CREATE TABLE public.customers (
  id           uuid PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES public.businesses (id),
  display_name text NOT NULL,
  -- Target of the composite foreign keys (layer 5).
  CONSTRAINT customers_business_id_id_key UNIQUE (business_id, id)
);

CREATE TABLE public.contacts (
  id           uuid PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES public.businesses (id),
  customer_id  uuid,
  display_name text NOT NULL,
  -- A contact can only point at a customer of the SAME business, whatever RLS does.
  CONSTRAINT contacts_customer_fkey FOREIGN KEY (business_id, customer_id)
    REFERENCES public.customers (business_id, id)
);
CREATE INDEX contacts_business_customer_idx ON public.contacts (business_id, customer_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.businesses, public.customers, public.contacts TO bos_app;
GRANT SELECT, DELETE ON public.businesses, public.customers, public.contacts TO bos_jobs;

-- Layer 4: the tenant policy template (§5.2), FORCE so even the table owner is subject to it.
ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.businesses FOR ALL TO bos_app
  USING      (id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.customers FOR ALL TO bos_app
  USING      (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.contacts FOR ALL TO bos_app
  USING      (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

RESET ROLE;

-- Jobs role (§7.1): read and delete only a purgeable business, with the 30-day floor in the database.
CREATE SCHEMA app_private AUTHORIZATION bos_owner;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
GRANT USAGE ON SCHEMA app_private TO bos_jobs, bos_maint;

GRANT SELECT (id, archived_at) ON public.businesses TO bos_maint;
CREATE POLICY maint_business_archived ON public.businesses FOR SELECT TO bos_maint
  USING (archived_at IS NOT NULL);

CREATE FUNCTION app_private.is_purgeable(p_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.businesses b
    WHERE b.id = p_business_id
      AND b.archived_at IS NOT NULL
      AND b.archived_at < pg_catalog.now() - interval '30 days')
$$;
ALTER FUNCTION app_private.is_purgeable(uuid) OWNER TO bos_maint;
REVOKE ALL ON FUNCTION app_private.is_purgeable(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.is_purgeable(uuid) TO bos_jobs;

CREATE POLICY jobs_purge_read ON public.businesses FOR SELECT TO bos_jobs
  USING (id = nullif(current_setting('app.business_id', true), '')::uuid
         AND app_private.is_purgeable(nullif(current_setting('app.business_id', true), '')::uuid));
CREATE POLICY jobs_purge_delete ON public.businesses FOR DELETE TO bos_jobs
  USING (id = nullif(current_setting('app.business_id', true), '')::uuid
         AND app_private.is_purgeable(nullif(current_setting('app.business_id', true), '')::uuid));
CREATE POLICY jobs_purge_read ON public.customers FOR SELECT TO bos_jobs
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid
         AND app_private.is_purgeable(nullif(current_setting('app.business_id', true), '')::uuid));
CREATE POLICY jobs_purge_delete ON public.customers FOR DELETE TO bos_jobs
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid
         AND app_private.is_purgeable(nullif(current_setting('app.business_id', true), '')::uuid));
CREATE POLICY jobs_purge_read ON public.contacts FOR SELECT TO bos_jobs
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid
         AND app_private.is_purgeable(nullif(current_setting('app.business_id', true), '')::uuid));
CREATE POLICY jobs_purge_delete ON public.contacts FOR DELETE TO bos_jobs
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid
         AND app_private.is_purgeable(nullif(current_setting('app.business_id', true), '')::uuid));
