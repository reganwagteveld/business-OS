# Finance F7-A: products and services catalog

> Status: **draft PR for independent audit.** Not merged, not migrated, not deployed. Migration
> `20261130000000_finance_catalog` is **not applied** anywhere except local and CI test databases.
> Owner decisions D-F7A-1 to D-F7A-10 (§9) were built as proposed defaults and are **pending Regan's approval**.

## 1. Audit (main at c6c833f)

| Area | Finding | Consequence for F7-A |
|---|---|---|
| Quote/invoice lines | `finance_document_lines` hold free-text `description`, `quantity`, `unit_price numeric(18,6)`, optional `tax_rate_id`; tax name and percentage are snapshotted by the line guard and sealed at issue (content hash). | The catalog never touches lines. A future picker copies values into a **draft** line; the existing document rules then apply unchanged. Issued documents cannot change. |
| Recurring templates (F6-1) | Lines are stored as JSON on the template and copied into each generated draft. | Same: a picker can fill template lines; nothing reads the catalog at generation time. |
| Tax | `finance_tax_rates` (name, percentage that never changes, archive). One tax per line, tax-exclusive only (FD-T1, FD-T3). Business default rate in `finance_settings.default_tax_rate_id`. | Items reference a rate or the business default; no percentage is stored or computed in the catalog. No new tax logic. |
| Pricing / money | `money.ts`: exact decimals, ISO 4217 via `Intl`, no conversion anywhere (FD-A3). Line unit prices allow 6 decimals. | Item price uses the same precision and contract (`UnitPrice`), one currency per item, never converted. |
| Permissions | `finance:*` keys, FD-P1 defaults; settings-like changes are `finance:manage` (OWNER/ADMIN). | New key `finance:catalog` (OWNER/ADMIN), reading with `finance:read`. |
| DB conventions | Forced RLS `tenant_isolation`, composite `(business_id, …)` FKs, `ON DELETE RESTRICT` to businesses, no DELETE grants, guard triggers with FN SQLSTATEs, `SECURITY INVOKER` + fixed `search_path`, migrations wrapped in one transaction. | Followed exactly; integrity inventory tests (T1, TR1–TR3) extended. |
| Concurrency | Optimistic `version` with conditional `updateMany` (categories, settings); unique-index arbitration for duplicates. | Same pattern plus a guard that forces `version` to advance by one. |
| Payments, reminders | F2/F6-3 workflows. | Not touched. |
| Open branches | S2 `20261128000000_scheduling_resources` (PR 61), E1 `20261129000000_communications_erasure`, People P2 (PR 56, client only), Reporting R2 (client only). | Migration `20261130000000` sorts after all of them and depends on none. Shared files touched: `tenancy.prisma` (one relation line), `routes.ts` (error maps), `permissions.ts`, `registry.ts` (one child), `contracts/src/index.ts`. Expect trivial merge conflicts only. |

## 2. Data model

One table, `finance_catalog_items` (`apps/api/prisma/schema/finance-catalog.prisma`):

| Column | Rule |
|---|---|
| `type` | `PRODUCT` or `SERVICE`; fixed once created (no UPDATE grant). |
| `name` | 1–200 characters (trimmed). |
| `description` | ≤ 2000, optional. |
| `code` | Optional SKU or service code: trimmed, 1–64, no control characters; **unique per business ignoring case, archived items included** (`finance_catalog_items_code_key` on `(business_id, lower(code))`). |
| `unit` | A code from the fixed list in the contracts (`CATALOG_UNITS`); the database checks the shape only, so adding a unit is a contract change. |
| `unit_price` | `numeric(18,6) ≥ 0`, tax-exclusive, optional (NULL = no default price). |
| `currency_code` | ISO 4217 code of the price (defaults to the business currency). Never converted. |
| `tax_mode`, `tax_rate_id` | `BUSINESS_DEFAULT` (the business default rate at the time of use), `RATE` (a rate of this business, composite FK), or `NONE`. CHECK: a rate iff `RATE`. |
| `status` | `ACTIVE` or `INACTIVE` (inactive = kept, not offered for new work). |
| `archived_at` | Stamped by the database. Archived = read-only and hidden by default until restored. |
| `version`, authorship, times | Version advances by exactly one on every update (guard). Times stamped by the database. |

No stock, warehouse, purchasing or valuation fields. Inventory, Purchasing and POS can reference an item by `(business_id, id)` later.

### Guard `finance_catalog_items_guard` (SQLSTATEs)

- `FN050`: identity or type changed, or a row inserted archived / not at version 1.
- `FN051`: an archived item changed (only a restore may change it), or an archive changed other fields in the same update.
- `FN052`: version did not advance by exactly one.
- `FN017` (existing, `archived_reference`): an archived tax rate newly linked. The rate is read `FOR SHARE`, so a concurrent archive of that rate either commits first (the link is refused) or waits.

Least privilege: `bos_app` has SELECT, INSERT and column-level UPDATE on the editable columns only; no DELETE or TRUNCATE. Forced RLS with the standard tenant policy.

## 3. API

All under `/api/v1/b/:slug/finance`, strict bodies, decimal strings.

| Method and path | Permission |
|---|---|
| `GET /catalog-items?q&code&type&status&taxRateId&currencyCode&cursor&limit` | `finance:read` |
| `GET /catalog-items/:itemId` | `finance:read` |
| `POST /catalog-items` | `finance:catalog` |
| `PATCH /catalog-items/:itemId` (with `version`; edit, activate/deactivate) | `finance:catalog` |
| `POST /catalog-items/:itemId/archive`, `/restore` (with `version`) | `finance:catalog` |

- `status`: `current` (default, not archived), `active`, `inactive`, `archived`, `all`. `q` searches name, code and description; `code` is an exact, case-insensitive match (scanners, imports).
- Order: name, then id (database collation, as Customers); keyset cursor bound to this list.
- Errors: `400 invalid_input`/`invalid_query`, `invalid_tax_rate`, `invalid_currency`; `409 stale`, `duplicate_code`, `archived`, `not_archived`, `archived_reference`; another business's id is `404`.
- No DELETE endpoint.

## 4. Reuse by future features

`lineDefaultsOf(item, { currencyCode, defaultTaxRateId })` (finance module public API) is the one place a picker turns an item into the values it **copies** into a draft line: description (name + description, ≤ 1000), unit price only when the document is in the item's currency, and the tax rate (item's rate, business default, or none). It refuses inactive and archived items. After copying, the line is ordinary document data; the catalog is never read again for that line.

Not built in F7-A (proposed for F7-B): the picker in the quote/invoice/recurring editors, and an optional `catalog_item_id` on lines for reporting (additive, nullable, never read for prices).

## 5. Permissions

`finance:catalog` (new): create, edit, deactivate, archive and restore. Default grant OWNER and ADMIN (D-F7A-2, provisional). MANAGER and anyone with `finance:read` can view. MEMBER has no Finance access (FD-P1).

## 6. Audit

| Action | Metadata |
|---|---|
| `finance.catalog.created` | `itemType` |
| `finance.catalog.updated` | `itemType`, `fields` (names only), `statusFrom`/`statusTo` when the status changed |
| `finance.catalog.archived`, `.restored` | `itemType` |

Target `finance_catalog_item` + id. Never names, codes, descriptions or prices (a test checks this). Reads write nothing.

## 7. UI

Finance gains a **Products & services** section (`packages/app/src/zones/finance/catalog.tsx`): list with search, type and status filters and paging; an item page with the edit form (only with `finance:catalog` and not archived), Mark inactive/active, Archive, Restore; a create form. Unit prices are shown exactly (up to 6 decimals), never rounded to cents. Screenshots: `docs/evidence/finance-f7a/` (taken from a local harness with fake data; nothing real).

## 8. Tests

- `apps/api/tests/integration/finance-catalog.test.ts` (25): permissions by key; validation; tax and currency; codes (case, archived, cross-business); edit, lifecycle; search, filters, paging, cursor tampering; tenant isolation through the API and raw SQL under RLS; four deterministic races (staged with `pg_blocking_pids`): same-version edits, edit vs archive, duplicate codes, linking a rate that is being archived; audit content; failed changes write nothing; documents unchanged after catalog edits; the guard on its own (G1–G6).
- `finance-integrity.test.ts`: table, trigger and function inventories now include the catalog (T1, TR1–TR3).
- `apps/api/tests/unit/access.test.ts`: permission matrix.
- `packages/app/tests/finance-catalog.test.tsx` (8): formatting, registry, reader view, create, duplicate code, stale edit, lifecycle, filters and paging.

Local results: unit 133 (api) + 386 (app) + 24 (contracts) + 95 (ui) + 293 (root) passing; integration 603 run, 601 passing. The two failures are local environment only and pass in CI's setup: `customers` sort order (the local cluster uses C collation; CI uses en_US) and a `finance-documents` CORS test (it passed after setting CI's `CORS_ALLOWED_ORIGINS`). `test:isolation` needs PgBouncer and was not run locally (CI runs it).

## 9. Owner decisions (built as defaults, pending approval)

| # | Decision | Default built |
|---|---|---|
| D-F7A-1 | One table with a type, or separate products and services tables | One table, `PRODUCT`/`SERVICE`, type fixed once created |
| D-F7A-2 | Who manages the catalog | New `finance:catalog`, OWNER and ADMIN; read with `finance:read` |
| D-F7A-3 | Prices and currency | One optional tax-exclusive default price per item in one currency (default business currency); never converted; price lists later |
| D-F7A-4 | Tax treatment | `BUSINESS_DEFAULT`, `RATE` (existing rates) or `NONE`; no stored percentages |
| D-F7A-5 | Code uniqueness | Optional; unique per business ignoring case, archived included; never reused |
| D-F7A-6 | Units | Fixed list of codes; extend by contract change |
| D-F7A-7 | Lifecycle | Active ⇄ Inactive; Archive ⇄ Restore (read-only while archived); no delete |
| D-F7A-8 | Documents | No change in F7-A; F7-B picker copies into draft lines; optional line reference later |
| D-F7A-9 | Audit | Ids, type, changed field names only |
| D-F7A-10 | Migration | `20261130000000_finance_catalog`, additive, no privileged SQL |

## 10. Migration safety, rollout and rollback

- **Additive only:** one table, its indexes, CHECKs, one guard function and trigger, grants and RLS policy. No existing table, column or row changes. Wrapped in one transaction.
- **No privileged SQL.**
- **Order:** migrate first, then deploy (the routes need the table; `finance:catalog` only exists in the new code, so a migrated-but-not-deployed state exposes nothing). With auto-deploy on main, apply the migration just before merging, under the standing recovery-branch policy.
- **Rollback:** code can be reverted independently; the table is then unused. Dropping it is a destructive change that needs explicit approval and is not needed for rollback.
