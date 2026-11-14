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

**Default pipeline.** It is created by an explicit, idempotent request, never as a side effect of a read:

- `POST /sales/pipelines/default` (`sales:write`) creates it (201) or returns the existing one (200).
- Creating the first opportunity without naming a pipeline (also a write) does the same.
- `GET /sales/pipelines` returns an empty list, and `GET /sales/stages` returns 404, until it exists.

It is called "Sales pipeline" and gets the standard stages New (10%), Qualified (25%), Proposal (50%) and Negotiation (75%).

The business-creation flow (the privileged `create_business` function) is deliberately unchanged. Initialising there would need a privileged SQL change and would create pipelines for businesses that never use Sales.

The insert is `INSERT … ON CONFLICT DO NOTHING` on `(business_id, default_slot)`, so concurrent first requests are safe:
1. The second request waits for the first to commit, then inserts nothing and reads the winner's pipeline.
2. Only the request that actually created the pipeline adds its stages and the `sales.pipeline.initialized` audit entry.

Tested two ways:
- 8 concurrent initialise requests return exactly one 201 and seven 200s, with one pipeline, four stages and one audit entry;
- 4 concurrent first opportunity creations all land in one default pipeline.

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
| `version` | Starts at 1 and is incremented by every change: edit, stage move, win, lose, reopen, archive, restore. Used for optimistic concurrency (§4). |
| authorship, timestamps, `archived_at` | |

### OpportunityOutcome (`opportunity_outcomes`)

One row per time an opportunity was won or lost, kept when it is reopened.

| Column | Notes |
|---|---|
| `id`, `business_id`, `opportunity_id` | FK `(business_id, opportunity_id) → opportunities` |
| `status` | `WON` or `LOST` only (CHECK) |
| `loss_reason` | ≤ 500 characters, only when `LOST` (CHECK) |
| `stage_id`, `amount`, `currency_code` | The stage and value at the moment of closing |
| `closed_at`, `closed_by_id` | When and by whom it was closed |
| `reopened_at`, `reopened_by_id` | Set when it is reopened; `reopened_at ≥ closed_at` (CHECK) |

`bos_app` may insert rows and set only `reopened_at` and `reopened_by_id`. Recorded facts can't be rewritten or deleted (tested).

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
- **Reopening** is an explicit transition from `WON`/`LOST` to `OPEN`, into the closing stage or a named active stage of the same pipeline. It clears `closed_at` and `loss_reason` on the opportunity row. The outcome it had stays in `opportunity_outcomes`, marked reopened.
- **Outcome history** (`GET /sales/opportunities/:id/outcomes`, `sales:read`) lists every win and loss, newest first, including any loss reason. The reason text is treated as tenant data, like the description:
  - it lives only in this RLS-protected, append-only table, with the same access as the opportunity;
  - the audit log records only `hasReason`.

  A future erasure flow can scrub the table without touching the security log.
- **Optimistic concurrency.** `PATCH` must send the `version` it was based on. The write is `UPDATE … WHERE version = $sent`, and it also increments the version. If anyone changed the opportunity since (an edit, stage move, win/lose, reopen or archive), the edit is refused with `409 stale` instead of overwriting their change. The client then re-reads and retries.

  Tested:
  - two editors: the second edit is refused and the first one is kept;
  - 6 simultaneous edits from the same version: exactly one succeeds;
  - an edit prepared before a win is refused.

  Win, lose, reopen, archive and restore are already conditional on state, so they don't need a version.
- **Archived opportunities** cannot be changed until restored (`409 archived`). Archived customers, contacts, pipelines and stages cannot be newly attached (`409 archived_reference`), but existing links stay readable and editable.

## 5. Permissions

| Permission | Covers | OWNER | ADMIN | MANAGER | MEMBER |
|---|---|:-:|:-:|:-:|:-:|
| `sales:read` | Pipelines, stages, opportunities (list, get) | ✓ | ✓ | ✓ | ✓ |
| `sales:write` | Create and edit opportunities, move stages, win, lose, reopen, archive, restore | ✓ | ✓ | ✓ | ✓ |
| `sales:manage` | Pipeline configuration (create pipelines; later stages and reordering) | ✓ | ✓ | | |

**Decision (MVP): MEMBER may win, lose, reopen and archive opportunities.** This matches the Customer Zone, where MEMBER already archives and restores customers and contacts with `customers:write`.

Why it is acceptable:
- outcomes are reversible: reopen and restore;
- every transition is audited with who and when;
- the outcome history keeps what happened.

No extra permission is added now.

If a business later needs closing restricted, the change is local: add `sales:close` (and possibly `sales:archive`) to `ZONE_PERMISSIONS`, grant it to the roles that should keep it, and switch the win, lose, reopen and archive routes to it. The matrix test then pins the new rule.

Configuration is a business setting, which the role policy already reserves for OWNER and ADMIN (`sales:manage`). Initialising the default pipeline is not configuration: it only creates the standard default, so `sales:write` suffices.

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

- `bos_app`: `SELECT, INSERT, UPDATE` on pipelines, stages and opportunities. On `opportunity_outcomes`: `SELECT, INSERT` plus `UPDATE (reopened_at, reopened_by_id)` only. **No DELETE** anywhere. Other runtime roles get nothing.
- RLS is enabled and forced with the standard `tenant_isolation` policy.
- Migration `20261114090000_sales` is additive: one enum, four tables, indexes, foreign keys, CHECKs, grants and policies. No existing table changes.
- **Rollback:** before any opportunity exists, drop the four tables and the enum and delete the migration's `_prisma_migrations` row. Afterwards, restore from the Neon branch taken before the migration.
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
