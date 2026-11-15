-- Finance F6-1 scheduler (docs/finance-billing-f6.md §5, owner decision D-F6-1). Applied by an
-- ADMINISTRATIVE role with `pnpm db:privileged`, after `prisma migrate deploy` has created the
-- recurring tables (migration 20261123000000_finance_billing). Idempotent.
--
-- The billing worker is cross-tenant only in one respect: it must learn WHICH businesses have due
-- work. Tenant RLS hides every business but the current one, so that list comes from this single
-- SECURITY DEFINER function. It returns business ids and nothing else (no template, customer or
-- amount), and the worker then does all real work as bos_app inside withTenant, under RLS.

-- Column-limited read rights for the function's owner, plus row policies (FORCE RLS applies to it).
GRANT SELECT ("id", "business_id", "status", "next_run_on", "time_zone") ON public.finance_recurring_templates TO bos_definer;
GRANT SELECT ("business_id", "template_id", "status", "run_after", "lease_expires_at") ON public.finance_recurring_runs TO bos_definer;
DROP POLICY IF EXISTS definer_billing_due_read ON public.finance_recurring_templates;
CREATE POLICY definer_billing_due_read ON public.finance_recurring_templates FOR SELECT TO bos_definer
  USING (status IN ('ACTIVE', 'ENDED'));
DROP POLICY IF EXISTS definer_billing_due_read ON public.finance_recurring_runs;
CREATE POLICY definer_billing_due_read ON public.finance_recurring_runs FOR SELECT TO bos_definer
  USING (status IN ('PENDING', 'RUNNING'));

GRANT bos_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA app_private TO bos_definer;
SET ROLE bos_definer;

-- Businesses (not archived) with an active schedule whose next run date has arrived in the
-- schedule's own time zone, or with a pending run that is due, or a running run whose lease expired
-- (runs of ACTIVE templates, and of ENDED ones whose last periods are still pending; never PAUSED).
-- Oldest work first, so no business starves. p_limit is clamped to 1..500.
CREATE OR REPLACE FUNCTION app_private.finance_billing_due(p_limit integer)
RETURNS TABLE (business_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH due AS (
    SELECT t.business_id, (t.next_run_on::timestamp AT TIME ZONE t.time_zone) AS due_at
      FROM public.finance_recurring_templates t
     WHERE t.status = 'ACTIVE' AND t.next_run_on <= (pg_catalog.now() AT TIME ZONE t.time_zone)::date
    UNION ALL
    SELECT r.business_id, r.run_after
      FROM public.finance_recurring_runs r
      JOIN public.finance_recurring_templates t ON t.business_id = r.business_id AND t.id = r.template_id
     WHERE ((r.status = 'PENDING' AND r.run_after <= pg_catalog.now())
        OR (r.status = 'RUNNING' AND r.lease_expires_at < pg_catalog.now()))
  )
  SELECT d.business_id
    FROM due d
    JOIN public.businesses b ON b.id = d.business_id
   GROUP BY d.business_id
   ORDER BY pg_catalog.min(d.due_at), d.business_id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;

REVOKE ALL ON FUNCTION app_private.finance_billing_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.finance_billing_due(integer) TO bos_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM bos_definer;
REVOKE bos_definer FROM CURRENT_USER;
