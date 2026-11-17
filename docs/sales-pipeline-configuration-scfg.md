# S-CFG: Sales pipeline and stage configuration (architecture and migration design)

**Status:** v1.0, design only. Nothing in this document is implemented, no migration file exists and no production change is proposed for execution here.
**Base:** `main` at `06405a5` (2026-11-17). Latest migration on `main`: `20261206000000_search_indexes`. Open PR #110 (WF-1B-1) reserves `20261207000000_workflow_links`.
**Owner of the work package:** Sales. Settings only links to it (Settings A3 §5 "Settings is a hub, not a second copy").
**Related:** `docs/sales-data-model.md` (§2, §5, §8 rows 17 and 18), `docs/settings-a3-architecture.md` (§7.4, §8 row "Zone settings: Sales pipelines", gap G-A3-17), `docs/cross-zone-workflows-wf1.md` (D-WF1-04, D-WF1-16, §6.10 lock order), ZCR-1 draft PR #117 (S-CFG, D-ZCR-8), A3/A2-D draft PR #122 (Zone configuration hub).

## Contents

1. Summary
2. Verified current state
3. Goals and non-goals
4. Configuration model and rules
5. Concurrency and locking
6. API design
7. Database changes: migration S-CFG-1
8. Production preflight, rehearsal and rollback
9. Client design
10. Cross-workstream alignment
11. Security and tenancy
12. Audit
13. Test plan
14. Work packages and readiness gates
15. Owner decisions
16. Known limitations and deferred work

---

## 1. Summary

Every business today gets four fixed stages (New, Qualified, Proposal, Negotiation) and cannot change them from the app. The schema was built for configuration from the start: stages have spaced positions, an `archived_at` and a `default_probability`; pipelines are archivable and have a single-default rule; `sales:manage` (OWNER, ADMIN) exists and gates only `POST /sales/pipelines`, which has no UI.

This design adds stage add, rename, reorder, archive (with moving its open opportunities) and restore, plus pipeline rename, behind `sales:manage`, as a Sales Zone child page that the Settings hub links to. Multiple pipelines in the UI are designed but kept as a separate, optional package (S-CFG-2) pending D-SCFG-1.

Configuration works without schema changes, but four invariants would then rest on application code alone. One small **additive** migration (S-CFG-1, §7) moves them into the database, following the Finance and WF-1B-1 guard-trigger pattern:

1. an open opportunity can only sit in an active stage of an active pipeline (closes a race that exists on `main` today, §2.3 F3);
2. a stage cannot be archived while open opportunities are in it, and a pipeline keeps at least one active stage;
3. a stage never changes pipeline or business;
4. active stage names are unique per pipeline, and active pipeline names unique per business (case-insensitive).

It also adds a `config_version` to `sales_pipelines` for optimistic concurrency on configuration edits.

## 2. Verified current state

### 2.1 What exists (on `main` at `06405a5`)

| Area | Fact | Where |
|---|---|---|
| Tables | `sales_pipelines` (name 1–100, `default_slot`, `position`, `archived_at`), `sales_stages` (name 1–60, `position ≥ 0`, `default_probability` 0–100/NULL, `archived_at`), `opportunities`, `opportunity_outcomes` | `apps/api/prisma/schema/sales.prisma`, migration `20261114090000_sales` |
| Integrity | One default per business (unique `(business_id, default_slot)`), default cannot be archived (CHECK `sales_pipelines_default_active`), stage belongs to the opportunity's pipeline (FK `(business_id, pipeline_id, stage_id)`) | same |
| Grants | `bos_app`: `SELECT, INSERT, UPDATE` on pipelines, stages, opportunities; no `DELETE` anywhere | same |
| RLS | Enabled and forced, standard `tenant_isolation` policy on all four tables | same |
| Triggers | None on Sales tables | `grep` of all migrations |
| Endpoints | `GET/POST /sales/pipelines`, `POST /sales/pipelines/default`, `GET /sales/stages?pipelineId=` (active stages only), opportunities CRUD, win, lose, reopen, archive, restore, outcomes, `GET /sales/summary` | `apps/api/src/app/api/v1/b/[slug]/sales/**` |
| Permissions | `sales:read`, `sales:write` (all four roles), `sales:manage` (OWNER, ADMIN) | `modules/access/server/permissions.ts:16-18, 98-121` |
| Client | List, Kanban board, detail, form. Pipeline selector appears only when more than one pipeline exists; no configuration screen | `packages/app/src/zones/sales/*` |
| Settings | Draft PR #122 lists no Sales link: "Sales pipelines are read-only today" | `zones/settings/zone-links.ts` on that branch |

### 2.2 How stages are used today

- New opportunities default to the first active stage of the default pipeline (`opportunities.ts:114-120`).
- A stage move (PATCH `stageId`) is allowed only while `OPEN` and checks the target stage is active (`checkStage`, `opportunities.ts:74-77`).
- Reopen returns to the closing stage or a named active stage; an archived closing stage gives `409 archived_reference` (`opportunities.ts:263-268`).
- `opportunity_outcomes.stage_id` records the stage at close. It has **no FK** to `sales_stages` (only to the opportunity), so it is history, not a live link.
- `default_probability` is stored and returned but never applied: `probability` on an opportunity is only what the user sets.
- `GET /sales/summary` already handles archived stages (shown only while they hold open opportunities, marked `archived`) and archived pipelines (left out unless they hold open opportunities).
- R1 metrics (`sales.won_value`, `sales.won_count`) do not group by stage.

### 2.3 Findings

| # | Finding | Impact | Addressed in |
|---|---|---|---|
| F1 | No API to rename, add, reorder, archive or restore stages, or to rename, archive or change the default pipeline | Every business is stuck with the four default stages | §6 |
| F2 | `POST /sales/pipelines` exists with no UI, and the board only ever shows `refData.pipelines[0]` (`pipeline-board.tsx:57`) | If a second pipeline were created through the API, its opportunities would never appear on the board | S-CFG-1B (defensive switcher) or S-CFG-2 |
| F3 | `checkStage` reads the stage without a lock. Once archiving exists, an archive that commits between that read and the opportunity write leaves an open opportunity in an archived stage. The FK takes only `FOR KEY SHARE`, which does not conflict with the archive's `FOR NO KEY UPDATE` | Latent today (no archive path), real as soon as F1 is built | §5, §7 trigger G2 |
| F4 | Reopen does not check that the pipeline is active | An opportunity could reopen into an archived pipeline once pipelines can be archived | §7 trigger G2 |
| F5 | `CreatePipelineRequest` allows duplicate stage names within one pipeline | Ambiguous labels on the board, list filter and summary | §4.3, §7 index |
| F6 | `GET /sales/stages` with a named pipeline does not refuse an archived pipeline | Harmless read, but inconsistent with `activePipeline` | S-CFG-1A |

## 3. Goals and non-goals

**Goals**
- OWNER and ADMIN can shape the sales process to how the business sells: add, rename, reorder, archive and restore stages, set a stage's default probability, rename the pipeline.
- No opportunity is ever lost, hidden or left in an invalid stage by a configuration change; history keeps its meaning.
- Database-enforced invariants, tested on real PostgreSQL under concurrency.
- Works with the current shell and design system (V2-B tokens); the configuration page belongs to the Sales Zone and the Settings hub links to it.

**Non-goals (this design)**
- Hard deletion of stages or pipelines (never: no `DELETE` grant, history refers to them).
- Won and Lost as stages (they stay outcomes, `sales-data-model.md` §2).
- Stage colours, per-stage required fields, automation on stage entry, stage SLAs.
- Per-team or per-user pipelines, record-level visibility (D-ZCR-9).
- Stage templates chosen at business creation (the privileged `create_business` stays unchanged).
- Weighted forecast (D-R2D-5 deferred) and stage-conversion analytics (§16).

## 4. Configuration model and rules

### 4.1 Pipeline

| Rule | Detail |
|---|---|
| Rename | `sales:manage`. 1–100 characters, trimmed. Unique among the business's **active** pipelines, case-insensitive (§7 index U2). |
| Default | Exactly one, never archived (existing CHECK). Changing the default (S-CFG-2) swaps `default_slot` in one transaction. |
| Archive (S-CFG-2) | Refused for the default (`409 default_pipeline`), and while it holds open, non-archived opportunities (`409 has_open_opportunities`), unless D-SCFG-2 (b) is extended to pipelines. Closed and archived opportunities stay in it and remain readable. |
| Restore (S-CFG-2) | Allowed if the name is still unique among active pipelines (`409 name_taken`). |
| Limit | At most 10 active pipelines per business (D-SCFG-6), checked under the business-level advisory lock in §5. |

### 4.2 Stage

| Rule | Detail |
|---|---|
| Add | Name 1–60, trimmed, unique among the pipeline's active stages (case-insensitive). Optional `defaultProbability` 0–100. Inserted after a named stage or at the end. |
| Rename / edit | Name and `defaultProbability`. Renaming changes the label everywhere at once, including history (outcomes, audit display), because names are read live and not snapshotted. |
| Reorder | The request sends the **complete** ordered list of active stage ids. Any mismatch with the current active set is `409 stale`. Positions are rewritten as 1000, 2000, … (at most 20 rows, so a full rewrite is cheaper and simpler than gap arithmetic). Archived stages keep their position and sort after active ones in configuration views. |
| Archive | Never the last active stage (`409 last_stage`). If open, non-archived opportunities are in it, the request must name an active target stage of the same pipeline (`moveOpenTo`) and they are moved in the same transaction (D-SCFG-2 recommended option), else `409 has_open_opportunities`. Won, lost and archived opportunities keep the stage. |
| Restore | Goes to the end of the active order. Refused if the name now clashes with an active stage (`409 name_taken`) or the pipeline already has 20 active stages (`409 stage_limit`). |
| Limits | 1–20 active stages per pipeline (D-SCFG-6). 20 matches the existing `CreatePipelineRequest` maximum. |
| Probability | `defaultProbability` is a hint: the form pre-fills it when a stage is chosen on a new opportunity whose probability is empty. A stage move never changes an opportunity's `probability` (D-SCFG-4). |

### 4.3 Names

Uniqueness is on `lower(btrim(name))` among active rows only, so an archived "Proposal" does not block a new "Proposal", and restore checks again. This is enforced by partial unique indexes (§7 U1, U2), mapped to `409 name_taken`. Existing data may contain duplicates (F5), so the production preflight counts them first (§8.1) and the migration stops if any exist.

### 4.4 Opportunities in archived stages and pipelines

| Opportunity state | Archived stage | Archived pipeline |
|---|---|---|
| `OPEN`, not archived | Impossible after S-CFG-1 (trigger G2 and the archive rules) | Impossible (same) |
| `WON` / `LOST` | Keeps the stage; detail shows "Stage (archived)". Reopen requires an active stage; the reopen dialog asks for one when the closing stage is archived (`409 archived_reference` stays the API answer) | Keeps the pipeline; reopen refused (`409 archived_reference`) until the pipeline is restored |
| Archived opportunity | Keeps the stage. Restore of the opportunity is allowed (it stays in its stage); a later edit that moves it needs an active stage. **Restoring an archived OPEN opportunity whose stage is archived** is refused by G2 with `409 archived_reference`, and the UI asks for a target stage first (restore + move in one request, §6.2) | Same, against the pipeline |

## 5. Concurrency and locking

The **stage row is the serialization point** between configuration and opportunity writes. The pipeline row carries `config_version` for staleness only. This keeps every lock order acyclic (§5.3).

### 5.1 Configuration writes

Every configuration write for a pipeline runs in one tenant transaction:

1. `pg_advisory_xact_lock(hashtext('sales.pipeline_config:' || pipeline_id))` – serializes configuration of one pipeline without touching any row an opportunity write needs.
2. Read the pipeline (`archived_at`, `config_version`); compare with the request's `configVersion` → `409 stale`.
3. Lock the stage rows involved `FOR UPDATE`, in `id` order (archive: the archived stage; reorder: all active stages; pipeline archive: all active stages).
4. Perform the change. For a stage archive with `moveOpenTo`: lock the target stage `FOR SHARE`, then `UPDATE opportunities SET stage_id = target, version = version + 1, updated_by_id = actor WHERE stage_id = archived AND status = 'OPEN' AND archived_at IS NULL`.
5. `UPDATE sales_pipelines SET config_version = config_version + 1, updated_at = now(), updated_by_id = actor` (last, so the pipeline row lock is held only briefly).
6. Audit entries (§12), commit.

Business-wide pipeline operations (create, make default, restore, the 10-pipeline limit; S-CFG-2) take `pg_advisory_xact_lock(hashtext('sales.pipelines:' || business_id))` first. `ensureDefaultPipeline` stays as it is: its `ON CONFLICT DO NOTHING` insert is already safe against a concurrent default swap (the swap's uncommitted unique entry makes the insert wait, then conflict).

### 5.2 Opportunity writes

Create, stage move, reopen and restore keep their current code paths. Trigger G2 (§7) adds, inside the same statement: `SELECT archived_at FROM sales_stages WHERE business_id = … AND id = NEW.stage_id FOR SHARE`, then a plain read of the pipeline's `archived_at`.

`FOR SHARE` conflicts with the archive's `FOR UPDATE` on the stage:

| Order | Outcome |
|---|---|
| Archive locks the stage first | The opportunity write waits, then re-reads the committed row: archived → `409 archived_reference` |
| Opportunity write locks first | The archive waits; after the opportunity commits, the archive's count (or move) sees it. With `moveOpenTo` the newcomer is moved too; without, `409 has_open_opportunities` |

Pipeline archive locks **every** active stage of the pipeline before counting, so any opportunity write into that pipeline (which must hold one of those stages `FOR SHARE`) is serialized against it. That is why G2 can read the pipeline without a lock.

### 5.3 Lock-order table (extends WF-1A §6.10)

| Path | Order |
|---|---|
| C1 stage archive (+move) | advisory pipeline_config → archived stage `FOR UPDATE` → target stage `FOR SHARE` → each open opportunity `FOR NO KEY UPDATE` (stage_id is not a key column) → G2 re-locks target `FOR SHARE` (own lock) → pipeline row `FOR NO KEY UPDATE` |
| C2 reorder / rename / add / restore stage | advisory pipeline_config → stage rows `FOR UPDATE` (id order) or `INSERT` → pipeline row |
| C3 pipeline archive (S-CFG-2) | advisory business pipelines → advisory pipeline_config → all active stages `FOR UPDATE` (id order) → count → pipeline row |
| C4 make default (S-CFG-2) | advisory business pipelines → old default `FOR UPDATE` (key column) → new default `FOR UPDATE` |
| O1 opportunity create / move / reopen / restore | opportunity row (insert or `FOR NO KEY UPDATE`) → G2 target stage `FOR SHARE` → FK `FOR KEY SHARE` on pipeline and stage |
| W WF-1 paths (P1–P9) | Take `FOR KEY SHARE` on opportunities through `projects.source_opportunity_id` and `finance_documents.opportunity_id`; never lock stages or pipelines |

Pairs that could cycle and why they do not:
- **C1 vs O1 moving an opportunity out of the archived stage:** O1 holds the opportunity and wants a *different* target stage `FOR SHARE`; compatible with C1's `FOR SHARE` on the same target, and C1 never holds that opportunity's new target `FOR UPDATE`. Whoever commits first wins; C1's `UPDATE … WHERE stage_id = archived` re-evaluates (EvalPlanQual) and skips a row that has left the stage.
- **C1 vs O1 moving an opportunity into the archived stage:** O1 waits on the stage; it holds no row C1 wants (the opportunity is not yet in the stage, so C1's `WHERE` does not select it).
- **C4 vs O1:** C4's `FOR UPDATE` on a pipeline conflicts with O1's FK `KEY SHARE`. Neither holds a lock the other already holds before that point, so one waits briefly; no cycle.
- **C1 vs W:** `FOR NO KEY UPDATE` on an opportunity is compatible with WF-1's `FOR KEY SHARE`.
- **C1 bulk move vs a user PATCH on the same opportunity:** the PATCH's conditional `UPDATE … WHERE version = $sent` gets `409 stale` after the bulk move; the client re-reads (existing behaviour).

These claims are proof obligations for S-CFG-1A (T-SC-20..27), on real PostgreSQL, like WF-1B-1's G-2.

## 6. API design

All routes are tenant routes under `/api/v1/b/:slug/sales`, contracts added to `packages/contracts/src/sales.ts` (additive, `.strict()` bodies). Writes need `sales:manage`; reads `sales:read`.

### 6.1 S-CFG-1A routes

| Method and path | Permission | Body / query | Result | Errors |
|---|---|---|---|---|
| `GET /sales/pipelines/:pipelineId` | `sales:read` | – | Pipeline (with `configVersion`), **all** stages incl. archived, and per stage `openCount` | 404 |
| `PATCH /sales/pipelines/:pipelineId` | `sales:manage` | `{ configVersion, name }` | Pipeline + stages | 409 `stale`, `name_taken`, `archived` |
| `POST /sales/pipelines/:pipelineId/stages` | `sales:manage` | `{ configVersion, name, defaultProbability?, afterStageId? }` | 201, pipeline + stages | 409 `stale`, `name_taken`, `stage_limit`, `archived`; 400 `invalid_stage` (afterStageId not active in this pipeline) |
| `PATCH /sales/pipelines/:pipelineId/stages/:stageId` | `sales:manage` | `{ configVersion, name?, defaultProbability? }` | Pipeline + stages | 404; 409 `stale`, `name_taken`, `archived` |
| `PUT /sales/pipelines/:pipelineId/stages/order` | `sales:manage` | `{ configVersion, stageIds: Uuid[] }` (1–20, no duplicates) | Pipeline + stages | 409 `stale` (set mismatch or version) |
| `POST /sales/pipelines/:pipelineId/stages/:stageId/archive` | `sales:manage` | `{ configVersion, moveOpenTo?: Uuid }` | Pipeline + stages + `moved: number` | 409 `stale`, `last_stage`, `has_open_opportunities`, `archived`; 400 `invalid_stage` (target archived, same stage or other pipeline) |
| `POST /sales/pipelines/:pipelineId/stages/:stageId/restore` | `sales:manage` | `{ configVersion }` | Pipeline + stages | 409 `stale`, `name_taken`, `stage_limit` |

Notes:
- `Pipeline` gains `configVersion: number` (additive field). `ListPipelinesResponse` is unchanged otherwise. The existing `GET /sales/stages` keeps returning active stages only, so the board, list and form are unaffected.
- The id in the path is always re-checked against the business by RLS and by `findFirst({ where: { id } })` in the tenant client: another business's id is `404`, never `403`.
- `configVersion` is required on every write; there is no "force".
- Existing `POST /sales/pipelines` (`createPipeline`) is tightened to reject duplicate stage names (F5) with `400 duplicate_stage_name`; the database index enforces it too.

### 6.2 Opportunity-side changes (S-CFG-1A)

- `POST /sales/opportunities/:id/restore` accepts an optional `{ stageId }` (additive): when the opportunity is `OPEN` and its stage is archived, the client sends a target and the restore moves it in the same transaction. Without it, the trigger's `409 archived_reference` reaches the client.
- `reopen` already takes `stageId`; it now also fails cleanly (`409 archived_reference`) when the pipeline is archived (F4).
- No change to win and lose: closing never moves a stage.

### 6.3 S-CFG-2 routes (only if D-SCFG-1 (b))

`POST /sales/pipelines/:id/archive`, `POST /sales/pipelines/:id/restore`, `POST /sales/pipelines/:id/default`, and `GET /sales/pipelines?archived=all`. Error codes: `default_pipeline`, `has_open_opportunities`, `pipeline_limit`, `name_taken`, `stale`.

### 6.4 Error mapping

The guard triggers raise their own SQLSTATE class **`SA`** (Sales), mapped in `apps/api/src/app/api/_lib/routes.ts` next to `FN`, `PE` and `CM`. That file is shared (WF-1B-1 #110 also touches it), so the S-CFG-1A PR adds only its own `SA` lines and resolves any conflict at the front of the merge queue.

| SQLSTATE | HTTP | Code | Raised by |
|---|---|---|---|
| `SA001` | 409 | `archived_reference` | G2: target stage archived, or pipeline archived, on an OPEN opportunity write |
| `SA002` | 409 | `has_open_opportunities` | G1: archiving a stage that still holds open opportunities |
| `SA003` | 409 | `last_stage` | G1: archiving the last active stage |
| `SA004` | 409 | `immutable` | G1: changing a stage's `business_id` or `pipeline_id` |
| `23505` on U1/U2 | 409 | `name_taken` | Partial unique indexes (constraint name identifies which) |

## 7. Database changes: migration S-CFG-1

**Proposed stamp:** `20261210000000_sales_configuration`. It must sort after every stamp on `main` and in open PRs at the time it is written (today: `20261207000000` in #110). Re-check before creating the file; the stamp is a proposal, not a reservation, until the S-CFG-1A PR exists.

**Classification:** additive. One new column with a constant default (catalog-only change in PostgreSQL 11+, no table rewrite), two partial unique indexes, two trigger functions and three triggers. No existing row is changed, no column dropped, no grant widened.

### 7.1 Contents (illustrative SQL, final text in S-CFG-1A)

```sql
-- Explicit transaction settings, as in 20261206000000_search_indexes.
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';

-- C. Concurrency token for configuration edits.
ALTER TABLE "sales_pipelines"
  ADD COLUMN "config_version" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT sales_pipelines_config_version_positive CHECK ("config_version" >= 1);

-- U1. Active stage names unique per pipeline. U2. Active pipeline names unique per business.
CREATE UNIQUE INDEX "sales_stages_active_name_key"
  ON "sales_stages" ("business_id", "pipeline_id", lower(btrim("name"))) WHERE "archived_at" IS NULL;
CREATE UNIQUE INDEX "sales_pipelines_active_name_key"
  ON "sales_pipelines" ("business_id", lower(btrim("name"))) WHERE "archived_at" IS NULL;

-- G1. Stage guard (BEFORE UPDATE ON sales_stages).
--   * business_id and pipeline_id never change                         -> SA004
--   * archived_at NULL -> NOT NULL:
--       - at least one other active stage remains in the pipeline     -> SA003
--       - no OPEN, non-archived opportunity references the stage      -> SA002
--     (reads run after the row lock is held, with a fresh READ COMMITTED snapshot)
-- G2. Opportunity stage guard (BEFORE INSERT, and BEFORE UPDATE OF stage_id, pipeline_id, status, archived_at
--     ON opportunities), only when the resulting row is OPEN and not archived and, on UPDATE, stage_id,
--     pipeline_id, status or archived_at actually changed:
--       SELECT archived_at FROM sales_stages WHERE business_id = NEW.business_id AND id = NEW.stage_id FOR SHARE;
--       stage archived, or the pipeline's archived_at IS NOT NULL                     -> SA001
-- Both functions are SECURITY INVOKER (they run as bos_app under forced RLS, so they only ever see the
-- current business) with a pinned search_path, owned by the migration role. No new grants.
```

Why G2 also fires on `archived_at` changes: restoring an archived OPEN opportunity puts it back on the board, so it must land in an active stage (§4.4). Why it ignores WON/LOST rows: closing and closed history must never fail because a stage was archived later.

Why G1 fires on the stage and not only in the service: direct SQL and future code paths (imports, workflows) get the same guarantee, as WF-1B-1 did for project links.

### 7.2 What the migration does not do

- No backfill, no change to existing stages, names or positions.
- No FK from `opportunity_outcomes.stage_id` to stages (history must survive any future change; display joins tolerate a missing stage).
- No index for `position` uniqueness (ties are broken by `id`; reorder rewrites positions).
- No change to `create_business` or any privileged SQL. **No `db:privileged` step.**

### 7.3 Risk

| Risk | Assessment |
|---|---|
| Locking | `ADD COLUMN … DEFAULT` takes `ACCESS EXCLUSIVE` on `sales_pipelines` for a catalog change only. The two index builds take `SHARE` on `sales_stages` / `sales_pipelines` (writes wait, reads continue) until commit. `CREATE TRIGGER` takes `SHARE ROW EXCLUSIVE` on `opportunities` and `sales_stages`. Production tables are expected to be tiny (single-digit rows per GS1-A preflight); `lock_timeout = 3s` makes the migration fail closed rather than queue behind a long transaction |
| Data | U1/U2 fail if duplicates exist. The preflight (§8.1) must report zero first; if not, stop and ask Regan how to rename (that is a data change, not part of this migration) |
| Behaviour | G2 adds one indexed lookup and a share lock per opportunity write that touches stage, pipeline, status or archive state. No change for writes that already target active stages. An existing OPEN opportunity in an archived stage (should be none: there is no archive path today) would block its own later edits that touch those columns; the preflight counts them |
| Escalation | None expected: additive, no data loss, no auth/RLS change, no external effect. ChatGPT may approve it under the delegation once every safeguard passes. If the preflight finds duplicates or invalid rows, the fix is a data change and escalates to Regan |

## 8. Production preflight, rehearsal and rollback

### 8.1 Preflight (read-only, Mac session)

1. Read `_prisma_migrations`: every applied checksum matches; exactly `20261210000000_sales_configuration` (or the final stamp) is pending, plus nothing unexpected.
2. Forced RLS hides rows from the owner role, so per-business counts run as the app role with `app.business_id` set for each business (WF-1A memory finding, same as the WF-1B-1 §10.2 preflight), with a control query proving the setting took effect. Exact `count(*)`, never `n_live_tup`. Report counts only, no names or ids:
   - duplicate active stage names per pipeline (`lower(btrim(name))`) → must be 0;
   - duplicate active pipeline names per business → must be 0;
   - OPEN, non-archived opportunities whose stage or pipeline is archived → must be 0;
   - pipelines with zero active stages → reported (allowed, but noted).
3. No long-running transaction on the Sales tables.

Any non-zero "must be 0" count: stop, post the counts, ask Regan.

### 8.2 Recovery point and rehearsal

- Recovery branch `pre-sales-configuration-migration`, recorded with LSN and time, validated, added to `ops/neon/recovery-points.json`.
- Rehearsal on a disposable Neon branch is **recommended** (index builds and triggers on populated tables): apply, run the G1/G2 smoke SQL (archive a stage with an open opportunity → `SA002`; move into an archived stage → `SA001`), then discard.

### 8.3 Rollback

- Before any configuration has been used: a reviewed forward migration drops the three triggers, two functions and two indexes. Dropping `config_version` drops a column and escalates to Regan; leaving it in place is harmless (the old code ignores it), so the default plan is to leave it.
- After configuration has been used: no rollback of data; fix forward. Point-in-time restore from the recovery branch only with Regan's approval.
- Deployment order (protocol): apply and verify the migration, then merge the S-CFG-1A code through the queue. The old code is compatible with the new schema (the triggers only reject states the old code never creates, and U1/U2 only reject duplicates `createPipeline` would create, which the UI never calls), so the gap between apply and merge is safe.

## 9. Client design

### 9.1 Placement

- A **Pipeline settings** child page in the Sales Zone (`{ zone: 'sales', child: 'settings' }`), mirroring Finance's Settings child. Reached from a "Pipeline settings" button in the Sales header, visible to `sales:read` (read-only for MANAGER and MEMBER, editable with `sales:manage`).
- Settings hub: a `ZoneLink` `{ id: 'sales-pipelines', zone: 'Sales', label: 'Sales pipeline', requires: ['sales:read'], route: { zone: 'sales', child: 'settings' }, editKey: 'sales:manage' }` in `zones/settings/zone-links.ts`. That file belongs to draft PR #122; the link is added in S-CFG-1B after #122 merges, or by the Settings thread, whichever comes second.
- `shell/registry.ts` gains a Sales `children` entry. Registry and `app.tsx` are coordinated shared files: S-CFG-1B lists them in its claim and syncs at the front of the queue.

### 9.2 Screen

- Pipeline name (inline edit), then the ordered list of active stages: name, default probability, open-opportunity count, actions (rename, archive). Reorder with drag handles **and** "Move up / Move down" buttons (keyboard and screen-reader path; drag is never the only way). "Add stage" at the end or after a stage. A collapsed "Archived stages" section with Restore.
- Archive dialog: when the stage has open opportunities, it states the count and requires a target stage ("Move 4 open opportunities to…"); it never offers "leave them".
- Every write sends `configVersion`; on `409 stale` the page reloads and says "Someone else changed this pipeline. Your change was not saved." No optimistic reorder without rollback.
- Uses existing V2-B tokens and `packages/ui` components; no new tokens (consistent with UI V2-B rules; V2-C/V2-D not required).

### 9.3 Existing Sales screens

- Board, list filter and form keep reading active stages (`GET /sales/stages`, `GET /sales/pipelines`). Labels for closed opportunities in an archived stage show "(archived)" (the data comes from the new `GET /sales/pipelines/:id` or a small cached map).
- Reopen dialog: when the closing stage is archived, pick an active stage (already supported by the API).
- Restore of an archived OPEN opportunity whose stage is archived: ask for a stage (§6.2).
- Board defensive fix for F2: when more than one active pipeline exists, a pipeline switcher above the board (defaults to the default pipeline, not `pipelines[0]`). Included in S-CFG-1B regardless of D-SCFG-1, because the API can already create pipelines.

## 10. Cross-workstream alignment

| Workstream | Interaction | Resolution |
|---|---|---|
| WF-1A / WF-1B-1 (#110) | WF writes never touch stages (D-WF1-04); project-from-opportunity depends on `OPEN or WON` (D-WF1-16), not on stage | No conflict. Lock order added in §5.3. The S-CFG migration stamp sorts after `20261207000000`. Shared file `routes.ts` (SQLSTATE map): add-only lines |
| WF-3 (accept + win) | Win changes status to WON; G2 only checks rows that end OPEN | No interaction |
| Settings A3 / A2-D (#119, #122) | Settings is a hub; G-A3-17 says Sales owns stage edit | Sales child page + one hub link (§9.1). This design closes G-A3-17 and the A3 §8 row "Zone settings: Sales pipelines" (OWNER/ADMIN edit, MANAGER/MEMBER read) |
| ZCR-1 (#117) | Lists S-CFG with D-ZCR-8 "Stage editing only, one pipeline" | D-SCFG-1 restates it with the S-CFG-2 option |
| R2 dashboard (`/sales/summary`) | Already handles archived stages and pipelines | No change. After S-CFG, archived stages appear only for closed history, which the summary ignores (it counts OPEN) |
| R1 / WP-R1 metrics | No stage dimension today | A future "by stage" dimension must read live stage names and include archived stages as labelled rows |
| GS-UI / global search | Opportunity search indexes title only | No interaction |
| WP-C1 (customer page opportunities panel) | Shows stage labels | Uses the same `stageLabel` helper; "(archived)" for closed rows |
| V2 UI | Tokens and components | No new tokens |

## 11. Security and tenancy

- **Authority:** every configuration write requires `sales:manage` (OWNER, ADMIN) server-side in `tenantRoute`; the UI hides controls but is never the gate. MANAGER and MEMBER can read the configuration (they already read stages).
- **Isolation:** no new table. All reads and writes run in `withTenant`; RLS is forced on both tables; the trigger functions are `SECURITY INVOKER`, so they run under the same RLS as the statement that fired them and can only see the current business. Composite FKs still forbid cross-business stage or pipeline references. A stage or pipeline id from another business is `404`.
- **Bulk move scope:** `UPDATE opportunities … WHERE stage_id = $archived` runs in the tenant client (business filter injected) and under RLS; the archived stage id has been re-read in this business first.
- **No new external effect, job or provider.** No privileged SQL. No auth, admission or RLS policy change.
- **Information exposure:** `openCount` per stage is visible to `sales:read`, which already lists every opportunity. Audit metadata carries ids and counts only, never names (names are tenant data, consistent with §6 of the Sales data model).
- **Denial of service:** bounded by 20 stages per pipeline and 10 pipelines; the bulk move is bounded by the open opportunities of one stage and runs in one statement.

## 12. Audit

Written in the same transaction as the change. Metadata holds ids, counts and field names, never names.

| Action | Target | Metadata |
|---|---|---|
| `sales.pipeline.updated` | pipeline | `fields` |
| `sales.stage.created` | stage | `pipelineId`, `position` |
| `sales.stage.updated` | stage | `pipelineId`, `fields` |
| `sales.stage.reordered` | pipeline | `stages` (count) |
| `sales.stage.archived` | stage | `pipelineId`, `movedTo` (id or null), `moved` (count) |
| `sales.stage.restored` | stage | `pipelineId` |
| `sales.opportunity.stage_changed` | each moved opportunity | existing fields + `cause: 'stage_archived'` |
| S-CFG-2: `sales.pipeline.archived`, `.restored`, `.default_changed` | pipeline | `from`/`to` for default |

The A2-E/A3-C audit viewer (A-AUD) needs only these action names; no schema change on its side.

## 13. Test plan

S-CFG-1A must pass all of these; T-SC-20..27 on real PostgreSQL (`pnpm test:integration`), not mocks.

| ID | Test |
|---|---|
| T-SC-01 | Permission matrix: OWNER/ADMIN may write; MANAGER/MEMBER get 403 on every configuration write; all four may `GET /sales/pipelines/:id` |
| T-SC-02 | Tenant isolation: pipeline and stage ids of business B are 404 for business A on every route; `tests/isolation` covers the new routes |
| T-SC-03 | Add, rename, edit probability, reorder, archive (with and without open opportunities), restore: happy paths and response shapes |
| T-SC-04 | Name uniqueness case- and whitespace-insensitive among active stages; archived names reusable; restore clash → `name_taken` |
| T-SC-05 | Limits: 21st active stage → `stage_limit`; archive last active stage → `last_stage` (service and trigger) |
| T-SC-06 | `configVersion` stale on every write; reorder with a missing, extra or duplicate id → `stale` / 400 |
| T-SC-07 | Archive with `moveOpenTo`: open opportunities moved, versions bumped, one `stage_changed` audit each with `cause`; won, lost and archived opportunities untouched |
| T-SC-08 | `moveOpenTo` archived, equal to the archived stage, or in another pipeline → 400 `invalid_stage` |
| T-SC-09 | Reopen into archived closing stage → `archived_reference`; reopen with an active `stageId` works |
| T-SC-10 | Restore of an archived OPEN opportunity in an archived stage: without `stageId` → `archived_reference`; with → restored and moved |
| T-SC-11 | `createPipeline` with duplicate stage names → 400 |
| T-SC-12 | Audit entries in the same transaction (rollback removes both) and carry no names |
| T-SC-13 | Trigger G1 via direct SQL as `bos_app`: change `pipeline_id` → `SA004`; archive with open opportunity → `SA002`; last stage → `SA003` |
| T-SC-14 | Trigger G2 via direct SQL: insert OPEN into archived stage → `SA001`; update a WON row's other columns in an archived stage → allowed |
| T-SC-20 | Race: stage archive vs opportunity move into that stage (both orders, with a barrier) → never an OPEN row in an archived stage |
| T-SC-21 | Race: stage archive vs opportunity create into that stage |
| T-SC-22 | Race: stage archive (+move) vs PATCH of an opportunity in that stage → one `stale`, no lost update |
| T-SC-23 | Race: two reorders from the same `configVersion` → exactly one succeeds |
| T-SC-24 | Race: two archives of the last two active stages → exactly one succeeds |
| T-SC-25 | Race: stage archive (+move) vs reopen into the archived stage |
| T-SC-26 | No deadlock across 50 randomized concurrent C1/C2/O1 operations (`40P01` count = 0) |
| T-SC-27 | WF-1 interplay: stage archive (+move) concurrent with `from-opportunity` and finance link writes on the same opportunity: both succeed |
| T-SC-30 | Client: configuration page read-only vs editable by role; keyboard reorder; archive dialog requires a target when count > 0; stale reload message; board pipeline switcher; archived stage label on closed opportunities |
| T-SC-31 | Contracts: `pnpm contracts:check` additive; snapshot regenerated |

## 14. Work packages and readiness gates

| Package | Scope | Migration | Depends on | Readiness gates |
|---|---|---|---|---|
| **S-CFG-0** | This document | None | – | ChatGPT architecture audit; owner decisions D-SCFG-1..8 recorded |
| **S-CFG-1A** | Migration `…_sales_configuration`; API routes §6.1–6.2; contracts; `SA` error map; service changes (F3–F6); tests T-SC-01..27, 31 | **Yes** | S-CFG-0 decisions | (1) Stamp sorts after every stamp on `main` and open PRs; (2) T-SC-20..27 pass on real PG and are posted; (3) ChatGPT code audit; (4) §8.1 preflight posted with all "must be 0" counts at 0; (5) recovery branch created and validated; (6) rehearsal posted (recommended); (7) `APPROVED — EXECUTE: MIGRATION` naming the file, applied from the Mac session and verified; (8) then `APPROVED — EXECUTE: MERGE` on the final head via the merge queue |
| **S-CFG-1B** | Pipeline settings page, Sales header entry, reopen/restore stage pickers, archived labels, board pipeline switcher (F2), registry child, Settings hub link (after #122); T-SC-30; screenshots light/dark/390 | None | S-CFG-1A merged (contracts) | ChatGPT audit; coordinated edits to `registry.ts`, `app.tsx`, `zone-links.ts`; merge verdict |
| **S-CFG-2** (optional) | Multiple pipelines in the UI: create, archive, restore, make default; routes §6.3; pipeline switcher everywhere; 10-pipeline limit | None (S-CFG-1 already enforces the pipeline rules) | D-SCFG-1 (b), S-CFG-1B | ChatGPT audit including C3/C4 race tests; merge verdict |

S-CFG-1A and S-CFG-1B can be built in parallel against the contract in §6 if the 1B branch stubs the client API; 1B merges after 1A.

## 15. Owner decisions

Recommendations are marked. None changes security, cost or an external effect.

| ID | Decision | Options | Recommendation | Why |
|---|---|---|---|---|
| **D-SCFG-1** | Pipelines in the UI | (a) one pipeline, stage editing only, now; multiple pipelines later as S-CFG-2 (b) build multiple pipelines now too | **(a)** | Matches D-ZCR-8; most small businesses sell one way; the database rules are already designed for (b), so it stays cheap later |
| **D-SCFG-2** | Archiving a stage that holds open opportunities | (a) require a target stage and move them in the same action (b) refuse until the user has moved them one by one | **(a)** | One clear dialog, atomic, audited per opportunity; (b) is tedious and racy for users |
| **D-SCFG-3** | Stage names unique within a pipeline (case-insensitive, active stages only) | Yes / No | **Yes** | Duplicate names make the board, filters and reports ambiguous |
| **D-SCFG-4** | Stage default probability | (a) hint only: pre-fills new opportunities, never changes an existing opportunity's probability (b) a stage move also sets probability to the stage default | **(a)** | Keeps user-entered values authoritative (same spirit as D-WF1-04); weighted forecast is deferred (D-R2D-5) |
| **D-SCFG-5** | Who configures | (a) OWNER and ADMIN (`sales:manage`), MANAGER read-only (b) also MANAGER | **(a)** | Matches the existing role policy and Settings A3 §8 |
| **D-SCFG-6** | Limits | 1–20 active stages per pipeline; 10 active pipelines per business | **Accept** | 20 matches the existing create contract; bounds the bulk move and the UI |
| **D-SCFG-7** | Renames apply to history | (a) live names everywhere, including won/lost history (b) snapshot the stage name on each outcome | **(a)** | No schema or data duplication; ids in audit keep the true record; rename is the user's intent |
| **D-SCFG-8** | Stage-transition history for funnel and conversion reporting | (a) defer; the audit log is the record (b) add an `opportunity_stage_events` table in S-CFG-1 | **(a)** | Not needed for configuration; belongs with WF-7 / R-series reporting design, which can backfill from audit `stage_changed` entries |

## 16. Known limitations and deferred work

- Funnel and conversion analytics by stage (D-SCFG-8), weighted forecast (D-R2D-5).
- Stage colours, required fields per stage, automation on stage entry.
- Pipeline templates at business creation; importing stages.
- Per-team pipelines and record-level visibility (D-ZCR-9).
- Stage-level permissions (who may move into "Won-ready" stages): out of scope; `sales:close` remains the documented extension point (`sales-data-model.md` §5).
- `sales-data-model.md` §8 rows 17 and 18 should point here once S-CFG-1A merges (docs touch-up in that PR).
