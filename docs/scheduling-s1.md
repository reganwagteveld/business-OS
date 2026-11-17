# Scheduling S1: core scheduling foundation

> Status: **Implemented for audit** (S1). Not merged or deployed. The migration has been applied only to local, disposable databases.
> [ADR 0006](./adr/0006-scheduling-conflicts-and-privacy.md) stays **Proposed**. S1 deliberately builds a smaller model than the S0 proposal in [scheduling-data-model.md](./scheduling-data-model.md). §2 lists the differences and shows how S1 keeps the S0 path open.
> Conventions follow [data-model.md](./data-model.md) and the Sales and Projects Zones: tenancy, forced RLS, composite foreign keys, permission keys, the audit log, optimistic versions and additive migrations.

## 1. Scope

**In S1:**

- **Calendars.** Business-wide calendars, each with its own IANA time zone and a colour. A business has exactly one default calendar once it has any calendar. The first calendar becomes the default, or initialisation creates one.
- **Events.** Each event belongs to one calendar and has:
  - a title, notes and a location;
  - an optional customer link;
  - an option to block time;
  - a choice to enforce the conflict check or not;
  - a cancel action and an archive action. Neither deletes anything.
- **API.** Endpoints under `/api/v1/b/:slug/scheduling/...`, with Zod contracts in `@business-os/contracts`.
- **UI.** A Schedule Zone with:
  - day, week and month views;
  - previous, next and today navigation;
  - a calendar picker;
  - create and edit forms, an event detail view, and cancel and archive actions;
  - conflict feedback, a "keep the overlap" option, and a choice when a time is ambiguous;
  - loading, empty and error states.

**Not in S1:** shifts, rostering, timesheets, leave, payroll, booking portals, reminders, calendar sync, recurrence, resources and equipment, task sync, invoices, payments, AI agents, mobile apps and external integrations. Private entries and privileged erasure are not built either. §2 explains why S1 does not block them.

## 2. Differences from S0 (ADR 0006 compatibility)

S0 proposed a resource-centred model:

- `schedule_resources`, `schedule_events` and `schedule_event_details`;
- assignments in `schedule_event_resources`;
- a `btree_gist` exclusion constraint;
- private entries behind a restrictive RLS policy;
- privileged erasure.

S1 builds a smaller, calendar-centred core. ADR 0006 is **not** accepted by this PR, and nothing in S1 contradicts it.

| Topic | S0 proposal (ADR 0006) | S1 as built | How the S0 path stays open |
|---|---|---|---|
| What time belongs to | Resources (people, rooms, equipment) through assignments | A calendar (`scheduling_calendars`) | A calendar can later be one kind of resource, or own resources. A future `scheduling_event_resources` table can reference `(business_id, event_id)`, which already has a composite unique key. No S1 column has to change. |
| Double-booking | An exclusion constraint, a `btree_gist` privileged step, and database-maintained copies | A per-calendar advisory-lock protocol (§4.3). Enforcement is per write (`enforceConflicts`). | An exclusion constraint cannot allow an overlap that someone has accepted on purpose, and S1 must allow one. A future table of hard, exclusive assignments can still add the S0 constraint. Its writes would take the same calendar or resource advisory locks first, as ADR 0006 §2 already requires. **No extension is used and no privileged step is added.** |
| Privacy | Sensitive text in `schedule_event_details`, behind a restrictive policy | Title, notes, location and customer are on the event row. Calendars are shared by the whole business. | Text columns are only written through the service, so they can move 1:1 into a details table later in one additive migration plus a backfill. No other table copies them. The audit log stores ids and flags but **no event text**, so the log will not need erasing. |
| Erasure | A privileged erasure path with database-verified authority | Not built. Tenants have no DELETE on either table. | Nothing outside the event row holds an event's text, so a future erasure function only has to blank or remove one row (or its future details row). |
| Permission zone name | `schedule:*` | `scheduling:*` (approved naming) | One zone, named once in the registry. |
| Time | `timestamptz` plus the IANA zone it was entered in, half-open ranges | The same. The zone is on the calendar, and the API also accepts an explicit offset instant. | — |

## 3. Schema

Migration `apps/api/prisma/migrations/20261118050000_scheduling/migration.sql` is **additive only**:

- one enum and two tables, with their indexes, checks, grants and policies;
- no change to any existing table's columns;
- no extension and no privileged step.

The Prisma relation fields added to `Business` and `Customer` are virtual, so they produce no DDL.

### 3.1 `scheduling_calendars`

| Column | Notes |
|---|---|
| `id`, `business_id` | `UNIQUE (business_id, id)` is the target of composite foreign keys. The business foreign key cascades, the same as other tenant tables. |
| `name` | 1–100 characters (CHECK). |
| `description` | Optional, ≤ 1000 characters. |
| `colour` | Optional `#RRGGBB` (CHECK). |
| `time_zone` | IANA name, canonicalised by the API. A shape CHECK and ≤ 64 characters. |
| `default_slot` | `'default'` or NULL. `UNIQUE (business_id, default_slot)` allows one default per business (the Sales default-record pattern). A CHECK stops an archived calendar from being the default. The API exposes it as `isDefault`. |
| `version` | Optimistic concurrency, ≥ 1. |
| `created_by_id`, `updated_by_id`, timestamps, `archived_at` | Archived calendars are kept. Their events stay readable and become read-only. |

### 3.2 `scheduling_events`

| Column | Notes |
|---|---|
| `calendar_id` | A composite foreign key `(business_id, calendar_id)` to calendars, so an event can never point at another business's calendar. |
| `title` | 1–200 characters. |
| `description` | ≤ 5000 characters. |
| `location` | ≤ 500 characters. |
| `start_at`, `end_at` | `timestamptz`. CHECK `end_at > start_at`, and duration ≤ 31 days. |
| `status` | `SCHEDULED` or `CANCELLED`. A CHECK requires `cancelled_at` to be set exactly when the status is `CANCELLED`. `cancelled_by_id` records who cancelled. |
| `blocks_availability` | Default `true`. A non-blocking event is never a conflict. |
| `customer_id` | Optional. A composite foreign key `(business_id, customer_id)` to `customers`. |
| `version`, audit columns, `archived_at` | — |

Indexes:

- `(business_id, calendar_id, start_at, id)` serves the conflict check and the calendar view;
- `(business_id, start_at, id)` serves the all-calendars view;
- `(business_id, customer_id)`.

**Grants and RLS.** On both tables `bos_app` has `SELECT, INSERT, UPDATE` and no `DELETE`. RLS is `ENABLE`d and `FORCE`d, with the standard `tenant_isolation` policy on `app.business_id`. Both models are registered in `TENANT_MODELS`, so the scoped client adds `businessId` to every query.

## 4. Rules

### 4.1 Time

- **Storage.** Instants are stored in UTC. Ranges are half-open (`[start, end)`), so back-to-back events never overlap.
- **Input.** An event time is either:
  - `{ at }`, an ISO instant with an explicit offset; or
  - `{ local, timeZone, disambiguation? }`, a wall-clock time in a named zone.
- **Resolving a local time** (`resolveWallTime` in `@business-os/contracts`, using Intl only):
  - A local time the zone skips, such as New York 2031-03-09 02:30, is refused with `nonexistent_local_time`.
  - A local time that happens twice, such as New York 2031-11-02 01:30, is refused with `ambiguous_local_time` unless `disambiguation` is `earlier` or `later`.
  - The UI asks the person which one they mean.
- **Time zones.** The API canonicalises zone names: `Asia/Calcutta` becomes `Asia/Kolkata`, and `utc` becomes `UTC`. An unknown zone is refused. A new calendar takes the business's zone by default.
- **Views.** Each view is computed in the calendar's zone, using the locale's first day of the week (Monday if unknown):
  - a day runs from local midnight to the next local midnight, so it can be 23, 23.5, 24 or 25 hours long;
  - a week is 7 local days;
  - a month view is 42 local days.
- **Limits:**
  - an event can last at most 31 days;
  - a list query can cover at most 62 days and returns at most 500 results per page;
  - the client follows at most 4 pages.
- **Tested zones and cases:** New York, Phoenix, Sydney, Lord Howe (30-minute daylight saving), Kolkata, Chatham, Kathmandu, London, a midnight daylight-saving gap in Santiago, and events that cross midnight or last several days.

### 4.2 Conflict semantics

These are the exact rules. Test names in `apps/api/tests/integration/scheduling.test.ts` match the bullet points.

- **Overlap.** Two events overlap when they are on the **same calendar** and `a.start < b.end AND b.start < a.end`. Touching ends never overlap.
- **Occupying events.** An event **occupies** time when it is `SCHEDULED`, not archived, and `blocksAvailability = true`. Only occupying events can be conflicts. Cancelled, archived and non-blocking events never are.
- **An enforced write** is any create or edit with `enforceConflicts` true, which is the default. It is refused with `409 scheduling_conflict` and the list of overlapping events, and nothing is written, if the result would occupy time that overlaps **any** occupying event on the target calendar.
  - **This includes events that were saved with enforcement off.** An enforced booking that meets an existing non-enforced overlap is refused. Enforcement belongs to each write, not to the stored event.
- **A non-enforced write** (`enforceConflicts: false`, the UI's "Keep the overlap") always succeeds. It returns the overlaps it created as `conflicts`, and the audit entry records `enforced: false, overlaps: n`.
- **Edits re-check** only when the result occupies time **and** an availability field changed: `calendarId`, `startAt`, `endAt` or `blocksAvailability`. A title-only edit of an event that already overlaps something succeeds without a check.
- **Cancel and archive** only free time, so they never conflict.
- **Reading** an event, or calling `GET /availability`, reports the current overlaps for information only.

### 4.3 Lock protocol (every availability-affecting mutation)

Every write that can change what a calendar's time looks like follows the steps below, in this order, inside **one** transaction (`withTenant`). That covers every create (enforced, non-enforced or non-blocking), every event edit (including a move between calendars), and every cancel and archive.

1. **Calendar rows `FOR SHARE`, sorted by id** (`lockCalendars`). Archiving or restoring a calendar `UPDATE`s its row, so it waits for event writes in progress on that calendar, and they wait for it. No event lands on a calendar that is being archived.
2. **One transaction advisory lock per calendar, in the same sorted order:** `pg_advisory_xact_lock(hashtextextended('scheduling.calendar:' || id, 0))`. A move between two calendars locks both. Ascending id order means two moves in opposite directions cannot deadlock.
3. **The event row `FOR UPDATE`** (edits, cancel and archive), with a version re-check. A concurrent change returns `409 stale` and is never overwritten.
4. **The conflict check, then the write.** Under READ COMMITTED each statement takes a new snapshot after the locks are granted, so the check sees every earlier writer's committed result. Both run in the same transaction, so **the check and the mutation are atomic**. The locks are released together at commit or rollback.

**Default calendar.** Every change to which calendar is the default takes a separate per-business lock, `hashtextextended('scheduling.default:' || business_id, 0)`, **before it touches any calendar row**. That covers initialising the default, creating any calendar, creating a calendar as the default, and making one the default.

- **Invariant (audit S1-01).** A business with any active calendar has exactly one default, and the default is active.
  - Under that lock, a calendar created while the business has no default is inserted straight into the default slot, in the same statement that creates it. This holds whether or not `POST calendars/default` was called, and when creates and initialisations race.
  - The unique `(business_id, default_slot)` index and the active-default CHECK back this up.
  - The default cannot be archived, and the API has no "un-default" call.
- **Ordering and staleness (audit S1-02).**
  - Lock order is always the default lock, then calendar rows. A detail edit without `isDefault` takes only its own row and never the default lock. So no cycle is possible.
  - Setting the new default re-checks the version the request was based on, so a stale "make default" fails with `409 stale` instead of winning over a concurrent edit.
  - Clearing the previous default bumps its version, so edits racing it from the old version are also `stale`.
  - The tests for both findings failed on the earlier code: a deadlock returned `retryable`, a stale request won, and concurrent creates left no default. They pass on the fix.

**Evidence (all on real PostgreSQL 16):**

- **Every mutation waits for the lock.** A test session holds a calendar's advisory lock. Each of the following is then shown to block, and to finish once the lock is released:
  - an enforced create, a non-enforced create and a non-blocking create;
  - a retime;
  - a move into the locked calendar;
  - a cancel and an archive.
  - Archiving a calendar is shown to wait for an event write that holds `FOR SHARE`.
- **Races:**
  - 12 concurrent enforced bookings for one slot: exactly 1 succeeds and 11 get `409`;
  - a non-enforced booking racing an enforced one: the outcome always matches the semantics in §4.2;
  - 6 concurrent reschedules into one slot: 1 succeeds;
  - a cancel racing a rebook of the freed slot;
  - opposite moves between two calendars, 8 rounds, with no deadlock;
  - 4 concurrent edits of one event: 1 succeeds and 3 are `stale`.
- **Mutation checks (run once, then reverted):**
  - removing the advisory lock makes 3 concurrency tests fail;
  - taking the locks unsorted makes the opposite-moves test fail with a deadlock (`503`).

## 5. Permissions

These are registry keys in `apps/api/src/modules/access/server/permissions.ts`.

| Key | Allows | OWNER | ADMIN | MANAGER | MEMBER |
|---|---|:-:|:-:|:-:|:-:|
| `scheduling:read` | Calendars, events, availability | ✓ | ✓ | ✓ | ✓ |
| `scheduling:create` | Create events; initialise the default calendar | ✓ | ✓ | ✓ | ✓ |
| `scheduling:update` | Edit and move events | ✓ | ✓ | ✓ | ✓ |
| `scheduling:cancel` | Cancel and archive events | ✓ | ✓ | ✓ | ✓ |
| `scheduling:manage_calendars` | Create, edit, archive and restore calendars; choose the default | ✓ | ✓ | ✓ | — |

Further rules:

- **Customer links.** Linking a customer also needs `customers:read`. The customer's name is shown only to people who hold `customers:read`.
- **Other businesses.** Any request for another business's calendar or event returns `404`, the same as an unknown slug. Composite foreign keys reject cross-tenant references even for the database owner.

## 6. API and UI

**Endpoints** (`packages/contracts/src/index.ts`, snapshot in `schema/api-v1.json`):

- **Calendars:**
  - `GET` and `POST` on `calendars`;
  - `POST calendars/default`, which is idempotent and returns `201` the first time and `200` after that;
  - `GET` and `PATCH` on `calendars/:id`;
  - `POST calendars/:id/archive` and `POST calendars/:id/restore`.
- **Events:**
  - `GET` and `POST` on `events`;
  - `GET` and `PATCH` on `events/:id`;
  - `POST events/:id/cancel` and `POST events/:id/archive`.
- **Availability:** `GET availability`.

**Errors:**

- `400` with a code: `invalid_input`, `invalid_interval`, `duration_too_long`, `nonexistent_local_time`, `ambiguous_local_time`, `invalid_range` or `range_too_long`;
- `409` with one of these codes: `scheduling_conflict`, `stale`, `archived`, `archived_reference`, `default_calendar` or `not_scheduled`;
- `403` and `404` as in the other Zones.

**Client and UI.** The client is `packages/app/src/api/scheduling.ts`. The Zone is `packages/app/src/zones/scheduling/`:

- `scheduling-zone.tsx` holds the shell, the toolbar and the overlays;
- `views.tsx` holds the day, week and month grids;
- `event-form.tsx` and `event-detail.tsx` hold the event dialogs;
- `calendar-math.ts` holds the view geometry and formatting;
- times are always shown in the calendar's zone;
- every control has a label, view buttons use `aria-pressed`, and the heading is a live region.

The UI ships no fake appointments.

## 7. Integration step (done in S3)

The Zone was built unregistered while People P1 was active. S3 (docs/scheduling-s3.md) registered it in the shell and removed the old integration patch, which no longer applied.

## 8. Shared files touched (minimal, additive)

| File | Change | People P1 / Finance F4 |
|---|---|---|
| `apps/api/prisma/schema/tenancy.prisma` | Two relation fields on `Business` (no DDL) | P1 (merged as #36) added fields to the same block. The rebase merged both. |
| `apps/api/prisma/schema/customers.prisma` | One relation field on `Customer` (no DDL) | None |
| `apps/api/src/core/db/app-client.ts` | Two `TENANT_MODELS` entries | P1 added entries next to them. The rebase merged both. |
| `apps/api/src/core/http/errors.ts` | `StateConflictCode` gains `default_calendar` and `not_scheduled` | P1 added codes next to them. The rebase merged both, and no names collide. |
| `apps/api/src/modules/access/server/permissions.ts` | A `scheduling` zone, `SCHEDULING_WORK`, and role entries | P1 added `people` next to it. The rebase merged both. The role sets are independent. |
| `packages/contracts/src/index.ts` | Exports, imports and 13 endpoints | P1 added its own. The rebase merged both, and the endpoint names are unique. |
| `packages/contracts/schema/api-v1.json` | Regenerated after the rebase | Regenerated, never hand-merged |

**Migration order.** `20261118050000_scheduling` sorts after P1's `20261118000000_people` and touches none of its tables.

**Finance F4.** No F4 branch was on the remote at the time of the rebase. S1 touches no finance file, table or migration. A later F4 rebase will see the same kind of additive neighbour edits in the five shared files above, and none in Finance's own files.

## 9. Known limitations

- **Calendars and privacy.** Calendars are business-wide. There are no private entries, and event text is visible to anyone with `scheduling:read` (§2).
- **Not built:** recurrence, reminders, resources, working hours and an all-day event type.
- **Conflict checks:**
  - they look only within one calendar, and the same customer double-booked on two calendars is not detected;
  - a check returns at most 50 overlaps.
- **Month view** shows three events per day, with the rest behind "+N more", which opens the day view.
- **Busy calendars.** The client stops after 4 pages of 500 events per view.
- **Calendar settings** have API support, but the UI only adds calendars. Editing, archiving and choosing the default are API-only for now.
- **Customer links** are supported by the API and shown in the event detail, but the event form has no customer picker yet.
- **Zone switched off.** The Zone is not reachable in the app until §7 is applied.
