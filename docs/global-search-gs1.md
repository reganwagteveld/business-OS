# GS1: Global Search, architecture and implementation plan

- **Status:** Proposed. Documentation only. Nothing here is built, migrated or deployed. Implementation starts only after review and Regan's approval of the decisions in §13.
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

Phases: **GS1-A** backend foundations, **GS1-B** palette record search, **GS1-C** more Zones, **GS1-D** performance and relevance. Fourteen owner decisions are listed in §13, each with a recommendation.

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
| `customer` | Customers | `customers:read` | display name, legal name, email, phone | customer detail |
| `contact` | Customers | `customers:read` | display name, email, phone, mobile | contact (via its customer) |
| `opportunity` | Sales | `sales:read` | title | opportunity detail |
| `project` | Projects | `projects:read` | name | project |
| `task` | Projects | `projects:read` | title | the task panel in its project |
| `quote`, `invoice`, `credit_note` | Finance | `finance:read` | document number; customer display name | `finance` target `kind:id` |
| `catalog_item` | Finance | `finance:read` | name, code | catalog item |
| `employee` | People | `people:read` | given, family and preferred name, employee number, work email, job title | employee profile |

Tasks and finance documents have no text search today; GS1-A adds it for global search only (Zone lists unchanged).

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
| **A. `ILIKE '%term%'`** (today) | Substring anywhere | No index can serve a leading wildcard without `pg_trgm`, so a scan per tenant. Fine up to a few thousand rows per table. | Keep as the fallback for short codes and numbers only |
| **B. Built-in full-text search** (`to_tsvector('simple', …)` + prefix `term:*`) | Word and word-prefix matching ("kel" finds "Kelp & Co"), multi-word AND, GIN-indexed, ranking with `ts_rank` | Built into PostgreSQL; no extension. Does not match the middle of a word or tolerate typos. | **Recommended** for names and titles |
| **C. B-tree prefix on `lower(column) text_pattern_ops`** | Fast "starts with" on numbers, codes, emails | Built in | **Recommended** for identifiers (`INV-0042`, `SKU-12`, emails) |
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

One request is one `withTenant` transaction. The search service builds a single `UNION ALL` of the permitted providers' branches with tagged `Prisma.sql` fragments (no `$queryRawUnsafe`). Each branch:

- filters `business_id = ${ctx.businessId}` **explicitly** (raw SQL is not covered by the app-side scope; RLS remains the backstop),
- applies its own archived / erased / visibility predicates,
- orders by its own rank and stops at `limit + 1`.

One round trip keeps latency low on Vercel → Neon and avoids holding the pooled connection for several sequential queries. `SET LOCAL statement_timeout = '1000ms'` bounds the worst case.

### 5.4 Scaling and when to change

| Size per business | Expected behaviour with F + B/C |
|---|---|
| Up to ~50k rows per type (target audience: 5–50 staff) | Index scans in single-digit milliseconds per branch |
| ~50k–1M rows per type | Still index-served; GIN pending-list and `work_mem` tuning; ranking cost grows with match count, bounded by per-branch limits |
| Beyond ~1M per type, or a need for typos, synonyms, semantic or attachment search | Revisit G or H with measurements; the API contract in §7 does not change |

Operating cost of the recommendation: index storage only (estimate: a few MB per 100k rows per indexed table) and slightly slower writes on indexed tables. No new compute, vendor or bill on the Neon Launch plan.

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

- **POST, not GET.** The term travels in the body, so it does not appear in Vercel request logs, browser history, proxies or `Referer` headers (D-GS1-12).
- The search route never logs the body, the term, or result titles. Errors log the class name only (existing convention). A unit test spies on `console.*` during a failing search and asserts the term does not appear.
- Prisma query logging stays off in production. Parameters are bound, never interpolated.
- Not audited: searching is a read, like opening a list. Opening a record is not audited either today.
- Metrics, if added in GS1-D, are aggregate and term-free: latency, result count bucket, zero-result flag, types searched.
- **Existing Zone lists** already send `?q=` in GET URLs (§2.3). Decision D-GS1-7 asks whether to accept that or move list search to POST in a later PR.
- Neon: statement logging with parameters is not enabled by us; to be confirmed in GS1-A (§15).

### 6.9 Abuse and cost bounds

- Minimum 2 characters, maximum 100 characters, at most 8 terms after normalisation.
- Per-branch limit ≤ 25, palette default 5.
- `statement_timeout` 1 s inside the search transaction; a timeout returns `503 retryable` with no detail (existing mapping for `57014` to be added).
- Client debounce and request cancellation (§10.4).
- No dedicated rate limiter exists in the API today. GS1 relies on the bounds above; a per-membership limit or Vercel firewall rule is D-GS1-13.

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

Errors: `400 invalid_request` (contract), `401`, `403 forbidden` (no `business:read`), `404 not_found` (slug), `503 retryable` (timeout, deadlock). No error body echoes the query.

Headers: existing `Cache-Control: private, no-store`. The route is POST so the CSRF policy for cookie sessions applies as for any mutation.

### 7.2 "See all" in one type

Same endpoint with `types: [one]`, `limit` up to 25 and an opaque keyset `cursor` over `(rank_tier, sort_key, id)`. Used by the palette's "Show more" for one group. Deep filtering stays in the Zone list screens.

### 7.3 Not in GS1

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

1. Unicode NFC, trim, collapse whitespace, lower case.
2. Split into terms on whitespace; drop terms that are only punctuation; keep at most 8.
3. For full-text branches: each term becomes a quoted lexeme with prefix (`'kelp':*`), joined with `&`. Built with `to_tsquery('simple', $1)` from a value that contains only escaped lexemes; tsquery operators in the input (`& | ! ( ) : * <->`) are never passed through.
4. For identifier branches: the raw normalised string, `LIKE` wildcards escaped, as a `lower(col) LIKE $1 || '%'` prefix.

### 9.2 Indexes (GS1-A migration, additive, no extension, no privileged step)

Expression GIN indexes, written by hand in the migration as the repo already does for partial and expression indexes (for example `people_employees_number_key` on `lower(employee_number)`, `20261118000000_people/migration.sql:282`), each leading with the tenant column through a composite B-tree where useful:

| Table | Index | Expression |
|---|---|---|
| customers | GIN | `to_tsvector('simple', coalesce(display_name,'') || ' ' || coalesce(legal_name,''))` |
| customers | B-tree | `(business_id, lower(email) text_pattern_ops)` |
| contacts | GIN | `to_tsvector('simple', display_name)` |
| contacts | B-tree | `(business_id, lower(email) text_pattern_ops)` |
| opportunities | GIN | `to_tsvector('simple', title)` |
| projects | GIN | `to_tsvector('simple', name)` |
| project_tasks | GIN | `to_tsvector('simple', title)` |
| finance_documents | B-tree | `(business_id, kind, lower(number) text_pattern_ops)` |
| finance_catalog_items | GIN + B-tree | `to_tsvector('simple', name)`; `(business_id, lower(code) text_pattern_ops)` |
| people_employees | GIN | `to_tsvector('simple', given_name || ' ' || family_name || ' ' || coalesce(preferred_name,'') || ' ' || coalesce(job_title,''))` |
| people_employees | B-tree | `(business_id, lower(work_email) text_pattern_ops)`, `(business_id, lower(employee_number) text_pattern_ops)` |

Notes:

- GIN on a tsvector cannot include `business_id`; the planner combines it with the existing `(business_id, …)` B-tree indexes through a bitmap AND, or filters the (small) GIN result by tenant. Measured in GS1-A (§11.4); if a large tenant ever dominates, GS1-D can add `btree_gin` (an extension, so a decision) or move to option G.
- Phone numbers are matched by digits-only prefix in GS1-D if needed; GS1-A matches phone with the existing `ILIKE` on customers and contacts only, bounded by the per-branch limit.
- Prisma cannot express these indexes. They are declared in the migration only, like the existing hand-written expression indexes, which `db:check-migrations` (`prisma migrate diff`) already passes with. GS1-A confirms the new ones pass too.
- Plain `CREATE INDEX` (not `CONCURRENTLY`, because Prisma runs migrations in a transaction) takes a lock that blocks writes on that table for the build time. At current production sizes this is well under a second per table; the migration's readiness note records measured timings from a disposable Neon branch.

### 9.3 Ranking within a type

Tiers, highest first; ties broken by the next rule:

1. Exact match of the whole normalised query on the primary name, number, code or email.
2. Primary name / number starts with the query.
3. All terms match as word prefixes (`ts_rank_cd` of the tsvector).
4. Identifier prefix on a secondary field (legal name, work email, code).
5. Within a tier: active before archived, current before former, then recently updated first, then `id`.

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
- Results for the previous query stay visible (muted) while the next one loads, so the list does not flash.
- In-memory cache of the last 20 `(businessId, membershipVersion, q, includeArchived)` responses for 30 s, to make backspacing instant. Cleared on business switch, role change and sign-out.

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
- A record that has since become unavailable (deleted, permission removed) opens the Zone's existing not-found state.
- GS1-B adds `target` handling to Customers, Sales, Projects and People in the same way Finance already handles it.

### 10.7 Recent

- GS1-B: **session only**: the last 8 records opened from the palette, kept in memory, cleared on business switch and sign-out. No search terms are kept anywhere.
- Persisted recents (ids only, re-checked by a `resolve` call) are a GS1-D option under D-GS1-6.

### 10.8 Desktop and narrow widths

- Tauri and web share the same palette (ADR 0005); no native shortcuts.
- Below 640 px the palette is full-screen; groups and keyboard behaviour are unchanged.

## 11. Performance plan

### 11.1 Targets (D-GS1-10)

| Measure | Target |
|---|---|
| Server time, p95, all permitted types, design-point tenant | ≤ 150 ms |
| Server time, p99 | ≤ 400 ms |
| Keystroke-to-results, p95, same region, after debounce | ≤ 300 ms |
| Hard cap | `statement_timeout` 1 s |
| Command filtering | < 16 ms (one frame) |

Design-point tenant: 10k customers, 20k contacts, 10k opportunities, 5k projects, 100k tasks, 50k finance documents, 2k catalog items, 500 employees.

### 11.2 Limits and pagination

- Palette: 5 per type, at most ~10 types → ≤ 50 rows per response.
- "Show more": 25 per page, keyset cursor, single type.
- No offset pagination; no total counts.

### 11.3 Debouncing

150 ms debounce, abort on new input, minimum 2 characters (§10.4).

### 11.4 Testing approach

1. **Plan tests** (integration suite, local Postgres 16): seed the design-point tenant plus a noisy second tenant, run `EXPLAIN (FORMAT JSON)` for each branch and assert the expected index is used. Runs in CI.
2. **Latency bench** (script, not CI-gating): run 200 representative queries (1–3 terms, numbers, emails, no-hit) against the seeded database and report p50/p95/p99 per type and for the full union.
3. **Neon check** (manual, GS1-A readiness): the same bench on a disposable Neon branch in the production region, then the branch is deleted. Allowed under the standing infrastructure policy for temporary test branches; no production data used.
4. **Write overhead**: measure insert/update time on indexed tables before and after the migration at the design point.

### 11.5 Scaling assumptions

- Most businesses are far below the design point; the largest SMB tenants should stay within it for years.
- The union holds one pooled connection for the request's duration (tens of ms).
- Search load is bursty per active person but debounced; a business of 50 people searching constantly is a few requests per second at most.

## 12. Implementation sequence

Each stage is its own thread, branch and draft PR, audited before merge, and none applies a production migration without Regan's separate approval.

### GS1-A: Search backend foundations

- `packages/contracts/src/search.ts` and contract snapshot.
- `apps/api/src/modules/search`: provider interface and registry, query normaliser, `UNION ALL` builder, ranking, cursor.
- Providers in their modules: customer, contact, opportunity, project, task, quote/invoice/credit note, catalog item, employee (work fields only).
- Route `POST /api/v1/b/:slug/search`; `57014` → `503 retryable` mapping.
- Migration `2026MMDD000000_search_indexes`: expression indexes only (§9.2). Stamp chosen at PR time after checking open PRs' stamps.
- Security, isolation, canary, logging and plan tests (§14).
- Readiness note: index build timings on a disposable Neon branch, Neon logging settings confirmed.

### GS1-B: Global command palette, record search

- Depends on GS1-A's contract (can use test fakes) and on the V2-C palette (D-GS1-11).
- Records section, grouping, keyboard model, states, debounce/abort, session recents, "Show more", "Include archived".
- `target` entry points for Customers, Sales, Projects (project + task) and People.
- UI tests for every rule in §10, plus the V2-A §8.2 rules unchanged.

### GS1-C: Expanded Zone coverage

One small PR per provider, in any order: events and resources (after D-V2A-8 readiness), expenses, departments and locations, saved reports, members, payments. Each adds its index (if any), provider, field review and tests.

### GS1-D: Performance and relevance

- Zero-result and latency metrics (term-free) to decide on trigram.
- Optional `pg_trgm` / `unaccent` via a privileged step (needs D-GS1-1 approval and its own migration approval).
- Digits-only phone matching, ranking tuning, persisted recents with `resolve` (if D-GS1-6 allows), rate limiting (D-GS1-13).
- Optionally move Zone list search from GET `?q=` to POST (D-GS1-7).

### Independence

| Work | Can start when |
|---|---|
| GS1-A contract + framework + providers | After this document is approved |
| GS1-A migration | With GS1-A; applying it to production is a separate approval |
| GS1-B UI | After the GS1-A contract merges (uses fakes), and the V2-C palette exists or D-GS1-11 says GS1-B builds it |
| GS1-B `target` entry points per Zone | Independently of each other and of GS1-A |
| Each GS1-C provider | After GS1-A merges; independent of each other and of GS1-B |
| GS1-D items | After GS1-A is in production with metrics; each independent |

## 13. Owner decisions

| ID | Decision | Options | Recommendation and tradeoff |
|---|---|---|---|
| D-GS1-1 | Search infrastructure | (a) Built-in PostgreSQL FTS + B-tree prefix, no extension; (b) add `pg_trgm` now; (c) external search service | **(a).** Zero new infrastructure, cost or privileged steps; covers word and prefix matching. Gives up typo tolerance and mid-word matches until data shows they matter. (b) adds a privileged step and larger indexes; (c) adds a vendor, sync, a second copy of personal data and erasure in two places. |
| D-GS1-2 | Indexing model | (a) Federated in-place expression indexes; (b) central `search_documents` table; (c) external index | **(a).** One source of truth, instant archive/erase/permission effect, modules keep ownership. Cross-type ranking is coarser (tiers, §9.4). |
| D-GS1-3 | People sensitive data | (a) Work fields only for `people:read`, personal details never searchable; (b) also match personal details for `people:read_sensitive` | **(a).** Searching personal phone or home address is rarely a real need and turns the palette into a lookup tool for private data. The profile screen remains the place to see them. |
| D-GS1-4 | Terminated employees | (a) Shown with "Former", ranked lower; (b) hidden | **(a).** Matches the directory's `all` view and helps when looking up past staff on old projects. |
| D-GS1-5 | Archived records | (a) Excluded by default, toggle to include; (b) always included, badged; (c) never | **(a).** Keeps results clean while still findable. |
| D-GS1-6 | Search history and retention | (a) No server history, no stored terms, session-only recent records; (b) persisted recent record ids (re-checked); (c) persisted search terms | **(a)** for GS1-B, (b) possible later. No retention or erasure burden; terms can contain personal data and are never stored. |
| D-GS1-7 | Existing Zone list `?q=` in URLs | (a) Accept for now, revisit in GS1-D; (b) move list search to POST soon | **(a)**, but confirm what Vercel's logs retain. Lists are in-Zone and already permission-gated; changing every list endpoint is a broad API change. |
| D-GS1-8 | Global shortcut | (a) One palette for commands and records on ⌘K / Ctrl+K; (b) separate search shortcut | **(a).** One habit; consistent with D-V2A-6. `/` stays the page filter. |
| D-GS1-9 | Debounce and minimum length | 150 ms / 2 chars; 250 ms / 3 chars | **150 ms, 2 chars.** Feels instant; cost bounded by limits and abort. |
| D-GS1-10 | Performance targets | §11.1 | **Accept §11.1** as GS1-A acceptance criteria on the design-point tenant. |
| D-GS1-11 | Sequencing with V2-C | (a) GS1-B waits for and extends the V2-C palette; (b) GS1-B builds the palette per V2-A §8.2 now, V2-C restyles | **(a)** if V2-B/V2-C are authorised soon; otherwise (b). GS1-A is unaffected either way. |
| D-GS1-12 | Transport | (a) POST with body; (b) GET with `q` | **(a).** Keeps terms out of URLs and logs; costs only REST purity. |
| D-GS1-13 | Rate limiting | (a) Bounds only (length, limits, timeout, debounce) for now; (b) per-membership limiter in GS1-A; (c) Vercel firewall rule | **(a)** now, revisit with metrics. (b) needs shared state we don't have; (c) may add cost. |
| D-GS1-14 | Scope of GS1 | (a) §4.1 now, §4.2 in GS1-C, activities/communications/leave excluded; (b) include activities and messages now | **(a).** Activities and messages carry restricted notes, OWNER_ONLY mail and E1 erasure; they deserve a separate review. |

## 14. Test strategy

| Level | What |
|---|---|
| Unit | Normaliser (NFC, whitespace, term cap, tsquery operator stripping, `LIKE` escaping); provider registry → permitted set per role; ranking and group ordering; cursor round-trip and tamper rejection |
| Contract | Snapshot of request and response schemas; unknown body fields rejected; string length caps |
| Permission matrix (integration, real Postgres as `bos_app`, forced RLS) | Each role × each type: present only with the read key. MEMBER never gets finance or employee results; MANAGER gets employees but no personal-detail matches |
| Tenant isolation | Two businesses with identical names, numbers and emails; every query returns only the caller's rows. Isolation seam: each branch with its explicit predicate removed still returns nothing from the other tenant under RLS |
| Field leakage canaries | Unique tokens in every non-match column (notes, descriptions, amounts, personal details, leave fields, restricted notes); searching each token returns nothing, and no token appears anywhere in any response body |
| Source rules | Search providers may not reference personal-details, leave, activity, message or mailbox tables; no `$queryRawUnsafe` in the search module |
| Record states | Archived (default off / on), voided, draft, terminated, erased, deleted |
| Direct API | Forged `types`, oversized `q`, too many terms, `limit` out of range, cursor for another type or business, GET → 405, injection strings (`' ; -- % _ \ & | ! ( ) : * <->`) |
| Logging | `console.*` spied: no term or title in any log line on success, validation failure, timeout and unexpected error |
| Performance | Plan assertions per branch at the design point (CI); latency bench (manual); Neon bench (readiness) |
| UI (GS1-B, harness from V2-A) | Shortcut and capture rules, debounce, abort and stale-response drop, grouping, keyboard model, ARIA roles, every state in §10.5, rebuild and cache clear on business switch, guard-first navigation, screenshots at 1440 / 900 / 390 in both themes |

## 15. Risks and open questions

| Risk or question | Mitigation |
|---|---|
| Vercel request logs include query strings for existing GET list endpoints | Verify on the project's log settings in GS1-A; D-GS1-7 |
| Neon statement logging could capture bound parameters | Confirm Neon project settings in GS1-A readiness; we enable no statement logging |
| Hand-written indexes drift from Prisma's view | Follow the existing pattern for hand-written expression indexes; `db:check-migrations` in CI |
| Index build locks block writes briefly | Measure on a disposable Neon branch; apply in a quiet window under the normal migration approval |
| No mid-word or typo matching disappoints users | Measure zero-result rate (term-free) and decide on trigram in GS1-D |
| GIN index cannot lead with `business_id` | Plan tests at the design point; `btree_gin` or option G only if measured |
| Scheduling becomes reachable through search before its readiness check | Event and resource providers wait for D-V2A-8 and are in GS1-C |
| A future module adds a visibility rule search doesn't know about | Provider contract requires reuse of the module's visibility function; field lists are snapshot-tested and reviewed per PR |
