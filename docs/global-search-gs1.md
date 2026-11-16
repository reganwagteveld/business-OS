# GS1: Global Search, architecture and implementation plan

- **Status:** Approved architecture (docs only). Revision 3, after Regan's review and ChatGPT's final re-audit on PR #75 (2026-11-16). All owner decisions D-GS1-1..18 are recorded in §13. Documentation only. Nothing here is built, migrated or deployed, and **GS1-A is not authorised yet**: it needs a separate go-ahead once this revision is reviewed.
- **Revision 2 changes:** exact branch SQL, index-compatible matching and no unindexed 2-character scans (§5.3, §9); statement-timeout mechanics and narrow 57014 handling (§5.5); no response cache, security-context invalidation and re-authorised recents (§10.4, §10.7); logging claims made conditional on a verification checklist, with a dated trigger for existing `?q=` lists (§6.8); enforceable server-side concurrency limits and measurement thresholds (§6.9); EXPLAIN as diagnostics, table-size and lock checks (§11.4, §12); verified navigation targets per type (§10.6); decisions, tests and sequencing updated (§12–§14).
- **Scope:** record search across the Zones, delivered through the command palette already specified in [UI V2-A §8.2](ui/pixa-design-system-v2-a.md#82-command-palette-client-side-no-backend).
- **Baseline:** `main` at `6bc707e` (UI V2-A merged). Open PRs checked: #68 (People P3-A leave, merging), #66 (Neon housekeeping), #53, #48. None of them adds or changes search; P3-A's leave tables are explicitly out of GS1 scope (§4.3).

## Contents

1. [Summary](#1-summary)
2. [Preflight findings](#2-preflight-findings)
3. [Principles](#3-principles)
4. [Entity coverage](#4-entity-coverage)
5. [Architecture options and recommendation](#5-architecture-options-and-recommendation)
6. [Security and permission model](#6-security-and-permission-model)
7. [API contract](#7-api-contract)
8. [Search result schema](#8-search-result-schema)
9. [Indexing, matching and ranking](#9-indexing-matching-and-ranking)
10. [UI interaction specification](#10-ui-interaction-specification)
11. [Performance plan](#11-performance-plan)
12. [Implementation sequence](#12-implementation-sequence)
13. [Owner decisions](#13-owner-decisions)
14. [Test strategy](#14-test-strategy)
15. [Risks and open questions](#15-risks-and-open-questions)

## 1. Summary

**Recommendation:** search the existing tables in place, with PostgreSQL's built-in full-text search and plain B-tree prefix indexes, behind one tenant-scoped API endpoint. No new service, no PostgreSQL extension, no copy of the data.

- **One endpoint**, `POST /api/v1/b/:slug/search`, runs inside the existing `tenantRoute` → `withTenant` unit of work, so forced RLS, the membership check and the permission check all apply exactly as for every other read.
- **Federated providers.** Each Zone module owns a small search provider for its own records: the permission key it needs, the fields it matches on, the fields it may return. The search module only combines them. A Zone the caller cannot read is never queried.
- **Names and identifiers only.** GS1 matches on titles, names, numbers, codes and work contact fields. It never matches or returns long free text (notes, descriptions, message bodies) and never touches People personal details, leave, activities or communications.
- **No search history on the server.** Search terms are sent in a POST body (not the URL), are not logged, not audited and not stored.
- **UI:** the ⌘K / Ctrl+K palette from V2-A gains a "Records" section once the person types two characters. Results are grouped by Zone, keyboard-navigable and open the record directly.
- **Cost:** no new infrastructure or vendor. One additive migration of expression indexes (no extension, no privileged step). A dedicated search service is not justified at SMB scale (§5.4).

Phases: **GS1-A** backend foundations, **GS1-B** palette record search, **GS1-C** more Zones, **GS1-D** performance and relevance. Regan's outcomes for D-GS1-1..14 and four new proposals (D-GS1-15..18) are in §13.

## 2. Preflight findings

What exists today, checked on `main` at `6bc707e`.

### 2.1 Database and tenant isolation

| Item | Finding | Where |
|---|---|---|
| Engine | PostgreSQL 16+ (local and CI 16.10; Neon production, aws-us-east-1). No extensions installed by any migration; ADR 0008 deliberately avoided `btree_gist`. | `docs/data-model.md`, migrations |
| Unit of work | Every tenant query runs in one interactive transaction that first sets `app.business_id` and `app.user_id` with `set_config(..., true)` and checks the result (fail closed). 5 s default timeout, READ COMMITTED. | `apps/api/src/core/db/with-tenant.ts` |
| App-side scope | Model delegates are wrapped so `where` always gets `business_id`. **Tagged `$queryRaw` is passed through unscoped**: raw SQL relies on RLS plus whatever predicate the author writes. | `with-tenant.ts:173-178` |
| RLS | `ENABLE` + `FORCE ROW LEVEL SECURITY` with a `tenant_isolation` policy for `bos_app` on every tenant table. | e.g. `20261114050000_customers/migration.sql:172` |
| Composite FKs | Cross-table references carry `business_id` (`[businessId, id]`), so a row cannot point at another tenant's row. | all schema files |
| Privileged SQL | Separate `prisma/privileged/*.sql`, applied by an administrative role with `pnpm db:privileged`. Any extension would need this path. | `apps/api/prisma/privileged/` |

### 2.2 Permissions

- Permission keys per Zone, roles map to key sets; code checks keys, never roles (`apps/api/src/modules/access/server/permissions.ts`).
- Relevant read keys: `customers:read`, `sales:read`, `projects:read`, `finance:read`, `people:read`, `people:read_sensitive`, `scheduling:read`, `activity:read` / `activity:read_restricted`, `communications:read`, `reporting:read`.
- Defaults that matter for search: **MEMBER** has no Finance and no People access; **MANAGER** has `people:read` but not `people:read_sensitive`; OWNER and ADMIN have everything.
- People keeps personal details in a separate 1:1 table, `people_employee_personal_details`, readable only with `people:read_sensitive`. The separation is enforced in the service layer; RLS on that table is tenant-only.
- Record-level rules already exist in places search must not bypass: RESTRICTED activity notes (`activity:read_restricted` or author), OWNER_ONLY mailboxes (C2), E1 erasure (`erased_at` and wiped content).

### 2.3 Existing search and filter implementations

All are per-Zone list filters using case-insensitive `contains` (Prisma → `ILIKE '%term%'`). None has a supporting index, so each is a scan of the tenant's rows (bounded by a `business_id` index).

| Zone list | Matches on | Where |
|---|---|---|
| Customers | display name, legal name, email, phone | `customers/server/customers.ts:37`, `shared.ts:13` |
| Contacts | display name, email, phone, mobile | `customers/server/contacts.ts:72` |
| Opportunities | title | `sales/server/opportunities.ts:332` |
| Projects | name | `projects/server/projects.ts:201` |
| Employees | given, family, preferred name, employee number, work email | `people/server/employees.ts:222` |
| Catalog | name, code, description | `finance/server/catalog.ts:116` |
| Expenses | supplier, description, reference | `finance/server/expenses.ts:476` |
| Scheduling resources | name | `scheduling/server/resources.ts:136` |
| Quotes, invoices, credit notes | **no text search** (filters only) | `finance/server/documents.ts:382` |
| Tasks, events | **no text search** | — |

All of these pass `q` in the **query string** of a GET. See §6.8 on what that means for logs.

### 2.4 UI and navigation

- V2-A (merged) specifies a client-only ⌘K / Ctrl+K palette built from `resolveNavigation` and the person's permissions, with binding rules: one source of truth, separate write checks for create commands, rebuild on business/role change, no capture while typing or in modals, platform labels. It explicitly says record search is future, backend-dependent work and the empty state reads "Searching records is not available yet". **GS1 is that future work and adds to §8.2; it does not redefine it.**
- V2-C (not yet authorised) builds the palette. The current top bar shows a disabled "Search · Soon" field.
- No URL routing. A `ShellRoute` is `{ zone, child?, target?, intent? }`; `target` opens one record. Finance already resolves `target` values such as `invoice:<id>` (`packages/app/src/zones/finance/finance-zone.tsx:30-40`). Other Zones need the same small entry point (GS1-B).
- Scheduling is built but not in the navigation registry until its readiness check (D-V2A-8). Search must not make it reachable earlier.
- Local storage today holds only the last business slug and a "had session" flag, deliberately no ids or tokens (`packages/app/src/workspace/storage.ts`).

### 2.5 Logging

- API errors log only the error class name (`routes.ts:128`). No request bodies are logged. Responses carry `Cache-Control: private, no-store` (`core/http/index.ts:8`).
- Vercel's request logs record the request path and can include the query string. This has not been checked against our project's log settings (§15).

## 3. Principles

1. **The server decides.** Every permission, field and record rule is enforced in the API and the database. The client only hides (ADR 0005).
2. **Search is a view, not a copy.** Results come from the live tables at query time, so archive, void, erase and permission changes take effect on the next keystroke, with no index to purge.
3. **Least surface.** Match on the fewest fields that make search useful, return fewer still. Every field is listed and reviewed (§6.4).
4. **A Zone owns its records.** Each provider lives in its module and uses that module's own visibility rules.
5. **No new infrastructure until measurements say so.**
6. **Honest UI.** Say what was searched; never imply completeness for Zones the person cannot see.

## 4. Entity coverage

### 4.1 Searchable in GS1-A/B (data, permission key and record screen exist)

| Type | Zone | Read key | Match fields | Opens |
|---|---|---|---|---|
| `customer` | Customers | `customers:read` | display name, legal name, email | customer detail |
| `contact` | Customers | `customers:read` | display name, email | contact (via its customer) |
| `opportunity` | Sales | `sales:read` | title | opportunity detail |
| `project` | Projects | `projects:read` | name | project |
| `task` | Projects | `projects:read` | title | the task panel in its project |
| `quote`, `invoice`, `credit_note` | Finance | `finance:read` | document number; customer display name | `finance` target `kind:id` |
| `catalog_item` | Finance | `finance:read` | name, code | catalog item |
| `employee` | People | `people:read` | given, family and preferred name, employee number, work email, job title | employee profile |

Tasks and finance documents have no text search today; GS1-A adds it for global search only (Zone lists unchanged). Phone numbers are **not** matched in GS1-A: the only way to match them today is an unindexed `ILIKE` scan. Digits-only phone matching with its own expression index is a GS1-D item. Whether each type can actually be opened from a result is verified in §10.6.

### 4.2 Later, in GS1-C (one provider per PR)

| Type | Read key | Condition |
|---|---|---|
| `event` (calendar events) | `scheduling:read` | Only after Scheduling is in the navigation (D-V2A-8). Match title and location; never description. Re-reviewed if ADR 0006 private entries are ever built. |
| `resource` | `scheduling:read` | Same condition. |
| `expense` | `finance:read` | Supplier name, reference number. |
| `payment` | `finance:read` | Reference only. Low value; include only if asked for. |
| `department`, `location` | `people:read` | Names. |
| `saved_report` | `reporting:read` | Must reuse R1's visibility rule (own private views plus shared ones). |
| `member` | `members:read` | Name only. Email only under the A2 rule (`members:invite`). Probably better served by Administration. |

### 4.3 Excluded from GS1 (a separate design, "GS2", if ever)

| Data | Why |
|---|---|
| Activities and notes | RESTRICTED notes, free-text bodies, E1 erasure. Needs the activity module's visibility function and its own review. |
| Conversations and messages | OWNER_ONLY mailboxes, retention and erasure, legal holds, message volume, third-party content. |
| People personal details | Never searchable, even with `people:read_sensitive` (D-GS1-3). |
| Leave (P3) types, policies, requests, balances | Leave types can be marked sensitive; requests reveal health and family facts. |
| PDFs, attachments, line items | Content search is a different problem (extraction, size) with little SMB value now. |
| Pipelines, stages, calendars, tax rates, settings | Configuration, reached through "Go to" commands, not records. |

## 5. Architecture options and recommendation

### 5.1 Matching technique

| Option | What it gives | Cost and risk | Verdict |
|---|---|---|---|
| **A. `ILIKE '%term%'`** (today) | Substring anywhere | No index can serve a leading wildcard without `pg_trgm`, so a scan per tenant. Fine up to a few thousand rows per table. | Not used by global search: no index can serve it (§5.3) |
| **B. Built-in full-text search** (`to_tsvector('simple', …)` + prefix `term:*`) | Word and word-prefix matching ("kel" finds "Kelp & Co"), multi-word AND, GIN-indexed, ranking with `ts_rank` | Built into PostgreSQL; no extension. Does not match the middle of a word or tolerate typos. | **Recommended** for names and titles |
| **C. B-tree prefix range on `lower(column) COLLATE "C"`** | Fast "starts with" on numbers, codes, emails | Built in | **Recommended** for identifiers (`INV-0042`, `SKU-12`, emails) |
| **D. Trigram (`pg_trgm`)** | Substring and typo tolerance, `similarity()` ranking | Needs `CREATE EXTENSION`, which in this repo means a privileged step on Neon; larger indexes; more tuning | Deferred to GS1-D, only if zero-result data shows a need (D-GS1-1) |
| **E. `unaccent`** | "Jose" finds "José" | Also an extension, and its dictionary is not immutable, which complicates index expressions | Deferred with D |

The `simple` text-search configuration is used, not `english`: it lowercases and splits words without stemming or stop words. Names do not stem, the product is international by default, and one configuration means one index per table.

### 5.2 Where the searchable text lives

| Option | Description | For | Against |
|---|---|---|---|
| **F. Federated, in place** | Each provider queries its own table with an expression index | Source of truth stays single; archive, void, permission and erasure changes apply instantly; no sync; each module owns its rules; additive migration only | One query branch per type; cross-type ranking needs care (§9.4) |
| **G. Central `search_documents` table** | Triggers copy title and keywords from every Zone into one table | One index, one query, uniform ranking | A second copy of personal data that E1 and People must purge; triggers couple every module to search; RLS and permission columns re-implemented; drift when a trigger is missed |
| **H. External engine** (Typesense, Meilisearch, Algolia, OpenSearch) | Separate service fed by change events | Typo tolerance, facets, scale | New vendor and DPA, monthly cost, sync pipeline, tenant isolation outside RLS, erasure in two places, more on-call surface |

**Recommendation: F.** It keeps every guarantee the platform already proves (forced RLS, composite FKs, erasure) and adds no moving parts. G is the natural next step only if F's cross-type ranking or latency becomes a measured problem; H only at a scale far beyond the initial audience (§5.4).

### 5.3 Query shape

One request is one `withTenant` transaction and **one SQL statement**: a `UNION ALL` of parenthesised branches, one per permitted provider, built from tagged `Prisma.sql` fragments (no `$queryRawUnsafe`, no string concatenation of input). The statement is preceded only by the tenant context, the timeout (§5.5) and the concurrency slots (§6.9).

Each branch is made of **arms**. An arm is one index-served access path with its own `LIMIT`. The P and I arms read their B-tree in order and stop at the `LIMIT`. The W arm's `LIMIT` caps candidate rows, but not the GIN work behind them (see below):

| Arm | Used for | Access path | Bound | Query length |
|---|---|---|---|---|
| **P**: primary-name prefix | tiers 1–2 | B-tree range on `(business_id, (lower(name) COLLATE "C"), id)`, read in index order | `LIMIT cap` (cap = `limit + 1`, max 26), stops early | ≥ 2 |
| **I**: identifier prefix | tiers 1, 4 | B-tree range on `(business_id, (lower(email \| number \| code) COLLATE "C"), id)` | `LIMIT cap` | ≥ 2 |
| **W**: word prefix | tier 3 | GIN on the `to_tsvector('simple', …)` expression | candidate `LIMIT 200` | ≥ 3 |

There is no `ILIKE`, no leading-wildcard `LIKE` and no `OR` between differently indexed columns anywhere in a branch: each column gets its own arm, so the planner never has to pick between a `BitmapOr` and a sequential scan.

Example branch (customers; the shape is the same for every provider):

```sql
( WITH p AS (                                    -- arm P, tiers 1-2
    SELECT id, display_name, legal_name, email, archived_at,
           CASE WHEN lower(display_name) = lower(${q}) THEN 1 ELSE 2 END AS tier
    FROM customers
    WHERE business_id = ${b}::uuid
      AND (archived_at IS NULL OR ${includeArchived})
      AND lower(display_name) COLLATE "C" >= lower(${q}) COLLATE "C"
      AND lower(display_name) COLLATE "C" <  (lower(${q}) || U&'\+10FFFF') COLLATE "C"
    ORDER BY lower(display_name) COLLATE "C", id
    LIMIT ${cap}
  ), i AS (                                      -- arm I, email: tier 1 exact, else 4
    SELECT id, display_name, legal_name, email, archived_at,
           CASE WHEN lower(email) = lower(${q}) THEN 1 ELSE 4 END AS tier
    FROM customers
    WHERE business_id = ${b}::uuid AND (archived_at IS NULL OR ${includeArchived})
      AND lower(email) COLLATE "C" >= lower(${q}) COLLATE "C"
      AND lower(email) COLLATE "C" <  (lower(${q}) || U&'\+10FFFF') COLLATE "C"
    ORDER BY lower(email) COLLATE "C", id
    LIMIT ${cap}
  ), w AS (                                      -- arm W, only when the query has >= 3 characters
    SELECT id, display_name, legal_name, email, archived_at, 3 AS tier
    FROM customers
    WHERE ${wordArmEnabled}
      AND business_id = ${b}::uuid AND (archived_at IS NULL OR ${includeArchived})
      AND to_tsvector('simple', display_name || ' ' || coalesce(legal_name, ''))
          @@ to_tsquery('simple', ${tsq})
    LIMIT 200
  ), m AS (                                      -- best tier per record, no second table access
    SELECT DISTINCT ON (id) * FROM (TABLE p UNION ALL TABLE i UNION ALL TABLE w) x
    ORDER BY id, tier
  )
  SELECT 'customer'::text AS type, id, tier, (archived_at IS NOT NULL) AS archived,
         display_name AS title, …subtitle from the provider's result fields…
  FROM m
  ORDER BY tier, archived, lower(display_name) COLLATE "C", id
  LIMIT ${limit} + 1 )
UNION ALL
( …next provider's branch… )
```

Rules this shape guarantees:

- **Tenant first.** Every arm and the final join carry `business_id = ${b}` explicitly, because tagged `$queryRaw` is not covered by the app-side scope (§2.1). Forced RLS is the backstop.
- **Per-branch `LIMIT ${limit} + 1`** decides `hasMore`; the extra row is dropped before the response.
- **Ordering inside a branch** is `tier`, then live before archived, then the sort key in byte order, then `id`. It is fully deterministic, so the keyset cursor `(tier, archived, sort_key, id)` is stable.
- **No global SQL ordering across branches.** The outer `UNION ALL` has no `ORDER BY`; groups are ordered in the service (§9.4). Comparing ranks across tables in SQL would be meaningless and would force every branch to be fully evaluated before sorting.
- **The W arm's `LIMIT 200` caps the candidate rows, not the index work.** A GIN bitmap scan cannot stop early: it reads the whole posting list for the query's prefix, **across all tenants**, and intersects it with the tenant through a `BitmapAnd` before the cap applies. So the W arm, and therefore the whole query, is **not** a strictly bounded index scan; its cost grows with how common the prefix is in the whole table. The 3-character minimum keeps the worst cases out, and §11.4 benchmarks extremely common 3-character prefixes with noisy neighbouring tenants. If those exceed the budget, the plan changes before production (for example a longer minimum for the W arm, `btree_gin`, or option G). Better W matches beyond the cap are only lost when a prefix matches more than 200 records, and in that case the P and I arms already return the strongest (tier 1–2) hits.
- **No join back to the table.** Each arm selects the provider's result fields itself, and duplicates are removed with `DISTINCT ON (id)`. A first draft joined the matched ids back to `customers`. In the spike below, the planner answered that join with a scan of all the tenant's rows: 11.7 ms for a 2-character query that takes 0.09 ms without the join. That run lacked the `(business_id, id)` unique index the real table has, but the rule removes the dependence on the planner either way: arms carry their own fields.
- **Expression identity.** Each provider declares its index expressions once (a constant shared by the migration test and the SQL builder), so the query expression is textually the same as the index expression. §11.4 checks this with EXPLAIN as a diagnostic.

**Spike evidence (local PostgreSQL 16, not a benchmark).** One throwaway run of this exact customers branch, with the three indexes, on 300k customers in two tenants (50k in the caller's), five name prefixes shared by everyone. Arms P and I used their B-tree indexes in order and stopped at their `LIMIT`. A 2-character query (`ma`) ran in **0.09 ms**, and an email prefix in **0.14 ms**. A 3-character prefix shared by a third of all rows (`mar`, about 100k matches across both tenants) ran in **12 ms**. Its cost was the GIN bitmap over every tenant's matches, combined with the tenant through a `BitmapAnd`. That is the noisy-tenant effect §11.4 measures properly. Nothing from this spike is committed. GS1-A repeats it at the design point and on Neon.

### 5.4 Scaling and when to change

| Size per business | Expected behaviour with F + B/C |
|---|---|
| Up to ~50k rows per type (target audience: 5–50 staff) | Index scans in single-digit milliseconds per branch |
| ~50k–1M rows per type | Still index-served; GIN pending-list and `work_mem` tuning; ranking cost grows with match count, bounded by per-branch limits |
| Beyond ~1M per type, or a need for typos, synonyms, semantic or attachment search | Revisit G or H with measurements; the API contract in §7 does not change |

Operating cost of the recommendation: index storage only (estimate: a few MB per 100k rows per indexed table) and slightly slower writes on indexed tables. No new compute, vendor or bill on the Neon Launch plan.

### 5.5 Statement timeout, transaction and pool

- The search runs in `withTenant(ctx, work, { timeoutMs: 3000 })`. That is Prisma's interactive-transaction timeout (the default in `withTenant` is 5 s, `with-tenant.ts:83`).
- The first statement after the tenant context is `SELECT set_config('statement_timeout', '1000', true)` through the tenant client's tagged `$queryRaw`. `TenantDb` exposes only `$queryRaw`, and `set_config(…, true)` is the transaction-local equivalent of `SET LOCAL`, returning a row the code checks (the same fail-closed pattern as the tenant context). It reverts at commit or rollback, so it never leaks to the next user of a pooled connection, including through Neon's transaction-mode pooler.
- The database timeout (1 s) is shorter than the transaction timeout (3 s), so PostgreSQL cancels the statement first and Prisma rolls back a read-only transaction cleanly; Prisma's own timeout is only a backstop.
- **57014 is handled narrowly.** Today `routes.ts` does not map SQLSTATE 57014 (it falls through to a 500 with the class name logged), and only the retention worker classifies it (`retention-worker.ts:26`). GS1 does **not** change that global mapping. The search service wraps only its own search statement: a 57014 raised there becomes a new `SearchTimeoutError`, which `errorResponse` maps by class to `503 search_timeout`. Any other 57014 elsewhere keeps today's behaviour.
- **Pool.** The API's Prisma client has at most 5 connections per function instance (`app-client.ts:12`). A search holds one for its transaction, normally tens of milliseconds and at most about 1 s. Search sets Prisma's `maxWait` (time to obtain a connection) to 1000 ms. If it runs out, the transaction-start error is mapped by class to `503 search_busy`, again only for the search route. The per-user and per-business slots (§6.9) bound how many connections search can hold at once.
- **Client aborts** do not cancel the database statement. The statement timeout bounds that waste.

## 6. Security and permission model

### 6.1 Layers

| Layer | Mechanism | Fails how |
|---|---|---|
| 1. Authentication | `tenantRoute` (cookie or bearer, CSRF policy, private-beta admission) | 401 |
| 2. Tenant resolution | slug → caller's verified membership; never a client-supplied business id | 404 |
| 3. Permission gate | The route requires `business:read`. The service computes the **permitted providers** from the principal's keys; others are never executed | Zone silently not searched |
| 4. Explicit tenant predicate | Every branch has `business_id = $ctx` | — |
| 5. Forced RLS | `tenant_isolation` on every table touched | zero rows |
| 6. Record rules | Provider predicates: archived, voided, erased, terminated, private (§6.5) | row excluded |
| 7. Field allow-list | Fixed match fields and fixed result fields per provider (§6.4) | field never read |

### 6.2 Provider contract (server)

```ts
interface SearchProvider {
  type: SearchType;                 // 'customer', 'invoice', …
  zone: ZoneId;                     // for grouping and navigation
  requires: Permission[];           // ALL must be held
  matchFields: readonly string[];   // reviewed list, snapshot-tested
  resultFields: readonly string[];  // reviewed list, snapshot-tested; subset of what `requires` already shows
  branch(q: NormalizedQuery, opts: BranchOptions): Prisma.Sql;  // one UNION ALL branch
}
```

Providers live in their own modules (`modules/customers/server/search.ts` and so on) and are registered in `modules/search`. The search module never imports another module's tables directly.

### 6.3 Record-level rules

- A provider's `requires` is the **same** key the Zone's own list endpoint checks. Search never grants more than the list screen.
- Where a module has a visibility function (activities, mailboxes, saved reports, future private events), the provider must call it, not re-implement it. In GS1-A/B no such entity is in scope.
- Cross-Zone text in results (for example a customer name under an invoice) is allowed only when the source Zone's own list already shows it to holders of the provider's key. Finance lists show the customer name to `finance:read`; so does search. A project result does **not** show the project's invoices or totals.

### 6.4 Field-level rules and the People Zone

- **Match fields ⊆ fields every holder of `requires` can already read.** Otherwise a search would answer "does this hidden field contain X?", which is a disclosure even with nothing displayed.
- **Result fields ⊆ match-field owners' list view**, and in GS1 exclude: free text (notes, descriptions), monetary amounts (the palette is often on screen during calls and demos), internal ids other than the record id, and audit metadata (who created or changed it).
- **No server-generated snippets.** No `ts_headline`, no text excerpts. The client highlights the query only inside the title it already received.

**People, explicitly:**

| Data | Table | In search? |
|---|---|---|
| Name, preferred name, employee number, work email, job title, status, department | `people_employees` (+ current department assignment) | Yes, with `people:read` |
| Work phone | `people_employees` | Not matched in GS1 (low value, phone formats) |
| Personal email and phone, home address, emergency contact | `people_employee_personal_details` | **Never**, for anyone, including holders of `people:read_sensitive` (D-GS1-3) |
| History reasons, status-change reasons | history tables | Never |
| Manager relationship | assignment tables | Not matched; not shown |
| Leave (P3) | leave tables | Never in GS1 |

Enforcement: the employee provider's SQL references only `people_employees` and the department assignment/department tables. A source rule test (in the style of the existing depcruise/source rules) fails the build if any file under a search provider mentions `people_employee_personal_details`, `personal_`, or a leave table. A canary test seeds unique tokens into every personal-details column and asserts no search, by any role, returns the employee for those tokens.

Terminated employees are visible in the People directory to `people:read`; search returns them with a "Former" badge and ranks them below current staff (D-GS1-4).

### 6.5 Archived, voided, erased and deleted records

| State | Default | With `includeArchived: true` |
|---|---|---|
| Archived (`archived_at` set) | Excluded | Included with an "Archived" badge, ranked last |
| Finance void / declined / expired | Included with status badge (they are real documents people look up) | same |
| Draft finance documents | Included (number is null; matched by customer name, labelled "Draft") | same |
| Terminated employee | Included with "Former" badge | same |
| Cancelled event (GS1-C) | Excluded | Included with badge |
| Hard-deleted | Gone; no index to purge | — |
| E1-erased content | Never (erased rows and wiped fields are excluded by predicate; nothing is copied, so nothing to purge) | Never |

Because nothing is copied, an erasure, archive or permission change is reflected on the very next query. The client must not cache results across business switch, sign-out or role change (§10.6).

### 6.6 Cross-business exposure

- Business id comes only from the verified membership (layer 2); the request body has no business field, and an unknown body field is rejected by the contract.
- Two-tenant integration tests with identical names and numbers in both businesses (§14).
- Raw SQL branches are checked twice: the explicit predicate and RLS. An isolation test runs every branch with the explicit predicate removed (test seam) and the context set to business B, and asserts zero rows of business A, mirroring spike test S8.

### 6.7 Direct API requests

- The server ignores any client notion of "allowed Zones". `types` in the request only **narrows** the permitted set; an unpermitted type is dropped silently (it would be listed by the caller's own permissions anyway, so silence leaks nothing), an unknown type is a 400 from the contract.
- `limit`, `q` length and term count are bounded by the contract; the server re-clamps.
- The response reports `searchedTypes`, which is derived from the caller's own permissions only.
- No counts beyond `hasMore` per permitted type. No total across types.

### 6.8 Logs and search terms

**Claim:** the design keeps search terms out of URLs and out of our own logs. **Not claimed:** that no system logs them. That is only claimed after the verification below has been done and recorded.

What the design does:

- **POST, not GET** (D-GS1-12). The term travels in the request body, not the URL, browser history or `Referer`. This alone proves nothing about logs; it only removes the most common path.
- The search route never logs the body, the term or result titles. Errors log the class name only (existing convention). A test spies on `console.*` during successful, invalid, timed-out and failing searches and asserts the term never appears.
- Prisma query logging stays off. Parameters are bound, never interpolated.
- Searches are not audited, like opening a list.
- Term-free operational logging only (§6.9): route, status, duration bucket, result-count bucket. No term, no ids, no titles.

**Verification checklist (GS1-A readiness; required before the search route is used in production):**

| # | Where | What to check | Pass when |
|---|---|---|---|
| L1 | Vercel, API project | Request/runtime logs: whether paths keep query strings; whether request bodies are ever recorded; any log drains or integrations | Bodies never recorded; drains (if any) listed with what they receive |
| L2 | Cloudflare | Whether the app and API hostnames are proxied; whether logs, Logpush or WAF payload logging are on | Bodies not logged; URL logging known |
| L3 | Neon | Read-only `SHOW log_statement`, `log_min_duration_statement`, `log_parameter_max_length`, `log_parameter_max_length_on_error`; what Neon's query monitoring shows | No statement or parameter logging; monitoring shows only normalised text (`$1`), never values |
| L4 | APM / error tracking | Confirm none is installed (none in the repo today: no Sentry, OpenTelemetry or Datadog dependency). Any future one must scrub the search route's body | Recorded |
| L5 | Our code | The `console.*` spy tests above | Green |

The result goes in the GS1-A readiness note. If L1–L3 find that bodies or bound parameters are retained, search stays disabled in production until fixed.

**Existing Zone lists (D-GS1-7, accepted conditionally).** Customers, Contacts, Sales, Projects, People, Catalog, Expenses and Resources send `?q=` in GET URLs today (§2.3).

- L1 and L2 are run for these URLs too, by **2026-11-30** (proposed date; Regan to confirm).
- If either keeps query strings, a remediation PR moves list search off the URL (a POST search body, or the GS1 endpoint with `types`). It must merge **before invite-only admission is widened** (the PR #71 lockdown is relaxed or the first non-invited business is admitted), and in any case by **2026-12-31** (proposed).
- If neither keeps query strings, the result is recorded and the lists stay as they are.

### 6.9 Abuse and cost controls (server-side)

Client debounce and cancellation (§10.4) save cost but are not controls: a direct API caller ignores them. The server enforces:

| Control | Value | How |
|---|---|---|
| Input bounds | 2–100 characters, ≤ 8 terms, `limit` ≤ 25 | Contract, re-clamped in the service |
| Work bounds | Per-arm `LIMIT`, W arm only from 3 characters, candidate cap 200 | §5.3 |
| Time bound | 1 s statement timeout, 3 s transaction timeout, 1 s pool wait | §5.5 |
| **Per-user concurrency** | At most **2** searches in flight per user per business | Transaction-scoped advisory try-locks (below) |
| **Per-business concurrency** | At most **8** searches in flight per business | Same |

Concurrency slots use the repository's existing advisory-lock convention (`pg_advisory_xact_lock(hashtextextended('<namespace>:' || …, 0))`, as in People, Communications and Scheduling), in non-blocking form. Inside the search transaction, before the search statement, the service tries slot keys `hashtextextended('search.user:' || business || ':' || user || ':' || n, 0)` for n = 0..1 and `'search.business:' || business || ':' || n` for n = 0..7, with `pg_try_advisory_xact_lock`. If no user slot or no business slot is free, it returns **`429 search_busy`** with `Retry-After: 1`. The locks are released automatically at commit or rollback, so they work through the transaction-mode pooler and cannot be leaked by a crashed function. `try` never waits, so search cannot deadlock or queue behind other work. A hash collision with another namespace can only cause a spurious `429`, never a wait.

This bounds simultaneous load. It does not bound the request **rate** (a client can send one search after another). Rate is handled with measurement and a threshold:

- GS1-A logs one term-free line per search: status, duration bucket, result-count bucket, and whether a slot was refused.
- **Before public beta** (anything beyond the invite-only private beta), a per-user rate limit is added if any of these holds in the measured period: any business sustains more than **600 searches per minute for 5 minutes**; more than **1 %** of searches get `429 search_busy`; or server p95 is above **150 ms** on a normal day. The mechanism (Vercel firewall rule, which may cost money, or a database token bucket) is chosen then, with its cost, as part of D-GS1-13.
- Even if none holds, D-GS1-13 is reviewed again before public beta.

## 7. API contract

Contracts live in `packages/contracts/src/search.ts` (Zod), in the snapshot like every other endpoint.

### 7.1 `POST /api/v1/b/:slug/search`

Requires `business:read`; every type additionally requires its provider's key.

Request:

```jsonc
{
  "q": "kelp",                       // 2..100 chars after trim; NFC-normalised server-side
  "types": ["customer", "invoice"],  // optional; narrows the permitted set
  "limit": 5,                        // per type, 1..25, default 5
  "includeArchived": false,          // default false
  "cursor": null                     // only valid when exactly one type is requested
}
```

Response `200`:

```jsonc
{
  "searchedTypes": ["customer", "contact", "opportunity", "project", "task"],
  "groups": [
    {
      "type": "customer",
      "zone": "customers",
      "items": [ /* SearchResult, §8 */ ],
      "hasMore": true,
      "nextCursor": null            // set only for single-type requests
    }
  ]
}
```

Groups with no hits are omitted; `searchedTypes` still lists them so the UI can say what was covered.

Errors: `400 invalid_request` (contract), `401`, `403 forbidden` (no `business:read`), `404 not_found` (slug), `429 search_busy` (no concurrency slot, with `Retry-After`), `503 search_timeout` (statement timeout, §5.5), `503 search_busy` (no pool connection in time), `503 retryable` (deadlock or serialization, existing mapping). No error body echoes the query.

Headers: existing `Cache-Control: private, no-store`. The route is POST so the CSRF policy for cookie sessions applies as for any mutation.

### 7.2 "See all" in one type

Same endpoint with `types: [one]`, `limit` up to 25 and an opaque keyset `cursor` over `(rank_tier, sort_key, id)`. Used by the palette's "Show more" for one group. Deep filtering stays in the Zone list screens.

### 7.3 `POST /api/v1/b/:slug/search/resolve`

Re-authorises recent records (§10.7). Request: `{ "items": [{ "type": "customer", "id": "…" }] }`, at most 8. Response: the same `SearchResult` shape (§8) for each item the caller can **still** see, in request order; anything deleted, archived (unless it was archived when opened), erased, in another business, or of a type the caller no longer has the key for is silently left out. It runs the same providers with an `id = ANY(${ids})` arm instead of the text arms, so the same permission, field and record rules apply. The same concurrency slots apply.

### 7.4 Not in GS1

No suggestion endpoint separate from search, no server-side recent searches, no saved searches, no bulk export of results.

## 8. Search result schema

```ts
type SearchResult = {
  type: SearchType;              // 'customer' | 'contact' | 'opportunity' | 'project' | 'task' | 'quote' | 'invoice' | 'credit_note' | 'catalog_item' | 'employee'
  id: string;                    // uuid
  title: string;                 // display name, title or number; max 200
  subtitle: string | null;       // max 160, from the provider's resultFields only
  badges: SearchBadge[];         // 'archived' | 'draft' | 'void' | 'former' | 'won' | 'lost' | 'overdue' | 'completed' …, closed enum
  route: { zone: ZoneId; child?: string; target: string };  // a ShellRoute the client can open
};
```

Per type, the only fields that may be returned:

| Type | title | subtitle |
|---|---|---|
| customer | display name | legal name if different, else email |
| contact | display name | customer display name |
| opportunity | title | customer display name · stage name |
| project | name | customer display name · status |
| task | title | project name · status |
| quote / invoice / credit_note | number, or "Draft quote/invoice/credit note" | customer display name · issue or due date |
| catalog_item | name | code · product or service |
| employee | preferred or given name + family name | job title · department |

No amounts, notes, descriptions, addresses, owners, creators, or timestamps other than the finance dates shown in the Finance lists. The contract caps every string length, and the snapshot test pins the field list.

## 9. Indexing, matching and ranking

### 9.1 Query normalisation (server, one function, unit-tested)

1. Unicode NFC, trim, collapse whitespace. Lower-casing is done **in SQL** with `lower()` on both sides (§5.3), never in JavaScript, so the query uses exactly the same case folding as the index expression.
2. `q` (for arms P and I) is the normalised string. It is only ever compared with `>=` and `<` against a `COLLATE "C"` expression, so `%`, `_` and `\` have no special meaning and need no escaping. The upper bound is `q || U+10FFFF`, the highest code point, which in byte order sorts after every string that starts with `q`.
3. Tokens for the W arm: runs of letters and digits (`[\p{L}\p{N}]+`) taken from `q`, at most 8, each at least 1 character. Because every token matches that pattern, the tsquery text `'tok1':* & 'tok2':*` needs no escaping and cannot contain tsquery operators (`& | ! ( ) : * <->`), quotes or backslashes. The builder asserts the pattern and throws otherwise. The string is passed as one bound parameter to `to_tsquery('simple', ${tsq})`.
4. If the query has fewer than 3 characters, or produces no tokens, the W arm is disabled (`${wordArmEnabled}` is false and the arm returns no rows without touching the GIN index).
5. **Parity with the PostgreSQL parser.** The `simple` parser also emits compound tokens (hyphenated words, emails, URLs, numbers with dots). Splitting into plain letter/digit runs matches their parts, which the parser also emits (for example `kelp-co` indexes `kelp-co`, `kelp` and `co`). An integration test runs a corpus of names (accents, hyphens, apostrophes, CJK, emails, numbers) through both and checks that every app token is found in `to_tsvector('simple', …)` of the source text.

### 9.2 Indexes (GS1-A migration, additive, no extension, no privileged step)

Written by hand in the migration, as the repo already does for expression indexes (for example `people_employees_number_key` on `lower(employee_number)`, `20261118000000_people/migration.sql:282`).

B-tree prefix indexes (arms P and I), each `(business_id, (lower(col) COLLATE "C"), id)`:

| Table | Columns |
|---|---|
| customers | display_name; email |
| contacts | display_name; email |
| opportunities | title |
| projects | name |
| project_tasks | title |
| finance_documents | number, as `(business_id, kind, (lower(number) COLLATE "C"), id)` |
| finance_catalog_items | name; code |
| people_employees | given_name; family_name; preferred_name; employee_number; work_email |

GIN indexes (arm W), `to_tsvector('simple', <expression>)`:

| Table | Expression |
|---|---|
| customers | `display_name || ' ' || coalesce(legal_name, '')` |
| contacts | `display_name` |
| opportunities | `title` |
| projects | `name` |
| project_tasks | `title` |
| finance_catalog_items | `name` |
| people_employees | `given_name || ' ' || family_name || ' ' || coalesce(preferred_name, '') || ' ' || coalesce(job_title, '')` |

Finance documents have no W arm: a document is found by its number (arm I) or through its customer's name (arm P on `customers.display_name`, joined by `customer_id`, with the existing `(business_id, customer_id)` index; that join is part of the benchmark).

Notes:

- `COLLATE "C"` makes the range comparison byte-ordered, which a B-tree can serve for any prefix without depending on the database's default collation. `lower()` is the same immutable function the existing employee-number index uses.
- A GIN index on a tsvector cannot lead with `business_id`. The arm filters the matched rows by tenant, so its cost grows with matches across **all** tenants for that prefix. The benchmark includes a large noisy tenant to measure this (§11.4). If it is too slow, the options are `btree_gin` (an extension, so an owner decision) or a central table (option G).
- 22 new indexes is a write cost on busy tables (tasks especially). The benchmark measures insert and update cost; any index whose arm brings little (for example `preferred_name`) is dropped in GS1-A rather than kept speculatively.
- Prisma cannot express these indexes. They live only in the migration, like the existing hand-written expression indexes, which `db:check-migrations` (`prisma migrate diff`) already passes with. GS1-A confirms the new ones pass too.
- Building them: see §11.4 (table sizes and lock time) before the migration is proposed for production.

### 9.3 Ranking within a type

| Tier | Meaning | Arm |
|---|---|---|
| 1 | The whole query equals the primary name, number, code or email (case-insensitive) | P, I |
| 2 | The primary name starts with the query | P |
| 3 | Every token is a word prefix somewhere in the indexed text | W |
| 4 | A secondary identifier (email, code, employee number, work email) starts with the query | I |

Within a tier: live before archived, then the sort key in byte order, then `id`. Former employees rank below current ones by an extra key. Text-relevance scoring (`ts_rank`) is not used in GS1-A: it costs a computation per candidate, is not comparable across tables, and adds little for short names. GS1-D can add it with measurements.

### 9.4 Ranking across types

Raw `ts_rank` values from different tables are not comparable. Groups are ordered by:

1. The best tier present in the group (a group with an exact match comes first).
2. Otherwise a fixed Zone order that matches the sidebar (`customers`, `sales`, `projects`, `finance`, `people`).
3. If the person is inside a Zone, that Zone's group is moved up one place (context boost, client-side).

The palette shows a "Top hit" row only when exactly one result in all groups is a tier-1 exact match.

## 10. UI interaction specification

This extends V2-A §8.2 and keeps every rule there. Where the palette previously said "Searching records is not available yet", it now searches.

### 10.1 Opening

- `⌘K` on macOS, `Ctrl+K` on Windows and Linux, and the top-bar "Jump to… ⌘K" button. Same palette, same rules for focus, modals, IME and platform labels (V2-A §8.2). No second shortcut for search (D-GS1-8).
- `/` keeps its V2-A meaning (focus the page's own filter), so list screens keep in-Zone search.
- In the browser, `Ctrl+K` is a browser shortcut on Windows and Linux; the handler calls `preventDefault` only when the app has focus and the V2-A capture rules allow it.

### 10.2 Layout (top to bottom)

1. Input: placeholder "Search or jump to…".
2. Under 2 characters: "Recent" (records opened this session, §10.7), then the V2-A commands (Go to, Create, Switch business, Preferences).
3. From 2 characters: matching **commands** first (max 5, filtered client-side, instant), then **Records**, grouped by Zone with a group heading ("Customers", "Finance · Invoices"), max 5 per group, each with "Show more" when `hasMore`.
4. Footer: key hints (↑↓ to move, ↵ to open, ⌘↵ to open in place of the current record, Esc to close), and "Searched: Customers, Sales, Projects" from `searchedTypes`.

Row: Zone icon, title with the query highlighted (client-side, title only), subtitle, badges. Archived results show muted with the badge. An "Include archived" toggle sits at the bottom of the Records section.

### 10.3 Keyboard navigation and accessibility

- ARIA combobox pattern: the input has `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant`; the list is a `listbox` with `group`s labelled by their headings; rows are `option`s.
- `↑ ↓` move across groups without wrapping into the input; `Home`/`End` go to first/last; `Enter` opens; `Tab` does not move between rows (stays WCAG-friendly, focus remains in the input).
- An `aria-live="polite"` region announces "12 results in 3 Zones" after each settled update, not on every keystroke.
- Reduced motion: no animated reordering.

### 10.4 Instant suggestions, debouncing and stale results

- Commands filter instantly on every keystroke (no network).
- Record search fires 150 ms after the last keystroke (D-GS1-9), and immediately on `Enter` if a search is pending.
- Each request carries an increasing sequence number and an `AbortController`; a newer keystroke aborts the older request, and a response whose sequence is older than the latest is dropped.
- **No response cache.** Every query goes to the server, so a permission or record change is reflected on the next keystroke. (Revision 1's 30-second cache is removed.)
- **Security context.** The palette keeps a context key: user id, business id, membership role and the sorted permission set, taken from the shell's membership state. Each request and each response is tagged with the key it was made under.
- **On any context change** (business switch, role or permission change, sign-out, session end), in the same render that applies the change: abort every in-flight search and resolve request, discard every result and every recent, and rebuild the command list (V2-A §8.2). A response tagged with an old key is dropped on arrival, even if its sequence number is current.
- **Previous results while loading:** shown muted only if they were fetched under the current context key, and only until the next response. They are never carried across a context change.
- **On `401` or `403` from search or resolve:** discard results and recents at once. `401` starts the session-ended flow; `403` makes the shell refresh the membership, which changes the context key if permissions changed.
- **On close:** results are discarded. Reopening the palette starts empty (recents are re-resolved, §10.7).
- Remaining window: if access is revoked on the server while results are on screen, those rows stay visible until the next keystroke or close. Opening one goes through the Zone's own API, which re-checks access (§10.6). This is the same window as any list screen that is already open.

### 10.5 States

| State | What the person sees |
|---|---|
| Fewer than 2 characters | Recent + commands; no request |
| Loading (first response not yet in, > 300 ms) | A thin progress bar under the input; commands stay usable |
| No results | "No records match "kelp" in Customers, Sales and Projects." plus "Include archived" if off |
| No searchable Zones (no read keys) | Commands only; the Records section does not appear |
| Offline | "You're offline. Commands still work; record search needs a connection." |
| Error (`5xx`, timeout) | "Search didn't finish. Try again." with a retry action; commands stay usable |
| Session ended (`401`) | Existing session-ended flow |

### 10.6 Opening a record

- `Enter` or click: close the palette, then navigate to `route` through the shell's normal navigation, **guard first** (the V2-A unsaved-changes guard runs before leaving).
- **Permission-safe by construction.** The shell honours a route only for a Zone the server's permissions open, and only in the business it was chosen in (`canOpen` and the slug check, `packages/app/src/app.tsx:212-214`); otherwise it lands on Home. The Zone then loads the record through its own API, which enforces the permission and tenant again. A record that has since become unavailable shows the Zone's existing not-found state.
- **Scheduling stays absent.** It has no registry entry until its V2-C readiness check (D-V2A-8), so `canOpen` rejects any Scheduling route. GS1-A/B have no event or resource provider, and the contract's `SearchType` enum has no `event` or `resource` value, so the API rejects them with `400`. A test pins both.

Verified state of each GS1 type's target (on `main` at `6bc707e`):

| Type | Opens today? | Evidence | Work in GS1-B |
|---|---|---|---|
| customer | Yes | `CustomerZone initialCustomerId={target}` (`app.tsx:227`) | none |
| contact | **No** | Contacts are reached inside their customer; no contact target | Add `contact:<id>` to the Customers Zone: opens the contact's customer with the contact selected, or a standalone contact view when it has no customer (`customer_id` is nullable) |
| opportunity | **No** | `SalesZone` receives only `initialAction` (`app.tsx:237`) | Add `initialOpportunityId` |
| project | Yes | `ProjectsZone initialProjectId={target}` (`app.tsx:245`) | none |
| task | **Partly** | The project opens; the task panel does not | Add a `<projectId>:task:<taskId>` target that opens the board with the task panel |
| quote, invoice, credit_note | Yes | `initialView` handles `quote:`, `invoice:`, `credit-note:` (`finance-zone.tsx:40-42`) | none |
| catalog_item | **No** | `initialView` has no catalog target | Add `catalog:<id>` |
| employee | Yes | `PeopleZone initialEmployeeId={target}` (`app.tsx:254`) | none |

**Rule:** the palette shows a type only once its target works. Until its GS1-B entry point lands, the client leaves that type out of `types` in the request. Each type has a UI test that opens a result end to end, and a test that a result for a Zone the member cannot open is never rendered and, if forced, lands on Home.

### 10.7 Recent

- GS1-B: **session only**. The palette keeps the `(type, id)` of the last 8 records opened from it, in memory only. It keeps no titles and no search terms, and nothing goes to local storage.
- **Re-authorised before display.** When the palette opens with recents, it calls `search/resolve` (§7.3) and shows only what the server returns, with the server's current titles. If resolve fails, the Recent section is hidden.
- **Re-authorised on open.** Opening a recent goes through the same guarded navigation and the Zone's own API (§10.6).
- Cleared on every security-context change (§10.4).
- Persisted recents (ids only, still resolved before display) are a later option under D-GS1-6, not part of GS1.

### 10.8 Desktop and narrow widths

- Tauri and web share the same palette (ADR 0005); no native shortcuts.
- Below 640 px the palette is full-screen; groups and keyboard behaviour are unchanged.

## 11. Performance plan

### 11.1 Targets (D-GS1-10: measurement goals)

| Measure | Target |
|---|---|
| Server time, p95, all permitted types, design-point tenant | ≤ 150 ms |
| Server time, p99 | ≤ 400 ms |
| Keystroke-to-results, p95, same region, after debounce | ≤ 300 ms |
| Hard cap | `statement_timeout` 1 s |
| Command filtering | < 16 ms (one frame) |

These are goals measured by the benchmark (§11.4) and recorded in the GS1-A readiness note. They are not CI gates. A miss blocks production use of GS1-A until it is explained and either fixed or accepted by Regan.

Design-point tenant: 10k customers, 20k contacts, 10k opportunities, 5k projects, 100k tasks, 50k finance documents, 2k catalog items, 500 employees. Plus a **noisy tenant** five times that size in the same database, sharing common name prefixes, so GIN arms pay for cross-tenant matches.

### 11.2 Limits and pagination

- Palette: 5 per type, at most ~10 types → ≤ 50 rows per response.
- "Show more": 25 per page, keyset cursor, single type.
- No offset pagination; no total counts.

### 11.3 Debouncing

150 ms debounce, abort on new input, minimum 2 characters (§10.4), provisionally (D-GS1-9): confirmed or changed (for example 250 ms / 3 characters) from the benchmark's cost per keystroke.

### 11.4 Benchmark, plans and migration safety

**CI (gating):** correctness only: results, permissions, isolation, record states, leak canaries (§14). CI does not assert which index the planner chooses or how long a query takes. Both depend on statistics and hardware and would make CI flaky.

**Benchmark (GS1-A, a script in the repo, run on demand; results recorded in the readiness note):**

1. Seed the design-point tenant and the noisy tenant (§11.1) locally, `ANALYZE`.
2. Query corpus of at least 300 queries: 2-character prefixes chosen to be the **most common** in the seeded names (worst case for arms P and I); 3- and 4-character common prefixes (worst case for arm W); full names; multi-word; numbers (`INV-00`), emails, codes; no-hit queries; accented and non-Latin queries.
3. For each: server time p50/p95/p99, per type and for the whole union; `EXPLAIN (ANALYZE, BUFFERS)` per branch saved as JSON.
4. **Plan diagnostics, not assertions:** a report lists any arm that did not use its intended index (sequential scan, wrong index, expression mismatch), plus buffers read per arm. Each one is investigated and fixed or explained before readiness.
5. Write overhead: insert and update timings on every indexed table, before and after the indexes.
6. Re-run on a **temporary Neon branch** in the production region, seeded with the same synthetic data, so latency includes Neon and its pooler. No production data is used. Creating, keeping and deleting this branch follows the standing Neon policy and the housekeeping process (recovery-branch registry, the 10-branch limit, any extra branch cost). It is not assumed to be blanket authorisation: if the branch would exceed the limit, add cost or need a deletion the policy does not cover, it waits for Regan's approval.

**Table sizes and index build locks (before the migration is proposed for production):**

- Read-only on production: `SELECT relname, n_live_tup, pg_total_relation_size(oid)` for each table in §9.2. This is a read-only check, so it is allowed without approval.
- Build every index on a temporary Neon branch seeded at **the larger of production's size and the design point**, and record the time per table. A plain `CREATE INDEX` inside the migration transaction blocks writes to that table for the build time.
- The 2-second threshold is a **planning threshold**, not a safety guarantee. If every table builds in under 2 s at production size, the plain in-migration build remains the plan, and these steps still come before any production DDL:
  1. Confirm how the actual migration runner (`prisma migrate deploy` as used in this repo) wraps the migration in a transaction, and what that means for locks held until commit.
  2. Put an explicit `SET LOCAL lock_timeout` (proposed 3 s) and a controlled `SET LOCAL statement_timeout` at the top of the migration, so a blocked or slow build fails and rolls back instead of queueing writes behind it.
  3. Write down the rollback and recovery plan: a fresh verified recovery branch first (standing policy), what to do if the migration times out, and the fact that a failed additive index migration leaves nothing to undo.
  4. Re-measure with realistic concurrent writes on the benchmark branch, not just an idle build.
  5. Get Regan's separate production-migration approval.
- **Otherwise** the slow indexes move to `CREATE INDEX CONCURRENTLY`. That cannot run inside a Prisma migration transaction, so it needs a separate non-transactional step (like the privileged scripts) and its own owner decision. GS1-A stops and asks rather than improvising.

### 11.5 Scaling assumptions

- Most businesses are far below the design point; the largest SMB tenants should stay within it for years.
- The union holds one pooled connection for the request's duration (tens of ms).
- Search load is bursty per active person but debounced; a business of 50 people searching constantly is a few requests per second at most.

## 12. Implementation sequence

Each stage is its own thread, branch and draft PR, audited before merge, and none applies a production migration without Regan's separate approval.

### GS1-A: Search backend foundations

- `packages/contracts/src/search.ts` (search and resolve) and contract snapshot.
- `apps/api/src/modules/search`: provider interface and registry, normaliser, branch and `UNION ALL` builder (§5.3), concurrency slots (§6.9), timeout handling (§5.5), group ordering, cursor.
- Providers in their modules: customer, contact, opportunity, project, task, quote/invoice/credit note, catalog item, employee (work fields only).
- Routes `POST /api/v1/b/:slug/search` and `/search/resolve`. Search-only error classes: `SearchTimeoutError` → `503 search_timeout`, pool wait → `503 search_busy`, no slot → `429 search_busy`. No change to the global 57014 handling.
- Migration `2026MMDD000000_search_indexes`: indexes only (§9.2). Stamp chosen at PR time after checking open PRs' stamps.
- Tests (§14) and the benchmark script (§11.4).

**GS1-A readiness gate** (all recorded in the PR before the migration is proposed for production or the route is used there):

1. Benchmark locally and on a temporary Neon branch, with plan diagnostics resolved (§11.4).
2. Production table sizes and index build times; lock plan accepted (§11.4).
3. Logging checklist L1–L5 done (§6.8). Search stays disabled in production if bodies or parameters are retained.
4. Concurrency slots tested under parallel load (§14).
5. Regan's approval to merge, then separately to apply the migration.

### GS1-B: Global command palette, record search

- **Waits for the V2-C palette** (D-GS1-11 a). Built against GS1-A's contract with test fakes, so it can be prepared once the contract merges, but it merges only after V2-C.
- Records section, grouping, keyboard model, states, debounce and abort, security-context invalidation, re-authorised recents, "Show more", "Include archived" (§10).
- The missing target entry points: contact, opportunity, task, catalog item (§10.6). Each type is enabled in the palette only once its target works.
- UI tests for every rule in §10, plus the V2-A §8.2 rules unchanged.

### GS1-C: Expanded Zone coverage

One small PR per provider, in any order: events and resources (after D-V2A-8 readiness), expenses, departments and locations, saved reports, members, payments. Each adds its index (if any), provider, field review and tests.

### GS1-D: Performance and relevance

- Zero-result and latency metrics (term-free) to decide on trigram.
- Optional `pg_trgm` / `unaccent` via a privileged step (needs a new owner decision and its own migration approval).
- Digits-only phone matching with its own expression index, `ts_rank` if measurements justify it, persisted recents (if D-GS1-6 is revisited).
- **Before public beta:** the per-user rate limit if a §6.9 threshold is crossed, and the D-GS1-13 review either way.
- **Dated:** the D-GS1-7 list remediation if L1/L2 found query strings retained (§6.8): before admission is widened, and by 2026-12-31 at the latest (proposed).

### Independence

| Work | Can start when |
|---|---|
| GS1-A (contract, framework, providers, migration file, tests, benchmark) | After Regan authorises GS1-A following this revision. Independent of V2-B/V2-C |
| GS1-A in production | After the readiness gate, merge approval and a separate migration approval |
| D-GS1-7 log verification (L1/L2 for existing lists) | Now; independent of GS1 code (proposed by 2026-11-30) |
| GS1-B target entry points (contact, opportunity, task, catalog) | Independently of each other and of GS1-A; small Zone PRs |
| GS1-B palette record search | Preparation after GS1-A's contract merges; merge after the V2-C palette merges |
| Each GS1-C provider | After GS1-A merges; independent of each other and of GS1-B. Events and resources only after the D-V2A-8 readiness check |
| GS1-D items | After GS1-A is in production with term-free measurements; each independent |

## 13. Owner decisions

Recorded from Regan's review on PR #75 (2026-11-16). This review approved the documentation direction only: no merge, migration, deployment or GS1-A implementation is authorised by it.

| ID | Decision | Outcome | Conditions and where they are handled |
|---|---|---|---|
| D-GS1-1 | Search infrastructure | **(a)** Built-in PostgreSQL FTS + B-tree prefix, no extension | Trigram or `unaccent` would need a new decision (GS1-D) |
| D-GS1-2 | Indexing model | **(a)** Federated, in-place expression indexes | §5.3, §9.2 |
| D-GS1-3 | People sensitive data | **(a)** Work fields only for `people:read`; personal details never searchable | §6.4 |
| D-GS1-4 | Terminated employees | **(a)** Shown as "Former", ranked lower | §6.5, §9.3 |
| D-GS1-5 | Archived records | **(a)** Excluded by default, toggle to include | §6.5 |
| D-GS1-6 | Search history and retention | **(a)** No server history, no stored terms, session-only recents | Recents hold ids only and are re-authorised before display and on open (§10.7) |
| D-GS1-7 | Existing Zone list `?q=` in URLs | **(a), conditional** | Verify L1/L2 for list URLs (proposed by 2026-11-30); if retained, remediation before admission is widened and by 2026-12-31 (proposed dates for Regan to confirm) (§6.8) |
| D-GS1-8 | Global shortcut | **(a)** One palette on ⌘K / Ctrl+K | §10.1 |
| D-GS1-9 | Debounce and minimum length | **150 ms / 2 characters, provisional** | Confirmed or changed from the benchmark's cost per keystroke (§11.3, §11.4) |
| D-GS1-10 | Performance targets | **Accepted as measurement goals** | Not fixed-index or latency CI gates; a miss blocks production use until explained (§11.1, §11.4) |
| D-GS1-11 | Sequencing with V2-C | **(a)** GS1-B waits for V2-C; GS1-A is independent | §12 |
| D-GS1-12 | Transport | **(a)** POST with body | Not treated as proof of zero logging (§6.8) |
| D-GS1-13 | Rate limiting | **Strengthened beyond (a)** | Server-side per-user (2) and per-business (8) concurrency slots in GS1-A; measured thresholds for a rate limit before public beta (§6.9) |
| D-GS1-14 | Scope of GS1 | **(a)** §4.1 now, §4.2 in GS1-C; activities, communications and leave excluded | §4 |

Added in revision 2 and decided by Regan on 2026-11-16, accepting the recommendations from ChatGPT's re-audits, conditions included:

| ID | Decision | Outcome | Conditions and where they are handled |
|---|---|---|---|
| D-GS1-15 | Concurrency limits | **Provisionally approved:** 2 in-flight searches per user per business, 8 per business, `429 search_busy` with `Retry-After: 1` | Subject to benchmarking; tuned from measurements (§6.9, §11.4) |
| D-GS1-16 | Index build lock threshold | **Approved as a planning threshold:** 2 s per table at production size | Not a safety guarantee. Under it: plain `CREATE INDEX` only with the §11.4 safeguards (runner transaction behaviour confirmed, `lock_timeout`, controlled `statement_timeout`, recovery plan, re-measure under writes) and a separate production migration approval. Over it: a separately approved `CREATE INDEX CONCURRENTLY` step |
| D-GS1-17 | Dates for D-GS1-7 | **Approved:** check list-URL logging (L1/L2) by 2026-11-30 | If query strings are retained, remediate before invite-only admission widens and no later than 2026-12-31 (§6.8) |
| D-GS1-18 | Phone matching | **Deferred to GS1-D** | Needs its own index and review (§4.1) |

These decisions settle the architecture document only. GS1-A implementation, benchmarks that create infrastructure, index creation, migrations and turning on live search each still need their own explicit approval.

## 14. Test strategy

**CI-gating** (correctness and security; no plan or timing assertions):

| Level | What |
|---|---|
| Unit | Normaliser (NFC, whitespace, term cap, token pattern, tsquery text contains no operators, quotes or backslashes for any input, fuzzed); range bounds for P/I arms; W arm disabled under 3 characters; registry → permitted set per role; group ordering; cursor round-trip and tamper rejection; slot key construction |
| Contract | Snapshot of search and resolve schemas; unknown body fields rejected; string caps; `event` and `resource` are not valid types |
| Permission matrix (integration, real Postgres as `bos_app`, forced RLS) | Each role × each type: present only with the read key. MEMBER never gets finance or employee results; MANAGER gets employees but never personal-detail matches |
| Tenant isolation | Two businesses with identical names, numbers and emails; every query and every resolve returns only the caller's rows. Isolation seam: each branch with its explicit predicate removed still returns nothing from the other tenant under RLS |
| Field leakage canaries | Unique tokens in every non-match column (notes, descriptions, amounts, phones, personal details, leave fields, restricted notes); searching each token returns nothing, and no token appears in any search or resolve response body |
| Source rules | Search providers may not reference personal-details, leave, activity, message or mailbox tables; no `$queryRawUnsafe`, `ILIKE` or leading-wildcard `LIKE` in the search module |
| Matching parity | App tokens vs `to_tsvector('simple', …)` over a multilingual corpus (§9.1); every arm's SQL expression equals its declared index expression |
| Record states | Archived (default off / on), voided, draft, terminated, erased, deleted; resolve drops items that became archived, deleted, erased or forbidden |
| Timeout and errors | A deliberately slow search (test seam: `pg_sleep` in a test-only provider) returns `503 search_timeout`, the transaction is rolled back and the connection's `statement_timeout` is back to default for the next transaction; a 57014 outside search is unchanged (still 500); pool wait → `503 search_busy` |
| Concurrency slots | Parallel requests: the 3rd concurrent search for one user and the 9th for one business get `429`; slots free after commit and after an error; no waiting |
| Direct API | Forged `types`, oversized `q`, too many terms, `limit` out of range, cursor for another type or business, GET → 405, injection strings (`' ; -- % _ \ & | ! ( ) : * <->`, Unicode look-alikes) |
| Logging | `console.*` spied: no term, id or title in any log line on success, validation failure, 429, timeout and unexpected error |
| UI (GS1-B, harness from V2-A) | Shortcut and capture rules; debounce, abort, stale-sequence and stale-context drop; results and recents cleared in the same render on business switch, role change, sign-out, 401 and 403; no previous-context row ever rendered (asserted per frame in the harness); recents shown only from resolve; every target in §10.6 end to end; Scheduling absent; every state in §10.5; ARIA roles; screenshots at 1440 / 900 / 390 in both themes |

**Not gating** (diagnostics, recorded in the readiness note): the benchmark, plan diagnostics, Neon re-run and write overhead (§11.4).

## 15. Risks and open questions

| Risk or question | Mitigation |
|---|---|
| Vercel or Cloudflare keep query strings for existing GET list endpoints | Checklist L1/L2 and the dated D-GS1-7 trigger (§6.8) |
| Some layer keeps request bodies or bound parameters | Checklist L1–L4; search stays disabled in production until clean (§6.8) |
| Hand-written indexes drift from Prisma's view | Follow the existing pattern for hand-written expression indexes; `db:check-migrations` in CI |
| Index builds block writes | Measure at production size; 2 s threshold; otherwise a separate decision (§11.4, D-GS1-16) |
| GIN arms pay for other tenants' matches | Noisy-tenant benchmark; `btree_gin` or a central table only if measured |
| Common 2-character prefixes are expensive | Only B-tree arms run under 3 characters, each stopping at its `LIMIT` (§5.3) |
| Stale results after a permission change | No cache; context-tagged requests; clear on change; resolve before showing recents (§10.4, §10.7) |
| Too many indexes slow writes | Write-overhead measurement; drop low-value indexes in GS1-A (§9.2) |
| No mid-word or typo matching disappoints users | Measure zero-result rate (term-free) and decide on trigram in GS1-D |
| Scheduling becomes reachable through search before its readiness check | No provider or type until GS1-C after D-V2A-8; tests pin it (§10.6) |
| A future module adds a visibility rule search doesn't know about | Provider contract requires reuse of the module's visibility function; field lists are snapshot-tested and reviewed per PR |
