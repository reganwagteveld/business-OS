# Communications C2-B2: provider-mail storage, isolation, retention and sync design

**Status:** docs-only design; owner decisions D-B2-1 to D-B2-6 accepted 2026-11-17 (§13). Revised after the ChatGPT conditional design pass on `1ab55f6`
(customer-link visibility narrowed, Keep as record deferred, personal sharing semantics, follow-up exception,
definer hygiene, attachment proxy, erasure privacy). No code, schema, migration, privileged SQL, worker, cron, provider
call or deployment change. Nothing here is authorised for implementation until its own package is approved.
**Base:** `main` at `616a254`. **Brief:** Regan's owner decision record on PR #114 (2026-11-17): D-UI-1 to
D-UI-10 accepted, including the limited amendment of D-C2-6 (D-UI-4), and "C2-B2 as docs-only backend design;
no worker or real mail activation".
**Reads:** `communications-c2.md` (§1.1, §3.2, §4, §5, §9, §14 register, §16, §17), `communications-e1.md`
(§3 to §13), `communications-c2-ui.md` (PR #114), the C1, C2-A, C2-B1 and E1 migrations, the activity,
communications, search and reporting modules.

Providers are **fixture-tested only**. Nothing in this document claims that Google or Microsoft sync works;
every provider behaviour named below is to be verified live under Gate C before it is relied on.

---

## 1. Bottom line

1. **Provider mail gets its own namespace, not C1's tables.** Synced mail is stored in new `mail_*` tables
   keyed by mailbox (`connection_id`). C1's `conversations`, `messages`, `message_participants` and
   `activities` are not changed, keep `conversations_linked`, keep `source IN ('MANUAL','IMPORT')`, and never
   receive a synced row. Every existing C1, timeline, search and reporting path therefore cannot surface
   provider mail, because none of them reads these tables (§3, proved by tests in §11).
2. **Visibility is per mailbox and enforced twice:** by one service predicate and by a restrictive RLS
   policy on every `mail_*` content table (§6). PERSONAL and BUSINESS mailboxes never share rows, and the same
   email in two mailboxes is two independent copies.
3. **Unmatched mail is stored only when a mailbox opts in** (D-B2-1): `DISCARD` (default, the original D-C2-6
   behaviour), `STAGE_30D` (BUSINESS only, the approved 30-day enquiry intake), or `RETAIN` (kept under the
   ordinary period, or as unshared personal mail). Matching is a classification at ingest and a suggestion in
   the UI. It never links anything.
4. **Customer linking is explicit, per thread, BUSINESS-only and audited** (D-UI-7). A link is a row in
   `mail_thread_links`; linked threads appear on the customer through a **new** read path that applies the
   **same mailbox rules**, never as C1 rows or `message.recorded` activities. A link never widens who can read
   the mail (D-B2-3, revised after audit).
5. **E1 is extended to the new tables** (categories per copy, tombstones, holds narrowed to the mailbox,
   re-import markers, ledger and replay). That needs a new privileged SQL file, so the storage package carries
   one owner-gated `db:privileged` step (§8, §10).
6. **The worker is designed, not built.** C2-B3 owns it, behind a flag that is off and with no cron entry. It
   re-checks authority before every provider call and fences every content write with the job lease (§9).

---

## 2. Constraints carried in (not reopened)

| Source | Constraint this design honours |
|---|---|
| D-UI-4 (amends D-C2-6) | Unmatched mail only in segregated, mailbox-scoped storage; never auto-linked; never in C1 activity, timeline, global search or reporting; linking and promotion explicit and audited; 30-day enquiry staging kept; PERSONAL/BUSINESS separate; prefer independent tables over relaxing `conversations_linked`. |
| D-UI-5 | Read state is Pixa-side, per user. No provider modify scope. |
| D-UI-6 | No Pixa server drafts. Provider drafts at most a read-only, unstored view. |
| D-UI-7 | Customer linking manual, per thread, audited, BUSINESS only. PERSONAL never on a customer. |
| D-UI-8 | Attachment metadata only; content proxied on demand through a permission-checking route; never stored. |
| D-UI-9 | Sending needs `communications:send` and per-mailbox SEND (C2-C). READ never sends. |
| D-C2-7 | Backfill 90 days default (30/90/180/365, B4). |
| D-C2-9 / register | Retention per copy in four categories; ordinary period has no default and is required before BUSINESS sync and before personal content is shared or promoted (criterion 1); provider deletion not mirrored. |
| D-C2-12 | Attachments: manual saving only, later stage. |
| D-C2-13 | Direct send, minimal scopes; out of scope here except the shared thread model. |
| §16.5 / C2B1-01, A2-B review | Holder authority checked at every provider call; running jobs stop on revocation; content writes fenced. |
| E1 §17 obligations | Check `communications_erased_matches` before writing; record each copy's mailbox so CONNECTION holds narrow; re-test erasure racing sharing and revocation; off-database erasure record before real mail (D-E1-7). |
| D-E1-5 | RETAINED_RECORD has no duration yet, so it never expires automatically. |

---

## 3. Data model choice

| Option | What it means | Verdict |
|---|---|---|
| A. Extend C1 | Add `connection_id` to `conversations`/`messages`, `source = SYNC`, relax `conversations_linked`, add a mailbox clause to every C1 read. | **Rejected.** Every C1 read (`listConversations`, `listMessages`, `getConversation`, `activities.visibleTo`, customer timeline, the planned `communications.messages_recorded` report) would need a new predicate, and one missed path leaks personal mail business-wide. C1 messages are immutable for `bos_app`, so read state, folder moves and re-classification would need a new writer anyway. D-UI-4 asks us not to take this route without a proof. |
| B. Independent `mail_*` namespace | New tables for threads, messages, participants, folders, attachments, per-user state and links. C1 untouched. | **Chosen.** Isolation is structural: C1 code never names these tables (boundary rule), and no C1 table has a foreign key into them. |
| C. Copy into C1 on link | Linking a thread copies its messages into C1 rows. | **Rejected.** Two copies drift, double the erasure surface, and a copy in C1 escapes mailbox visibility after unlink. |

Consequence for E1: E1 §3 class 1 and 2 ("`messages.retention_category` written by C2-B3") move to
`mail_messages.retention_category`. `messages.retention_category` stays (always NULL for C1 rows); E1's
functions gain the `mail_*` tables (§8).

---

## 4. Proposed schema (one additive migration, package B2-1)

All tables: primary key `(business_id, id)` (or the natural composite key shown), `ENABLE` and
`FORCE ROW LEVEL SECURITY`, tenant policy on `app.business_id`, a `business_id`-leading index, and composite
tenant foreign keys `(business_id, …)` on every link. Column names are proposals.

### 4.1 `mail_threads`
| Column | Notes |
|---|---|
| `id`, `business_id`, `connection_id` | FK `(business_id, connection_id) → mail_connections` (ON DELETE RESTRICT; connections are never deleted, only disconnected). |
| `provider_thread_id` | Gmail `threadId`, Graph `conversationId`. NULL once erased. Unique `(business_id, connection_id, provider_thread_id)` where not NULL. |
| `subject` | Latest subject. Content; NULL once erased. |
| `first_message_at`, `last_message_at`, `message_count` | Maintained by the writer. |
| `shared_at`, `shared_by_id` | PERSONAL per-thread share (B2-2, D-B2-4). NULL otherwise. |
| `erased_at` | E1 tombstone. CHECK `erased_at IS NULL OR (subject IS NULL AND provider_thread_id IS NULL)`. |

### 4.2 `mail_messages` (one row per copy per mailbox)
| Column | Notes |
|---|---|
| `id`, `business_id`, `connection_id`, `thread_id` | FK `(business_id, thread_id) → mail_threads`; CHECK the thread's `connection_id` matches (trigger, since it spans tables). |
| `provider_message_id` | Gmail message id, Graph immutable id (`Prefer: IdType="ImmutableId"`, to verify). Unique `(business_id, connection_id, provider_message_id)` where not NULL: sync idempotency. |
| `rfc822_message_id`, `in_reply_to`, `references_digest` | Threading and C2-C correlation. Content-adjacent; NULL once erased. |
| `direction` | `INBOUND` / `OUTBOUND` relative to the mailbox. |
| `occurred_at`, `recorded_at` | Provider date and ingest time. |
| `subject`, `snippet`, `body_text`, `body_html` | `body_html` is **already sanitised** (§4.8); raw MIME and raw HTML are never stored. Size caps per part with a `truncated` flag. |
| `sanitizer_version` | Lets a later sanitizer re-process stored HTML. |
| `content_hash` | sha256 of normalised content; `sha256('erased:'‖id)` after erasure (as E1). |
| `ingest_basis` | `MATCHED` / `UNMATCHED` / `OWN_SENT` (sent from this mailbox) / `THREAD_FOLLOWUP` (an otherwise unmatched message in a thread that is already stored; §5). Classification only, shown to readers as "stored because…". |
| `retention_category` | NOT NULL: `PERSONAL_UNSHARED`, `STAGED_INTAKE`, `ORDINARY`, `RETAINED_RECORD`. Written only by the writer role and the E1/B2 functions (§7). |
| `category_changed_at`, `category_changed_by_id` | Last re-classification. |
| `provider_removed_at` | Provider-side deletion or move to Trash seen by sync. Not mirrored (register); shown as a badge. |
| `erased_at` | E1 tombstone; `*_erased_empty` CHECK as in E1. |

No `contact_id`, no `customer_id`: matching is never stored as a link.

### 4.3 `mail_message_participants`
`message_id`, `role` (`FROM`, `SENDER`, `TO`, `CC`, `BCC`, `REPLY_TO`), `position`, `display_name`, `address`,
`address_norm` (lower-cased, for erasure and suggestion lookups), `erased_at`. Written only together with
their message (same guard as E1 §9). No contact FK.

### 4.4 `mail_folders` and `mail_message_folders`
`mail_folders`: per connection, `provider_folder_id` (Gmail label id, Graph folder id), `kind`
(`INBOX`, `SENT`, `ARCHIVE`, `CUSTOM`, `OTHER`), `display_name` (content-like for custom labels; erased with the
connection's history only by a CONNECTION-scope purge). `mail_message_folders`: membership, replaced on each
sync of the message. Spam, Trash and Drafts are **not synced** (D-B2-5); a message that moves there gets
`provider_removed_at`.

### 4.5 `mail_attachments` (metadata only, D-UI-8)
`message_id`, `provider_attachment_id` (erased), `filename` (content, erased), `content_type`, `size_bytes`,
`is_inline`, `content_id`. No bytes. The download proxy (UI-A backend) checks visibility of the message, then
streams from the provider with the holder's credential; nothing is cached or written to disk. It sends
`Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`, and never
logs file names, URLs or provider ids (only the attachment row id and a result code). The holder-authority
check of §9 step 3 applies to each download.

### 4.6 `mail_message_user_state` (D-UI-5)
`(business_id, message_id, user_id)` primary key; `read_at`, `version`. Restrictive policy `user_id =
app.user_id` for INSERT/UPDATE/DELETE; SELECT also needs the message to be visible. Cascade on membership
removal. Holds no content and is not touched by erasure.

### 4.7 `mail_thread_links` (D-UI-7)
`id`, `thread_id`, `connection_id`, exactly one of `customer_id` / `contact_id` (composite FKs), `linked_by_id`,
`linked_at`, `unlinked_by_id`, `unlinked_at`, `version`. Partial unique index on live links per
`(thread_id, customer_id|contact_id)`. Insert guard: the connection is `kind = 'BUSINESS'` (PERSONAL refused,
new SQLSTATE), the retention period is set (CM009), and the thread is not erased. No DELETE grant; unlink is
an update. Every link and unlink is audited.

### 4.8 HTML handling (stored side)
The writer stores only sanitised HTML: an allow-list sanitiser (no scripts, styles limited, no forms, no event
handlers, no `javascript:`/`data:` URLs except inline `cid:` images, remote images rewritten to a blocked
placeholder unless the viewer opts in, links forced to `target=_blank rel="noopener noreferrer"`). The reader
(UI-A) additionally renders in a sandboxed iframe without `allow-scripts` or `allow-same-origin` and a strict
CSP (PR #114 §6). Inline `cid:` images are served only through the same permission-checked proxy, and
`cid:` rendering and remote-image blocking are part of the hostile-content QA corpus (§11). Sanitising on write means a sanitiser bug is fixed by bumping `sanitizer_version` and
re-sanitising from the provider on next sync, never by rendering stored raw HTML.

### 4.9 Changes to existing tables
- `mail_connections`: `unmatched_policy` (`DISCARD` default, `STAGE_30D`, `RETAIN`; CHECK `STAGE_30D` only
  for BUSINESS), `unmatched_policy_changed_at/_by_id`, `backfill_days` (B4), `personal_purge_after`
  (§8.4). Update guard: only the roles in D-B2-1 may change the policy; retention must be set first (CM009).
- `communications_legal_holds`: no schema change; CONNECTION scope is now enforced per mailbox (§8).
- `communications_erasures`: nullable `mail_message_id` and `mail_thread_id` (composite FKs), `target_type`
  gains `MAIL_MESSAGE` and `MAIL_THREAD`, and the one-target CHECK and open-request unique index are widened
  to the new columns. `communications_erasure_items.entity_type` gains `MAIL_MESSAGE`, `MAIL_THREAD`,
  `MAIL_PARTICIPANT`, `MAIL_ATTACHMENT`. `communications_privileged_grants.operation` gains
  `ERASE_MAIL_MESSAGE`, `ERASE_MAIL_THREAD` and `ERASE_OWN_MAIL_THREAD`. Re-import markers keep kinds
  `MESSAGE`/`THREAD` with a mail-specific source string (§8.2). All are CHECK widenings on small tables.
- No change to `conversations`, `messages`, `message_participants`, `activities`.

### 4.10 Grants
`bos_app`: SELECT on all `mail_*`; INSERT/UPDATE on `mail_message_user_state`, `mail_thread_links` (link and
unlink columns only), the `shared_*` columns of `mail_threads`; nothing else. **Content is written only by a
dedicated path** (§7): `bos_app` gets no INSERT on `mail_messages`, `mail_threads`, participants, folders or
attachments, and no UPDATE of content or category columns. Default privileges revoked first, as E1 does.

---

## 5. Classification at ingest and the unmatched policy

**Matched** means a non-mailbox participant whose `address_norm` equals a live contact's email in this
business (exact, case-insensitive; aliases not recognised, as C2-B1 §16.12(5)). Sent mail from the mailbox
is `OWN_SENT`, classified like matched mail (the user chose to write it).

| Mailbox | Message | Stored? | Category |
|---|---|---|---|
| PERSONAL, OWNER_ONLY | matched, own sent or follow-up | yes | `PERSONAL_UNSHARED` |
| PERSONAL, OWNER_ONLY | unmatched | only if policy `RETAIN` | `PERSONAL_UNSHARED` |
| PERSONAL, sharing BUSINESS | as above | as above | new copies: `ORDINARY` if within the ordinary period at ingest, otherwise not stored (§5 rule on already-due copies); existing copies per §5.1 (D-B2-4) |
| BUSINESS | matched, own sent | yes | `ORDINARY` |
| BUSINESS | unmatched follow-up in a thread already stored (`THREAD_FOLLOWUP`) | yes, under every policy (exception below) | `ORDINARY` (or `STAGED_INTAKE` if the whole thread is still staged) |
| BUSINESS | unmatched | `DISCARD`: no. `STAGE_30D`: yes. `RETAIN`: yes | `STAGE_30D` → `STAGED_INTAKE`; `RETAIN` → `ORDINARY` |

Rules:
- PERSONAL mail is never staged (register).
- **The follow-up exception (audit point D-B2-1/2).** Under `DISCARD`, an unmatched message is still stored
  if its provider thread already has stored messages in this mailbox (for example a customer's colleague
  replying to a matched thread, or a reply from an unknown address to mail the mailbox sent). Without it a
  stored thread would show gaps and replies would vanish. The exception is narrow: it is decided per mailbox
  from that mailbox's own stored threads (never another mailbox's), it never creates a thread, and it never
  links anything. Readers see the reason ("stored because this conversation is already kept"). It is part of
  D-B2-1 for the owner to accept or refuse; refusing it means threads may show gaps.
- Matched and sent BUSINESS mail is `ORDINARY`, which needs the business's ordinary period: BUSINESS sync is
  already refused until it is set (CM009, §16.6), so there is never an ORDINARY copy without a configured period.
- A message whose computed `mail_retention_due_at` is already past at ingest (old backfill under a short
  period, or staged mail older than 30 days) is **not stored**, rather than stored and purged.
- `DISCARD` stores nothing about the message: no row, no counter, no marker. Only the job's page counts
  (`skipped`) are kept, with no identifiers.
- Changing the policy is audited (`communications.mailbox.unmatched_policy_changed`, old and new value) and
  applies to future ingest only. Switching to `DISCARD` does not delete what is stored; staged copies still
  expire on their 30 days, retained ones follow their category.

**Leaving intake (`STAGED_INTAKE` → `ORDINARY`).** Only by an explicit, audited action of a mailbox READ
member: *Keep* or *Link to customer/contact* (D-UI-7). Re-classification is per thread and applies to every
copy in it. Nothing leaves intake automatically, including a later contact match (it becomes a suggestion
only). The ORDINARY due date is computed from each message's own date, so keeping a 25-day-old enquiry does
not restart any clock.

**Keep as record (`RETAINED_RECORD`) is reserved, not enabled (D-B2-6, revised after audit).** The category
exists (E1), and B2-2 documents the action, but the action stays **disabled** (refused by the database
function, not only hidden) until the E1 §13.1 retention durations, lawful basis and expiry semantics are
approved. When enabled, a record copy gets the approved duration through `mail_retention_due_at`; nothing in
this design creates indefinitely retained live data.

### 5.1 Personal sharing and categories (D-B2-4, specified after audit)

| Event | Visibility | Category | Retention clock |
|---|---|---|---|
| Owner shares the mailbox business-wide, or shares one thread | widened to `communications:read` (mailbox or thread) | every existing and future copy covered becomes `ORDINARY` | due = message date + ordinary period in force. Not reset by sharing. |
| Sharing would cover copies already past the ordinary period | – | – | Those threads are **refused** for sharing (the owner is told they are older than the business keeps mail), so sharing never triggers an unexpected purge. Mailbox-wide sharing shares only the copies within the period; older ones stay personal. |
| Owner unshares (mailbox or thread) | back to owner only | **stays `ORDINARY`** (sticky) | unchanged: the copy still expires on its ordinary date |
| Copy reaches its due date while shared or after unsharing | – | – | purged by E1 as any ORDINARY copy, unless a hold covers it |
| Legal hold placed | – | unchanged | purge and erasure deferred as in E1 |

Why sticky: reverting to `PERSONAL_UNSHARED` on unshare would make a copy the business already had access to
non-expiring again (indefinite retention by category change) and would let share/unshare cycles evade the
ordinary schedule. Keeping it `ORDINARY` means unsharing restores privacy but never extends retention. The
owner can still erase their own *unshared, never-shared* copies (D-B2-5); a once-shared copy is erased
through an E1 request or its retention date. There is no export feature to account for; any future export
must respect visibility at the time of export.

---

## 6. Visibility and permissions

### 6.1 Who can read which copy

| Copy in… | Readable by (each must be an ACTIVE member with `communications:read`) |
|---|---|
| PERSONAL, OWNER_ONLY | The mailbox owner only. `manage_connections` sees connection metadata, never content or counts (§4). |
| PERSONAL, sharing BUSINESS | Every member with `communications:read`, **per copy**: only copies that are `ORDINARY` because of the share. Copies left `PERSONAL_UNSHARED` (older than the period when the mailbox was shared, §5.1) stay owner-only: not listed, not counted, not searchable, attachments not downloadable, hidden by RLS. A thread mixing both shows shared viewers only its shared copies. |
| PERSONAL, one thread shared (B2-2) | Owner, plus every member with `communications:read` for that thread only. |
| BUSINESS | Members of `mail_connection_members` with READ or SEND. `manage_connections` without membership sees metadata only (C2-B1 §16.4); an admin who wants content adds themselves, which is audited. |
| BUSINESS thread linked to a customer/contact | **The same mailbox members only** (D-B2-3, revised). The customer's correspondence view lists a linked thread only to viewers who could already read it in the mailbox, and they also need `customers:read` to open the customer. A link adds no readers and no future-message exposure beyond the mailbox's own rule. |

A wider audience for customer-linked mail (an explicit per-thread "share to customer" with a named
audience, a per-message decision about later messages, revocation and audit) is **not** in this design. It
would need its own owner decision and audit.

A departed, suspended or demoted member loses access at once, because every check reads the live
membership. Visibility never depends on the UI; invisible rows answer 404.

### 6.2 Enforcement
1. **Service predicate:** one function, `mailReadScope(viewer)`, used by every `mail_*` read, list, count,
   download and suggestion query, in the same style as `activities.visibleTo`. A boundary rule allows only
   `modules/communications/server/mail/*` to query `mail_*` tables, and forbids C1, activity, search and
   reporting modules from importing it.
2. **RLS, defence in depth:** a restrictive SELECT policy on `mail_threads`, `mail_messages`,
   `mail_message_participants`, `mail_attachments`, `mail_message_folders` and `mail_thread_links` that calls a
   `STABLE` function `mail_viewer_may_read(business_id, connection_id, thread_id)` evaluated against
   `app.user_id`. It encodes the table in §6.1 using memberships and roles (in the current fixed role map every
   role has `communications:read` and `customers:read`; a future custom-role feature must update the function
   and is flagged in its tests). Because `bos_app` sets `app.user_id`, this protects against query bugs, not
   against a compromised runtime; that remains the tenant boundary's job.
3. **Writer and erasure roles** get their own policies (§7, §8); the E1 eligibility view keeps excluding
   `PERSONAL_UNSHARED` from counts.

### 6.3 Actions and permissions (no new permission key in B2)

| Action | Requirement |
|---|---|
| List mailboxes, threads, messages; read; mark read | `communications:read` + §6.1 |
| Download an attachment (proxy, UI-A backend) | as read, plus the connection `ACTIVE` with a live holder |
| Change unmatched policy | BUSINESS: `manage_connections`; PERSONAL: the owner (D-B2-1) |
| Keep a staged thread | BUSINESS mailbox READ/SEND member |
| Link / unlink a thread to a customer or contact | BUSINESS mailbox READ/SEND member + `customers:write` (D-B2-3) |
| Keep as record (RETAINED_RECORD) | **Disabled** until E1 §13.1 is approved; then BUSINESS mailbox member + `manage_connections` (D-B2-6) |
| Share / unshare one personal thread | PERSONAL owner, retention set (criterion 1) |
| Erase own unshared personal copies | PERSONAL owner with a single-use code (D-B2-5) |
| Send (C2-C) | `communications:send` + SEND membership (D-UI-9) |

---

## 7. Writer path

Synced content must not be writable by ordinary request code, and E1 already refuses categorised inserts
from `bos_app`. Two options:

- **W1 (recommended): a `SECURITY DEFINER` writer function** owned by a writer role (`bos_maint`-style,
  privileged SQL), `app_private.mail_ingest_page(job_id, lease_id, payload jsonb)`. It checks, on database
  time and in the same transaction: the job lease is valid; the connection is `ACTIVE`, sync enabled,
  holder (BUSINESS) or owner (PERSONAL) still an active member with the needed role; retention set for
  BUSINESS; no erased marker matches (E1 `communications_erased_matches`); the thread is not erased. It then
  classifies (§5), inserts or updates rows, and returns per-message outcomes (`stored`, `duplicate`,
  `skipped_unmatched`, `skipped_due`, `erased`, `thread_erased`) with no identifiers in the response beyond
  provider ids the caller already holds.
- W2: a separate database login for the worker. Rejected: another credential in Vercel and a new role in
  the roles script, for no extra isolation over W1.

Re-classification, keep, link, share and record go through narrower definer functions with the actor's
session token checked as in E1 (`communications_erasure_actor` pattern), so the database, not only the
service, refuses an unauthorised promotion.

**Definer and RLS hygiene (audit condition), required of B2-1:**
- Each function has a named owner role (`bos_definer` for read-only cross-checks such as
  `mail_viewer_may_read`; `bos_maint` for writers and erasure), `SECURITY DEFINER`, and a fixed
  `SET search_path = pg_catalog, public` with every object schema-qualified.
- `REVOKE ALL ON FUNCTION … FROM PUBLIC`; `GRANT EXECUTE` only to `bos_app`, and only for the entry points
  (`mail_ingest_page`, the action functions, `mail_viewer_may_read`). Internal helpers have no runtime grant.
- Every entry point re-checks, per call: the tenant (`app.business_id` matches the row), the actor (session
  token for user actions, job lease on database time for ingest) and the connection state. Nothing is trusted
  from arguments alone.
- The owner roles' own policies are scoped to the current business (`maint_tenant` pattern from E1).
- Tests run as the real runtime role against `FORCE ROW LEVEL SECURITY` tables in a database built like CI
  and production (roles script, migrations, `db:privileged`), and check that the table-owning role is never
  used at runtime.
- Writing `006` to production with `db:privileged` needs Regan's own separate approval.

---

## 8. Retention and erasure over `mail_*` (E1 extension)

### 8.1 Retention
- `mail_retention_due_at` is reused: ORDINARY = `occurred_at` + period in force (with the 30-day shortening
  delay), STAGED_INTAKE = `recorded_at` + 30 days, PERSONAL_UNSHARED never (approved register; bounded in
  practice by self-erasure, D-B2-5, and the departure purge, §8.4).
- **RETAINED_RECORD:** while "Keep as record" is disabled (D-B2-6) the writer and every action function refuse
  this category for mail copies, so **no live mail copy can hold it** (tested). Enabling the action is a later,
  separately approved change that must, in the same change, give `mail_retention_due_at` the approved finite
  E1 §13.1 durations for mail record copies, so that eligibility and purge treat them like every other dated
  category. This design never relies on, or promises, indefinite retention for this category.
- The purge, the scheduler due query and the eligibility endpoint read `mail_messages` as well as `messages`,
  with the same function, so "due" means the same everywhere (E1 test carried over).

### 8.2 Erasure
- Tombstone in place: subject, snippet, bodies, `rfc822_message_id`, `in_reply_to`, `references_digest`,
  provider ids, participant names and addresses, attachment filenames and provider ids. Ids, dates,
  direction, category and thread structure stay. A thread loses subject and provider id when all its
  messages are erased.
- Targets: `MESSAGE` and `CONVERSATION` (as E1) gain their mail equivalents `MAIL_MESSAGE` and `MAIL_THREAD`;
  `CONTACT` erasure also scans `mail_message_participants.address_norm` across **every** mailbox (personal
  included), applying E1's full/partial rule per copy. Erasure is a duty, so it sees mail no admin can read.
  **Non-disclosure policy (audit condition, revised):** a requester never learns anything about copies they
  cannot read.
  - Everything the requester sees (the request status, its counts, its review items, its audit event, the
    ledger rows `bos_app` can select) is computed **only** from records the requester could read at request
    time: C1 rows and mail copies visible to them under §6.1.
  - Erasure of copies they cannot read (other people's personal mail, business mailboxes they are not a
    member of) is carried out in the same request, but its items, counts and any hold deferral are recorded
    only in privileged ledger rows that no runtime role can select. The requester-visible status is derived
    from visible items alone, so a hold deferring only an invisible copy does not show as `DEFERRED` to them;
    the privileged part is rechecked daily like any deferral.
  - Global totals are available only to the owner through a documented privileged procedure (the same
    `bos_maint` access used for replay), to evidence compliance if a regulator or the data subject requires
    it; each such read is logged in the ledger.
  - Tests compare **values**, not just shape: the same request, against the same visible data, returns
    identical counts, status and items whether the business holds zero or many invisible personal copies of
    that contact, including when one of them is under a hold.
  Whether a statutory obligation requires keeping some of those copies is an E1 §13 legal item; holds and
  deferrals apply exactly as for C1 copies.
- Re-import markers: kind `MESSAGE` (and `THREAD`) with source `mail:<provider>:<connection_id>`, so the
  HMAC input is `MESSAGE:mail:<provider>:<connection_id>:<provider_message_id>` and the
  same provider id in two mailboxes is two markers. Ingest checks them before writing (§7), and only for its
  own connection's source string, so the check cannot be used to learn whether another mailbox held a message.
  Markers stay unreadable to every runtime role (E1).
- Holds: `CONNECTION` now covers exactly that mailbox's `mail_*` copies (E1 §6.2 obligation). `BUSINESS`
  and `CONTACT` holds cover mail copies too.
- Ledger, replay and replay-remaining cover the four new entity types. Restore procedure (E1 §10) unchanged.
- Lock order (E1 §9) extended: request row → hold lock (shared) → retention settings `FOR SHARE` (purge) →
  `mail_threads` by id → `mail_messages` by id → participants and attachments. Ingest takes the hold lock in
  shared mode and the thread `FOR KEY SHARE` before checking `erased_at`, so ingest into a thread being erased
  waits and is then refused (`thread_erased`), as C1 inserts are.

### 8.3 Personal self-erasure (D-B2-5)
E1 erasure needs OWNER or ADMIN, who cannot see unshared personal mail, and personal copies never expire
while provider deletion is not mirrored. Recommended: the mailbox owner may erase their own
`PERSONAL_UNSHARED` threads, with an `ERASE_OWN_MAIL_THREAD` single-use code bound to that thread, audited as
`communications.erasure.own_mail_erased` (ids only). Holds still defer it.

### 8.4 Departure and disconnect
- PERSONAL owner leaves the business: access ends at once (C2-B1). `personal_purge_after = departure + 30
  days` is set by the membership lifecycle event; then all the mailbox's `PERSONAL_UNSHARED` copies become due
  (confirmed reading of the 30-day grace, §16.5). Copies already shared (ORDINARY) stay under the ordinary
  period. Rejoining before the date clears it.
- Disconnect (either kind): history kept (D-C2-9), no new ingest, retention continues.
- BUSINESS holder departs: no content effect; the mailbox needs a new holder (§16.5).

### 8.5 Gates before any real mail (unchanged, restated)
E1 §13 items 1, 2, 3 and 6 (RETAINED_RECORD durations, marker expiry, off-database erasure record, backup and
branch retention), STAB-H2, Gate C per provider, owner set-up, and Regan's own approval for the E1 worker, the
sync worker and any cron.

---

## 9. Worker lifecycle (design for C2-B3; nothing built in B2)

1. **Dispatch.** `app_private.mail_sync_due(limit)` (`bos_definer`, privileged SQL) returns
   `(business_id, connection_id)` only. Route `POST /api/internal/jobs/mail-sync`, bearer `CRON_SECRET`
   (constant-time), answers 503 unless `COMMUNICATIONS_MAIL_SYNC_ENABLED=true`. **Not** in `vercel.json`.
2. **Claim** with the C2-A lease (`claimSyncJob`), acting as the owner (PERSONAL) or holder (BUSINESS).
3. **Before every provider call:** re-read on database time that the lease is valid, the connection is
   `ACTIVE` with sync enabled, the holder/owner is an active member with the needed role, retention is set
   (BUSINESS), and the credential version is unchanged. Any failure ends the job at that step (C2B1-01,
   A2-B review). The in-memory access token is dropped.
4. **Fetch** a page (Gmail `history.list` then `messages.get`; Graph `delta` on the mailbox folders), parse
   MIME, sanitise, compute `ingest_basis`.
5. **Write** the page through `mail_ingest_page` (§7) in one transaction that also advances the cursor; the
   function refuses if the lease expired, so a reclaimed or revoked job writes nothing.
6. **Heartbeat** between pages; checkpoint after each page so a function timeout loses nothing.
7. **Errors:** retryable codes back off (30 s × 2^n, max 1 h, or `Retry-After`); `invalid_grant` →
   `NEEDS_REAUTH`; cursor expired → `FULL_RESYNC` bounded by `backfill_days`.
8. **Never** writes provider-side state, never sends, never stores attachment bytes.
9. **Activation** (Regan's own approval each): flag on in Production, cron entry in `vercel.json`, a real
   mailbox connected, after the gates in §8.5.

---

## 10. Migration and privileged SQL plan

| Item | Package | Stamp / file | Notes |
|---|---|---|---|
| Mail store tables, RLS, guards, grants, `mail_connections` columns, ledger CHECK changes | B2-1 | `2026121X000000_communications_mail_store` (must sort after every stamp on `main` and open PRs; today the newest open is `20261207000000_workflow_links`, PR #110) | Additive. New empty tables; `mail_connections` gets columns with defaults. No rewrite of populated tables, so no rehearsal needed beyond CI, unless the audit asks. |
| Writer, reclassify/link/share/self-erase functions, E1 function extensions, `mail_viewer_may_read` | B2-1 | `apps/api/prisma/privileged/006_communications_mail_store.sql` | `db:privileged` on production is **Regan's own approval**, not delegated. |
| `mail_sync_due` dispatcher | B3 | `007_…` | Regan's approval (privileged). |
| Backfill and ops columns, if any | B4 | later stamp | |
| Outbound tables | C2-C | later stamp | |

Production steps follow the protocol: read `_prisma_migrations`, recovery branch `pre-c2b2-migration`
validated, evidence on the PR, `APPROVED — EXECUTE: MIGRATION` naming the file, apply, then Regan's own
approval for `db:privileged`, verify, then merge under a separate merge verdict. Code must not land before its
schema (the read API reads the new tables).

**Rollback** (before any mail is stored): drop the new tables and functions, drop the added columns,
restore the ledger CHECKs, re-apply E1's privileged 004 definitions, delete the `_prisma_migrations` row. The
B2-1 PR must include the exact script and prove it locally with a `pg_dump --schema-only` comparison, as
C2-B1 did. Once real mail exists rollback is not offered; fixes go forward.

---

## 11. Test matrix

| Area | Tests (integration against PostgreSQL unless noted) |
|---|---|
| C1 isolation | Seed `mail_*` rows (matched, unmatched, linked, personal, business) and assert every C1 endpoint, `listActivities`, customer and contact timelines, conversation detail, GS1 search providers and reporting metrics return exactly what they return without them. Boundary rule test: no C1, activity, search or reporting file imports the mail module or names a `mail_*` table. |
| Visibility matrix | OWNER, ADMIN, MANAGER, MEMBER × PERSONAL owner, PERSONAL other, PERSONAL shared, personal thread shared, BUSINESS READ, BUSINESS SEND, BUSINESS non-member admin, linked-thread customer viewer, departed, suspended, demoted. For list, read, counts, attachment download, suggestions: allowed or 404. |
| RLS defence | Same matrix by direct SQL as `bos_app` with `app.user_id` set: restrictive policy hides rows even when the service predicate is bypassed. Cross-business: nothing visible, composite FKs refuse cross-tenant links. |
| Writer | Lease expired, reclaimed, cancelled; connection paused, NEEDS_REAUTH, disconnected; holder departed or demoted mid-job; retention unset; erased marker; erased thread; duplicate page (idempotent); `DISCARD`/`STAGE_30D`/`RETAIN` per kind; PERSONAL never staged; already-due copies not stored; `bos_app` cannot insert or update content or category. |
| Classification and promotion | Keep, link, record, share each change category exactly as §5/§6.3, are audited, refuse PERSONAL links (SQLSTATE), refuse without retention (CM009), refuse unauthorised actors at the database (forged session, wrong user). Later contact match never promotes. |
| Retention | Category boundaries for mail copies (29/31 days staged; period ±1 day ordinary); shortening delay applies; eligibility counts equal what purge erases; personal counts never exposed. |
| Erasure | Mail message, thread, contact across mailboxes (full and partial), attachments' filenames, markers per connection, CONNECTION hold scoped to one mailbox, BUSINESS hold, deferral, replay of all four entity types, personal self-erasure code (own thread only, single use, expiry). |
| Races | Ingest vs thread erasure; ingest vs hold placement; ingest vs sharing change; ingest vs connection revocation; link vs erasure; purge vs reclassify; two workers on one job. |
| Departure | `personal_purge_after` set on removal, cleared on rejoin, copies due after 30 days, shared copies untouched. |
| HTML (unit) | Hostile corpus: scripts, event handlers, `javascript:`/`data:` links, CSS expressions, forms, tracking pixels, remote images blocked by default, `cid:` references to other messages or missing parts, malformed MIME, huge parts (truncation), charset edge cases. |
| Linked views (D-B2-3) | Customer correspondence view hides linked threads from viewers without mailbox READ, in the service and by RLS; later messages in a linked thread follow mailbox rules only. |
| Personal categories (D-B2-4) | Share → ORDINARY with unchanged due date; share refused for past-due threads; unshare keeps ORDINARY; share/unshare cycles never move a due date; hold defers purge. Mailbox-wide share: excluded older copies stay hidden from shared viewers in lists, counts, thread views, search, attachment download and direct SQL under RLS; new mail follows the same per-copy rule. |
| Erasure non-disclosure | Requester-visible status, counts and items are equal with and without invisible personal copies of the contact (including one under a hold); privileged totals readable only by the owner procedure. |
| RETAINED_RECORD | No writer or action can create a mail copy in this category while disabled. |
| Follow-up exception | Under `DISCARD`, an unmatched reply is stored only when the same mailbox already stores that thread; never creates a thread; another mailbox's threads have no effect. |
| Keep as record | Refused by the database while disabled. |
| Definer hygiene | Fixed `search_path`, no PUBLIC execute, helpers not callable by `bos_app`, all as the runtime role under forced RLS. |
| Privacy | No address, subject, body or filename in any audit row, job row, error code, log line or ledger row. |
| Migration | Fresh database build, `db:check-migrations`, rollback script schema comparison. |

---

## 12. Packages

| Package | Contents | Migration | Activation | Depends on |
|---|---|---|---|---|
| **B2-1 Mail store** | §4 schema, RLS, writer and E1 extension (§7, §8), read API (mailboxes, threads, messages, read state) with the visibility predicate, unmatched-policy setting, contracts, tests. No caller of the writer except tests. | Yes + privileged 006 | None | This design accepted |
| **B2-2 Mail actions** | Keep, link/unlink, keep as record (built but disabled until E1 §13.1), personal thread share, personal self-erasure, customer correspondence read path. | Possibly none (columns in B2-1) | None | B2-1 |
| **B3 Sync** | Adapters `listChanges`/`fetchMessage`, MIME parsing, sanitiser, worker, dispatcher (privileged 007), flag off, no cron. | Privileged 007 | Off; Regan to enable | B2-1, E1 §13 items for real mail |
| **B4 Sync operations** | Backfill choice, reauth/error surfaces, rate-limit handling, contact-match suggestions on read, intake triage view support, ops metrics. | Maybe | None | B3 |
| **C2-C Send** | `communications:send`, outbound table and states, send scopes by re-consent, correlation tests per provider. | Yes | Regan (scopes, external effect) | B3 |

UI packages (PR #114 §5): UI-A after B2-1/B3, UI-B after C2-C, UI-D after B2-2.

---

## 13. Decisions needed

Owner decisions (Regan):

| # | Decision | Recommendation |
|---|---|---|
Revised on 2026-11-17 after the ChatGPT audit of `1ab55f6` (conditional design pass) and its re-audit of
`783ce01`, which recommended YES to each as revised.

**ACCEPTED by Regan on 2026-11-17 (09:51 UTC, in the project thread: "Yes I approve the recommendations"):
D-B2-1 to D-B2-6 exactly as recommended below**, including the stored-thread follow-up exception (D-B2-1),
no new readers through customer links (D-B2-3), sticky ORDINARY expiry for shared personal mail (D-B2-4) and
"Keep as record" disabled until the E1 §13.1 durations are approved (D-B2-6). This accepts the design only.
It does not authorise B2-1 implementation, any migration, privileged SQL, worker, cron or real mail; each
still needs its own approval.

| # | Decision | Recommendation |
|---|---|---|
| D-B2-1 | Unmatched-mail policy per mailbox: `DISCARD` / `STAGE_30D` (BUSINESS only, the opt-in 30-day enquiry staging) / `RETAIN`; who sets it; and the follow-up exception (§5): unmatched replies in a thread the mailbox already stores are kept. | Default `DISCARD` for both kinds. BUSINESS set by `manage_connections`; PERSONAL by its owner. Retention must be set first. Accept the follow-up exception. |
| D-B2-2 | Matched and sent BUSINESS mail is ORDINARY from ingest (not staged), under the business's configured period; only unmatched mail can be staged. | Yes. BUSINESS sync is already refused until the period is set. |
| D-B2-3 | **Revised:** a customer link is a navigation aid only. The linked thread shows on the customer only to people who can already read that mailbox; it never adds readers. Linking needs mailbox membership + `customers:write`; link and unlink audited. | Yes. A wider "share to customer" audience would be a separate decision later. |
| D-B2-4 | **Specified:** sharing personal mail makes those copies ORDINARY, with the clock from each message's date (no reset); copies already past the period cannot be shared; unsharing restores privacy but the copies stay ORDINARY and still expire on schedule (§5.1). | Yes. This prevents both indefinite retention and evasion by unsharing. |
| D-B2-5 | Spam, Trash and Drafts are not synced; personal mailbox owners may erase their own never-shared personal threads with a single-use code. | Yes to both. |
| D-B2-6 | **Revised:** "Keep as record" stays disabled until E1 §13.1 retention durations are approved; then it uses the approved durations. | Yes, defer. |

Technical choices for the audit (ChatGPT may decide): independent namespace (§3); RLS restrictive policy as
well as the service predicate (§6.2); definer writer function W1 (§7); sanitise on write, never store raw
HTML or MIME (§4.8); per-connection markers (§8.2); contact erasure across personal mailboxes with totals-only
results (§8.2); not storing already-due copies (§5).

## 14. Verification statement

- Verified by reading code on `main` at `616a254`: C1 table definitions and constraints, E1 columns and
  guards, C2-A/C2-B1 connection and member tables, permission keys, `activities.visibleTo`, absence of
  messages in GS1 search providers, the planned `communications.messages_recorded` metric, open PR migration
  stamps (#97 `20261206000000`, #110 `20261207000000`).
- Not verified: any provider behaviour (Gmail history, Graph delta and immutable ids, label/folder mapping,
  shared-mailbox Sent copies), production state, performance of the RLS function at volume. These are
  assumptions to test in B3 and Gate C.
- This document changes no behaviour, schema or deployment.
