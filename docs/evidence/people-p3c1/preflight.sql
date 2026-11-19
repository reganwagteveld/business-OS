-- P3-C1 J.2 preflight. Read-only; run as the superuser/admin role (BYPASSRLS) in a READ ONLY transaction.
BEGIN READ ONLY;
-- 1. Pending set and checksums: done separately from _prisma_migrations (protocol "Production migrations").
SELECT 'applied_migrations=' || count(*) || ' newest=' || max(migration_name) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
-- 2. Rows the back-fill will transform.
SELECT 'revision_rows=' || count(*) || ' businesses_with_revisions=' || count(DISTINCT business_id) FROM people_leave_policy_revisions;
-- 3. Businesses whose time zone changed after their earliest revision (their INFERRED dates may be one day off;
--    if this lists any business, D-P3C-35 goes to Regan before the apply verdict).
SELECT 'tz_changed_after_revision=' || b.id || ' changes=' || count(*)
  FROM businesses b
  JOIN audit_events a ON a.business_id = b.id AND a.action = 'business.updated' AND a.metadata ? 'timeZoneTo'
 WHERE a.created_at > (SELECT min(r.recorded_at) FROM people_leave_policy_revisions r WHERE r.business_id = b.id)
 GROUP BY b.id ORDER BY b.id;
-- 4. Ledger tables must not exist yet.
SELECT 'ledger_tables_present=' || count(*) FROM pg_class WHERE relname LIKE 'people_leave_%' AND relname IN
  ('people_leave_accounts', 'people_leave_buckets', 'people_leave_transactions', 'people_leave_entries', 'people_leave_authorisations');
ROLLBACK;
