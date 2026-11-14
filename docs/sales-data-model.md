# Sales Zone data model (Phase 4, PR 15)

The implementation plan asks for the Sales Zone to have its own data-model document before code. This is that document, written with the backend foundation in the same PR. It follows [data-model.md](./data-model.md): same tenancy, RLS, composite foreign keys, roles, audit and migration conventions.

## 1. Principles

- **One business data model.** Opportunities link to the Customer Zone's own `customers` and `contacts`. There are no copies and no sales-only customer records (architecture §2.2).
- **Tenant isolation in three layers.** As in data-model §5:
  - the scoped Prisma client injects `business_id`;
  - forced RLS policies check it again;
  - composite `(business_id, …)` foreign keys make a cross-business link impossible even with raw SQL.
- **Money is exact and never assumes a currency.** Amounts are `numeric(18,4)` in PostgreSQL, `Prisma.Decimal` in code and decimal strings in the API, so there is no binary floating point anywhere. Every amount carries an ISO 4217 code.
- **History is kept.** Nothing in this module can be deleted by tenant code. Pipelines, stages and opportunities are archived and restored, and outcomes are recorded in the audit log.

## 2. Entities

### SalesPipeline (`sales_pipelines`)

| Column | Notes |
|---|---|
| `id`, `business_id` | UUID; `(business_id, id)` unique for composite FKs |
| `name` | 1–100 characters (CHECK) |
| `default_slot` | `'default'` on the business's default pipeline, NULL on the rest. `(business_id, default_slot)` is unique, so a business has at most one default. A CHECK keeps the default from being archived. |
| `position` | Display order (spaced integers) |
| `created_by_id`, `updated_by_id`, `created_at`, `updated_at`, `archived_at` | Authorship, timestamps, reversible archive |

**Default pipeline.** It is created on first use: listing pipelines or stages, or creating an opportunity without a pipeline. It is called "Sales pipeline" and gets the standard stages New (10%), Qualified (25%), Proposal (50%) and Negotiation (75%).

The insert is `INSERT … ON CONFLICT DO NOTHING` on `(business_id, default_slot)`, so concurrent first requests are safe:
1. The second request waits for the first to commit, then inserts nothing and reads the winner's pipeline.
2. Only the request that actually created the pipeline adds its stages and the `sales.pipeline.initialized` audit entry.

The test runs 8 concurrent first requests and checks for exactly one pipeline, four stages and one audit entry.

### SalesStage (`sales_stages`)

| Column | Notes |
|---|---|
| `id`, `business_id`, `pipeline_id` | FK `(business_id, pipeline_id) → sales_pipelines(business_id, id)`; `(business_id, pipeline_id, id)` unique, so opportunities can prove a stage belongs to their pipeline |
| `name` | 1–60 characters (CHECK) |
| `position` | Spaced integers (1000, 2000, …). A later drag-and-drop reorder can place a stage between two others without renumbering the rest. Ties are broken by `id`. |
| `default_probability` | 0–100 or NULL (CHECK) |
| `archived_at` | "Active" means not archived. Archiving a stage keeps every opportunity in it valid. |

Won and Lost are **outcomes** (`opportunities.status`), not stages. An opportunity keeps the stage it closed in.

### Opportunity (`opportunities`)

| Column | Notes |
|---|---|
| `id`, `business_id`, `title` (1–200) | |
| `customer_id` | FK `(business_id, customer_id) → customers` |
| `contact_id` | FK `(business_id, contact_id) → contacts` |
| `pipeline_id`, `stage_id` | FK `(business_id, pipeline_id) → sales_pipelines` and FK `(business_id, pipeline_id, stage_id) → sales_stages(business_id, pipeline_id, id)`: the stage must belong to the opportunity's pipeline, enforced by the database |
| `amount` | `numeric(18,4)`, not negative, nullable |
| `currency_code` | `char(3)`, `^[A-Z]{3}$` (CHECK); the service also checks it is a real ISO 4217 code |
| `probability` | 0–100 or NULL |
| `expected_close_date` | `date` (a calendar date, no time zone) |
| `owner_user_id` | FK `(business_id, owner_user_id) → memberships(business_id, user_id)`; the service also requires the membership to be ACTIVE |
| `description` (≤ 5000) | |
| `status` | `OPEN` \| `WON` \| `LOST` |
| `loss_reason` (≤ 500) | Only when `LOST` (CHECK) |
| `closed_at` | NULL exactly when `OPEN` (CHECK) |
| authorship, timestamps, `archived_at` | |

**Why the contact link is a two-column FK.** A three-column FK `(business_id, customer_id, contact_id) → contacts(business_id, customer_id, id)` would stop contacts moving between customers in the Customer Zone. It would also not be checked when `customer_id` is NULL. Instead, the two-column FK guarantees tenant safety, and the service enforces consistency when the link is made or changed:
- a contact that belongs to a customer can only be used with that customer;
- given only a contact, its customer is filed too.

Moving a contact later does not rewrite opportunity history (tested).

## 3. Money

- **API:** `amount` is a string matching `^\d{1,14}(\.\d{1,4})?$`. JSON numbers are rejected.
- **Decimal places:** the service rejects more decimals than the currency's minor unit, using `Intl` currency data (JPY 0, AUD 2, KWD 3). Responses format the amount with exactly that many decimals ("1250.50", "150000").
- **Default currency:** the business's own currency when none is given. US dollars are never assumed.
- **Changing currency** re-checks the existing amount against the new currency's minor unit.
- **Totals:** none are computed yet. When the sales dashboard arrives, totals are per currency (no implicit conversion) and use SQL `numeric` sums.

## 4. Lifecycle

```
OPEN ──win──▶ WON ──reopen──▶ OPEN
OPEN ──lose─▶ LOST ─reopen──▶ OPEN
```

- **Status changes** go through `win`, `lose` and `reopen`, never through PATCH (the body schema is strict). Every change is a conditional `UPDATE … WHERE status = … AND archived_at IS NULL`. Under concurrency, exactly one of several simultaneous win/lose requests succeeds and the others get `409 not_open` (tested with 6 concurrent requests).
- **Stage moves** (PATCH `stageId`, or `pipelineId` + `stageId`) are allowed only while `OPEN` (`409 not_open`). Other details stay editable after an outcome.
- **Reopening** is an explicit transition from `WON`/`LOST` to `OPEN`, into the closing stage or a named active stage of the same pipeline. It clears `closed_at` and `loss_reason` on the row. The audit entry keeps the previous status and close date.
- **Archived opportunities** cannot be changed until restored (`409 archived`). Archived customers, contacts, pipelines and stages cannot be newly attached (`409 archived_reference`), but existing links stay readable and editable.

## 5. Permissions

| Permission | Covers | OWNER | ADMIN | MANAGER | MEMBER |
|---|---|:-:|:-:|:-:|:-:|
| `sales:read` | Pipelines, stages, opportunities (list, get) | ✓ | ✓ | ✓ | ✓ |
| `sales:write` | Create and edit opportunities, move stages, win, lose, reopen, archive, restore | ✓ | ✓ | ✓ | ✓ |
| `sales:manage` | Pipeline configuration (create pipelines; later stages and reordering) | ✓ | ✓ | | |

This mirrors the Customer Zone, where every role reads and writes business data. Configuration is a business setting, which the role policy already reserves for OWNER and ADMIN. Reading pipelines may create the default pipeline, which is system initialisation and attributed to the reader in the audit log.

## 6. Audit

All entries are written in the same unit of work as the change (a rollback removes both; tested at database level). Metadata holds ids and structured facts only, never titles, descriptions or loss-reason text.

| Action | Metadata |
|---|---|
| `sales.pipeline.initialized`, `sales.pipeline.created` | `stages` (count) |
| `sales.opportunity.created` | pipelineId, stageId, customerId, ownerUserId, currencyCode, hasAmount |
| `sales.opportunity.updated` | `fields` (names only) |
| `sales.opportunity.stage_changed` | fromPipelineId, fromStageId, toPipelineId, toStageId |
| `sales.opportunity.assigned` | from, to |
| `sales.opportunity.won`, `.lost` | stageId, amount, currencyCode (and hasReason for lost) |
| `sales.opportunity.reopened` | previousStatus, previousClosedAt, stageId |
| `sales.opportunity.archived`, `.restored` | none |

## 7. Database roles and migration

- `bos_app`: `SELECT, INSERT, UPDATE` on the three tables, and **no DELETE**. Other runtime roles get nothing.
- RLS is enabled and forced with the standard `tenant_isolation` policy.
- Migration `20261114090000_sales` is additive: one enum, three tables, indexes, foreign keys, CHECKs, grants and policies. No existing table changes.
- **Rollback:** before any opportunity exists, drop the three tables and the enum and delete the migration's `_prisma_migrations` row. Afterwards, restore from the Neon branch taken before the migration.
- **Deployment order:** migrate first (no privileged SQL changes), then deploy the API. The new routes return 500 until the migration is applied, so the migration must not be skipped.

## 8. Deferred (PRs 16–20)

| PR | Scope |
|---|---|
| 16 | Opportunity interface: list, detail, create/edit forms in the Sales Zone (web and desktop) |
| 17 | Kanban pipeline: drag between stages, using the existing PATCH stage move; stage reorder endpoint (`sales:manage`) using spaced positions |
| 18 | Pipeline configuration: rename, archive pipelines and stages, make default; stage add/rename/archive with "move open opportunities first" rules |
| 19 | Sales dashboard: per-currency totals, win rate, forecast (probability × amount) from real records only |
| 20 | Activity integration: opportunity events on the customer timeline (an `opportunity_id` link on activities, per data-model §4.7 option A); customer lifecycle status (DM2) if still wanted |

Also deferred:
- hard deletion and erasure of opportunities;
- multi-currency conversion;
- products and line items;
- quotes;
- trigram search (titles use `ILIKE`).
