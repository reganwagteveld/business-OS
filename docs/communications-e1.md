# Communications E1: data retention, privacy and erasure foundation

Status: implemented on branch `claude/project-thread-du5otb`, **draft for independent audit**. Not merged,
not migrated, not deployed, not activated.
Migration: `20261201000000_communications_erasure` (additive). Privileged SQL:
`apps/api/prisma/privileged/004_communications_erasure.sql`.

E1 is the retention and erasure foundation that must exist before any real Gmail or Microsoft 365 mail is
stored. The sequence approved on 2026-11-15 is: C2-B1, then **E1**, then C2-B2, C2-B3 and C2-B4.

E1 does not sync mail, connect a mailbox, or enable any scheduled job. It does not guarantee compliance with
any particular law. It provides the mechanisms: retention by category, legal holds, authorised erasure, a
ledger and replay. The legal durations and policies that drive those mechanisms are owner decisions, listed
in §13.

---

## 1. What E1 delivers

- **Retention by category, per message copy** (T-C2-3, D-C2-9).
  - Every copy is one of `PERSONAL_UNSHARED`, `ORDINARY`, `RETAINED_RECORD` or `STAGED_INTAKE`.
  - C1's manual and imported history has no category (`NULL`).
  - The database computes when each copy expires.
  - When the ordinary period is **shortened**, the new period starts applying only after 30 days (D-E1-3).
- **Erasure in place (tombstones).** Content, provider ids and the identity of participants are removed.
  Ids, dates, direction and thread structure stay. Nothing is orphaned, and history still reads consistently.
- **Erasure requests** for one message, one conversation, or everything about one contact (D-E1-6).
  - The caller must be an OWNER or ADMIN, and the database itself checks this.
  - Each request also needs a single-use code that is valid for 5 minutes and only for that operation (D-E1-4).
- **Legal holds** by business, contact or mailbox.
  - A hold defers erasure requests and the retention purge.
  - Releasing a hold needs authorisation and is audited.
- **Retention purge**, which erases copies that are past their expiry and are not held.
- **Keyed re-import markers.** An erased provider message cannot quietly come back through a re-import, and
  the raw provider id is not kept (D-E1-2).
- **An erasure ledger** holding ids and counts only, plus a **replay** that re-applies every recorded erasure
  after a database restore (D-E1-7).
- **A worker and an internal scheduler route**, both off by default. Turning them on is an owner action.
- **A minimal API** (§8) using shared Zod contracts. Every new response field is optional, so existing
  clients keep working.

**Not in E1:**

- live mail sync;
- storing attachments;
- deleting contact records;
- tools to redact quoted text;
- a copy of the ledger outside the database;
- any user interface (that is C2-D).

## 2. Audit of what existed (main at 357c2ec)

| Area | Before E1 | What E1 changes |
|---|---|---|
| `messages`, `message_participants` | Immutable for every role (trigger `communications_read_only`, error CM002). bos_app has SELECT and INSERT only. | One narrow exception: `bos_maint` may tombstone a row once (content and provider ids set to NULL). Existing grants are unchanged. |
| `conversations` | bos_app may update `last_message_at` only (enforced by a guard). | `bos_maint` may clear the subject and external thread id, once. |
| `activities` | Authors can edit their notes. Removal is a soft delete (`deleted_at`). `message.recorded` entries carry ids only. | New column `erased_at`. Once an entry is erased, no role except `bos_maint` can change it. |
| `mail_retention_settings` (C2-B1) | One ordinary period per business. No default. It cannot be unset. | Adds the 30-day delay on shortening (`previous_retention_days`, `shortening_effective_at`). |
| Audit | bos_app writes `audit_events`. | bos_app can no longer write `communications.erasure.*` events. Only the privileged functions can. |
| Mail from mailboxes | None stored. No business has a real mailbox. | E1 can ship before any mail exists. C2-B3 will write the categorised copies. |
| Deleting a whole business | `DELETE FROM businesses` cascades to every tenant row. | Unchanged. The new tables cascade the same way. |

No existing Communications table is changed destructively:

- new columns are nullable;
- existing CHECK constraints are relaxed only so that an erased row is valid;
- C1's grants and its existing tests are unchanged.

## 3. Data classification

| # | Class | Where it lives | Holds personal information? | What happens to it in E1 | What is kept for security or accounting |
|---|---|---|---|---|---|
| 1 | Data from PERSONAL mailboxes | `messages.retention_category = 'PERSONAL_UNSHARED'` (written by C2-B3) | Yes: content, names, addresses | Never expires automatically in E1. Can be erased by request. Not counted in the administrators' eligibility view. Sharing a copy with the business (C2-B2) changes its category. | Nothing beyond ids |
| 2 | Data from BUSINESS mailboxes | Starts as `STAGED_INTAKE`, then becomes `ORDINARY` or `RETAINED_RECORD` | Yes | Intake expires 30 days after it was recorded. ORDINARY expires at the message date plus the period in force. RETAINED_RECORD never expires automatically until its duration is decided (§13). | Ledger ids and counts |
| 3 | Ordinary business communications | `ORDINARY` copies | Yes | As for class 2. If no period is set, nothing expires automatically. | Nothing |
| 4 | Conversations linked to customers | `conversations` (subject and links) and C1 messages (category `NULL`) | Yes: the subject and the messages | C1 messages never expire automatically (D-E1-1) but can be erased by request. A conversation loses its subject once every message in it is erased, unless it is held. | Conversation id, channel, links, dates |
| 5 | Activity timeline entries | `activities` | Notes, calls and meetings: yes (subject and body). `message.recorded`: no, ids only. | A contact erasure removes the subject and body of the timeline entries people wrote about that contact. Message entries keep their ids and point to the erased message. | Ids, type, dates, who acted |
| 6 | Attachment metadata | Not stored yet. Saving attachments by hand is a later stage (D-C2-12). | It would be: file names | Rule for the stage that adds attachments: the file name and storage key count as content and are erased with the message. Size and type may stay. | Size and type only |
| 7 | Audit records | `audit_events` | Must never contain content | E1 events carry only ids, counts, reason codes and scopes. Tests check that no subject, body, name or address appears. How long the audit log itself is kept is an open decision (§13). | Yes: who requested, released or applied what, and when |
| 8 | Credentials and provider identifiers | `mail_connection_credentials` (encrypted), `messages.external_message_id`, `conversations.external_thread_id` | Provider ids can identify a person's mail | Erasure removes the provider ids from the row. Only a keyed, one-way marker is kept, and it expires (§6.3). Credentials are handled by C2-A (removed when a mailbox is disconnected), not by E1. | Markers, until they expire |

Different kinds of record are removed in different ways:

- content is tombstoned in place (classes 1 to 5);
- markers expire and are then removed by housekeeping (class 8);
- audit and ledger rows are only ever appended (class 7);
- deleting a whole business still uses the existing cascade.

## 4. Retention rules

- **A period is required, and there is no default** (C2-B1 §16.6).
  - Until a business sets one, `ORDINARY` copies never expire automatically.
  - Until then, C2-B1 also refuses BUSINESS sync and the sharing of personal mail.
  - `STAGED_INTAKE` copies still expire after 30 days (D-C2-6).
- **Who may change the period:** anyone with `communications:manage_connections` (OWNER and ADMIN). Once set,
  the period cannot be removed.
- **A shorter period starts applying only after 30 days (D-E1-3).**
  - When the period is shortened, the trigger `mail_retention_settings_stamp` records the period that was in
    force (`previous_retention_days`) and the date the new one takes over (`shortening_effective_at`, now
    plus 30 days). No runtime role can skip this.
  - Lengthening the period cancels any pending reduction immediately.
  - `mail_effective_ordinary_days()` returns the longer period until the 30 days are over.
  - Once a period is set, the API shows `ordinaryRetentionDaysInForce` and `pendingReduction`.
- **The exception to the delay.**
  - An OWNER (not an ADMIN) can make a pending reduction take effect now.
  - This needs a single-use `APPLY_RETENTION_REDUCTION` code and a reason code: `LEGAL_OBLIGATION`,
    `DATA_MINIMISATION` or `OTHER`.
  - It is audited as `communications.erasure.retention_reduction_applied`.
  - A verified legal obligation to erase never waits for the delay. It is made as an erasure **request**,
    and retention timing does not apply to requests at all.
- **Eligibility is calculated the same way everywhere.**
  - `mail_retention_due_at(category, occurred_at, recorded_at, ordinary_days)` gives the date a copy is due.
  - It returns the message date plus the period for ORDINARY, the recorded date plus 30 days for
    STAGED_INTAKE, and NULL (never due) for every other category.
  - The purge, the scheduler's due query and the eligibility endpoint all use this one function.
  - So what the eligibility endpoint reports as due is exactly what the next purge erases (tested).
- **Erased content cannot be reached another way.**
  - Every read path shows the same tombstone: the conversation list, the message list, the conversation
    detail, the activity timeline (by customer or by contact) and the activity detail.
  - There is no separate search endpoint today. Any future search (C2-D) must read the same columns, which
    are NULL.

## 5. Erasure semantics

**A message is tombstoned, not deleted.**

- It keeps its id, conversation, direction, source, dates, recorder and category.
- Its subject, body, `external_source` and `external_message_id` are set to NULL, and `erased_at` is set.
- `content_hash` becomes `sha256('erased:' || id)`, so it no longer reveals anything about the content.
- Every participant loses `display_name`, `address` and `contact_id`. A business member's `user_id` stays.
- CHECK constraints (`*_erased_empty`) make it impossible for an erased row to hold content.
- An erased conversation refuses new messages (error CM011).
- An erased timeline entry cannot be edited back.

**What a request can target** (worked out by `communications_erasure_plan`):

| Target | What happens |
|---|---|
| MESSAGE | That message is erased in full. |
| CONVERSATION | Every message in it is erased, then the conversation's subject and external thread id. |
| CONTACT (D-E1-6) | Described below. |

**How a CONTACT erasure works.**

1. **Finding the contact.** A participant belongs to the contact if it is linked to the contact, or if its
   address matches the contact's own email address (ignoring case).
2. **Full erasure.** A message is erased in full if the contact wrote it, or if no other person outside the
   business took part in it.
3. **Partial erasure.** For every other message, only the contact's participant rows are cleared. The body is
   kept for the other people in it. The message is marked `REVIEW_REQUIRED`, because it may still quote the
   contact.
4. **Conversations.** A conversation filed under the contact is tombstoned once all its messages are erased.
   If it still holds other people's messages, it is marked for review instead.
5. **Timeline entries.** Entries people wrote about the contact (`note`, `call`, and so on) lose their
   subject and body.
6. **The contact record itself is not deleted.** That is outside E1.

**Deferrals.**

- A message under a legal hold, or classified `RETAINED_RECORD`, is never touched.
- The request becomes `DEFERRED`, with the reason `LEGAL_HOLD` or `RETAINED_RECORD`, and the worker checks it
  again every day.
- Everything else in the request still goes ahead.

**Repeatable and limited in size.**

- One step erases at most `batch` messages (at most 500), in one transaction.
- Asking again for a target that already has an open request returns that request (status 200).
- Asking again after the request has completed creates a new request, which finds nothing left (counts 0).
- Tombstoning a row that is already erased changes nothing.

**The ledger.**

- `communications_erasures` holds one row per request or purge batch: its status, counts, and an error code
  that contains no content.
- `communications_erasure_items` holds one row per erased or flagged record, by id only, with the action
  `ERASED` or `REVIEW_REQUIRED`.
- Items can only be added, never changed. A completed request can no longer change (error CM013).

## 6. Eligibility, holds and re-import markers

### 6.1 Eligibility view

`GET …/communications/retention/eligibility` returns:

- for each category (ORDINARY, RETAINED_RECORD, STAGED_INTAKE): how many copies are live, due and held, and
  when the next one becomes due;
- the period in force, and any pending reduction;
- how many unclassified (C1) messages are live.

Unshared personal copies are **not** counted. An administrator's view must not reveal how much personal mail
someone has.

### 6.2 Legal holds

A hold covers one of three scopes: `BUSINESS`, `CONTACT` or `CONNECTION`.

- **Placing a hold** needs only `manage_connections`, because a hold protects data.
  - Placing the same hold twice returns the existing one.
  - It is audited as `communications.legal_hold.placed`.
  - It takes the business's hold lock exclusively (§9). Once it commits, nothing it covers can be erased.
- **Releasing a hold** needs a single-use `RELEASE_LEGAL_HOLD` code and is audited as
  `communications.erasure.hold_released`.
- No runtime role can update or delete a hold row.

**A `CONNECTION` hold covers the whole business in E1.** Copies do not yet record which mailbox they came
from. Until C2-B3 adds that link, a mailbox hold protects every copy in the business, so nothing is missed
(tested).

### 6.3 Keyed re-import markers (D-E1-2)

**How a marker is made and used.**

1. When a message that has provider ids is erased, the database removes the ids from the row.
2. It stores `HMAC-SHA256(business key, kind:source:id)` in `communications_erased_references`.
3. The business key is 32 random bytes, created the first time it is needed. It is stored in
   `communications_erasure_keys` and never leaves the database.
4. No runtime role can read either table.
5. Before importing, the code asks `communications_erased_matches`. If any id in the batch was erased, the
   whole batch is refused with 409 `erased`.

A marker cannot be turned back into the provider id. Markers from different businesses cannot be linked to
each other.

**How long a marker is kept.** Until the later of these two dates:

- 30 days after the erasure;
- 395 days after the message's own date. That is the longest approved backfill (365 days, D-C2-7) plus a
  margin; after it, a provider would not deliver the message again in a normal sync.

After that, housekeeping removes the marker and the same id could be imported again. This trade-off is
tested, and it is listed as an owner decision (§13).

**How long a key is kept.** A key lives as long as its business; the cascade removes it with the business.
Replacing a key would make every existing marker useless, which is the same as expiring them all, so E1 does
not offer key rotation.

## 7. Worker (background cleanup)

The worker follows the same pattern as the finance jobs (`billing-worker.ts`, `reminder-worker.ts`).

1. **Find businesses with due work.**
   - `app_private.communications_erasure_due(limit)` (owned by bos_definer) returns **business ids only**.
   - A business is due if it has a request whose next attempt is due, or a categorised copy past its expiry
     that is not under a business or mailbox hold.
   - It reads no content columns.
2. **Work through each business.** This runs as bos_app inside `withTenant({ businessId, userId: null })`,
   with each step in its own short transaction:
   - retention purge batches (`communications_retention_purge`), until nothing is due or time runs out;
   - each due request (`PENDING`, or `DEFERRED` with its daily recheck due), stepped until it completes,
     is deferred, or time runs out;
   - housekeeping: expired markers, and codes that expired more than a day ago.
3. **Claiming work.**
   - A request row is taken with `FOR UPDATE SKIP LOCKED`.
   - A second worker reaching the same request gets `busy` and changes nothing (tested).
   - Purge batches lock their rows in a fixed order, so two purges run one after the other.
4. **Failures.**
   - A failed step is rolled back completely.
   - The worker records an error code that contains no content: `deadlock`, `lock_timeout`, `serialization`,
     `statement_timeout`, `database_error` or `worker_error`.
   - It waits before retrying: 30 seconds times 2 to the power of the number of attempts, at most 1 hour.
   - A request is never abandoned (tested).
5. **The scheduler route:** `GET /api/internal/jobs/communications-retention`.
   - It answers 503 unless the caller sends `Authorization: Bearer $CRON_SECRET` **and**
     `COMMUNICATIONS_RETENTION_JOBS_ENABLED=true` is set.
   - It is **not** listed in `vercel.json`.
   - `runCommunicationsRetentionPass()` can be called directly against a throwaway database, as the tests do.

## 8. Authorization and API

All endpoints are under `/api/v1/b/:slug/communications/` and need `communications:manage_connections`.
MANAGER and MEMBER get 403. The contracts are in `packages/contracts/src/communications-erasure.ts`.

| Endpoint | Purpose | Extra checks |
|---|---|---|
| `POST authorizations` | Get a single-use code for one operation on one target | The database checks: a live session, a verified email, an ACTIVE OWNER or ADMIN membership of this business (OWNER for `APPLY_RETENTION_REDUCTION`), and a business that is not archived |
| `GET/POST erasures`, `GET erasures/:id` | List requests; make a request (202 if new, 200 if an open one already exists); read one request with its review items (ids only) | Making a request needs an `ERASE_<TYPE>` code for that target, used up in the same step |
| `GET/POST legal-holds`, `POST legal-holds/:id/release` | List holds; place one (201 if new, 200 if it already exists); release one | Releasing needs a `RELEASE_LEGAL_HOLD` code for that hold |
| `GET retention/eligibility` | Counts per category | None |
| `POST retention/apply-reduction` | Make a pending reduction take effect now | An OWNER's code and a reason code |

**How authority is enforced (D-E1-4).**

- The high-risk database functions receive the caller's **raw session token** and check it themselves
  (`communications_erasure_actor`). They do not trust `app.user_id`, because bos_app sets that value.
- They also check that the token belongs to the same user as the `app.user_id` of the current transaction.
- A code is 64 hex characters. Only its SHA-256 hash is stored.
- A code is tied to one user, business, operation and target.
- It expires after 5 minutes. A CHECK constraint caps any code's lifetime at 10 minutes.
- The same UPDATE that checks a code also marks it used, so the code cannot be replayed.
- A code stops working if, between getting it and using it, the person is demoted or suspended, or their
  session expires or is revoked (tested).
- Two boundary rules back this up:
  - only the four E1 routes may ask `tenantRoute` for the raw token;
  - only `erasure.ts` may call the E1 database functions.

**Errors.**

| Status | Meaning |
|---|---|
| 403 | Not allowed |
| 404 | Not found, or not in this business |
| 400 | Invalid input |
| 409 `erased` | The target was erased (CM011) |
| 409 `legal_hold_rule` | A legal hold rule was broken (CM012) |
| 409 `immutable` | The record can no longer change (CM013) |

## 9. Concurrency and lock order

Every erasure step and purge batch takes its locks in this order:

1. the request row, with `FOR UPDATE SKIP LOCKED` (requests only);
2. the business's hold lock, in shared mode:
   `pg_advisory_xact_lock_shared(hashtext('communications.legal_hold'), hashtext(business))`.
   Placing a hold takes the same lock in exclusive mode;
3. the business's `mail_retention_settings` row, `FOR SHARE` (purge only), so a change to the period waits;
4. the conversations involved, `FOR UPDATE`, in id order;
5. the messages, `FOR UPDATE`, in id order. The plan is then **worked out again on the locked rows**;
6. activities, `FOR UPDATE`, in id order.

| Race | What happens (tested unless noted) |
|---|---|
| A message is recorded while its conversation is being erased | The insert guard locks the conversation (`FOR KEY SHARE`) *before* checking it. So it waits for the erasure step, then sees `erased_at` and refuses with 409 `erased`. No live message is left. |
| A message is recorded just before the erasure step | The step waits for the insert to finish. When the step re-plans, it sees the new message and erases it. The inserting transaction then updates `last_message_at`, which needs a stronger lock, and there is no deadlock. |
| Someone tries to add a participant to an existing message | Refused. The insert guard only accepts participants written in the same transaction as their message, so a participant can never be added to a message an erasure has just handled. |
| A legal hold is placed during an erasure step | The hold waits for the step, and the next step is deferred. Exactly what was processed before the hold is erased. |
| The retention period changes during a purge | The change waits for the purge, because the purge reads the settings row `FOR SHARE`. |
| Two workers pick the same request | One runs. The other gets `busy` and changes nothing. |
| A timeline entry is created for a contact during a contact erasure | If it is committed before the step's final check, the request stays `PENDING` and the next step erases it. If it is created after the request has completed, it is new data. Not tested, only documented. |
| Mailbox sharing changes, or a connection is revoked | No effect in E1. Copies are not linked to a mailbox yet, and a mailbox hold covers the whole business. C2-B3 must test both again once copies record their mailbox. |
| A customer or contact is updated | Erasure neither locks nor changes customers or contacts. A change to a contact's email only affects the next plan. |

**No new deadlock cycle.**

- C1's write path first takes a shared key lock on the conversation (through the insert guard and the
  foreign key), then a stronger update lock on the same row.
- While it holds a lock on a message, it never waits for a lock it does not already hold.
- Erasure always locks conversations before messages.

## 10. Recovery, retries and backups

**Retries.** See §7. Each step is all-or-nothing, so interrupted work leaves either nothing changed or one
complete step.

**Replaying erasures after a restore (D-E1-7).**

- `app_private.communications_erasure_replay(business, limit)` re-applies up to `limit` **pending** ledger
  entries: entities the ledger records as `ERASED` whose row exists and is not erased now (messages,
  participants, timeline entries and conversations). Because it works only on what is still pending, each call
  makes progress through the whole ledger, however large (audit E1-01).
- `app_private.communications_erasure_replay_remaining(business)` is the completion check: it counts what is
  still pending. A return of 0 from `replay` is **not** the completion signal; `remaining = 0` is.
- Tested with 31 ledger entities of all four types replayed in pages of 4, and with content restored only
  for entries that sort last. Running replay again afterwards changes nothing.
- Only the administrative role can run it. No runtime role can.

**Restores are kept isolated until erasures are re-applied.** Every restore follows these steps, whether it
comes from a point-in-time restore, a Neon recovery branch that is promoted or copied back, or a dump:

1. Restore into a branch or database that **no deployment points at**. No app `DATABASE_URL` may reference
   it, and no Vercel environment variable is switched to it.
2. Re-apply erasures.
   - In E1, for every business, call `communications_erasure_replay` repeatedly until
     `communications_erasure_replay_remaining` returns 0, against the restored database and using the
     **current** ledger.
   - If the live `communications_erasures` and `communications_erasure_items` rows are newer than the
     restored ones, copy them into the restored database first.
   - Once real mail exists, also replay the separate erasure record kept outside the database (open decision
     3, §13). A restore taken before an erasure has also lost that erasure's ledger rows.
3. **Gate:** `communications_erasure_replay_remaining` must return 0 for every business, and spot-checks must
   show content is NULL. Until then no deployment, environment variable or person is pointed at it.
4. Only then point anything at the restored database.

**Recovery branches.**

- A temporary Neon recovery branch made before an approved migration still holds pre-erasure content for as
  long as it exists.
- The standing infrastructure policy keeps such branches only as long as they are needed: at least 2 recent
  verified recovery points, the oldest deleted first, and every deletion logged.
- Once real mail exists, an erasure must also be honoured in any recovery branch that is later used, by
  following the restore steps above.
- How long recovery branches are kept should be decided together with backup retention (§13).

## 11. Privileged SQL and migration

**The migration** `20261201000000_communications_erasure`:

- **Ordering.**
  - It sorts after the newest migration on main, `20261130000000_finance_catalog` (Finance F7-A), and after
    `20261128000000_scheduling_resources` (Scheduling S2). Both merged before E1.
  - It was first named `20261129000000`; it was renamed when F7-A merged ahead of it, because CI requires
    a new migration to sort after main's newest. It has never been applied anywhere but local and CI
    databases, so the rename changes no recorded checksum.
  - It references no scheduling or finance object, so it commutes with both.
- **Additive only.**
  - Six new tables.
  - Nullable columns added to existing tables:
    - `messages`: `erased_at`, `retention_category`;
    - `message_participants`, `conversations` and `activities`: `erased_at`;
    - `mail_retention_settings`: two columns.
  - New CHECK constraints, guard functions and triggers. Existing CHECK constraints are relaxed only so that
    erased rows are valid.
- **Row-level security** is forced on every new table. Composite tenant foreign keys `(business_id, id)`
  cover every new link.
- **Grants.**
  - Grants on the C1 tables are unchanged.
  - The new tables first remove the default privileges bos_app would otherwise get.
  - bos_app then gets SELECT on erasures, items and holds, and INSERT on the hold columns.
  - bos_app gets nothing on keys, markers or codes.
- **Tested from a fresh database**, the same way CI builds one: the roles script, `prisma migrate deploy`,
  then `db:privileged`.

**The privileged SQL** (`004_communications_erasure.sql`), and why each privilege is needed:

| Owner | Function | Why it must be privileged |
|---|---|---|
| bos_definer | `communications_erasure_actor` | It reads `sessions` and `memberships` to verify the caller. Only bos_maint can run it. |
| bos_definer | `communications_erasure_due` | It has to see across businesses to find those with due work. It returns ids only. Its policies let it read only open requests, live categorised copies, and active business or mailbox holds. |
| bos_maint | tombstone, plan, step, purge, release, apply-reduction, markers, housekeeping, replay | bos_maint is the only role allowed past the read-only guards. It has column-level UPDATE on exactly the content columns, its `maint_tenant` policy limits it to the current business, and it may write `communications.erasure.*` audit events. No runtime role can run the internal helpers or the replay. |

## 12. Activation procedure (each step needs the owner's approval)

E1 can be merged and migrated with nothing switched on. To turn on automatic retention later:

1. Make the owner and legal decisions in §13. At minimum: the RETAINED_RECORD durations, the marker expiry,
   and the erasure record outside the database (needed before real mail).
2. Run the production migration through its documented steps. Create and verify a fresh recovery branch
   first, as the standing policy requires. Then run `db:privileged` with `ADMIN_DATABASE_URL`.
3. Set `COMMUNICATIONS_RETENTION_JOBS_ENABLED=true` in Vercel production, and make sure `CRON_SECRET` (the
   same secret the finance jobs use) is set.
4. Add a cron entry for `/api/internal/jobs/communications-retention` to `vercel.json`, for example hourly.
   This changes the deploy configuration, so it needs approval.
5. Watch the first runs: new `communications_erasures` rows of kind RETENTION, `retention_purged` audit
   events, and the summary the route returns.

**To switch it off:** unset the flag, and the route answers 503 again. Erasure requests can still finish
through the first step that runs when a request is made, or through a manual worker run.

## 13. Owner decisions and open legal decisions

**Decisions already made (Regan, 2026-11-16):**

| # | Decision | How E1 implements it |
|---|---|---|
| D-E1-1 | C1 manual and imported messages never expire automatically, can be erased by an authorised request, and are to be revisited before live mail | They have category `NULL` and are never due. Erasing by request works (tested). |
| D-E1-2 | Keep thread structure and non-sensitive markers, but not raw provider ids. Use keyed, one-way references to avoid duplicates. Document key retention and marker expiry. Erasure must really remove content. | §5, §6.3 |
| D-E1-3 | A 30-day delay on voluntary reductions. It never overrides a verified legal erasure. Any exception must be authorised and audited. | §4 |
| D-E1-4 | OWNER or ADMIN, enforced in the database, with short-lived codes limited to one operation and protected against replay | §8 |
| D-E1-5 | No blanket 7-year minimum. Retention is set per category, obligation and purpose. A duration that is not yet decided needs an owner or legal decision before automated purge. | RETAINED_RECORD is never due automatically. No duration has been invented. |
| D-E1-6 | Contact erasure removes identifying content and timeline notes, keeps other people's records, and handles shared conversations, quoted content and conflicting retention explicitly. Contact records are not deleted. | §5: partial erasure with review items; holds and retained records defer the request |
| D-E1-7 | An in-database ledger plus replay is enough for E1. A separate, independently protected erasure record outside the database is required before real mail. | §10 |

D-E1-5 replaces the line "Retained AU records are kept 7 years" in the C2 register
(`communications-c2.md`).

**Still open. These are needed before automated purge or real mail, and E1 does not decide them:**

1. **RETAINED_RECORD durations**, for each obligation (for example tax or employment records). Until they are
   set, these copies never expire automatically, and erasure requests defer on them.
2. **Marker expiry** (395 days after the message date, and at least 30 days after erasure). Is it acceptable
   that a message can be imported again after its marker expires, or should some sources keep markers
   longer?
3. **The erasure record outside the database** (D-E1-7, needed before real mail): where it lives (for
   example append-only object storage with a retention lock), who can read it, and how a restore replays it.
4. **How long audit events and ledger rows are kept.** Today they are kept for as long as the business
   exists.
5. **Handling quoted content.** Partial erasures mark messages for review. Should quoted text be redacted,
   and who does the review?
6. **How long backups and recovery branches are kept** once real mail exists (§10). This is the longest time
   erased content can survive in a backup or branch.
7. **Deleting contact records, and the links left behind.** Erased conversations and `message.recorded`
   entries keep their links (ids) to the contact and customer. Deleting the contact record, or removing
   those links, is a later stage.
8. **Revisiting the C1 model** (D-E1-1) before live mail.

## 14. Tests

`apps/api/tests/integration/communications-erasure.test.ts` holds 24 tests. They run against PostgreSQL with
the migrations and privileged SQL applied to a fresh database.

- **Authorisation:**
  - which roles can get codes;
  - only an OWNER can apply a reduction early;
  - a code works only for its own target and operation, only once, and only before it expires;
  - another user's code and another business's code are refused;
  - forged sessions, demoted members, suspended members and expired sessions are refused;
  - a refused request changes nothing.
- **Erasure:**
  - a C1 message;
  - a whole conversation, which then refuses new messages with 409, including through direct SQL;
  - a contact, covering full and partial erasure, review items, timeline notes, no participant left linked to
    the contact, and the contact record kept;
  - repeated requests.
- **Deferrals and holds:**
  - requests deferred by a legal hold and by a retained record;
  - the request is checked again after the hold is released;
  - holds cannot be changed through SQL;
  - a mailbox hold covers the whole business.
- **Retention:**
  - the 30-day delay;
  - lengthening the period clears the delay, and bos_app cannot clear it;
  - the OWNER's early application is audited;
  - category boundaries (364 and 366 days, 29 and 31 days);
  - personal copies and C1 messages are never due;
  - the eligibility counts match what the purge erases;
  - a business hold stops the worker.
- **Markers:**
  - re-importing an erased message is refused with 409 `erased`;
  - the raw id is gone everywhere;
  - another business is not affected;
  - once the marker expires and housekeeping runs, the message can be imported again.
- **Replay:** content restored from a backup is erased again; replay in small pages walks the whole ledger
  (including entries beyond the first page) until the completion check reports 0; replaying again changes
  nothing.
- **Listing:** the erasures cursor is bound to its filters (changed, added or removed filters refuse it) and
  paging returns every row exactly once.
- **Least privilege.** bos_app cannot:
  - update or delete message history, the ledger, holds, keys, markers or codes;
  - call the internal functions;
  - write fake erasure audit events;
  - insert rows that are already erased or already categorised;
  - add participants to an existing message.
- **Races:**
  - two workers on the same request;
  - a message inserted during an erasure step, and one inserted just before it, including the stronger lock
    taken afterwards;
  - a hold placed during a step;
  - a retention change during a purge;
  - a failed step and its retry.
- **Other businesses:** business B can neither see nor erase anything that belongs to business A.

**Other checks:**

- The existing suites (C1, C2-A, C2-B1, database roles and all others) run unchanged.
- Typecheck, lint, boundaries, the contracts snapshot, unit tests and `db:check-migrations` also pass.
- The PgBouncer isolation suite runs in CI.

## 15. Known limitations

- No copies from real mailboxes exist until C2-B3, so the category behaviour is tested with seeded rows.
- A mailbox hold covers the whole business until copies record which mailbox they came from.
- Races with mailbox sharing and connection revocation only matter once C2-B3 exists, and C2-B3 must test
  them again.
- Erased conversations and message timeline entries keep the contact's and customer's **ids**, but no
  content.
- A partial erasure keeps other people's message bodies, which may quote the contact. Those messages are
  marked for review, not redacted.
- The ledger is stored in the same database as the data it records. D-E1-7 accepts this for E1 only.
- The worker is not scheduled. A request finishes through its first step if it covers up to 50 messages.
  Anything beyond that waits until the worker is switched on or run by hand.
