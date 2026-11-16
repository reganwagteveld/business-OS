-- Finance F6-3 reminder scheduler (docs/finance-billing-f6.md §10.6, owner decision D-F6-13). Applied
-- by an ADMINISTRATIVE role with `pnpm db:privileged`, after `prisma migrate deploy` has created the
-- reminder tables (migration 20261127000000_finance_reminders). Idempotent.
--
-- Same shape as 002_finance_billing_due.sql: the reminder worker must learn WHICH businesses have
-- reminder work, and tenant RLS hides every business but the current one. This SECURITY DEFINER
-- function returns business ids and nothing else. It reads no invoice, customer, amount or due date:
-- only policy status and planning time, and reminder status and timing. The worker then does all real
-- work (finding overdue invoices, checking balances) as bos_app inside withTenant, under RLS.

DO $$
BEGIN
  IF NOT has_column_privilege('bos_definer', 'public.businesses', 'id', 'SELECT') THEN
    RAISE EXCEPTION 'bos_definer cannot read public.businesses(id): apply 001_trusted_paths.sql first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'businesses' AND policyname = 'definer_business_read') THEN
    RAISE EXCEPTION 'policy definer_business_read on public.businesses is missing: apply 001_trusted_paths.sql first';
  END IF;
END $$;

-- Column-limited read rights for the function's owner, plus row policies (FORCE RLS applies to it).
GRANT SELECT ("business_id", "status", "last_planned_at") ON public.finance_reminder_policies TO bos_definer;
GRANT SELECT ("business_id", "status", "run_after", "lease_expires_at") ON public.finance_reminders TO bos_definer;
DROP POLICY IF EXISTS definer_reminders_due_read ON public.finance_reminder_policies;
CREATE POLICY definer_reminders_due_read ON public.finance_reminder_policies FOR SELECT TO bos_definer
  USING (status = 'ACTIVE');
DROP POLICY IF EXISTS definer_reminders_due_read ON public.finance_reminders;
CREATE POLICY definer_reminders_due_read ON public.finance_reminders FOR SELECT TO bos_definer
  USING (status IN ('PENDING', 'RUNNING', 'READY'));

GRANT bos_definer TO CURRENT_USER;
GRANT CREATE ON SCHEMA app_private TO bos_definer;
SET ROLE bos_definer;

-- Businesses (not archived) that have an active reminder policy not planned in the last hour, or a
-- pending or ready reminder whose next check is due, or a running reminder whose lease expired.
-- Oldest work first, so no business starves. p_limit is clamped to 1..500.
CREATE OR REPLACE FUNCTION app_private.finance_reminders_due(p_limit integer)
RETURNS TABLE (business_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH due AS (
    SELECT p.business_id, coalesce(p.last_planned_at, '-infinity'::timestamptz) AS due_at
      FROM public.finance_reminder_policies p
     WHERE p.status = 'ACTIVE' AND (p.last_planned_at IS NULL OR p.last_planned_at <= pg_catalog.now() - interval '1 hour')
    UNION ALL
    SELECT r.business_id, r.run_after
      FROM public.finance_reminders r
     WHERE (r.status IN ('PENDING', 'READY') AND r.run_after <= pg_catalog.now())
        OR (r.status = 'RUNNING' AND r.lease_expires_at < pg_catalog.now())
  )
  SELECT d.business_id
    FROM due d
    JOIN public.businesses b ON b.id = d.business_id
   GROUP BY d.business_id
   ORDER BY pg_catalog.min(d.due_at), d.business_id
   LIMIT least(greatest(coalesce(p_limit, 50), 1), 500)
$$;

REVOKE ALL ON FUNCTION app_private.finance_reminders_due(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_private.finance_reminders_due(integer) TO bos_app;

RESET ROLE;
REVOKE CREATE ON SCHEMA app_private FROM bos_definer;
REVOKE bos_definer FROM CURRENT_USER;
