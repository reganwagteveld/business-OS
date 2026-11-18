-- Global search GS1-A: indexes only (docs/global-search-gs1.md §9.2). Procedure, rehearsal results and recovery:
-- docs/search-index-migration.md. NOT APPLIED ANYWHERE BUT LOCAL/CI
-- DATABASES. Applying it to production needs Regan's separate approval after the GS1-A readiness gate
-- (§11.4, §12, D-GS1-16): production table sizes and build times measured on a temporary Neon branch,
-- this transaction's lock behaviour confirmed for `prisma migrate deploy`, a fresh verified recovery
-- branch, and a re-measure under concurrent writes. If any table builds in more than 2 s at production
-- size, that index moves to a separately approved CREATE INDEX CONCURRENTLY step instead.
--
-- Additive: no table, column, constraint, grant, policy or extension changes; no privileged step. Each
-- expression is declared once in the owning module's search provider (prefixIndex / wordIndex in
-- core/search) and a unit test checks every declared statement appears here verbatim. Prisma cannot
-- express these expression indexes, like the existing hand-written ones (people_employees_number_key).
--
-- LOCKS ARE CUMULATIVE. Each plain CREATE INDEX takes a SHARE lock on its table, and inside this one
-- transaction every lock is held until COMMIT. Writes to customers are therefore blocked from its first
-- build until the LAST of the 22 builds finishes, not just for its own build time: a per-table "under 2 s"
-- measurement does not bound user-facing impact (ChatGPT audit of PR #93, M2). Before any production
-- approval, rehearse THIS WHOLE FILE through `prisma migrate deploy` on a representative Neon branch with
-- concurrent writes, and record end-to-end lock waits and write latency. If that is not acceptable, the
-- options are smaller groups (one migration per table or Zone) or separately approved CREATE INDEX
-- CONCURRENTLY steps outside a transaction; that choice is Regan's.
--
-- lock_timeout makes a build that cannot get its lock fail fast (and roll back whole) instead of queueing
-- writes behind it; statement_timeout bounds each build. Rolling back an index-only migration leaves
-- nothing to undo.

-- One transaction: a failure leaves nothing behind (docs/migration-readiness.md §7).
BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- Customers Zone (customer, contact)
CREATE INDEX "customers_search_display_name_idx" ON "customers" ("business_id", (lower("display_name") COLLATE "C"), "id");
CREATE INDEX "customers_search_email_idx" ON "customers" ("business_id", (lower("email") COLLATE "C"), "id");
CREATE INDEX "customers_search_words_idx" ON "customers" USING gin (to_tsvector('simple'::regconfig, display_name || ' ' || coalesce(legal_name, '')));
CREATE INDEX "contacts_search_display_name_idx" ON "contacts" ("business_id", (lower("display_name") COLLATE "C"), "id");
CREATE INDEX "contacts_search_email_idx" ON "contacts" ("business_id", (lower("email") COLLATE "C"), "id");
CREATE INDEX "contacts_search_words_idx" ON "contacts" USING gin (to_tsvector('simple'::regconfig, display_name));

-- Sales Zone (opportunity)
CREATE INDEX "opportunities_search_title_idx" ON "opportunities" ("business_id", (lower("title") COLLATE "C"), "id");
CREATE INDEX "opportunities_search_words_idx" ON "opportunities" USING gin (to_tsvector('simple'::regconfig, title));

-- Projects Zone (project, task)
CREATE INDEX "projects_search_name_idx" ON "projects" ("business_id", (lower("name") COLLATE "C"), "id");
CREATE INDEX "projects_search_words_idx" ON "projects" USING gin (to_tsvector('simple'::regconfig, name));
CREATE INDEX "project_tasks_search_title_idx" ON "project_tasks" ("business_id", (lower("title") COLLATE "C"), "id");
CREATE INDEX "project_tasks_search_words_idx" ON "project_tasks" USING gin (to_tsvector('simple'::regconfig, title));

-- Finance Zone (quote, invoice, credit note by number; catalog item). Documents are also found through
-- their customer's name, which uses customers_search_display_name_idx and the existing (business_id, customer_id) index.
CREATE INDEX "finance_documents_search_number_idx" ON "finance_documents" ("business_id", "kind", (lower("number") COLLATE "C"), "id");
CREATE INDEX "finance_catalog_items_search_name_idx" ON "finance_catalog_items" ("business_id", (lower("name") COLLATE "C"), "id");
CREATE INDEX "finance_catalog_items_search_code_idx" ON "finance_catalog_items" ("business_id", (lower("code") COLLATE "C"), "id");
CREATE INDEX "finance_catalog_items_search_words_idx" ON "finance_catalog_items" USING gin (to_tsvector('simple'::regconfig, name));

-- People Zone (employee): work fields only. Nothing on people_employee_personal_details, history or leave.
CREATE INDEX "people_employees_search_given_name_idx" ON "people_employees" ("business_id", (lower("given_name") COLLATE "C"), "id");
CREATE INDEX "people_employees_search_family_name_idx" ON "people_employees" ("business_id", (lower("family_name") COLLATE "C"), "id");
CREATE INDEX "people_employees_search_preferred_name_idx" ON "people_employees" ("business_id", (lower("preferred_name") COLLATE "C"), "id");
CREATE INDEX "people_employees_search_employee_number_idx" ON "people_employees" ("business_id", (lower("employee_number") COLLATE "C"), "id");
CREATE INDEX "people_employees_search_work_email_idx" ON "people_employees" ("business_id", (lower("work_email") COLLATE "C"), "id");
CREATE INDEX "people_employees_search_words_idx" ON "people_employees" USING gin (to_tsvector('simple'::regconfig, given_name || ' ' || family_name || ' ' || coalesce(preferred_name, '') || ' ' || coalesce(job_title, '')));

COMMIT;
