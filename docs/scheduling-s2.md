# Scheduling S2: resources, availability and conflict-safe bookings

> Status: **Merged** (PR #61, `9dc670d`, 2026-11-16). Migration applied to production before the merge (see migration-readiness.md §9). Scheduling navigation was switched on in S3 (D-S2-8, docs/scheduling-s3.md).
> Builds on [scheduling-s1.md](./scheduling-s1.md) (PR #38). Conflict prevention is recorded in [ADR 0008](./adr/0008-scheduling-ordered-lock-conflict-prevention.md), which supersedes [ADR 0006](./adr/0006-scheduling-conflicts-and-privacy.md) §2–§3. ADR 0006's privacy and erasure sections stay future requirements (§10).
> Every S1 invariant is kept: half-open intervals, `enforceConflicts` per write, the S1 lock steps, optimistic versions, forced RLS, composite tenant keys, no DELETE grant.

## 0. Audit summary (main at 52de37f)

| Area | Finding | Consequence for S2 |
|---|---|---|
| Schema | `scheduling_calendars`, `scheduling_events`; `UNIQUE (business_id, id)` on events already exists "for a future `scheduling_event_resources`" (S1 §2). | Assignments reference `(business_id, event_id)` with no change to any S1 column. |
| Conflicts | Per-calendar, per-write `enforceConflicts`; overlaps allowed when off; an enforced write conflicts with any occupying event, including earlier non-enforced ones. | Resource conflicts use exactly the same rule. No exclusion constraint (it would make accepted overlaps impossible). |
| Locks | Calendar rows FOR SHARE (sorted) → calendar advisory locks (sorted) → event row FOR UPDATE + version → check + write. Separate per-business default lock, only on calendar paths, always first. | Resource steps slot in **between** the calendar steps and the event row (§5). Default-lock paths never touch resources. |
| API/contracts | Strict Zod objects in `packages/contracts/src/scheduling.ts`; client parses every response strictly. | New response fields are additive in the contract, but a strict-parsing client must ship with them. The Schedule Zone is still **not registered in navigation** on main (S1 §7 patch), so no shipped client reads these responses today. |
| UI | Day/week/month views, event form/detail; Zone not in the shell. | S2 adds Resources and a resource timeline inside the Zone; the navigation patch stays deferred and is refreshed. |
| Permissions | `scheduling:read/create/update/cancel` all roles; `scheduling:manage_calendars` OWNER/ADMIN/MANAGER. | One new key, `scheduling:manage_resources`, same roles as `manage_calendars`. |
| People P1 | `people_employees` exists, but `people-boundaries.test.ts` forbids any code outside the People module reading People tables, and any non-People contract carrying `employeeId`. | Linking a PERSON resource to an employee would need People-owned changes while P2 is active. **PERSON resources are standalone in S2** (D-S2-1); the later path is in §9. |
| Migrations | Newest on main: `20261127000000_finance_reminders`. No open PR adds a migration (PR #53 and #48 are docs/tooling; no People P2 branch on the remote yet). | S2 migration: `20261128000000_scheduling_resources`. If People P2 picks the same timestamp, one of the two renames before merge. |

## 1. Scope

**In S2:** resource registry (PERSON, ROOM, EQUIPMENT, OTHER), lifecycle (active, inactive, archived, restore), assigning several resources to an event atomically with the event write, resource conflict detection and enforcement, a resource availability query, the resource directory and detail UI, a resource picker in the existing event form, a resource timeline view, audit events and permissions.

**Not in S2:** recurrence, rostering, leave, timesheets, attendance, calendar sync, public booking, reminders, AI or automatic scheduling, optimisation, billing, quantities/stock, private entries and erasure, working hours, employee linkage, drag-and-drop.

## 2. Schema (migration `20261128000000_scheduling_resources`, additive only)

Two enums, two tables. No S1 column, index or row changes; no extension; no privileged step.

### 2.1 `scheduling_resources`

| Column | Notes |
|---|---|
| `id`, `business_id` | `UNIQUE (business_id, id)` is the composite FK target. Business FK cascades like every tenant table. |
| `name` | 1–100 characters (CHECK). Not unique: two "Room 1"s in different sites are allowed. |
| `description` | ≤ 1000 characters. Free text the business writes; never copied elsewhere. |
| `resource_type` | `PERSON`, `ROOM`, `EQUIPMENT`, `OTHER`. Industry-neutral; the business's own words go in `name`. |
| `status` | `ACTIVE`, `INACTIVE`, `ARCHIVED` (§3). CHECK: `archived_at` is set exactly when `ARCHIVED`. |
| `colour` | Optional `#RRGGBB`, for the timeline. |
| `version`, `created_by_id`, `updated_by_id`, timestamps, `archived_at` | As S1 calendars. |

No `calendar_id`: a resource is business-wide and can be booked from any calendar. Times are shown in the zone of the calendar being viewed, as in S1.

### 2.2 `scheduling_event_resources` (assignments)

| Column | Notes |
|---|---|
| `id`, `business_id` | — |
| `event_id` | Composite FK `(business_id, event_id)` → `scheduling_events`. |
| `resource_id` | Composite FK `(business_id, resource_id)` → `scheduling_resources`. |
| `created_at`, `created_by_id` | Who assigned it. |
| `removed_at`, `removed_by_id` | Soft removal: set together (CHECK). A removed assignment is history and frees the time. |

- **One live assignment per (event, resource):** partial unique index on `(business_id, event_id, resource_id) WHERE removed_at IS NULL`. Re-adding after removal inserts a new row.
- **No copied times.** Occupancy is computed by joining the event; there is no second ledger to keep in sync.
- **Grants:** `bos_app` gets `SELECT, INSERT` and `UPDATE (removed_at, removed_by_id)` only, so an assignment can never be re-pointed at another event or resource. No DELETE on either table.
- **Indexes:** `(business_id, resource_id, event_id) WHERE removed_at IS NULL` (conflict check and per-resource bookings), `(business_id, event_id) WHERE removed_at IS NULL` (an event's resources).
- **No assignment metadata** (role, quantity, notes): not needed for S2's exclusive, all-or-nothing allocation, and each would be a product decision.

## 3. Resource lifecycle

| Status | Offered in the picker | New assignment | Existing assignments | Editable |
|---|:-:|:-:|---|:-:|
| `ACTIVE` | ✓ | ✓ | occupy time | ✓ |
| `INACTIVE` (out of service for now) | — | refused `409 resource_inactive` | kept and still occupy time | ✓ |
| `ARCHIVED` (retired) | — | refused `409 archived_reference` | kept and still occupy time; shown on history | read-only until restored |

- Transitions: `ACTIVE ⇄ INACTIVE` via `PATCH { status }`; `ACTIVE|INACTIVE → ARCHIVED` via `POST /archive`; `ARCHIVED → ACTIVE` via `POST /restore`.
- Archiving or deactivating does **not** remove the resource from events already booked (no silent rewrite of bookings). The response reports how many upcoming bookings still hold it, so the person can move them. Editing such an event keeps the resource; it only cannot be **added** again.
- No hard deletion anywhere.

## 4. Conflict and availability semantics

- **Overlap:** `existing.start_at < proposed.end_at AND proposed.start_at < existing.end_at` (half-open). Touching intervals never conflict.
- **A resource is occupied** by an event when the event is `SCHEDULED`, not archived, `blocks_availability`, and has a live (not removed) assignment of that resource. Cancelled, archived and non-blocking events, and removed assignments, never occupy.
- **Exclusive:** every resource has capacity one in S2.
- **Enforced write** (`enforceConflicts: true`, the default): refused with `409 scheduling_conflict` if **either** the calendar check (S1, unchanged) **or** the resource check finds an occupying overlap. Nothing is written: no event change, no assignment.
- **Non-enforced write** (`enforceConflicts: false`): succeeds, returns every calendar and resource overlap it created, and writes `scheduling.event.overlap_accepted` (ids and counts only).
- **When each check runs:**
  - calendar check: exactly as S1 (result blocks and `calendarId`, `startAt`, `endAt` or `blocksAvailability` changed);
  - resource check: result blocks and (`startAt`, `endAt` or `blocksAvailability` changed → every assigned resource) or (resources added → the added ones). A move between calendars alone does not re-check resources (their occupancy does not change).
- **Cancel, archive, removing a resource** only free time: never a conflict.
- **Reads** (`GET events/:id`, availability) report current overlaps for information.

### 4.1 Conflict response (additive)

Each conflict entry keeps the S1 fields (`eventId`, `calendarId`, `title`, `startAt`, `endAt`) and adds:

- `kind`: `calendar` or `resource`;
- `resource`: `{ id, name }` for resource conflicts, else `null`;
- `blocking`: `true` when it refused the write (409), `false` for an accepted or informational overlap.

An event that clashes on two resources yields two entries. Titles are shown because `scheduling:read` already lets every reader see every event (calendars are business-wide in S1); no description, location, customer or People data is ever included.

### 4.2 Availability query

`GET /scheduling/resources/availability?start&end[&resourceIds][&type][&calendarId][&excludeEventId][&cursor][&limit]`

- Interval ≤ 31 days (the event maximum); up to 50 `resourceIds`, or a page (≤ 100) of non-archived resources in name order.
- Each resource is `available`, `occupied` (with its conflicts) or `unavailable` (inactive or archived; with its status).
- With `calendarId`, the calendar's own S1 overlaps are returned as well.
- Computed from events and assignments only. **Advisory**: the booking transaction re-checks under locks.
- Conflicts listed here always carry `blocking: false` (nothing was refused); at most 20 per resource.

## 5. Lock protocol (extends S1 §4.3)

Every availability-affecting mutation runs, in one transaction, in this order:

1. **Calendar rows `FOR SHARE`**, sorted by id (S1 step 1).
2. **Calendar advisory locks**, same order (S1 step 2).
3. **Resource rows `FOR SHARE`**, sorted by id: every resource the write touches (assigned before ∪ after). Reads each resource's status under the lock.
4. **Resource advisory locks** `hashtextextended('scheduling.resource:' || id, 0)`, same order.
5. **Event row `FOR UPDATE`** with the version re-check (S1 step 3). Assignments only change through event writes that bump the event version, so a version match proves the assignment set read before step 1 is still current.
6. **Calendar check, resource check, then the writes** (event row, assignments, audit). Locks release at commit or rollback.

Who takes what:

| Operation | 1–2 calendars | 3–4 resources | 5 event |
|---|---|---|---|
| Create event | its calendar | requested resources | — |
| Edit event (any field, incl. move, retime, resource changes) | old ∪ new calendar | old ∪ new resources | ✓ |
| Cancel / archive event | its calendar | its resources | ✓ |
| Resource create | — | — | — |
| Resource edit / status / archive / restore | — | its row, `UPDATE` (waits for 3) | — |
| Calendar create / default change | default lock, then calendar rows (S1) | — | — |
| Calendar edit / archive / restore | its row, `UPDATE` (S1) | — | — |

**Why no cycle is possible:** every path acquires in the global order *default lock → calendar rows → calendar advisory → resource rows → resource advisory → event row*, sorted within each step, and the lifecycle paths (resource or calendar `UPDATE`) each hold exactly one row lock and wait for nothing else. Nothing ever takes a resource lock after an event lock, or a calendar lock after a resource lock.

**Why advisory locks and not an exclusion constraint:** S1's accepted overlaps must stay possible (ADR 0006 §2 variant A would forbid them), and no extension or privileged step is needed.

## 6. API (all under `/api/v1/b/:slug/scheduling/`)

| Method | Path | Permission |
|---|---|---|
| GET | `resources` (search `q`, `type`, `status`, cursor; ≤ 100 per page) | `scheduling:read` |
| POST | `resources` | `scheduling:manage_resources` |
| GET | `resources/:id` (with upcoming-booking count) | `scheduling:read` |
| PATCH | `resources/:id` (details, `status: ACTIVE|INACTIVE`, version) | `scheduling:manage_resources` |
| POST | `resources/:id/archive`, `resources/:id/restore` | `scheduling:manage_resources` |
| GET | `resources/availability` | `scheduling:read` |
| GET | `events?…&resourceId=` (new optional filter) | `scheduling:read` |
| POST / PATCH | `events`, `events/:id`: new optional `resourceIds` (≤ 20; on PATCH the full desired set) | `scheduling:create` / `scheduling:update` |

Events gain `resources: [{ id, name, type, status }]` (live assignments). Error codes added: `resource_inactive` (409). Existing codes reused: `scheduling_conflict`, `stale`, `archived`, `archived_reference`, `not_archived`.

## 7. Permissions

| Key | OWNER | ADMIN | MANAGER | MEMBER |
|---|:-:|:-:|:-:|:-:|
| `scheduling:manage_resources` (new) | ✓ | ✓ | ✓ | — |

Viewing resources and availability uses `scheduling:read`; assigning or removing resources on an event uses the event's `scheduling:create` or `scheduling:update`. No People, Customer or other Scheduling permission changes.

## 8. Audit

`scheduling.resource.created`, `.updated` (field names), `.status_changed` (from/to), `.archived`, `.restored`; `scheduling.event.resources_changed` (added/removed resource ids); `scheduling.event.overlap_accepted` (calendar and resource overlap counts, conflicting event and resource ids). Never names, descriptions or event text.

## 9. People integration (deferred)

S2 keeps PERSON resources standalone (D-S2-1). Later path, owned by People: a nullable `employee_id` on `scheduling_resources` with a composite FK to `people_employees`, plus a People-module function that returns only a display name for an employee id, and an update to `people-boundaries.test.ts` that allows exactly that call. No S2 column has to change.

## 10. ADR 0006 reconciliation (ADR 0008)

ChatGPT's audit of PR #61 asked that ADR 0006 not be accepted unchanged, because it still names an exclusion constraint as the primary safeguard. [ADR 0008](./adr/0008-scheduling-ordered-lock-conflict-prevention.md) therefore supersedes ADR 0006 §2–§3. It records the lock protocol actually built, its guarantees, its limitations, and the rule every future write path must follow. ADR 0006 is marked "superseded in part"; its §1 (time) is implemented, and its §4–§7 stay future requirements.

**Implemented in S1/S2:**
- time model;
- calendars and events;
- resources and assignments;
- calendar and resource conflicts with one override;
- availability;
- ordered locking;
- permissions and audit.

**Future, not built:**
- **private events** (sensitive text behind a restrictive policy);
- **busy-only visibility**: today every `scheduling:read` holder sees event titles, including in conflicts;
- escalation guards;
- privileged erasure;
- a **database-enforced exclusion constraint** (`btree_gist`): not installed, kept as a future option for hard bookings;
- the People link;
- capacity > 1, working hours, recurrence.

The full table is ADR 0008 §6.

## 11. Owner decisions

D-S2-1 to D-S2-6 were **approved by Regan on 2026-11-16**, with these additions, all built:

- keep a later People link possible without bypassing People boundaries (§9);
- `manage_resources` enforced on the server; members assign only through `scheduling:create` / `scheduling:update`;
- inactive and archived resources keep their assignments (history); INACTIVE → ACTIVE is a plain status edit, ARCHIVED → ACTIVE is `restore`;
- calendar and resource conflicts are distinguishable, with one overlap override;
- deterministic concurrency tests for multi-resource bookings, opposite-order assignments, archive races and moves (§12.2);
- additive contract compatible with S1 clients (§11.1);
- migration name unique and ordered against main (§14).

| # | Decision | Built |
|---|---|---|
| D-S2-1 | PERSON resources linked to employees? | **Approved.** Standalone in S2; People-owned link later (§9). |
| D-S2-2 | Who manages resources | **Approved.** New `scheduling:manage_resources` for OWNER/ADMIN/MANAGER; MEMBER views and assigns. |
| D-S2-3 | Inactive/archived resources with upcoming bookings | **Approved.** Bookings kept and still occupy time; no new assignments; the resource response lists upcoming bookings. |
| D-S2-4 | Overrides | **Approved.** One `enforceConflicts` flag covers calendar and resource conflicts; every resource exclusive (capacity 1). |
| D-S2-5 | Locking | **Approved.** Extended advisory protocol (§5), no `btree_gist`. Recorded in ADR 0008 (supersedes ADR 0006 §2–§3) after the PR #61 audit. |
| D-S2-6 | Response contract | **Approved.** Conflict entries gain `kind`, `resource`, `blocking`; events gain `resources` (§11.1). |
| D-S2-7 | Limits | **Approved** by Regan in the PR #61 re-audit: ≤ 20 resources per event, ≤ 50 per availability call, ≤ 20 conflicts listed per resource. |
| D-S2-8 | Navigation | **Stays off** pending a separate activation decision (Regan, PR #61 re-audit). The S1 integration patch was regenerated against current main and covers S2 too. |

### 11.1 Compatibility with S1 clients

Every change is additive: new optional request fields (`resourceIds`, `resourceId`), new response fields, new endpoints, a new error code. Requests valid in S1 stay valid and behave the same when no resource is named. One caveat: the app parses responses with **strict** schemas, so a client built from the S1 contracts would reject the new response fields. No shipped build calls the Scheduling endpoints (the Zone is not in navigation), so nothing breaks today; the app and API must ship together when the Zone is switched on, as for every Zone.

## 12. Tests and results

### 12.1 Suites

| Suite | What it covers |
|---|---|
| `apps/api/tests/integration/scheduling-resources.test.ts` (new, 33 tests) | Registry and lifecycle (all types, ACTIVE ⇄ INACTIVE, archive, restore, read-only archive, audit without names); assignments (all or nothing, full-set PATCH, soft removal keeps history, re-add is a new row, version bumps); inactive/archived history; event `resources` and `resourceId` filter; conflicts (cross-calendar, calendar + resource together, one override, cancelled/archived/non-blocking/removed never occupy, retime re-checks all, adds check only the added); availability; time zones (Perth, Sydney, New York, London, Kolkata, Kathmandu, DST gaps and repeats, midnight crossing); tenant isolation, database grants and cross-tenant FKs; permissions by role; 14 concurrency tests; a performance test. |
| `apps/api/tests/integration/scheduling.test.ts` (S1, 29 tests) | Unchanged behaviour; expectations updated only for the additive conflict fields and the grants query scoped to S1 tables. |
| `apps/api/tests/unit/scheduling-access.test.ts` | The new permission key and its role matrix. |
| `packages/app/tests/scheduling-zone.test.tsx` (18 tests, 9 new) | Tabs, resource directory and filters, create/edit form, lifecycle actions, picker and availability badges, grouped calendar/resource conflicts, override success message, timeline layout and overlap marks, permission gating. |

### 12.2 Concurrency evidence

Each test runs real parallel transactions against PostgreSQL through the app role and checks the database afterwards, not just responses:

- order probe: a separate session holds the highest resource's advisory lock; a booking that names the resources in reverse order blocks while already holding the calendar lock, every resource row and the lower resources' advisory locks, and an edit blocked the same way does not yet hold its event row;
- every resource-touching mutation (create, edit, retime, move, cancel, archive, enforced or not) waits on the resource lock;
- one resource booked from two calendars at once: exactly one succeeds;
- multi-resource all or nothing (Room 1 + Employee 1 vs Room 1 + Employee 2);
- the same resources named in opposite orders, and two events exchanging resources: no deadlock, never two occupants;
- reschedule vs new booking, cancellation vs booking of the freed slot;
- archive vs assign, inactivate vs book: whichever runs second sees the other;
- event archive/cancel racing resource edits, and moves between calendars in opposite directions: no deadlock;
- concurrent full-set edits from one version: one wins, the rest get `stale`;
- a control test showing check-then-write double-books without the lock.

### 12.3 Mutation checks (run locally, then reverted)

| Mutation | Result |
|---|---|
| Resource advisory lock removed | 6 concurrency tests fail (double bookings). |
| Resource locks taken in request order instead of sorted | 3 tests fail: the order probe, and real deadlocks (503 `retryable`) in the opposite-order and exchange tests. |

### 12.4 Performance (local PostgreSQL 16)

300 resources, 6,000 events, 18,000 assignments: availability for 50 resources about 9–11 ms per query; an enforced booking holding 20 resources 26–40 ms. Plans use the partial live-assignment indexes (bitmap heap scans), no sequential scans.

### 12.5 Quality gates

Run locally on 2026-11-16 (PostgreSQL 16, no pooler):

| Gate | Result |
|---|---|
| `pnpm contracts:check` (schema regenerated) | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm boundaries` (incl. People boundary tests) | pass |
| `pnpm test` | pass: contracts 24, ui 95, api unit 134, app 386, architecture 294 |
| `pnpm test:integration` | pass: 611 / 611 (22 files; S2 33, S1 29) |
| `pnpm db:check-migrations` | pass: migrations match the schema |
| `check-migration-order.sh` against main | pass |
| `pnpm build` | pass |
| Fresh database, all 18 migrations | applied cleanly |
| `pnpm test:isolation` | not runnable here: needs PgBouncer on 6433, which this environment lacks; CI runs it and the new pooler step |

One app test (`finance-f5`, PDF card) failed once while the integration suite was loading the machine and passed on three reruns; Finance code is unchanged here.

## 13. Known limitations

- Capacity is always 1; no shared or pooled resources.
- No working hours, opening times or resource-specific time off; "available" means "not booked".
- PERSON resources are not linked to People employees (§9).
- Conflict titles are visible to every `scheduling:read` holder (as in S1); private entries and erasure (ADR 0006 §4–5, §7) remain unbuilt.
- The guarantee is application-level locking, not a database constraint. A future write path that skips the protocol could double-book (ADR 0008, "Risk").
- The Zone is still not in navigation (D-S2-8); the timeline is a simple day/week table, without drag and drop.
- The PgBouncer CI step for the S2 suite was added but could not be run locally (no pooler in this environment); CI runs it.

## 14. Migration and rollout

- `20261128000000_scheduling_resources` is the only new migration. It sorts after main's newest (`20261127000000_finance_reminders`, applied to production on 2026-11-16); People P2 (#56, merged as `f91669e`) added no migration. Rechecked 2026-11-16 after the audit: the only other branch with a later migration is the Communications erasure branch (`claude/project-thread-du5otb`, `20261129000000_communications_erasure`). It sorts after this one, its header says it commutes with S2, and it touches no scheduling object. If that branch merges first, this migration must be renamed past it before merge, because CI requires new migrations to sort after main's newest. The only textual overlap between the two branches is the Business relation fields in `tenancy.prisma` (plus regenerated `api-v1.json`), a trivial merge for whichever lands second.
- Additive only, one transaction, no extension, no privileged SQL file, no data backfill. Applied cleanly to a fresh database with all 18 migrations.
- Order: merge, recovery branch (the Neon Free plan's 10-branch limit applies), `prisma migrate deploy`, verify RLS/grants as for F6-3, then deploy. Because the change is additive, the old API keeps working against the new schema, so either order is safe.
- Rollback: redeploy the previous API; the two tables can stay. Dropping them needs a new forward migration.
- Done 2026-11-16: recovery branch `pre-s2-migration`, migration applied, RLS and grants verified, then PR #61 merged. Navigation not changed.
