# Scheduling Zone data model (S0, proposed)

> Status: **Proposed for final architectural review** (S0). Nothing here is built. No migration exists, and S1 starts only after Regan and ChatGPT approve this document and [ADR 0006](./adr/0006-scheduling-conflicts-and-privacy.md).
> It follows [data-model.md](./data-model.md), [sales-data-model.md](./sales-data-model.md) and [projects-data-model.md](./projects-data-model.md): same tenancy, RLS, composite FKs, permission keys, audit and migration conventions.
> Evidence: `apps/api/tests/isolation/scheduling-spike.test.ts` with its fixture `tests/isolation/fixtures/scheduling-spike-schema.sql`, which is the exact shape S1 must migrate.

## 1. Principles

- **Industry independent core.** Five general kinds of entry and three kinds of resource. Industry vocabulary and workflows (online booking, dispatch, capacity reservations, classes, rostering) are optional modules that own their own tables and depend on `scheduling`, never the other way round.
- **One business data model.** Entries link to the Customer Zone's own customers and contacts and the Projects Zone's own projects and tasks. Nothing is copied.
- **Double-booking is impossible, not unlikely.** A database exclusion constraint holds under any concurrency (ADR 0006 §2).
- **Privacy is enforced by the database.** A private entry is "Busy" to everyone except its organizer and the members on it (§4).
- **History is kept.** Tenant code has no DELETE on any scheduling table that records what happened: entries are cancelled (reversible), assignments are soft-removed, and resources are archived.
  - **The one exception is `schedule_working_hours`.** It holds configuration (a resource's weekly hours), not history. Replacing a week deletes and re-inserts that resource's rows in one unit of work, and the change is audited with the before and after rule sets. No other scheduling table grants DELETE (§3).
- **Assignments are not permissions**, with one narrow, explicit exception: an organizer or participant may **see** that one entry's details (§4).

## 2. Tables

All of them have:
- `business_id` with `UNIQUE (business_id, id)`;
- indexes leading with `business_id`;
- forced RLS with the standard `tenant_isolation` policy;
- authorship and timestamps, as in Projects. These are left out of the fixture.

### 2.1 `schedule_resources`

| Column | Notes |
|---|---|
| `kind` | `MEMBER`, `PLACE`, `EQUIPMENT` |
| `user_id` | FK `(business_id, user_id) → memberships`. Non-MEMBER ⇒ NULL. MEMBER ⇒ NOT NULL unless archived. Partial unique per user. **Can never be re-pointed at another user** (guard). It may only become NULL on archive. |
| `name` | 1–100. For members, a fallback label after they leave. |
| `time_zone` | IANA, nullable (NULL = business zone). For working hours. |
| `exclusive` | Default true; the MVP accepts only true. False is reserved for capacity modules (§7). `UNIQUE (business_id, id, exclusive)` is the copy-FK target. |
| `bookable`, `color`, `version`, `archived_at` | |

### 2.2 `schedule_events` (the time row: visible to everyone with `schedule:read`)

| Column | Notes |
|---|---|
| `kind` | `APPOINTMENT`, `JOB`, `RESERVATION`, `INTERNAL`, `TIME_OFF`. Redacted by the service for busy-only viewers. |
| `status` | `TENTATIVE`, `CONFIRMED`, `COMPLETED`, `CANCELLED`, `NO_SHOW`. Changed only by transition endpoints. |
| `visibility` | `STANDARD` (default) or `PRIVATE`. `TIME_OFF` defaults to `PRIVATE`. |
| `organizer_user_id` | FK to memberships. **Must be the creator on insert** (guard). |
| `starts_at`, `ends_at`, `time_zone`, `all_day`, `start_date`, `end_date`, `blocks_time` | UTC instants plus IANA zone. Duration ≤ 31 days. |
| `during`, `occupying` | Generated, stored, read-only (ADR 0006 §2) |
| `ical_uid`, `version` | |

Indexes: `UNIQUE (business_id, id, during, occupying)`, GiST `(business_id, during)`, `(business_id, starts_at, id)`.

### 2.3 `schedule_event_details` (1:1; behind the restrictive `private_details` policy)

`title` (1–200), `description` (≤ 5000), `location` (≤ 500), `customer_id`, `contact_id`, `project_id`, `project_task_id`, `cancel_reason` (≤ 500).

- All links are composite FKs.
- The task FK is `(business_id, project_id, project_task_id) → project_tasks(business_id, project_id, id)`, which needs an additive unique index on `project_tasks` in S1.
- The links are here, not on the time row, because *who* a private appointment is with is itself private.

### 2.4 `schedule_event_resources` (assignments)

| Column | Notes |
|---|---|
| `event_id`, `resource_id`, `role` (`REQUIRED`/`OPTIONAL`) | |
| `during`, `occupying`, `exclusive` | Copies kept by composite FKs `ON UPDATE CASCADE`. Never writable by `bos_app`. |
| `removed_at`, `removed_by_id`, `removal_reason` (`EDITED`, `DECLINED`, `MEMBER_REMOVED`, `REASSIGNED`) | Soft removal, one way only (guard). The only columns `bos_app` may update. |

- Partial unique `(business_id, event_id, resource_id) WHERE removed_at IS NULL`.
- `schedule_no_double_booking` exclusion constraint (ADR 0006 §2).
- Rows are inserted only by raw SQL that selects the copies from their sources.

### 2.5 `schedule_working_hours`

Weekday, local `start_time`/`end_time`, effective dates. Expanded in the resource's zone. Produces soft warnings only. This is the **only scheduling table with DELETE** (§1): rows are configuration, a week is replaced as a whole, and the audit entry keeps the previous rules.

## 3. Grants

| Table | `bos_app` |
|---|---|
| `schedule_resources`, `schedule_events`, `schedule_event_details` | SELECT, INSERT, UPDATE |
| `schedule_event_resources` | SELECT, INSERT, UPDATE (`removed_at`, `removed_by_id`, `removal_reason`) |
| `schedule_working_hours` | SELECT, INSERT, UPDATE, DELETE (the configuration exception in §1) |
| Anything | No other runtime role gets anything, except `bos_maint` on details for erasure (§8) |

## 4. Privacy

| Viewer | STANDARD | PRIVATE |
|---|---|---|
| Organizer, or a member assigned (not removed) | Everything | Everything |
| Anyone else with `schedule:read`, owners and admins included | Everything | **Busy only:** time, all-day, zone, non-cancelled status, resource ids |
| Other businesses, or no user context | Nothing | Nothing |

- Enforced in two layers: the service redacts (`busy: true`, details `null`), and the restrictive `private_details` RLS policy applies to reads **and** writes.
- Every reader (customer tab, project tab, Home, search, conflict panels) goes through it.
- Private entries write no customer/contact activity entries, and their audit entries carry event and resource ids only.

## 5. RBAC and the escalation boundary

| Key | OWNER | ADMIN | MANAGER | MEMBER | Covers |
|---|:-:|:-:|:-:|:-:|---|
| `schedule:read` | ✓ | ✓ | ✓ | ✓ | See the schedule (subject to §4), resources, hours, free/busy |
| `schedule:write` | ✓ | ✓ | ✓ | ✓ | **Create** entries with any bookable resources, colleagues included. **Change entries you organize.** Decline (remove yourself). |
| `schedule:manage` | ✓ | ✓ | ✓ | | **Change anyone's entries** (time, status, resources, organizer) and configure resources and working hours |

- Service rule: `authorize(ctx, 'schedule:write')`. Then, if the caller is not the organizer, `authorize(ctx, 'schedule:manage', { zone: 'schedule', type: 'event', id })`. No role checks.
- `schedule:manage` **never** gives sight of private details. The database refuses every change that would widen who can see a private entry unless the caller can already see it. Tests E1–E7 cover each case:

| Indirect route | Blocked by |
|---|---|
| Make it STANDARD | `guard_event_privacy` (E1) |
| Transfer organizer to self or anyone | `guard_event_privacy` (E2) |
| Create an entry "organized" by someone else | `guard_event_privacy` on insert (E3) |
| Add self or another member as participant (required or optional) | `guard_assignment_privacy` (E4) |
| Re-point a member resource at self | `guard_resource_user` (E5) |
| Revive a removed participant | `guard_assignment_privacy` (E6) |
| Write or plant details | Restrictive policy `WITH CHECK` (P1) |
| Change the copies, role or resource of an assignment | Column grants (W2) |
| Read through erasure | The function returns a count only (R1) |
| Read through owner export | Export runs under RLS (§8) |
| Read through a conflict error | Details never forwarded; the data is busy-time only (ADR 0006 consequence 2) |

- Still allowed for `schedule:manage` on a private entry: reschedule, change status, cancel without a reason, add places and equipment, remove participants, clear the organizer (E7).
- Allowed to people who can see it: everything `schedule:write` gives the organizer, including handing the organizer role on, after which the new organizer can see it (E2).

## 6. Member removal, history and reassignment

**Member removal.** Tenancy locks the membership `FOR UPDATE`, as today, then calls `scheduling.detachMember` in the same unit of work. It does the following (tested in R2):

1. Soft-removes the member's assignments on future, non-cancelled entries (`MEMBER_REMOVED`) and bumps the versions.
2. Keeps in-progress and past assignments as history.
3. Clears `organizer_user_id` on their entries.
4. Archives their resource with `user_id = NULL`.

After that, deleting the membership succeeds (it is blocked with `23503` before). A re-invited person gets a new resource.

**History.**
- Assignments are never deleted. Removal is one-way.
- Cancel keeps the assignments; they just stop occupying.
- Reopen re-occupies them and re-checks conflicts (C5).
- A soft-removed assignment frees the slot (C8).
- The audit log records each add and remove by id.

**Reassignment.**
- Single entry: replace the set with the entry `version`. Old rows become `REASSIGNED`, then new rows are inserted, and the constraint re-checks.
- Bulk (S2): `schedule:manage`, dry run first, then all-or-nothing, at most 200 entries.
- Reassigning *members* on a private entry needs sight of it (§5). A manager who cannot see it cancels it and asks the person to rebook.

## 7. RESERVATION and capacity modules

The core is exclusive (capacity 1). A capacity module works like this:
1. It sets `exclusive = false` on its resources. The cascade lifts the exclusion for their assignments (R3).
2. It owns `reservation_capacity` and `reservation_details` (party size and so on), with composite FKs.
3. It enforces capacity by counting after `SELECT … FOR UPDATE` on the resource.
4. Making a resource exclusive again is refused while overlaps exist (R3).

No core table or constraint changes.

## 8. Erasure, export and legally authorised access

| Path | Who | Sees private details? | Mechanism |
|---|---|---|---|
| **Ordinary owner export** (Phase 1e "export all business data") | OWNER, as `bos_app` with their user id | **No.** Private entries are exported busy-only (time, resources, "Private"), except the owner's own entries. | Normal RLS. Audited `export.created`. |
| **Personal export** (later): a person exports their own schedule | Any member | Only entries they organize or attend | Normal RLS |
| **Privileged erasure** (contact, customer or departed member) | The erasure service, after its own permission check (`customers:delete` today: OWNER/ADMIN) | **Never reads.** It scrubs title, description, location and cancel reason, and unlinks the subject. | `scheduling_private.scrub_event_details()`: `SECURITY DEFINER`, owned by `bos_maint`, fixed `search_path`, current tenant only, user context required, returns a count. Has a `bos_maint` tenant policy (without it, it silently scrubs 0 rows; mutation-tested). Audited with the count only. |
| **Legally authorised access** (court order, regulator, a disclosure that must include a private entry) | **No tenant role, ever** | Only under the platform procedure | Not a product feature. Business OS staff verify the legal basis (not the tenant). Two-person approval. A time-limited break-glass administrative session on an isolated Neon branch. Recorded in the platform audit log. The tenant owner is told unless the law forbids it. Needs its own policy document before the first request (open choice U4). |

## 9. Time zones

Unchanged from the proposal:
- instants in UTC plus the IANA zone;
- local rules expanded on the server with Luxon behind `core/time`;
- DST gaps shift forward and ambiguous times take the earlier offset (RFC 5545);
- the S2 test matrix covers New York, Los Angeles, London, Sydney, Lord Howe, Kolkata, Chatham and Phoenix.

## 10. S0 evidence

| Check | PG 16.10 (CI image, local) | PG 18.7 (local) | Neon test branch (PG 18.7, `bos_app` via Neon's pooler) |
|---|---|---|---|
| Scheduling spike suite (23 tests) | 23/23 | 23/23 | 23/23: 22 in one full run; C7 (40 sequential setup bookings) exceeded the default 30 s test timeout over the network and passed alone with a 180 s timeout |
| Whole isolation suite (Phase 1b S1–S13 + scheduling) | — | 36/36 (direct; CI adds PgBouncer) | not run (Phase 1b fixture drops `public` tables, not appropriate on a production copy) |
| `prisma migrate diff --exit-code` (main migrations + S1-shaped scheduling migration) | 0 | 0 | not run (needs a shadow database) |
| `btree_gist` | 1.7 | 1.8 | 1.8 available. **Installed by `neondb_owner` (privileged step).** `bos_owner`: permission denied (as designed). |
| Mutation check (each guard, policy, grant and predicate term removed in turn) | every removal fails at least one test | — | — |

**Neon-specific findings:**
1. A function owner change needs `CREATE` on the schema for the new owner. A superuser skips that check, so it only showed up on Neon. The fixture now grants it for the change, as privileged/001 does.
2. Schema-only branches are refused for this project ("legacy web access role": `bos_definer`), so verification branches copy production data. They are handled under §10.1.
3. On the first Neon runs, tests failed with Prisma `P2028` ("unable to start a transaction in the given time"). Opening a cold TLS connection to Neon's pooler can take longer than Prisma's 2 s interactive-transaction `maxWait`, so 50 simultaneous units of work gave up *while waiting for a connection, before any statement ran*. That is a connection-acquisition limit, not a correctness failure: no wrong booking was ever accepted. The suite now opens its pool first, after which C6 (50 concurrent bookings, exactly one wins) passed on Neon in 2.7 s. The same latency can hit production after idle periods, so S1 handles it as in §10.2.

### 10.1 Test copies of production data

Until schema-only branches work (U7), every Neon verification branch is a copy of production and is treated as production data:

- **Minimum access.** Only the roles a check needs:
  - the owner role, for the privileged extension step and the fixture, which writes only to its own `scheduling_spike*` schemas;
  - `bos_app` through the pooler, for the tests.

  No query reads tenant tables. The only reads outside the fixture are catalog and role checks (version, extension availability, role membership, privileges).
- **No exports.** No `pg_dump`, no row copies, and no test output containing row data. Connection strings are fetched into environment variables for the run and never printed, logged or saved, and the helper that built them is deleted afterwards. Neither the Phase 1b isolation suite (it rebuilds `public` tables) nor anything else that touches existing tables runs on such a branch.
- **Short-lived, with deletion confirmed.** The branch is created with an expiry of at most 24 hours and deleted as soon as the run ends. Deletion is then confirmed by listing the project's branches.
- **Record of the S0 run.** Branch `s0-scheduling-spike` (`br-patient-thunder-bb52udkz`) was created from `production` at 12:52 UTC on 2026-11-14 with a 24 h expiry, deleted at about 12:57 UTC the same day, and confirmed absent from the branch list. The remaining branches are `production` and the three earlier pre-migration branches, which are also production copies, outside this work.

### 10.2 Connection acquisition vs transaction failures (rule for S1)

`P2028` covers more than one situation, so the API must tell them apart:

| Failure | How S1 recognises it | Response | Retry |
|---|---|---|---|
| **No connection was acquired; the unit of work never started** | `withTenant` sets a flag on the first line inside the transaction callback. A failure with the flag unset proves no statement ran, so nothing could have committed. | `503 service_unavailable` with `Retry-After` and `retryable: true` | The **client** may resubmit. The API never re-executes a mutation by itself. |
| **The transaction started and then failed** (timeout inside the unit of work, connection lost mid-way, commit outcome unknown) | Flag set | `500` (or the mapped `409`/`400` for known database errors). **Not** marked retryable. | Never automatic. The client re-reads, and the user decides. |
| Read-only requests (GET) | Any of the above | As above | The client may retry reads freely |

- **No automatic retries of mutations anywhere in the API.** A resubmitted booking is a new request.
- For exclusive resources, the exclusion constraint stops a resubmission from double-booking: the second attempt gets `409 resource_conflict`. Entries with no exclusive resource (unassigned jobs, non-blocking entries) could still be created twice. So S1 adds an optional `Idempotency-Key` on `POST /schedule/events`, stored with a business-scoped unique index, which returns the first result for a repeated key (open choice U8).
- Pool size (`max: 5` today) and `maxWait` are measured in S1 before any change (U6).

## 11. Reconciliation with PR #19

- Checked against `main` at `1b27d17` and PR #19 head `a9157b3` (open, CI green). #19 changes no tables.
- Its project-wide task ordering takes the project `FOR SHARE`, then a transaction advisory lock. Scheduling takes only `FOR SHARE` on a project when linking, so the lock order is compatible.
- Tasks never change project, so the 3-column task FK holds.
- **Repeat this check on the merged `main` immediately before S0 is opened as a PR.**

## 12. Open choices for final review

| # | Choice | Recommendation |
|---|---|---|
| U1 | May `schedule:manage` clear the organizer of a private entry? It narrows access, but locks the organizer out of their own entry. | The DB allows it (member removal needs it); the **service allows it only in `detachMember`** |
| U2 | Reassigning members on a private entry needs sight of it | Accept. Managers cancel, and the person rebooks. |
| U3 | Permission for erasure | Keep Phase 1e's `customers:delete` (OWNER, ADMIN) for contact/customer erasure; the same for departed-member scrubbing |
| U4 | Legally authorised access | Platform-operated break-glass only, with a written procedure before first use. No tenant feature. |
| U5 | Owner export of the owner's *own* private entries | Included (RLS already allows it) |
| U6 | Connection pool and `maxWait` for bursty booking | `503 retryable` only when the unit of work provably never started (§10.2). Never auto-retry mutations. Measure in S1 before changing the pool (today `max: 5`). |
| U7 | Schema-only Neon branches are blocked by the legacy role | Accept full-copy test branches under §10.1 for now. Migrating the role is a separate change with its own approval. |
| U8 | Idempotency for creating entries | Optional `Idempotency-Key` on `POST /schedule/events` (business-scoped, unique), in S1 |
