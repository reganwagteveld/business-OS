# ADR 0006: Scheduling conflict prevention, time and privacy

- Status: **Proposed** (S0). Architecture provisionally approved by ChatGPT (final auditor) on 2026-11-14 subject to this ADR. Accepted only when Regan and ChatGPT approve; nothing in S1 starts before then.
- Date: 2026-11-14
- Related: [scheduling-data-model.md](../scheduling-data-model.md), ADR 0004 (database isolation design)

## Context

The Scheduling Zone stores appointments, jobs, reservations, internal events and time off for people, places and equipment. Two properties cannot be left to application code alone:

1. **No double-booking** of a person or resource, even under concurrent requests.
2. **Busy-only privacy.** Sensitive entries (for example a staff member's medical time off) show only as "Busy" to everyone except the people involved. That includes owners and managers.

Both must hold under the existing isolation design (ADR 0004): forced RLS, `bos_app` without `BYPASSRLS`, a transaction-mode pooler, and Prisma 7.10.1 with `@prisma/adapter-pg`.

## Decision

### 1. Time

- Instants are stored as `timestamptz` (UTC), together with the IANA zone the entry was made in.
- Repeating local times (working hours, and later recurrence) are stored as local `time` plus a zone and expanded on the server.
- Ranges are half-open (`[start, end)`), so back-to-back bookings never conflict.

### 2. Conflict prevention: exclusion constraint with database-maintained copies (variant A)

- On `schedule_events`:
  - `during tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED`;
  - `occupying boolean GENERATED ALWAYS AS (blocks_time AND status <> 'CANCELLED') STORED`.
- `schedule_event_resources` carries copies of `during` and `occupying` (from the event) and of `exclusive` (from the resource). The copies are kept equal by composite FKs `ON UPDATE CASCADE` that target `UNIQUE (business_id, id, during, occupying)` on events and `UNIQUE (business_id, id, exclusive)` on resources.
- `EXCLUDE USING gist (business_id WITH =, resource_id WITH =, during WITH &&) WHERE (occupying AND exclusive AND role = 'REQUIRED' AND removed_at IS NULL)`.
- `bos_app` cannot update the copies (column grants) and cannot forge them on insert (the FK). Assignments are soft-removed (`removed_at`) and never deleted.
- **Fallback (variant B, tested in S0):** `SECURITY INVOKER` triggers maintain the copies, with a column-level `UPDATE` grant guarded by a trigger that re-derives them. It is never `SECURITY DEFINER` (see consequence 3).

### 3. Extensions: privileged pre-migration step

`btree_gist` is installed by an administrative role **before** `prisma migrate deploy`, in a new `prisma/privileged/000_extensions.sql` and a matching CI/docker init step. The S1 migration keeps `CREATE EXTENSION IF NOT EXISTS btree_gist` as an assertion that the step ran. `bos_owner` is **not** given `CREATE` on the database.

### 4. Privacy

- Sensitive content (title, description, location, customer/contact/project/task links, cancel reason) lives in `schedule_event_details`, 1:1 with the event.
- A **restrictive** RLS policy on that table, ANDed with `tenant_isolation`, allows reads and writes only when `may_see_details()` holds: the entry is STANDARD, or the caller (`app.user_id`) is its organizer or an active member participant. There is no owner/admin override.
- The time row (`schedule_events`) stays visible to everyone with `schedule:read`, so conflicts and calendars work.

### 5. No escalation into private details

`SECURITY INVOKER` guards in the database (and the same rules in the service) allow a change that could **widen** who sees a private entry only to someone who can already see it:

- `PRIVATE → STANDARD`, or setting `organizer_user_id` to a different non-null user;
- adding a MEMBER resource (required or optional) to a private entry;
- a new entry naming anyone but its creator as organizer;
- re-pointing a member resource at another user (`user_id` may only become NULL, on archive);
- reviving a removed assignment.

Narrowing changes (STANDARD → PRIVATE, clearing the organizer, removing a participant) and time/status changes stay available to `schedule:manage`.

### 6. Privileged erasure

- Erasure is the only path that changes private details its caller cannot see. It goes through a `SECURITY DEFINER` function owned by `bos_maint`, with these limits:
  - fixed `search_path`;
  - tenant from `app.business_id` only, and a user context is required;
  - it scrubs named columns only and returns a count, never content;
  - its own tenant-limited policy for `bos_maint`;
  - executable only by `bos_app`.
- Ordinary owner export returns private entries as busy-only. Legally authorised access is not a product feature (data-model §8).

## Evidence (S0)

The `tests/isolation/scheduling-spike.test.ts` suite (23 tests) passes:

| Environment | Result |
|---|---|
| PostgreSQL 16.10 (CI image) | 23/23 |
| PostgreSQL 18.7 (local) | 23/23; the whole isolation suite 36/36 |
| Neon test branch (PG 18.7, `bos_app` through Neon's pooler, `btree_gist` 1.8 installed by `neondb_owner`) | 23/23 (details and two harness fixes in scheduling-data-model.md §10); branch deleted afterwards |

- Every guard, the restrictive policy, the `bos_maint` policy, the column grants and each term of the exclusion predicate were removed one at a time. Each removal made at least one test fail.
- Prisma `migrate diff --from-migrations … --to-schema … --exit-code` returns 0 on PG 16 and PG 18 for the S1-shaped schema, given these annotations:
  - `@default(dbgenerated(...))` for the generated columns;
  - `Unsupported("tstzrange")` for the ranges;
  - GiST `ops: raw("gist_uuid_ops")`.

## Consequences

1. Assignments are inserted with raw SQL that selects the copies from their sources. Prisma generates no `create` for that model (type-level, checked by `tsc`) and drops relations over `Unsupported` columns from the client, so assignments are read with a second query.
2. Conflicts surface as SQLSTATE `23P01` and are mapped to `409 resource_conflict`. When a conflict is raised through the FK cascade, PostgreSQL's error detail includes the other entry's resource id and time range, because referential actions run as the table owner. Details are never returned or logged.
3. **A `SECURITY DEFINER` function owned by a role without a matching policy matches 0 rows under FORCE RLS and fails silently.** Every definer function needs an explicit policy for its owner and a test that it really changes rows.
4. Changing a definer function's owner needs `CREATE` on its schema for the new owner (found on Neon; a superuser skips the check). It is granted only for the change, as `privileged/001` already does for `bos_definer`.
5. The schema guard must accept named restrictive policies next to `tenant_isolation`, GiST indexes and exclusion constraints that lead with `business_id`.
6. Generated columns are not published by logical replication before PG 18. This only matters for the future CDC path (architecture §13.4).
7. A Prisma, adapter, pooler or PostgreSQL upgrade re-runs this suite, as for ADR 0004.

## Alternatives considered

- **Advisory or row locks per resource:** correct only if every write path remembers to lock. Rejected as the primary guarantee.
- **Service-only privacy redaction:** one missed read path leaks. Rejected in favour of RLS plus service redaction.
- **An owner/admin override for private details:** defeats the purpose for staff personal time. Left out. A later override would be a permission passed into the unit of work, decided separately.
