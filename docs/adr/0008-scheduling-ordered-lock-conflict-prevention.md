# ADR 0008: Scheduling conflict prevention by globally ordered transaction locks

- Status: **Proposed**, approved in substance. Regan approved this approach as D-S2-5 on 2026-11-16, and ChatGPT's audit of PR #61 (2026-11-16, commit `6b6eefb`) approved it. It becomes **Accepted** when PR #61 merges with Regan's approval.
- Date: 2026-11-16
- Supersedes: [ADR 0006](./0006-scheduling-conflicts-and-privacy.md) **§2** (conflict prevention by exclusion constraint) and **§3** (`btree_gist` privileged step). ADR 0006 §1 (time) is implemented as written. ADR 0006 §4–§7 (privacy, escalation guards, trust model for private details, erasure) are **not** superseded and **not** accepted: they stay future requirements (§6 below).
- Related: [scheduling-s1.md §4.3](../scheduling-s1.md), [scheduling-s2.md §5](../scheduling-s2.md#5-lock-protocol-extends-s1-43), ADR 0004 (database isolation design).

## Context

ADR 0006 proposed making double-booking impossible in the database. A `btree_gist` exclusion constraint would sit over resource assignments, with database-maintained copies of each event's time range. Per-resource advisory locks would only help progress, never act as the guarantee.

S1 (PR #38) and S2 (PR #61) were approved with a different requirement: **an overlap must be acceptable on purpose.** A write with `enforceConflicts=false` must be able to commit even though it overlaps. An exclusion constraint cannot express "refuse unless this write says it accepts the overlap". It would forbid every overlap, including ones the business wants, such as double-staffing a room for a handover. Regan also asked for no PostgreSQL extension without explicit justification.

The protection therefore lives in the service's transactions. This ADR records exactly what that protection is, what it guarantees, where it is weaker than ADR 0006 §2, and what every future write path must do.

## Options considered

1. **Exclusion constraint with database-maintained copies (ADR 0006 §2, variant A).** The strongest guarantee: no write path can double-book, even a buggy one or ad-hoc SQL as `bos_app`. But it cannot allow accepted overlaps. It also needs `btree_gist` (a privileged step) and generated-column copies kept in step by FK cascades. Rejected for S1/S2 because of the accepted-overlap requirement.
2. **Exclusion constraint on a separate "hard booking" table, used only for enforced writes.** This keeps the database guarantee for enforced bookings. But a hard booking must still not land on top of an existing accepted overlap: S1 requires that an enforced write conflicts with *any* blocking event, including non-enforced ones. That would need copies of all blocking intervals, and the same extension. Deferred, not rejected (§6).
3. **SERIALIZABLE isolation for scheduling writes.** No locks to order, but every conflicting write fails with `40001` and must be retried. The API never retries mutations itself (scheduling-data-model.md §10.2). Rejected.
4. **Globally ordered row and advisory locks in one transaction (chosen).** No extension and no privileged step, and accepted overlaps are allowed. Correctness depends on every write path taking the locks.

## Decision

### 1. Lock protocol

Every mutation that can change what occupies time runs in **one** transaction, at READ COMMITTED, through `withTenant`. It acquires locks in this global order, sorted by id within each step:

| Step | Lock | Helper |
|---|---|---|
| 0 | Per-business default-calendar advisory lock (calendar create and default changes only) | `lockDefaultChoice` |
| 1 | Calendar rows `FOR SHARE` | `lockCalendars` |
| 2 | Calendar advisory locks `hashtextextended('scheduling.calendar:' \|\| id, 0)` | `lockCalendars` |
| 3 | Resource rows `FOR SHARE`: every resource assigned before ∪ after | `lockResources` |
| 4 | Resource advisory locks `hashtextextended('scheduling.resource:' \|\| id, 0)` | `lockResources` |
| 5 | Event row `FOR UPDATE`, with the optimistic version re-checked | `lockEvent` |
| 6 | Calendar conflict check, resource conflict check, then the writes (event, assignments, audit) | `findConflicts`, `findResourceConflicts` |

All locks are transaction-scoped (`pg_advisory_xact_lock`). They release at commit or rollback, so they work behind the transaction-mode pooler.

Who takes what is listed in scheduling-s2.md §5. In short:

- Create, edit (including retime, calendar move and resource change), cancel and archive of an event take steps 1–6 for the calendars and resources they touch, before and after.
- Lifecycle changes to a calendar or resource `UPDATE` exactly one row. That update waits for any booking holding the row `FOR SHARE`.
- Assignments change only through event writes that bump the event version. So a version match at step 5 proves that the assignment set read before step 1 is still current.

### 2. Conflict semantics

- Intervals are half-open `[start, end)`: back-to-back bookings never conflict.
- An event **occupies** its calendar and its live assigned resources when it is `SCHEDULED`, not archived, and `blocks_availability`.
- Every resource has capacity 1.
- An enforced write is refused (409, `blocking: true`) if any occupying event overlaps on the same calendar or the same resource, including events that were written without enforcement.
- `enforceConflicts=false` is the single override for both kinds. The write commits and an `overlap_accepted` audit row records the counts and ids.

## Guarantees

For writes that go through the Scheduling service (`apps/api/src/modules/scheduling/server`):

1. **No unaccepted double-booking.** An enforced write never commits while another committed, occupying event overlaps it on a shared calendar or a shared live resource. Writers that touch a calendar or resource serialise on its advisory lock. The conflict check runs after the lock is held, in a fresh READ COMMITTED statement snapshot, so it sees every earlier commit.
2. **All or nothing.** A multi-resource booking either writes the event and all its assignments, or writes nothing.
3. **No lock-order deadlocks between scheduling writes.** Every path acquires locks in the same global order, sorted within each step. No path takes a calendar lock after a resource lock, or a resource lock after the event row. Lifecycle updates hold a single row lock and wait for nothing else.
4. **Lifecycle races are serialised.** Archiving or inactivating a resource, and assigning it, cannot interleave: whichever runs second sees the other. The same holds for calendar archive and booking (S1).
5. **History is never lost.** There is no DELETE grant. Assignments are soft-removed through a column-level UPDATE grant on the two removal columns only. A partial unique index allows one live assignment per event and resource.

Evidence: 14 concurrency tests in `apps/api/tests/integration/scheduling-resources.test.ts` and the S1 suite run real competing transactions against PostgreSQL. Removing the resource lock fails 6 of them. Taking the locks unsorted produces real deadlocks and fails 3. Details are in scheduling-s2.md §12.

## Limitations

1. **The guarantee lives in application code, not in a database constraint.** Any code that writes `scheduling_events` or `scheduling_event_resources` without the protocol can double-book. Nothing in the database stops it. ADR 0006 §2 would have stopped it.
2. **Code running as `bos_app` is trusted to follow the protocol.** A compromised API process or ad-hoc SQL as `bos_app` can write overlapping bookings. Tenant isolation (forced RLS, composite FKs) still holds. This is the same trust boundary as ADR 0004.
3. **Advisory-lock keys are 64-bit hashes.** A collision only makes two unrelated calendars or resources wait for each other. It never breaks correctness.
4. **Locks are held until commit.** A slow transaction delays other bookings of the same calendar or resource. Units of work keep their existing timeouts, and the API never retries a failed mutation itself.
5. **Every resource has capacity 1.** There are no pooled resources, working hours or resource time off.

## Risk: future write paths that bypass the protocol

This is the main cost of the decision. Today only `events.ts` writes events and assignments, and `resources.ts` writes resource rows. No other module references the scheduling tables (checked 2026-11-16). Every write calls the shared helpers in `shared.ts`. Likely future writers include:

- recurring-event expansion;
- bulk import;
- external calendar sync;
- People P3 leave and time off creating blocking events;
- an erasure path;
- a data repair script or backfill;
- moving events when a calendar or resource is merged.

**Rule for every new write path.** Any code that inserts or updates an event's time, status, `blocks_availability`, calendar or assignments must:

1. run inside one `withTenant` transaction;
2. call `lockCalendars` and then `lockResources` for every calendar and resource it touches, before and after the change, before touching any event row;
3. lock and version-check the event row (`lockEvent`) for an existing event;
4. run both conflict checks after the locks, and honour `enforceConflicts`;
5. bump the event version whenever assignments change;
6. add a test to the "every mutation waits for the resource lock" group.

Batch writers must lock the union of their calendars and resources in one sorted call, not one event at a time.

**A one-off SQL fix or backfill must not create or move occupying events.** If one must, it takes the same advisory locks in the same order, or runs while scheduling writes are paused.

**Mitigations today:** a single module owns all writes; shared helpers; a test that every resource-touching mutation waits on the resource lock; an order-probe test; mutation checks that show the tests fail when the protocol is broken. **Recommended follow-up (not built):** an architecture test in `tests/architecture` that fails if any file outside `modules/scheduling/server` references `schedulingEvent` or `schedulingEventResource` writes. This would turn the first rule into a CI check.

## 6. What is implemented and what is future

| Capability | Status | Where |
|---|---|---|
| Time: `timestamptz` plus IANA zone, half-open ranges, daylight-saving handling (ADR 0006 §1) | **Implemented** (S1) | scheduling-s1.md |
| Calendars, events, per-write `enforceConflicts`, calendar conflict locking | **Implemented** (S1) | scheduling-s1.md §4.3 |
| Resources (PERSON, ROOM, EQUIPMENT, OTHER), lifecycle, assignments with soft removal | **Implemented** (S2, PR #61) | scheduling-s2.md |
| Resource conflicts, structured calendar and resource conflicts, one override, availability query | **Implemented** (S2) | scheduling-s2.md §4 |
| Globally ordered calendar and resource locks (this ADR) | **Implemented** (S1 + S2) | §1 above |
| `scheduling:manage_resources` permission; audit without event text or names | **Implemented** (S2) | scheduling-s2.md §7–§8 |
| **Private events** (sensitive text in a separate details table behind a restrictive RLS policy) | **Future**, not built. Today title, notes, location and customer are on the event row, visible to every `scheduling:read` holder. | ADR 0006 §4 |
| **Busy-only visibility** (others see only "Busy") | **Future**, not built. Conflicts and lists show event titles to every reader. | ADR 0006 §4 |
| Escalation guards on private entries | **Future**, not built | ADR 0006 §5 |
| Privileged erasure with database-verified authority | **Future**, not built. No event text is copied outside the event row (the audit stores ids only), so erasure can stay one-row. | ADR 0006 §7 |
| **Database-enforced exclusion constraint** (`btree_gist`) | **Future option**, not built. No extension is installed. It could be added later for a hard-booking table (Option 2) whose writers still take these locks first. | ADR 0006 §2–§3 |
| PERSON resource linked to a People employee | **Future**, owned by People | scheduling-s2.md §9 |
| Capacity > 1, working hours, resource time off, recurrence | **Future** | — |
| Scheduling Zone in navigation | **Not switched on**. Patch kept in `docs/scheduling-s1-integration.patch`. | scheduling-s1.md §7 |

## Consequences

- No extension and no privileged migration step. Migrations stay additive and run as `bos_owner`.
- Accepted overlaps remain possible and audited.
- Every new write path carries a review obligation (the rule above). Reviews of scheduling PRs must check it.
- **Revisit this ADR** when any of these happens:
  - a write path outside `modules/scheduling/server` is proposed;
  - private events or erasure are built (ADR 0006 §4–§7 then needs its own acceptance);
  - a hard-booking guarantee must hold against code running as `bos_app`;
  - capacity > 1 is needed;
  - a Prisma, adapter, pooler or PostgreSQL upgrade changes lock or isolation behaviour (re-run the concurrency suites).
