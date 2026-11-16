# ADR 0006: Scheduling conflict prevention, time and privacy

- Status: **Superseded in part by [ADR 0008] (Accepted)(./0008-scheduling-ordered-lock-conflict-prevention.md)** (2026-11-16): §2 (exclusion constraint) and §3 (`btree_gist` privileged step) are replaced by globally ordered transaction locks. §1 (time) is implemented as written. §4–§7 (private details, busy-only visibility, escalation guards, trust model, erasure) remain **Proposed future requirements**: not built, not accepted. Originally Proposed (S0); architecture provisionally approved by ChatGPT on 2026-11-14 subject to this ADR.
- Date: 2026-11-14
- Related: [scheduling-data-model.md](../scheduling-data-model.md), ADR 0004 (database isolation design), [scheduling-s1.md](../scheduling-s1.md)

> **S1 note (2026-11-15).** This ADR stays Proposed. S1 was approved by Regan to build a smaller, calendar-centred core: per-calendar advisory locks instead of the exclusion constraint, no `btree_gist`, no private entries and no erasure path. [scheduling-s1.md §2](../scheduling-s1.md#2-differences-from-s0-adr-0006-compatibility) lists each difference and how S1 keeps resources, private details and erasure possible later. Nothing in S1 accepts or rejects a decision recorded here.

> **S2 note (2026-11-16).** S2 (PR #61) added resources and assignments with per-resource locks, without an exclusion constraint, because accepted overlaps (`enforceConflicts=false`) must remain possible. That contradicts §2 below and this ADR's "Alternatives considered", which reject per-resource locks as the primary guarantee. Regan (D-S2-5) and ChatGPT's PR #61 audit approved the lock approach, so [ADR 0008](./0008-scheduling-ordered-lock-conflict-prevention.md) now records the conflict-prevention decision: its guarantees, its limits, and the rule every future write path must follow. **Read §2–§3 below as the original S0 proposal, not as the current design.** ADR 0008 §6 lists what is implemented and what is still future.

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

### 2. Conflict prevention: exclusion constraint with database-maintained copies (variant A) — superseded by ADR 0008

- On `schedule_events`:
  - `during tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED`;
  - `occupying boolean GENERATED ALWAYS AS (blocks_time AND status <> 'CANCELLED') STORED`.
- `schedule_event_resources` carries copies of `during` and `occupying` (from the event) and of `exclusive` (from the resource). The copies are kept equal by composite FKs `ON UPDATE CASCADE` that target `UNIQUE (business_id, id, during, occupying)` on events and `UNIQUE (business_id, id, exclusive)` on resources.
- `EXCLUDE USING gist (business_id WITH =, resource_id WITH =, during WITH &&) WHERE (occupying AND exclusive AND role = 'REQUIRED' AND removed_at IS NULL)`.
- `bos_app` cannot update the copies (column grants) and cannot forge them on insert (the FK). Assignments are soft-removed (`removed_at`) and never deleted.
- Deletion: no scheduling table that records what happened grants DELETE. The single exception is `schedule_working_hours` (configuration).
- **Lock order (liveness).** Every write that can occupy time first takes a transaction advisory lock per resource, sorted by key: the PR #19 pattern, per resource instead of per project. Without it, conflicting concurrent writers wait on each other's uncommitted exclusion-index entries and can deadlock. In one observed local run, 19 of 20 concurrent reschedules got `40P01` and the last one ran into the unit-of-work timeout, so none succeeded and nobody double-booked. The lock is for progress only: the exclusion constraint remains the guarantee, and a write path that forgets the lock can fail, but cannot double-book.
- **Fallback (variant B, tested in S0):** `SECURITY INVOKER` triggers maintain the copies, with a column-level `UPDATE` grant guarded by a trigger that re-derives them. It is never `SECURITY DEFINER` (see consequence 3).

### 3. Extensions: privileged pre-migration step — superseded by ADR 0008 (no extension is installed)

`btree_gist` is installed by an administrative role **before** `prisma migrate deploy`, in a new `prisma/privileged/000_extensions.sql` and a matching CI/docker init step. The S1 migration keeps `CREATE EXTENSION IF NOT EXISTS btree_gist` as an assertion that the step ran. `bos_owner` is **not** given `CREATE` on the database.

### 4. Privacy — future requirement, not built

- Sensitive content (title, description, location, customer/contact/project/task links, cancel reason) lives in `schedule_event_details`, 1:1 with the event.
- A **restrictive** RLS policy on that table, ANDed with `tenant_isolation`, allows reads and writes only when `may_see_details()` holds: the entry is STANDARD, or the caller (`app.user_id`) is its organizer or an active member participant. There is no owner/admin override.
- The time row (`schedule_events`) stays visible to everyone with `schedule:read`, so conflicts and calendars work.

### 5. No escalation into private details — future requirement, not built

`SECURITY INVOKER` guards in the database (and the same rules in the service) allow a change that could **widen** who sees a private entry only to someone who can already see it:

- `PRIVATE → STANDARD`, or setting `organizer_user_id` to a different non-null user;
- adding a MEMBER resource (required or optional) to a private entry;
- a new entry naming anyone but its creator as organizer;
- re-pointing a member resource at another user (`user_id` may only become NULL, on archive);
- reviving a removed assignment.

Narrowing changes (STANDARD → PRIVATE, clearing the organizer, removing a participant) and time/status changes stay available to `schedule:manage`.

### 6. Trust model for transaction settings

- `app.business_id` and `app.user_id` are set by `withTenant` from a session the API verified. They are **not** authenticated by the database: any code running as `bos_app` can change them with `set_config`.
- They are therefore trusted only to **scope** queries: RLS, the privacy policy, audit authorship checks. In each case they back up application-layer checks, the same model as ADR 0004.
- They are **never authority for an irreversible or privileged operation.**
- The consequence is spelled out: busy-only privacy (§4) and the escalation guards (§5) protect against bugs and against requests that pass through the API. They do **not** protect against a compromised API process or arbitrary SQL running as `bos_app`, which could set `app.user_id` to an organizer's id and read that entry. This is the same boundary as tenant isolation itself. S1 narrows it further:
  - a boundary rule allows `set_config` and `current_setting` only in `core/db`, which `check-boundaries.mjs` already does for `businessId`;
  - `$queryRawUnsafe` and `$executeRawUnsafe` stay unreachable from services (ADR 0004 S3).

### 7. Privileged erasure: authority from a database-verified session — future requirement, not built

- Erasure is the only path that changes private details its caller cannot see. Its authority comes from the caller's **raw session token, verified in the database**, the same mechanism as the pre-tenant trusted paths (data-model §5.5, ADR 0004). `bos_app` cannot read `sessions`, so it cannot obtain or forge a token for someone else.
- The work is split across two functions:

| Function | Owner | Executable by | Does |
|---|---|---|---|
| `erasure_actor(token, business)` | `bos_definer` (already the role trusted to verify sessions) | `bos_maint` only | Returns the user id only if all of the following hold: the session's token hash matches, it is not expired and not revoked; the user is not deactivated and has a verified email; and the user's membership **in that business** is `ACTIVE` with role `OWNER` or `ADMIN`. `bos_definer`'s row policies repeat the expiry, revocation, deactivation and role conditions, so each check is enforced twice. |
| `scrub_event_details(token, subject, id)` | `bos_maint` | `bos_app` | Refuses unless `erasure_actor` returns a user **and** that user equals `app.user_id` (a mismatch means a tampered or confused context). Scrubs named columns in the **current** business only. Writes its own audit row as the verified user, so the API can neither skip it nor forge it (`bos_app` has no INSERT for that action). Returns a count, never content. Every failure is the same generic `42501`. |

- **Roles vs permission keys.** The database cannot read `ROLE_PERMISSIONS`, so `erasure_actor` names the roles that hold `customers:delete` today (OWNER, ADMIN), as `create_business` names OWNER. S1 adds a unit test that fails if the two lists drift. Custom roles (architecture §7.2) will need this function to read the role tables instead.
- **Residual assumptions:**
  1. A compromised API process can use the tokens of owners whose requests it is handling. The database bounds that to those owners' businesses and to the token's lifetime, and records each use in an audit row the process cannot suppress. A "recent sign-in" requirement for erasure (step-up) is a candidate for S1 (U9).
  2. The session-verification rules must stay identical to `app_private.session_user_id`. In S1 the helper is placed next to it in `privileged/` and covered by the trusted-path schema tests.
  3. The role list check above.
- Ordinary owner export returns private entries as busy-only. Legally authorised access is not a product feature (data-model §8).

## Evidence (S0)

The `tests/isolation/scheduling-spike.test.ts` suite (28 tests) passes:

| Environment | Result |
|---|---|
| PostgreSQL 16.10 (CI image) | 28/28; C6 and C7 (concurrency) 15/15 repeated runs |
| PostgreSQL 18.7 (local) | 28/28; C6 and C7 15/15 repeated runs; the whole isolation suite passes |
| Neon test branches (PG 18.7, `bos_app` through Neon's pooler, `btree_gist` 1.8 installed by `neondb_owner`) | First run 23/23. Audit re-run: the new erasure functions install under Neon's non-superuser owner role and A1–A6 pass; concurrency tests pass with the latency-tolerant invariant (scheduling-data-model.md §10). Both branches deleted afterwards. |

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
8. Failing to get a connection (`P2028` before the unit of work starts) is reported as a retryable `503`. Any failure after it starts is not. The API never retries a mutation itself (scheduling-data-model.md §10.2).
9. Neon verification branches are full production copies while schema-only branches are blocked. They follow the minimum-access, no-export, confirmed-deletion rules in scheduling-data-model.md §10.1.

## Alternatives considered

- **Advisory or row locks per resource:** correct only if every write path remembers to lock. Rejected as the primary guarantee.
- **Service-only privacy redaction:** one missed read path leaks. Rejected in favour of RLS plus service redaction.
- **An owner/admin override for private details:** defeats the purpose for staff personal time. Left out. A later override would be a permission passed into the unit of work, decided separately.
