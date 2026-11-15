# Communications C1: Unified Activity & Communications Foundation

Status: implementation in branch `communications/c1-foundation`, pending audit and owner approval.
Migration: `20261119300000_communications` (additive; depends only on `20261114050000_customers`).

C1 lets a business record customer interactions and internal notes, keep a read-only history of
messages exchanged outside Business OS, and see one coherent activity timeline. It is **not** an
email client, chat platform or notification engine: nothing is sent, no provider is connected, no
OAuth exists, and nothing in C1 may claim that Business OS sent a message.

## 1. Inspection findings (before implementation)

| Area | What exists on `main` (c7ce20c) | Consequence for C1 |
|---|---|---|
| `activity` module | One `activities` table (data-model §4.7), PK `(business_id, id)` (E1), composite FKs to `customers` and `contacts`, forced RLS, `bos_app` may `SELECT, INSERT` and `UPDATE (deleted_at, updated_at)` only. User types `note, call, meeting, email`; system types `customer.*`, `contact.*`, written by the customers module through `recordSystemActivity` in the same unit of work. No edit or remove endpoint. | Stays the single timeline. C1 extends this table; it adds no second activity table or customer history. |
| Subject linking | Data-model §4.7 chose option A: one explicit, nullable, composite FK per subject type; JSON or `subject_type + subject_id` references were rejected. | Messages link to the timeline through real composite FK columns (`conversation_id`, `message_id`), never through `data`. |
| Contact/customer movement | Activities record the customer at the time of writing and are never rewritten (§4.7 history table). | Message activities follow the same rule: the contact's customer at the time the message is recorded. |
| `customers` | The only writer of system activities. Archived records refuse new manual activity (409 `archived_reference`). | The same subject rules apply to conversations and messages, through one shared resolver in `activity`. |
| `access` | Permission keys per Zone; all four roles hold `activity:read/write`. | New keys are added (§4); no role-based checks in code. |
| `core/audit` | `recordAudit` in the same unit of work, no business content in metadata. | Every C1 mutation is audited with ids and types only. |
| Erasure / retention | Documented in data-model §7 (contact erasure scrubs activity content; `ON DELETE SET NULL (contact_id)`), **not implemented**: there is no erasure service, no DELETE grant, and the FK is `NO ACTION`. | C1 is erasure-*ready* but does not implement erasure (see §7). |
| Sales, Projects, Finance | None write activities today. Sales doc PR 20 plans an `opportunity_id` link. | No integration in C1. The extension point is the activity public API (`recordSystemActivity` with a registered type, plus one FK column per subject). |
| People P1, Scheduling S1, Finance F4 | In flight in other worktrees. People P1 adds `20261118000000_people` and edits `access/permissions.ts`, `app-client.ts`, `tenancy.prisma`, `contracts/index.ts` additively. Scheduling S0 says private entries write no activity. | C1 touches no People/Scheduling/Finance files. The shared files above get additive edits only; textual merge conflicts with People P1 are expected in the role map lines and are trivial. |
| Timeline UI | Customer detail shows an activity panel with a composer ("Log activity") and keyset paging. The Home "Recent activity" area says a cross-Zone feed is not built yet. | The customer detail panel is stable and is integrated. The Home feed is part of the app shell and is not touched (deferred). |

### Conflicts and the conservative choices taken

1. **Erasure not yet built.** C1 does not build erasure; it keeps every new contact link nullable and
   all personal content in known columns, so the erasure service can scrub it later (§7).
2. **"No parallel history" vs separate message storage.** Messages need their own immutable rows
   (participants, external ids). Each recorded message writes exactly **one** activity row of type
   `message.recorded` that points at the message through composite FKs. The message body is stored
   once (in `messages`); the activity row carries no copy of it.
3. **Restricted visibility in RLS.** Enforcing per-user visibility in RLS would need a new tenant
   setting in the shared `withTenant` core. C1 keeps RLS tenant-only (as every other table) and
   enforces restricted visibility in the activity service, in one query builder used by every read.
   **Decided by Regan (2026-11-15):** restricted visibility is enforced in the activity service; RLS
   stays tenant-only and the shared `withTenant` core is untouched.
4. **Shared permission map.** Additive edits; expected trivial merge conflict with People P1.

## 2. Data model

All new tables: `business_id` first in every key, PK `(business_id, id)` (E1, partition-ready),
composite tenant FKs only, forced RLS with the standard `tenant_isolation` policy, `ON DELETE
CASCADE` from `businesses` (business purge) and `NO ACTION` from customers/contacts (as activities).

### 2.1 `activities` (extended)

| Column | Purpose |
|---|---|
| `visibility` `STANDARD`/`RESTRICTED` | Restricted is allowed only for notes (CHECK). |
| `edited_at` | Set when the author edits a note's subject/body. |
| `conversation_id`, `message_id` | Set only for `message.recorded` (CHECK both ways). FK `(business_id, conversation_id, message_id) → messages(business_id, conversation_id, id)`; one activity per message (unique). |

Guard trigger (`activities_guard_update`, SQLSTATE `CM001`): only `subject`, `body`, `edited_at`,
`updated_at`, `deleted_at` may change; subject/body only on a live `note`; `deleted_at` only on a
user-type activity and never cleared. Column grants mirror this, so authorship, type, links,
visibility and timestamps cannot be rewritten even by a bug in the service.

New user type `interaction` (SMS, chat, social, in person, other). Per-type payloads in `data` are
validated by a registry in code: `call`/`email`/`interaction` carry `direction` (`INBOUND`/
`OUTBOUND`), `interaction` carries `channel`, `message.recorded` carries `direction` and `channel`.

### 2.2 `conversations`

`last_message_at` only moves forward: the service uses one conditional UPDATE
(`WHERE last_message_at IS NULL OR last_message_at < $new`), and `conversations_guard_update` keeps
the old value if any writer tries to set an older value or null (audit C1-01).

`channel` (`EMAIL, PHONE, SMS, CHAT, SOCIAL, IN_PERSON, OTHER`), `subject`, `customer_id`,
`contact_id` (at least one), `created_by_id` (verified user), `source` (`MANUAL`/`IMPORT`),
`external_source` + `external_thread_id` (optional, unique per business), `last_message_at`.
`bos_app`: `SELECT, INSERT, UPDATE (last_message_at, updated_at)`.

### 2.3 `messages` (immutable)

`conversation_id`, `direction` (`INBOUND`/`OUTBOUND`/`INTERNAL`), `source` (`MANUAL`/`IMPORT`; there
is deliberately no value meaning "sent by Business OS"), `occurred_at` (original time), `recorded_at`
(database time), `recorded_by_id`, `subject`, `body` (plain text), `external_source` +
`external_message_id` (unique per business; required for imports), `content_hash` (SHA-256 of the
canonical message, for idempotent re-import). `bos_app`: `SELECT, INSERT` only, plus a trigger that
rejects any `UPDATE` (SQLSTATE `CM002`). No provider tokens, headers or raw MIME are stored.

### 2.4 `message_participants` (immutable)

`message_id`, `role` (`FROM, TO, CC, BCC`), `position`, `display_name`, `address`, optional
`contact_id` (composite FK) and `user_id`. Exactly one `FROM` per message (service rule).

## 3. Services (module public APIs)

- `activity`: `createActivity` (note, call, meeting, email, interaction; direction/channel;
  restricted notes), `updateNote` (author only, live note, subject not archived), `removeActivity`
  (author only, user types only), `listActivities` (unified timeline; customer, contact, type and
  visibility filters; keyset paging on `(occurred_at, id)`), `recordSystemActivity` (registered system
  types only), `recordMessageActivity` (for the communications module), `resolveSubject` (shared
  customer/contact rules).
- `communications` (new module, depends on `activity`, `access`, `core`): `createConversation`,
  `getConversation`, `listConversations`, `recordMessage`, `importMessages` (1–100 per call,
  idempotent by external id), `listMessages` (ascending `(occurred_at, id)`, keyset paging).

Every mutation and its activity and audit rows commit or roll back together (one `withTenant`
unit of work). No module writes another module's tables: `communications` writes timeline entries only
through `recordMessageActivity`, and reuses `resolveSubject` for the customer/contact rules.

**Filing rule for message entries** (same as data-model §4.7): with a contact on the conversation, an
entry is filed under the contact's customer *at the time the message is recorded*; without one, under
the conversation's customer. Earlier entries and the conversation record are never rewritten, so a
contact who moves takes new entries to the new customer while the old customer keeps its history.

**Import idempotency:** `(business_id, external_source, external_message_id)` is unique. Re-importing
the same message into the same conversation with the same canonical content (SHA-256 over direction,
time, subject, body and participants) reports `duplicate` and writes nothing. The same id with
different content, or in another conversation, refuses the whole batch with 409
`idempotency_conflict` (one transaction, nothing half-imported). A concurrent import that loses the
race on the unique index also gets 409; retrying it reports `duplicate`.

## 4. Permissions

| Key | OWNER | ADMIN | MANAGER | MEMBER |
|---|---|---|---|---|
| `activity:read` / `activity:write` (existing) | ✓ | ✓ | ✓ | ✓ |
| `activity:read_restricted` (new) | ✓ | ✓ | – | – |
| `communications:read` (new) | ✓ | ✓ | ✓ | ✓ |
| `communications:record` (new) | ✓ | ✓ | ✓ | ✓ |

Every read of `activities` (list, filters, paging and direct get, plus the reads behind edit and remove)
applies the single predicate `visibleTo`; a unit test fails if any read path skips it. A hidden note
answers exactly like a missing one (same 404 body), is never counted or paged over in a way that leaves an
extra empty page, and a cursor positioned on one reveals nothing (audit C1-02). A restricted note is visible to its author and to holders of `activity:read_restricted`; to anyone
else it does not exist (404 on direct access, absent from lists and counts). Timeline entries linked
to a message are shown only with `communications:read`. Customer/contact-filtered reads also need
`customers:read`. Editing and removing are author-only with `activity:write`.

## 5. API (`/api/v1/b/:slug/…`)

| Method | Path | Permission |
|---|---|---|
| GET | `/activities?customerId|contactId&types&visibility&cursor&limit` | `activity:read` |
| POST | `/activities` | `activity:write` |
| GET | `/activities/:activityId` | `activity:read` |
| PATCH | `/activities/:activityId` (note subject/body, author only) | `activity:write` |
| POST | `/activities/:activityId/remove` (soft remove, own user-entered entry) | `activity:write` |
| GET / POST | `/conversations` | `communications:read` / `communications:record` |
| GET | `/conversations/:conversationId` | `communications:read` |
| GET / POST | `/conversations/:conversationId/messages` | `communications:read` / `communications:record` |
| POST | `/conversations/:conversationId/messages/import` | `communications:record` |

All timeline and conversation reads also require `customers:read`. Contracts:
`packages/contracts/src/communications.ts` plus additive activity fields (`visibility`, `editedAt`,
`conversationId`, `messageId`; request fields `visibility`, `direction`, `channel`; user type
`interaction`). Error codes: 404 `not_found` (also for restricted notes and other businesses), 403
`forbidden` (not the author), 409 `immutable` / `archived_reference` / `idempotency_conflict`, 400
`invalid_input` / `invalid_query` / `invalid_type` / `invalid_date` / `invalid_participant` /
`invalid_cursor`. Database guards CM001–CM004 map to the same stable codes; no detail is forwarded.

## 6. Migration ordering

`20261119300000_communications` alters `activities` and creates three tables. It depends only on
`20261114050000_customers`; it does not reference finance, sales, projects, people or scheduling
objects, so it can be applied before or after `20261118000000_people` (merged in #36) and
`20261118050000_scheduling` (in flight); its timestamp sorts after both. It was chosen after checking
every branch, worktree and open PR on 2026-11-15. Precondition: none (existing
activity rows get `visibility = 'STANDARD'` by default and satisfy every new CHECK).

## 7. Retention and erasure — C1 is not privacy-complete

**C1 does not support erasure of customer or contact data.** Erasure stays deferred, as agreed. Before
any customer-data erasure (for example a GDPR-style request for a contact) can be supported, all of
the following are required, each as reviewed work:

1. **A privileged erasure pathway**, for example a SECURITY DEFINER function or a dedicated role
   (`bos_maint`/`bos_definer`, data-model §5.1). It must verify the requesting OWNER/ADMIN from the raw
   session token in the database, as the scheduling erasure design does, never from `app.user_id`.
   Tenant code (`bos_app`) has no DELETE on any C1 table and no UPDATE on message history, and must not
   be given them.
2. **Trigger changes.** These triggers currently refuse every change that erasure needs:
   `messages_read_only` and `message_participants_read_only` (CM002) refuse scrubbing message
   `subject`/`body` and participant `display_name`/`address`. `activities_guard_update` (CM001)
   refuses scrubbing `subject`/`body` of calls, meetings, emails and interactions and refuses clearing
   `contact_id`. `conversations_guard_update` (CM001) refuses clearing `contact_id` or `subject`.
   The erasure migration must allow those changes only on the privileged path.
3. **Grant and FK changes.** `contact_id` FKs on `activities`, `conversations` and
   `message_participants` are `NO ACTION`, so a contact cannot be hard-deleted while referenced. The
   erasure design must pick `SET NULL (contact_id)` or explicit nulling in the privileged function,
   and grant only that path the required DELETE/UPDATE.
4. **Scope rules**, decided by the owner: what is scrubbed when a contact is one participant among
   several, how imported messages are handled (`external_message_id` is kept or not), and how the
   erasure itself is audited without the erased PII.

What C1 already does to make that later work possible (prepared for erasure, but no erasure exists):
every contact link is nullable, personal content sits in known columns (`messages.subject/body`,
`message_participants.display_name/address`, `conversations.subject`, `activities.subject/body`), no
message content enters audit metadata or logs, and business purge cascades through every C1 table
(`ON DELETE CASCADE` from `businesses`, tested). Retention periods for communications are not defined.

## 8. UI (`packages/app/src/zones/activity`)

Reusable components: `ActivityTimeline` / `ActivityTimelineItem` (unified timeline with type filter,
paging, loading/empty/error states), `ActivityTypeBadge` / `ActivityTypeIcon`, `NoteComposer` (with
restricted option), `LogInteractionForm` (note, call, meeting, email, other interaction; direction and
channel; states "Nothing is sent"), `ConversationHistory` / `MessageItem` (read-only, oldest first,
"Recorded" / "Imported from …", "Sent outside Business OS"). Integrated only on the customer page
(stable surface): the Activity panel now uses them, and a Conversations panel appears for
`communications:read`. The app shell, design tokens, `packages/ui` and other Zones are untouched;
the Customer Zone's `ActivityComposer` is now an alias of `LogInteractionForm`.

## 9. Deferred (C2/C3)

- C2: provider integration (Gmail/Microsoft/IMAP), OAuth, inbound sync, attachments, sending and
  delivery status, conversation threading by provider ids (`external_thread_id` is already reserved).
- C3: notifications, the Home cross-Zone feed (app shell), mentions, assignment.
- UI for recording/importing messages, editing/removing notes (the API exists; the client does not
  know the signed-in user's id yet, which "edit your own" needs).
- Sales/Projects/Finance/People timeline links (one composite FK column per subject, option A), via
  `recordSystemActivity` with registered types.
- Contact erasure (§7: needs a privileged pathway plus trigger, grant and FK changes), conversation
  archiving, full-text search, restricted visibility in RLS.

## 10. Owner decisions

D-C1 to D-C7 were approved as proposed on 2026-11-15 (preliminary audit of PR #39).

| # | Decision | Implemented |
|---|---|---|
| D-C1 | Role defaults | `communications:read/record` for all four roles; `activity:read_restricted` OWNER and ADMIN |
| D-C2 | Restricted visibility | Notes only; visible to the author and `activity:read_restricted`; others get 404 (decided 2026-11-15: enforced in the service, RLS tenant-only) |
| D-C3 | Edit and remove | Author only; only notes are editable; any user-entered entry can be soft-removed once; no admin override; archived customers/contacts are read-only |
| D-C4 | Filing after a contact moves | Follows the contact's customer at recording time (§3) |
| D-C5 | Import conflicts | Whole batch refused on any conflicting external id; ≤ 100 messages per call; ids are scoped by `external_source` |
| D-C6 | Dating | A historical message may be at most 1 day ahead of now; logged activities keep the existing 366-day limit |
| D-C7 | Conversation order | Newest created first (stable keyset), not by last message |

## 11. Known risks

- Shared files (`access/permissions.ts`, `core/db/app-client.ts`, `tenancy.prisma`, `contracts/index.ts`)
  will conflict textually with People P1; both sides are additive. `prisma format` realigned the
  Contact and Activity blocks in `customers.prisma` (whitespace only).
- Restricted notes rely on the service filter (`visibleTo`), not RLS; every read goes through it and
  integration tests cover list, get, edit and remove.
- **Not privacy-complete:** contact/customer erasure is unsupported until the privileged pathway and the trigger, grant and FK changes in §7 exist.
- Message bodies are stored as plain text up to 100,000 characters; there is no content scanning.
