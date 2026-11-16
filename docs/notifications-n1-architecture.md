# Notifications N1: architecture

**Status:** proposal, documentation only. Nothing in this document is built, and nothing here is approved
until Regan approves it. No tables, migrations, queues, workers, schedules or email providers are added by
the PR that carries this document.
**Base:** `main` at `b2f308b` (2026-11-16).
**Owner decisions:** §20 (D-N1-1 to D-N1-18), accepted by Regan on 2026-11-16 subject to the audit safeguards; D-N1-18 conditionally, for the restricted beta only. Acceptance of the design is not approval to implement, migrate or merge.
**Revision 2 (2026-11-16):** answers the ChatGPT audit on PR #80 (head `c7424bc`): explicit `notify`
outcomes and failure policy (§7.1.1), an ACL-safe badge (§5.4), N1-A limited to producers whose hooks
and transaction context exist today (§18.1), a trusted write path for `user_notices` (§11.2), mandatory
notices exempt from caps and failing closed (§16.1), bounded cleanup without a scheduler (§13.1), and
business export separated from personal-data access (§13.3). Audit response table: §23.
**Revision 3 (2026-11-16):** answers the re-audit on head `4850b9d`: every write `bos_app` cannot make
under the recipient-only policies (cleanup, erasure, resolving) now goes through narrow privileged
functions (§5.2.1); the 50-per-hour limit is a skip, not a fold (§16); access and role changes are
user-level notices only, so a demotion can never be blocked by its own notice (§11.3, §18.1); the badge
is described as an ACL-safe lower bound (§5.4). Response table: §23.2.
**Revision 4 (2026-11-16):** answers the third audit on head `de7619b`: erasure, resolving and all
user-level notices are written by **database triggers on the real state change** (no function a tenant
session can call to erase, resolve or write a notice), so provenance is the committed transition itself
(§5.2.1, §11.2); §7.1.1 now separates the tenant-inbox `notify` path from the trigger path. Response
table: §23.3.

---

## 0. Summary

Pixa OS has no notification system today. The bell was removed from the top bar until one exists
(UI V2-A, D-V2A-6), and nothing on `main` writes, stores or shows a notification.

This document proposes one, built in stages:

1. **N1-A (MVP): in-app inbox, event-driven only.** When a Zone makes a change that someone else should
   know about (a task assigned to you, ownership of a customer given to you, a quote you raised marked
   accepted), the Zone's own service writes a notification row **in the same database transaction** as
   the change. There is no queue, no worker, no cron and no email. Nothing has to be switched on in
   production apart from the migration itself, and if the transaction rolls back, so does the
   notification.
2. **N1-B: preferences and noise control.** Per-user mute and per-type settings, business defaults,
   grouping.
3. **N1-C: time-based notifications** (overdue invoice, task due, event starting). These need a
   scheduler, which is deliberately off in production. N1-C reuses the existing cron-route pattern and
   stays dormant until Regan turns it on.
4. **N1-D: email channel.** A delivery outbox and worker over the existing `core/email` transport,
   dormant until approved, with privacy-safe templates.
5. **N1-E: later channels** (desktop OS notifications through Tauri, web push, SMS), each a separate
   decision.

The two boundaries that make it safe:

- **Authoritative delivery boundary.** The notification inbox row is the only source of truth that a
  notification exists. Every channel (in-app list, badge, email, desktop) is a view of, or a delivery
  attempt for, that row. A channel never invents a notification, and a failed email never removes or
  changes the inbox row.
- **Permission boundary.** A notification is **a pointer, not a copy**. It says that something happened
  to a record and links to it. It carries only text that every eligible recipient was already allowed
  to see, and for sensitive classes (People, leave, payroll, finance amounts, mailbox content) it
  carries **no record text at all**. Eligibility is checked when the row is written **and again every
  time it is read**. Opening the record goes through the owning Zone's API, which applies its own
  checks as it does today.

---

## 1. What exists today (verified on `main` at `b2f308b`)

| Area | What the repository has | Relevance |
|---|---|---|
| Notifications | None. No table, module, contract or UI. `docs/ui/app-shell.md` and `docs/ui/pixa-design-system-v2-a.md` §8 say notifications are "not available yet" and must not be faked. | N1 starts from zero. The UI must not show a bell until N1-A ships. |
| Cross-module side effects | `architecture.md` §5.2 rule 5: called explicitly from the service, **inside the same database transaction**; an in-process event bus is deferred until there are enough consumers. | N1-A follows this rule exactly (§6). |
| Audit log | `core/audit`: `recordAudit` (actor required, same transaction) and `recordSystemAudit` (no actor; allowed only for `communications.system.*` and `finance.system.*`). `audit_events` is append-only, holds no customer PII, OWNER/ADMIN read it (`audit:read`). | Audit and notifications are separate (§2.3). A notification never replaces an audit entry. |
| Activity timeline | `activity` module, `recordSystemActivity`; the business-facing history of a customer. | Separate from notifications (§2.3). |
| Email | `core/email/sendEmail({ to, subject, text })`: transports `log` (dev, keeps a 100-message in-memory outbox) and `resend` (HTTPS, no SDK). Used for verification, password reset, "someone tried to sign up with your email" (`identity/server/auth-adapter.ts`) and invitations (`api/v1/b/[slug]/invitations`). No retry, no delivery state, no idempotency. Production config refuses `EMAIL_TRANSPORT=log`. | N1-D wraps this, it does not replace it (§12). |
| Mailbox transport | Communications C2-A (provider connections), C2-B1 (mailbox identity). C2-C outbound is **not built**. C2 explicitly excludes a cross-Zone notification feed (`communications-c2.md` §2). | N1 never sends through a user's connected mailbox (§12.1). |
| Scheduled work | `GET /api/internal/jobs/{finance-billing,finance-reminders,communications-retention}` with `Authorization: Bearer $CRON_SECRET`, 503 while unset. `apps/api/vercel.json` has **no `crons`**, so nothing runs. Due-work discovery through `SECURITY DEFINER` functions in `apps/api/prisma/privileged/` that return business ids only; work then runs as `bos_app` in `withTenant({ businessId, userId: null })`, claims rows with `FOR UPDATE SKIP LOCKED` and a lease, and backs off exponentially. | N1-C and N1-D reuse this pattern unchanged and stay dormant the same way (§7). |
| Outbox precedent | F6-3 `finance/server/reminder-outbox.ts`: transactional enqueue, idempotency key, a pre-dispatch re-check (`confirmReminderBeforeSend`) before contacting a provider, `UNKNOWN` never auto-failed or auto-resent. | N1-D adopts the same contract (§7.3, §12). |
| Retention/erasure | E1 (dormant): retention rules, erasure semantics, legal holds, a retention worker, all off until `communications-e1.md` §13 legal decisions. `data-model.md` §7: contact erasure scrubs PII from related rows. | Notifications must be covered by erasure and have their own retention (§13). |
| Permissions | `access/server/permissions.ts`: permission keys per Zone, four roles. Finance, People and Communications are separate from other Zones. Assignments (project owner, task assignee, customer owner) are **not** permissions. | Recipient rules use permission keys, never roles (§5). |
| Membership | `memberships.status` `ACTIVE`/`SUSPENDED`; A2-B (#76, merged; migration `20261205000000_membership_lifecycle`) adds suspend/reactivate, `suspended_at`/`suspended_by` and the owner lock. Removal clears owners and assignees. | Inbox reads must require an ACTIVE membership (§5.4). |
| Client routing | No URL routing. Zone `route` ids are stable, but syncing to the browser URL is deferred (`app-shell.md`). | Deep links in N1-A are structured targets, not URLs. Email links need web routing first (§14.3). |
| User-level events | Better Auth emails (verification, reset). No "password changed", "new sign-in" or "email changed" notice exists. | Account security notices are user-level, not tenant-level (§11). |

Related open work checked by title and changed files only (none changes a contract N1 depends on, except
as noted): #76 A2-B, since merged (membership suspend/remove: N1 must react to it, §5.4), #75 GS1 (same "no
server snippets" stance, §14), #78 agent context pack (read for this task), #77 F8 banking (future
producer only). People P3-A is merged (#68); P3-B (requests and approvals) is not built.

---

## 2. Principles and boundaries

### 2.1 Rules

1. **Pointer, not copy.** A notification references a record; the record stays the source of truth.
2. **Least text.** A notification stores the minimum text needed to be useful, drawn only from fields
   classified safe for its sensitivity class (§14.1). Sensitive classes store no record text.
3. **Check twice.** Eligibility is checked at write time (who gets it) and at read time (can they still
   see it). Read-time checks win.
4. **One authoritative row per recipient.** Channels deliver it; they never own it.
5. **Producers own meaning; N1 owns delivery.** Each Zone decides when its event happens and who it
   concerns. The notifications module decides how it is stored, shown, muted, grouped and delivered.
6. **Nothing external without approval.** No channel that leaves the product (email, push, SMS) runs
   until Regan approves it, and a tenant-facing notification email is never sent from a user's
   connected mailbox.
7. **Never fake.** No bell, badge or channel appears in the UI before its backend exists.

### 2.2 What N1 is not

- Not a messaging or chat system, and not Communications (no customer-facing mail).
- Not an event bus. Producers call one function. A bus can come later if consumers multiply
  (`architecture.md` §5.2).
- Not a workflow engine. W1 (cross-Zone workflows) may use notifications as an output; it does not run
  through them.
- Not an audit log. Notifications can be muted, expire and be deleted; audit entries cannot.

### 2.3 Notifications vs audit vs activity

| | Audit (`audit_events`) | Activity (`activities`) | Notification (proposed) |
|---|---|---|---|
| Question it answers | Who did what, for security | What happened with this customer | What do *I* need to know or do |
| Audience | OWNER/ADMIN (`audit:read`) | Anyone who can read the record | One named recipient |
| Mutable | Append-only | Business content, editable notes | Read/unread, archived, expires |
| Retention | Security retention | Business records | Short (§13) |
| Contains PII | No customer PII | Yes | Minimal; none for sensitive classes |

A producer that writes a notification for a security-relevant change still writes its audit entry.

---

## 3. Event taxonomy

### 3.1 Naming

`<zone>.<entity>.<event>` in lower snake case, past tense for facts and `_due`/`_soon` for time-based
ones: `projects.task.assigned`, `finance.invoice.overdue`, `scheduling.event.starting_soon`.

The type key is permanent once shipped. Renaming means adding a new key and retiring the old one.

### 3.2 Categories

Every type belongs to exactly one category. The category drives defaults, muting and the UI badge.

| Category | Meaning | Can a user turn it off? |
|---|---|---|
| `SECURITY` | Your account or access changed, or someone may be misusing it | **No** (in-app and email) |
| `ACCESS` | Your role, membership or ownership in a business changed | In-app: no. Email: no for loss of access, yes otherwise |
| `ACTION` | Something is waiting for your decision (approve leave, reconnect a mailbox) | In-app: no while the action is open. Email: yes |
| `ASSIGNMENT` | Work was given to you or taken from you | Yes |
| `UPDATE` | Something you own or follow changed status | Yes |
| `REMINDER` | Time-based (due, overdue, starting soon) | Yes |
| `SYSTEM` | A background process you are responsible for failed (billing run failed, sync failed) | In-app: no while unresolved. Email: yes |

### 3.3 Sensitivity classes

Separate from category: it decides what text may be stored and shown (§14).

| Class | Applies to | Stored text |
|---|---|---|
| `STANDARD` | Projects, Sales, Customers (non-personal fields), Scheduling titles | Record title snapshot allowed (§14.1) |
| `FINANCIAL` | Finance documents, payments, billing runs | Document number only; **no amounts, no customer name** |
| `PEOPLE` | Employee records, leave, any future payroll | **No record text.** Generic sentence only ("A leave request needs your decision") |
| `MAILBOX` | Mailbox connections and sync | Connection label set by its owner only; **never** subject, sender, recipient or body |
| `SECURITY` | Account and access notices | Generic sentence plus coarse facts (time, approximate device type); never tokens or links that grant access in the in-app copy |

`PAYROLL` is reserved as a class name so a future payroll Zone cannot be added as `PEOPLE` by
accident; it follows `PEOPLE` rules and additionally never names a pay period or amount.

### 3.4 Catalogue

"Trigger exists" means the state change the event describes already happens in code on `main`.
It does **not** mean a notification is sent. Recipients are always intersected with the read-time
rules of §5.

| Type | Producer module | Category / class | Trigger | Recipients | Trigger exists on `main`? | Earliest stage |
|---|---|---|---|---|---|---|
| `projects.task.assigned` | projects | ASSIGNMENT / STANDARD | `assignee_user_id` set or changed | New assignee, if not the actor | Yes | N1-A |
| `projects.task.unassigned` | projects | ASSIGNMENT / STANDARD | assignee cleared or changed by someone else | Previous assignee, if not the actor | Yes | N1-A |
| `projects.project.owner_assigned` | projects | ASSIGNMENT / STANDARD | `owner_user_id` set or changed | New owner, if not the actor | Yes | N1-A |
| `projects.task.due_soon` / `.overdue` | projects | REMINDER / STANDARD | due date reached | Assignee | Data yes, scheduler off | N1-C |
| `customers.customer.owner_assigned` | customers | ASSIGNMENT / STANDARD | `owner_user_id` set or changed | New owner, if not the actor | Yes | N1-A |
| `sales.opportunity.owner_assigned` | sales | ASSIGNMENT / STANDARD | `owner_user_id` set or changed | New owner, if not the actor | Yes | N1-A |
| `sales.opportunity.won` / `.lost` | sales | UPDATE / STANDARD | outcome recorded | Opportunity owner, if not the actor | Yes | N1-B (opt-in) |
| `finance.quote.accepted` | finance | UPDATE / FINANCIAL | staff records the customer's acceptance (`finance:issue`) | Quote creator (`created_by_id`) and the linked opportunity's owner, if not the actor | Yes | N1-A |
| `finance.quote.declined` / `.expired` | finance | UPDATE / FINANCIAL | as above | as above | Yes (expiry is time-based) | N1-A / N1-C |
| `finance.invoice.overdue` | finance | REMINDER / FINANCIAL | due date passes with an outstanding amount | Invoice creator; optionally `finance:billing` holders (D-N1-9) | Data yes, scheduler off | N1-C |
| `finance.payment.recorded` | finance | UPDATE / FINANCIAL | payment allocated to an invoice | Invoice creator, opt-in | Yes | N1-B (opt-in) |
| `finance.billing.run_failed` | finance (system) | SYSTEM / FINANCIAL | F6 run fails or exhausts attempts | `finance:billing` holders | Code yes, F6 jobs off | Live only when F6 is turned on |
| `finance.reminder.delivery_failed` / `.delivery_unknown` | finance (system) | SYSTEM / FINANCIAL | outbound state FAILED/UNKNOWN | `finance:billing` holders | No (needs C2-C) | After C2-C |
| `scheduling.event.overlap_kept` | scheduling | UPDATE / STANDARD | a non-enforced write creates an overlap ("Keep the overlap") | Creators of the overlapped events, if not the actor | Yes | N1-A (D-N1-10) |
| `scheduling.event.cancelled` | scheduling | UPDATE / STANDARD | event cancelled | Event creator, if not the actor | Yes | N1-B |
| `scheduling.event.starting_soon` | scheduling | REMINDER / STANDARD | start time approaching | Attendees | **No attendees model**; PERSON resources have no user link (D-S2-1) | After attendees exist |
| `people.leave.submitted` | people | ACTION / PEOPLE | request submitted | Resolved approver (D-P3-13) | No (P3-B) | With P3-B |
| `people.leave.decided` | people | UPDATE / PEOPLE | approved, rejected, cancelled | The employee's linked user | No (P3-B) | With P3-B |
| `people.leave.withdrawn` | people | UPDATE / PEOPLE | employee withdraws | The approver who held it | No (P3-B) | With P3-B |
| `communications.mailbox.reconnect_required` | communications (system) | ACTION / MAILBOX | refresh fails permanently / grant revoked | Mailbox owner | Trigger yes, but runs on a system path (no session user) during refresh/sync, and no sync worker runs | With C2-B3 (sync worker), via the system write path (§18.1) |
| `communications.mailbox.access_removed` | communications (system) | ACCESS / MAILBOX | A2-B mailbox cutoff on suspend/remove/demote | Mailbox owner (if still a member) and `communications:manage_connections` holders | No (A2-B #76 merged; no notice yet) | With A2-B |
| `tenancy.membership.role_changed` | tenancy | ACCESS / SECURITY | role changed | The member, as a **user-level** notice (§11.3), never in the tenant inbox | Yes | N1-U |
| `tenancy.membership.suspended` / `.removed` | tenancy | ACCESS / SECURITY | A2-B | The member: a `user_notices` row (§11.3); email in N1-D | No (A2-B #76 merged; no notice yet) | N1-U |
| `tenancy.invitation.accepted` | tenancy | UPDATE / STANDARD | invitee joins | Inviter, if still a member | Yes, but acceptance runs in the pre-tenant `app_private.accept_invitation` SECURITY DEFINER function, outside any tenant unit of work | Later: needs a privileged-SQL change (§18.1) |
| `tenancy.ownership.changed` | tenancy | ACCESS / SECURITY | a role change to or from OWNER (transfer, step-down, promotion) | The outgoing and incoming owner, as user-level notices (§11.3) | No (A2-B) | N1-U, after A2-B |
| `account.password.changed` | identity | SECURITY / SECURITY | password changed or reset | The user | Hook not written | N1-U (user-level, §11, §18) |
| `account.email.changed` | identity | SECURITY / SECURITY | email changed | The user, at **old and new** address | Hook not written | N1-D (email) |
| `account.session.new_device` | identity | SECURITY / SECURITY | sign-in from an unrecognised client | The user | No device tracking | Later (D-N1-14) |
| `reporting.view.shared` | reporting | UPDATE / STANDARD | a view is shared with the business | Opt-in only | Yes | N1-B (opt-in) |

Not in the catalogue on purpose: anything for customers or contacts (they are not users), mentions in
notes (no mention model), "someone viewed your record", marketing or product announcements.

### 3.5 Producer ownership

A Zone module owns its event types: it defines the type key, the payload schema, the trigger, the
recipient rule and the safe text. It registers them with the notifications module (§4.3). The
notifications module may refuse a registration that violates the sensitivity rules (for example a
`PEOPLE` type that declares a text parameter), and a contract test enforces the same rule in CI.

| Zone / module | Owns | Must not |
|---|---|---|
| projects, customers, sales, scheduling, reporting | Their `ASSIGNMENT`/`UPDATE`/`REMINDER` types | Notify about another Zone's records |
| finance | All `finance.*` types | Put amounts or customer names in stored text |
| people | All `people.*` types, including resolving the leave approver | Put leave type, reason, dates or notes in stored text when the type is sensitive (D-P3-22); in N1 no People text at all |
| communications | `communications.mailbox.*` | Put any message content or address in a notification |
| tenancy / identity | `tenancy.*` / `account.*` | Use the tenant inbox for user-level security notices (§11) |
| notifications (new) | Storage, read state, preferences, grouping, rate limits, channels, retention | Decide who is eligible for a Zone's event, or read a Zone's tables directly |

---

## 4. Event envelope and schema versioning

### 4.1 Envelope (what a producer hands over)

```ts
// Proposal for packages/contracts (types only) and the notifications module's public API.
interface NotificationEvent<P> {
  type: string;                 // 'projects.task.assigned' — registered key
  schemaVersion: number;        // version of P for this type, starts at 1
  businessId: string;           // never passed by the producer: taken from the TenantDb context
  occurredAt: string;           // DB time of the change (now() in the producer's transaction)
  actorUserId: string | null;   // session user, or null for system work
  subject: { kind: string; id: string };     // the record, e.g. { kind: 'project_task', id }
  parent?: { kind: string; id: string };     // optional, e.g. the task's project, for grouping and links
  recipients: RecipientSpec;    // §5.1
  params: P;                    // type-specific, validated against the registered schema
  dedupeKey: string;            // §6
}
```

`businessId` is deliberately not a producer field: the module reads it from the tenant context of the
`TenantDb` it is called with, as every tenant service does (`scripts/check-boundaries.mjs` already forbids
reading `businessId` outside `core/tenant`/`core/db`).

### 4.2 Params

- Each type registers a schema for `params` (zod, in `packages/contracts`, so the client renders the
  same shape it receives).
- Params may contain **ids**, **enums** (stage names, statuses), **numbers that are not money**
  (days overdue is allowed only for `FINANCIAL` types that are shown to `finance:read` holders),
  and **title snapshots** only for `STANDARD` types and only from a field the Zone has declared safe
  (§14.1).
- `PEOPLE`, `PAYROLL` and `MAILBOX` schemas may contain ids and enums only. The registration check
  rejects a string field for those classes, apart from a mailbox's own connection label for its owner.

### 4.3 Registration

```ts
// Each producer module exports its registrations from its index.ts; the app layer collects them.
registerNotificationType({
  type: 'projects.task.assigned',
  category: 'ASSIGNMENT',
  sensitivity: 'STANDARD',
  schemaVersion: 1,
  paramsSchema,            // zod
  requiredPermission: 'projects:read',
  recordCheck?: 'projects.task.visible', // optional record-level resolver name (§5.3)
  defaultChannels: { inApp: true, email: false },
  mandatory: false,
  groupBy: ['subject'],    // or ['parent'], or [] (§16)
  expiresAfterDays: 90,
});
```

The registry lives in code (like `ZONE_PERMISSIONS`), so an unknown type is a type error and the full
list is reviewable in one place.

### 4.4 Versioning rules

1. Adding an optional param is a non-breaking change: same `schemaVersion`.
2. Removing, renaming or retyping a param, or changing its meaning, bumps `schemaVersion`.
3. Stored rows keep the version they were written with. The client renderer must handle **every
   version still inside the retention window** (90 days by default), then the old renderer can go.
4. A row whose type or version is unknown to the client renders a safe fallback ("You have an update
   in Projects", with the link) instead of failing.
5. Contract tests pin every registered `(type, schemaVersion)` and its schema; changing one without a
   version bump fails CI (same idea as `pnpm contracts:check`).
6. Type keys are never reused for a different meaning.

---

## 5. Recipient resolution and tenant enforcement

### 5.1 Recipient specs

A producer states who the event concerns, in its own terms:

| Spec | Example | Resolved by |
|---|---|---|
| `{ users: [userId…] }` | task assignee, record owner, quote creator | Producer (it already has the ids on the locked row) |
| `{ permission: 'finance:billing' }` | billing run failed | Notifications module: active members whose role grants the key |
| `{ resolver: 'people.leave.approver', ref }` | leave approver (D-P3-13) | The People module's public resolver |

Then the notifications module applies the same filter to every spec, in this order:

1. **Same business.** Each user must have a membership in the transaction's business. The table's
   composite foreign key `(business_id, recipient_user_id) → memberships(business_id, user_id)`
   makes a cross-tenant recipient impossible, not just unlikely.
2. **Active.** Membership `status = 'ACTIVE'` (read under `FOR SHARE`, so a concurrent suspend or
   removal either commits first and the recipient is dropped, or waits).
3. **Permission.** The recipient's role grants `requiredPermission`.
4. **Record check**, if the type declares one (§5.3).
5. **Not the actor**, unless the type opts in (security notices about your own action do).
6. **Preferences** (§10): mandatory types skip this step.
7. **Cap.** At most 100 recipients per event (D-N1-6), for **non-mandatory** types only. What happens
   when the cap is exceeded is defined once, in §7.1.1 (outcome `SKIPPED_CAP`). Mandatory types are
   never capped: their recipient spec is bounded by registration instead (§16.1). From N1-C, larger
   non-mandatory fan-outs go through the outbox (§7.2).

A recipient dropped by any step gets nothing, not a redacted copy.

### 5.2 Tenant enforcement layers (same as every tenant table)

1. `withTenant` sets `app.business_id` and `app.user_id` for the transaction.
2. The `TenantDb` passed to the module is scoped to the business.
3. **RLS:** `ENABLE` and `FORCE ROW LEVEL SECURITY` with `tenant_isolation` on `business_id`, **plus**
   a recipient policy for reads and updates:
   `USING (business_id = app.business_id AND recipient_user_id = app.user_id)`. A user can never list
   or mark another user's notifications, even with a buggy service. Inserts are allowed for any
   recipient in the business (the producer writes on someone else's behalf), with `WITH CHECK
   (business_id = app.business_id)` and the composite FK.
4. Composite foreign keys to `memberships` (and to the business root for purge).
5. `tests/isolation` covers the new tables like every other tenant table.

`bos_app` gets `SELECT`, `INSERT` and column `UPDATE (read_at, archived_at)` only, all under the
recipient policy. It has **no `DELETE`**, and it cannot update `resolved_at`. Every write that touches
rows of a user other than the session user, or deletes rows, goes through §5.2.1.

#### 5.2.1 Privileged maintenance paths (the only delete and resolve paths)

The producer runs as the **actor**, but the rows it would need to delete or resolve belong to
**recipients**, and the recipient policy (correctly) stops the actor touching them. `bos_app` gets no
`DELETE` and no `UPDATE (resolved_at)`. Instead there are exactly three privileged paths, all owned by
`bos_maint` (the NOLOGIN maintenance owner E1 already uses), in `apps/api/prisma/privileged/`:

| Path | How it runs | Authority comes from | What it may do, enforced in SQL |
|---|---|---|---|
| `app_private.notifications_purge_own(p_limit int)` | Callable: `EXECUTE` for `bos_app`, from the inbox API (list, mark-all) | The session user acting on **their own** rows only | Requires `app.business_id` and `app.user_id`; `p_limit` 1–50. Deletes only `business_id = app.business_id AND recipient_user_id = app.user_id` rows that are past `expires_at`, archived over 30 days or resolved over 30 days. Cannot touch another user's rows, so it needs no further authority. |
| `app_private.notifications_on_subject_erased()` | **Trigger function only.** `AFTER DELETE` (and, for E1 tombstoned rows, `AFTER UPDATE` when the row enters its erased state) `FOR EACH ROW` on each subject table, attached by the reviewed migration of the stage that adds that subject's producer. `TG_ARGV[0]` is the subject kind, fixed in `CREATE TRIGGER` | The record really was deleted or erased in this transaction: the trigger fires only on that committed-together row change | Deletes rows with `business_id = OLD.business_id AND subject_kind = TG_ARGV[0] AND subject_id = OLD.id`. Raises (aborting the erasure) if `app.business_id` is unset or differs from `OLD.business_id`, so it can never silently leave notifications behind or act on another business. |
| `app_private.notifications_on_action_closed()` | **Trigger function only.** `AFTER UPDATE OF <status column>` `FOR EACH ROW` on the action's source table (for example P3-B leave requests, C2 mailbox connections). `TG_ARGV` = subject kind, `ACTION` type, and the set of "open" states, fixed in `CREATE TRIGGER` | The source row really left an open state in this transaction | Only when `OLD.status` is in the open set and `NEW.status` is not: sets `resolved_at = now()` on matching unresolved rows of that type for `NEW.id` in `NEW.business_id`. Changes no other column. |

No `EXECUTE` is granted on the two trigger functions to any role, and PostgreSQL refuses to call a
function returning `trigger` directly, so an ordinary tenant session **cannot** erase or resolve
anyone's notifications except by actually erasing the record or closing the action, which is governed
by the owning Zone's own permissions, guards and audit. The owning module therefore needs no
`eraseNotificationsForSubject` or `resolveNotifications` call: atomicity comes from the trigger running
inside the same statement.

Grants for `bos_maint` on `notifications`: `SELECT (business_id, id, recipient_user_id, type,
subject_kind, subject_id, expires_at, archived_at, resolved_at)`, `DELETE`, and `UPDATE (resolved_at)`,
under forced RLS policies for `bos_maint` that restrict every operation to
`business_id = nullif(current_setting('app.business_id', true), '')::uuid`, as a second fence behind the
function checks.

Removal of a member deletes their rows through the `ON DELETE CASCADE` foreign key to `memberships`;
PostgreSQL runs referential actions without the referencing table's grants or RLS, so this needs no
`DELETE` grant either (confirmed by a test, as for other tenant tables).

Tests against the real roles, with RLS forced: `bos_app` `DELETE` and `UPDATE (resolved_at)` are
refused; `bos_app` cannot call either trigger function (direct call fails, no `EXECUTE`); purge deletes
only the caller's expired rows (another user's expired row survives); deleting or erasing a subject
removes exactly its notifications and nothing else; an update that does not leave an open state
resolves nothing; a rolled-back erasure or decision leaves notifications unchanged; a subject delete
with a mismatched or missing `app.business_id` aborts.

### 5.3 Record-level checks

Some Zones decide visibility per record, not only per key:

- Communications: `OWNER_ONLY` mailboxes are visible only to their owner.
- People P3-B: leave detail is visible to the employee, their approver and `people:read_sensitive`
  holders (D-P3-22).
- Activity: `RESTRICTED` notes.

For these, the producing module exports a **record check** (`(db, userId, subjectId) => boolean`)
from its `index.ts`. The notifications module does not import it (that would create a dependency from
notifications to every Zone, and every Zone already depends on notifications). The app layer
(`apps/api/src/app`) wires the checks into the registry at startup, which `architecture.md` §5.2
permits because `app` may import every module.

### 5.4 Read-time re-check

Every inbox read (`list`, `count`, `get`) returns only rows where, **now**:

- the reader's membership in this business is ACTIVE (already required to reach any tenant route);
- the reader's role grants the type's `requiredPermission`;
- the type's record check, if any, still passes (run for the page being returned, at most 50 rows, so
  it stays bounded);
- the subject has not been erased (§13.3).

Rows that fail are **hidden, not deleted**, and not counted in the badge. If the reader's role is
later restored, they reappear. This is the rule that makes a stored title snapshot acceptable: losing
access hides the snapshot immediately.

**The unread badge is an ACL-safe lower bound: it never counts a row the reader could not open**
(D-N1-7, revised after audit). It is exact for ordinary types and may under-count record-scoped ones.
It is computed in two parts:

1. **Types without a record check:** a SQL count over the reader's unread rows, filtered by the set of
   type keys their role currently permits. Exact and cheap.
2. **Types with a record check** (People, mailbox, restricted activity, anything registered with
   `recordCheck`): the newest 20 unread rows of those types are loaded and passed through each type's
   **batch** record check (`(db, userId, subjectIds[]) => Set<subjectId>`, one query per type, not
   per row). Only rows that pass are counted. Older unread rows of these types beyond the newest 20 are
   **not counted** in the badge (they still appear, checked, when the list is opened).

So the badge can under-count, never over-count: it never reveals that a restricted event exists for
someone who cannot open it. It is **not** a complete total: the `unread-count` response says
`{ count, complete: false }` when part 2 was truncated, and the client then shows the number without implying it is the total ("20+" is not
used, because it would itself hint at hidden rows). Tested by revoking record access (manager link,
mailbox share, restricted note) after the notification was written, with the coarse key kept.

### 5.5 Users in several businesses

Notifications are per business. The inbox and badge show the current business. A cross-business
"you have unread items in Kelp Plumbing" indicator needs a pre-tenant `SECURITY DEFINER` function
returning **counts per business only** (no titles), similar to `my_memberships`. Proposed for N1-B,
not the MVP (D-N1-8).

---

## 6. Deduplication and idempotency

| Risk | Rule |
|---|---|
| The producer's transaction retries (serialization, deadlock, client retry with an idempotency key) | The insert is in the same transaction, so a rolled-back attempt leaves nothing. |
| The same fact is reported twice (a double-submitted assignment, a retried job) | Unique index `(business_id, recipient_user_id, type, dedupe_key)`; insert uses `ON CONFLICT DO NOTHING`. |
| Assign → unassign → reassign within minutes | Different `dedupe_key`s (the producer uses the record `version` that the change produced), but grouping (§16) collapses them in the list. |
| Time-based reminders on every scheduler pass | `dedupe_key` = `<subject id>:<stage>:<local date>` (for example `invoice:…:overdue:7d`), so one reminder per stage, ever. |
| Email resent after a timeout | Delivery rows carry their own idempotency key (`notification id + channel`), and `UNKNOWN` is never auto-resent (§12.3). |

Producers build `dedupe_key` from facts on the locked row (`<subject id>:<version>` for state
changes), never from the clock or a random value. The key is opaque to the notifications module.

---

## 7. Delivery pipeline, queue, retry and dead letter

### 7.1 N1-A: synchronous, in the producer's transaction

```
Zone service (inside withTenant, row locked)
  ├─ change the record
  ├─ recordAudit(...)                          (as today)
  └─ notify(db, event)                         (new; same transaction)
        ├─ validate params against the registered schema
        ├─ resolve recipients (§5.1, bounded)
        └─ INSERT notifications … ON CONFLICT DO NOTHING
```

- **No queue, no worker, no cron, no provider.** Nothing has to be activated.
- Cost: one bounded insert per event, a few rows. Small businesses (5–50 people) make this cheap.
- Failure: see §7.1.1. In short, **errors** roll the producer's change back; **intentional skips**
  do not; a **mandatory** notice that cannot be written always rolls the change back. `notify` does no
  network I/O and its work is bounded, so errors should only come from bugs or the database.
- Alternative considered: write after commit (fire and forget). Rejected: a crash between commit and
  insert loses the notification silently, and it would need a second transaction outside the lock.

#### 7.1.1 `notify` outcomes and failure policy

`notify` returns a typed result or throws. Every case is listed; there is no other path.

| Outcome | Examples | `notify` | Producer's change | Recorded |
|---|---|---|---|---|
| `WRITTEN` | One or more rows inserted | returns `{ outcome: 'WRITTEN', count }` | commits | nothing extra |
| `SKIPPED_NO_RECIPIENT` | Recipient is the actor; recipient not ACTIVE; lacks the permission; fails the record check | returns | commits | debug counter |
| `SKIPPED_PREFERENCE` | Recipient muted the type (N1-B); never possible for mandatory types | returns | commits | nothing |
| `SKIPPED_DUPLICATE` | `ON CONFLICT DO NOTHING` hit | returns | commits | nothing |
| `SKIPPED_CAP` | **Non-mandatory** type over the per-event recipient cap (§5.1), the per-recipient hourly limit or the per-business daily limit (§16). Applied per recipient: others under the limit still get theirs | returns | commits | warning counter with type and business id; an alert if it repeats |
| `ERROR_CONTRACT` | Unknown type; params fail the schema; a sensitivity rule fails; a mandatory type with an unbounded recipient spec | **throws** | **rolls back** | error log (type and code only) |
| `ERROR_DATABASE` | Insert fails (FK, RLS, timeout, serialization) | **throws** | **rolls back** (the transaction is already aborted) | as any DB error |
| `ERROR_MANDATORY` | A mandatory **tenant-inbox** type resolves to zero recipients from its membership facts. No such type is planned in N1-A or N1-U; the outcome exists so a future one (for example an unresolved billing failure that must reach every `finance:billing` holder) fails closed | **throws** | **rolls back** | error log; alert |

This table covers the **tenant-inbox path** (`notify`, called by Zone services). User-level notices
about a person's own account or access (password, email, role, suspension, removal, ownership) do
**not** use `notify`: they are written by database triggers on the change itself (§11.2) and follow the
same principle, fail closed, by construction (a failed trigger aborts the statement that changed the
role or status).

Rules that follow from the table:

1. **Skips are decisions, not failures.** They are expected and the producer's change stands.
2. **Mandatory notices fail closed.** No skip outcome applies to a mandatory type except
   `SKIPPED_DUPLICATE` (the notice already exists) and `SKIPPED_NO_RECIPIENT` for "is the actor" where
   the type allows it. A change that produces a mandatory tenant-inbox notice therefore **cannot
   commit** having silently discarded it. (Role, ownership and account changes get the same guarantee
   from the trigger path in §11.2.)
3. **Caps never decide whether a mandatory notice is written** (§16.1).
3a. **Mandatory recipients never depend on the recipient's post-change permissions.** A mandatory type
   resolves recipients from membership facts only (§5.1 steps 3, 4 and 6 do not apply). Notices about a
   change to the recipient's **own** access (role change, suspension, removal, ownership transfer) are
   not tenant-inbox notifications at all: they are user-level notices written by the `memberships`
   trigger (§11.2), readable whatever the recipient's role becomes, and the trigger has no recipient
   filter that could fail. So no legitimate demotion or removal can be blocked by its own notice.
4. Producers do not catch `notify` errors. A contract test checks that no producer wraps `notify` in a
   `try`.
5. Tests (`notify` path): rollback on each `ERROR_*`; commit on each `SKIPPED_*`; cap exhaustion on a non-mandatory type commits the producer
   change and writes nothing; cap pressure from non-mandatory rows never blocks a mandatory one.

### 7.2 N1-C/N1-D: a Postgres outbox drained by the existing job pattern

Time-based events and external channels need work outside a request. Proposal:

- `notification_deliveries` (per notification, per channel) and, for time-based producers, the
  producer's own "due" query (like `finance_reminders_due`).
- A job route `GET /api/internal/jobs/notifications` with the existing `CRON_SECRET` rules **and** its
  own switch `NOTIFICATIONS_JOBS_ENABLED=true`, returning 503 otherwise. Not listed in `vercel.json`
  until Regan approves.
- Discovery through `app_private.notifications_due(limit)` (`SECURITY DEFINER`, owner `bos_definer`,
  `EXECUTE` for `bos_app` only) returning business ids only.
- Per business: `withTenant({ businessId, userId: null })` as `bos_app`, claim with
  `FOR UPDATE SKIP LOCKED` and a 120 s lease, one item per transaction, 45 s budget per pass, counts-only
  response.

### 7.3 Queue options (none installed)

| Option | Fits our constraints? | Cost | Recommendation |
|---|---|---|---|
| **Postgres outbox + cron route** (existing F6/E1 pattern) | Yes: same database, RLS, tests, no new vendor | No new vendor. Cron frequency and function duration depend on the Vercel plan (**unverified**; check the current plan's cron limits before N1-C) | **Recommended** for N1-C and N1-D |
| `pg-boss` (queue inside Postgres) | Same database, but expects a long-running poller; on Vercel it would still be drained by cron | Open source; uses DB connections (Neon compute time is billed) | Revisit if delivery volume outgrows the cron pattern (already named in `data-model.md` §7.1) |
| Vercel Queues / Cron-triggered functions | Native to the host | Paid usage, product terms **unverified** | Not needed yet |
| Upstash QStash, Inngest, Trigger.dev | External HTTP queues with retries and dashboards | Free tiers exist but are **not** a basis for commercial multi-tenant production; paid plans **unverified** | Not recommended for N1; adds a vendor holding tenant event metadata |
| Redis / SQS / Pub/Sub | General-purpose queues | Paid; new infrastructure | No |

### 7.4 Retry and dead letter

For each delivery row (N1-D) and each time-based producer item (N1-C):

- States: `PENDING → CLAIMED → SENT | FAILED | UNKNOWN | SUPPRESSED | DEAD`.
- Retry with backoff `30 s × 2^attempts`, capped at 1 hour (same as E1), maximum 8 attempts
  (D-N1-12).
- **Transient** (timeout before the request is sent, 429, 5xx with no acceptance): retry.
- **Permanent** (invalid address, provider rejects content): `FAILED`, no retry.
- **Ambiguous** (timeout after the request was sent): `UNKNOWN`. Never auto-resent, never shown as
  failed (same rule as C2 and F6-3). Resolved by the provider's delivery webhook, if one is adopted,
  or left as unknown.
- **Dead letter** is not a separate queue: it is the `DEAD` state (attempts exhausted), with an
  error code that contains no content (`provider_rejected`, `timeout`, `rate_limited`, …), visible to
  OWNER/ADMIN as a count in Settings and to operators in logs. An operator "retry dead deliveries"
  action is N1-D scope and needs `business:manage`.
- **Pre-dispatch re-check** (from F6-3): right before contacting a provider, in the claiming
  transaction, re-run §5.4 for the recipient. If they lost access, were suspended, muted the type or
  the notification was already read in-app, the delivery becomes `SUPPRESSED` with a reason.

The in-app notification never depends on any of this: it already exists before a delivery row is
created.

---

## 8. Inbox model (proposal; no migration in this PR)

### 8.1 Tables

**`notifications`** (tenant table, module `notifications`)

| Column | Notes |
|---|---|
| `business_id`, `id` | PK `(business_id, id)`; `id` is uuid v7 (time-ordered) |
| `recipient_user_id` | composite FK `(business_id, recipient_user_id) → memberships(business_id, user_id)`, `ON DELETE CASCADE` (removed member's notifications go with the membership) |
| `type`, `schema_version`, `category`, `sensitivity` | from the registry; `category` and `sensitivity` stored so retention and filters do not need code |
| `actor_user_id` | nullable; no FK to memberships (the actor may have left), shown as "Someone" if not a current member |
| `subject_kind`, `subject_id`, `parent_kind`, `parent_id` | pointer; no FK (subjects live in many tables and may be deleted) |
| `params` | jsonb, validated by the registered schema; `CHECK (octet_length(params::text) <= 2048)` |
| `dedupe_key` | text, unique per `(business_id, recipient_user_id, type, dedupe_key)` |
| `group_key` | text, for collapsing (§16) |
| `occurred_at` | DB time of the change |
| `created_at` | insert time |
| `read_at`, `archived_at`, `resolved_at` | nullable; the only columns `bos_app` may update (`resolved_at` only by the action-closed trigger, §5.2.1) |
| `expires_at` | `created_at + registered expiry`; retention deletes after this (§13) |

Indexes: `(business_id, recipient_user_id, archived_at, created_at DESC, id)` for the list,
partial `(business_id, recipient_user_id) WHERE read_at IS NULL AND archived_at IS NULL` for the
badge, `(business_id, subject_kind, subject_id)` for erasure and record-delete cleanup,
`(business_id, expires_at)` for retention.

**`notification_preferences`** (N1-B, tenant table): `(business_id, user_id, type_or_category,
in_app, email, muted_until)`. **`notification_business_defaults`** (N1-B):
`(business_id, type_or_category, in_app, email, locked)`. **`notification_deliveries`** (N1-D):
`(business_id, id, notification_id, channel, state, attempts, next_attempt_at, lease_expires_at,
idempotency_key, provider_message_id, error_code, updated_at)`.

**`user_notices`** (§11, **not** a tenant table): `(user_id, id, type, params, created_at, read_at)`,
RLS `user_id = app.user_id`, reached only through `/api/v1/me`.

### 8.2 Why per-recipient rows (fan-out on write)

| | Fan-out on write (one row per recipient) | Fan-out on read (one event row, computed per viewer) |
|---|---|---|
| Read/unread | A column | A second table anyway |
| Tenant + recipient RLS | Simple `recipient_user_id = app.user_id` | Needs a join per read |
| Storage | Rows × recipients (small: recipients are capped, businesses are small) | Less |
| Recommendation | **Yes** | Revisit only for very large "everyone" broadcasts, which N1 does not have |

### 8.3 API (proposal, `packages/contracts/src/notifications.ts`, additive within `/api/v1`)

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /api/v1/b/:slug/notifications?cursor&filter=unread|all|archived&category` | any active member | Own rows only; read-time re-check (§5.4); cursor on `(created_at, id)`; page size 25, max 50 |
| `GET /api/v1/b/:slug/notifications/unread-count` | any active member | `{ count, complete: boolean }`; ACL-safe lower bound (§5.4), displayed as 99+ beyond 99 (D-N1-7) |
| `POST /api/v1/b/:slug/notifications/read` | any active member | `{ ids: [...] }` (max 100) or `{ all: true, before: <created_at> }`; idempotent |
| `POST /api/v1/b/:slug/notifications/unread` | any active member | `{ ids }`; idempotent |
| `POST /api/v1/b/:slug/notifications/archive` / `unarchive` | any active member | `{ ids }`; idempotent |
| `GET/PUT /api/v1/b/:slug/notifications/preferences` | any active member | N1-B |
| `GET/PUT /api/v1/b/:slug/notifications/defaults` | `business:manage` | N1-B |
| `GET /api/v1/me/notices`, `POST /api/v1/me/notices/read` | signed-in user | §11 |

There is no endpoint to create a notification. Notifications are only written by server code inside a
producer's transaction.

The client polls `unread-count` (every 60 s while the window is focused, and on focus). Real-time push
(SSE or WebSocket) is not needed for the MVP and is not well served by the current serverless API;
it is listed in N1-E.

---

## 9. Read, unread and archive controls

- Opening a notification marks it read. "Mark as unread", "Mark all as read" (scoped to the current
  filter, bounded by `before` so items that arrive while the click is in flight stay unread) and
  "Archive" are available.
- `ACTION` notifications stay pinned at the top as "Needs action" until the action is resolved
  (the leave decided, the mailbox reconnected). The producer calls
  nothing: the action-closed trigger on the source table (§5.2.1) sets `resolved_at` when the source
  row leaves its open state, in the same transaction. Reading an `ACTION` notification does not resolve it.
- Read state is per business and per user and is not synchronised to email (an email opened is not a
  notification read; open tracking is not used, §12.4).
- Read and archive are never audited (high volume, no security value). Changes to business defaults
  are audited (`notifications.defaults_changed`).

---

## 10. Preferences: user, business, mandatory

### 10.1 Resolution order

For each recipient and channel:

1. **Mandatory** types (`SECURITY`, loss-of-access `ACCESS`, and open `ACTION`/`SYSTEM` items in-app)
   are always delivered in-app. Mandatory email applies to `SECURITY` and loss of access only.
2. **Business default**, if the business **locked** it (for example "billing failures always email
   `finance:billing` holders"). Only `business:manage` holders set defaults; they can make a type more
   on, never turn off a mandatory one.
3. **User preference** for the type, else for its category.
4. **Business default** (unlocked).
5. **Registry default.**

### 10.2 What users control (N1-B)

- Per category and per type: in-app on/off, email on/off (email only once N1-D exists).
- "Mute this record" (stop `UPDATE` notifications for one subject).
- "Pause notifications" for a period, except mandatory ones.
- Email digest instead of individual emails (N1-D, D-N1-13).

Settings placement follows A3 (settings architecture, separate thread): **Personal settings →
Notifications** for user preferences and **Business settings → Notifications** for defaults. N1 owns
the data and API; A3 owns where it sits in the Settings tree.

### 10.3 Mandatory vs opt-in (proposal)

| Mandatory (cannot turn off) | On by default, can turn off | Off by default (opt-in) |
|---|---|---|
| Account security notices, role change, suspension/removal, ownership transfer, open `ACTION` items in-app, unresolved `SYSTEM` failures in-app | Assignments, quote accepted/declined, overlap kept, invitation accepted, reminders (N1-C) | Opportunity won/lost, payment recorded, event cancelled, reporting view shared |

---

## 11. Account and security notices (user-level)

### 11.1 Why separate

A password change, email change or suspicious sign-in concerns the **person**, not a business. A
user may be in several businesses or in none (admission granted, no business yet). Putting these in a
tenant inbox would either duplicate them per business or hide them from users with no business.

### 11.2 Model

- `user_notices` (§8.1) is not tenant-scoped. **Reads:** only through `/api/v1/me/notices`, as
  `bos_app` with `app.user_id` set from the verified session, under RLS `user_id = app.user_id`;
  `bos_app` has `SELECT` and column `UPDATE (read_at)` only, never `INSERT` or `DELETE`.
- **Writes** happen only in `AFTER … FOR EACH ROW` **triggers** on the tables whose change the notice
  reports. The trigger functions are `SECURITY DEFINER`, owned by `bos_definer` (which alone has
  `INSERT` on `user_notices`), in `apps/api/prisma/privileged/`, with **no `EXECUTE` grant to any role**;
  a function returning `trigger` cannot be called directly. There is therefore no callable notice
  writer to spoof: the only way to produce an access notice is to make the access change itself,
  through the A2 services that already enforce `members:manage`, rank, the last-owner lock and the
  other A2-B guards. Every param comes from `OLD`/`NEW` (business id, old and new role or status) plus
  the actor from `app.user_id` (null for system work); nothing comes from the caller.

  | Change | Trigger | Notice | Order and checks |
  |---|---|---|---|
  | Role change | `AFTER UPDATE OF role ON memberships`, only when `OLD.role IS DISTINCT FROM NEW.role` | `tenancy.membership.role_changed`, or `tenancy.ownership.changed` when either side is `OWNER` | Fires after the row is updated, inside the statement. The A2 service has already locked the row and run its authority and rank checks; a trigger failure aborts the update (fail closed). |
  | Ownership transfer / step-down (A2-B) | The same trigger, once per affected row | One `tenancy.ownership.changed` notice for the outgoing and one for the incoming owner | Both role updates and both notices commit or roll back together in the A2-B transfer transaction; the A2-B last-owner guard runs first. |
  | Suspension / reactivation (A2-B) | `AFTER UPDATE OF status ON memberships`, only when the status changes | `tenancy.membership.suspended` / `.reactivated` | As above. |
  | Removal | `AFTER DELETE ON memberships` | `tenancy.membership.removed` | Fires after the delete, in the same statement. Skipped when the delete is a cascade from business purge (purge runs as `bos_jobs` with no session user; exact detection tested in N1-U). The notice has no FK to the membership, so it survives. |
  | Password change | `AFTER UPDATE OF password ON accounts` (the Better Auth credential row; column verified in `identity.prisma`) when it changes | `account.password.changed` | Fires for any path that changes the password (reset or change), so no adapter hook is needed. |
  | Email change | `AFTER UPDATE OF email ON users` when it changes | `account.email.changed` (old address kept in params only for the N1-D email to the old address, then cleared) | As above. |

- Concurrency: two changes to one membership serialise on its row lock (taken by the `UPDATE`
  itself); each committed transition produces exactly one notice; a no-op update produces none.
- Tests: user A cannot read or mark user B's notices; `bos_app` cannot `INSERT` into `user_notices` and
  cannot call any trigger function; each change in the table writes exactly its notice with the right
  old/new values; demotions OWNER→ADMIN, ADMIN→MANAGER, MANAGER→MEMBER and any role → a role without
  `members:read` all commit with their notice; a forced trigger failure leaves the role unchanged;
  concurrent role changes and a role change racing a removal produce consistent notices; a rolled-back
  change leaves no notice; business purge writes no removal notices.
- Shown in the same notification panel in a "Your account" section, above business items.
- **Email is the primary channel** for security notices because the account itself may be
  compromised: the in-app copy is a record, the email is the alert. Email already exists for
  verification and reset; N1-A adds no new email. `account.password.changed` and
  `account.email.changed` emails are N1-D (they need an approved template and are outbound email,
  which the protocol keeps off).
- Copy never includes a link that grants access. It says what happened, when, and "If this wasn't you,
  reset your password" with a link to the normal reset page.

### 11.3 Role changes, suspension, removal and ownership transfer

A change to someone's own access must reach them whatever access they have afterwards. A tenant-inbox
row would either be filtered out by the new role (§5.1) and block the change (`ERROR_MANDATORY`), or be
written and then be unreadable. So all of them go to `user_notices`, written by the `memberships`
triggers of §11.2 inside the admin's transaction (N1-U). Role change and ownership transfer need nothing from A2-B (role change
exists today); suspension, removal and transfer arrive with A2-B. The business name is rendered at read
time only while the reader is still a member; otherwise the notice says "a business". For suspension
and removal the copy is "Your access to a business changed" **without the business name** (D-N1-15: naming the business is useful but tells a
removed person something about a tenant they no longer belong to; the owner decides). Email for this
is N1-D.

---

## 12. Email channel

### 12.1 Separation from Communications

| | Notification email (N1-D) | Communications outbound (C2-C) |
|---|---|---|
| Sender | Pixa OS system address on `mail.pixakova.com` (Resend, via `core/email`) | The user's connected Google/Microsoft mailbox |
| Recipient | A Pixa OS user, about their own account or work | A customer or contact |
| Content | Short, templated, privacy-safe, link back to the app | Business correspondence |
| Approval gate | N1-D activation (Regan) | C2-C Gates A–C |

A notification is **never** sent from a user's connected mailbox, and Communications never sends a
notification. The two must not share a queue or state machine, so a C2 outage does not stop security
notices and a notification bug cannot send from someone's mailbox.

### 12.2 Provider abstraction

`core/email` already hides the provider behind `sendEmail`. N1-D extends it (owned by `core`, not by
notifications) to:

```ts
interface EmailTransport {
  send(message: { to: string; subject: string; text: string; html?: string;
                  idempotencyKey: string; tags: Record<string, string> })
    : Promise<{ outcome: 'accepted'; providerMessageId: string }
            | { outcome: 'rejected'; permanent: boolean; code: string }
            | { outcome: 'unknown' }>;
}
```

- `log` stays for development and tests; `resend` stays the production transport. Adding or switching
  providers (SES, Postmark) is a separate decision with its own cost check (D-N1-11).
- Resend supports idempotency keys on send (to verify against current docs when N1-D starts); where a
  provider does not, `unknown` outcomes are never retried automatically.
- Existing callers (`auth-adapter.ts`, invitations) keep working unchanged.
- Delivery webhooks (bounces, complaints) need a public signed endpoint and are N1-D scope with their
  own approval. Without them, `accepted` is the final known state.

### 12.3 Delivery failure

- States and retries as §7.4. A permanently failing address (hard bounce, if webhooks are adopted)
  sets an email-suppressed flag for that user, shown in their notification settings ("Emails to this
  address are bouncing"); in-app delivery continues.
- An email failure never changes the in-app notification and never surfaces as an error to the actor
  who triggered it.
- Security notices that fail permanently are logged as an operational alert (counts and codes only).

### 12.4 Email content rules

- **Subject:** category and Zone only: "New assignment in Projects", "A leave request needs your
  decision", "Action needed: reconnect your mailbox". Never a record title for `FINANCIAL`, `PEOPLE`,
  `PAYROLL`, `MAILBOX`; for `STANDARD`, a title only if the business allows it (D-N1-16, default off,
  because emails are forwarded, previewed on lock screens and kept by third-party providers).
- **Body:** the same generic sentence, the business name (D-N1-16), and a link to the record that
  requires signing in. No amounts, customer names, employee names, leave details, mail content or
  pay data, ever.
- Plain text plus a simple accessible HTML version; no tracking pixels and no link-click tracking.
- Footer: why you got this, and a link to notification settings. Mandatory notices say they cannot be
  turned off.
- Email language and time zone: the business's locale and time zone for business events, the user's
  for account notices (when user-level locale exists; until then the business or platform default).
- Legal: transactional system email to users of the service. Whether any notification type counts as
  commercial or marketing email under CAN-SPAM, CASL, the Australian Spam Act or GDPR/ePrivacy is a
  legal question, **unverified** here; N1 sends none that are intended as marketing (D-N1-17).

---

## 13. Retention and privacy

### 13.1 Retention (proposal)

| Item | Kept for | Then |
|---|---|---|
| Unarchived notification | `expires_at` = 90 days (types may register shorter, never longer without an owner decision) | Deleted |
| Archived notification | 30 days after archiving, or `expires_at`, whichever is first | Deleted |
| Open `ACTION` notification | Until resolved, then 30 days | Deleted |
| Delivery rows | 30 days after the last state change | Deleted; counts kept in job logs |
| `user_notices` | 1 year (security history the user can see) | Deleted |
| Preferences | While the membership exists | Cascade with membership |

**Enforcement without a scheduler (N1-A).** Expired rows are hidden at read time. They are also
**physically deleted by their own recipient's activity**: each inbox list call and each "mark all as
read" calls `app_private.notifications_purge_own(50)` (§5.2.1), which deletes up to 50 of the caller's
own expired, long-archived or long-resolved rows. `notify` does **not** delete anything (the actor
must not touch recipients' rows). Bounded, indexed, no cron.

**Residual exposure until the N1-C retention job is approved:** rows of recipients who never open the
inbox again stay stored after expiry, **indefinitely** without the job (for example a member who is
suspended and never reactivated, or one who simply stops using the product). They are invisible to
users and the API but remain in the database and in Neon backups and history (whose retention window
depends on the Neon plan; not verified here) until deleted. Size, as an order of magnitude: a 50-person
business producing about 20 notifications per person per working day would accumulate roughly 250 000
rows a year (well under 200 MB with indexes) if nobody ever opened the inbox; real figures will be far
lower. They contain only the minimal text of §14.1 and are removed by membership removal, business
purge and subject erasure as usual. Gate: before N1-A's migration is
applied, Regan either accepts this residual exposure for the **restricted beta** (after the privacy
review in D-N1-17) or requires the retention job first. Either way, the retention job (N1-C pattern,
`bos_maint` purge function, dormant behind its switch) must be built and enabled **before any release
wider than the invite-only beta** (D-N1-18).

### 13.2 Membership and business lifecycle

- **Member removed:** their notifications and preferences cascade with the membership row.
- **Member suspended:** rows are kept but unreachable (§5.4); reactivation restores them.
- **Business archived:** no new notifications (producers cannot write to an archived business);
  business purge deletes everything with the business (`ON DELETE CASCADE` from `businesses`).

### 13.3 Erasure

- When a record is erased or hard-deleted (contact erasure, E1 erasure of a message, a future People
  erasure), the subject-erased trigger on that table (§5.2.1) **deletes** matching rows in the same
  transaction (by the `(business_id, subject_kind, subject_id)`
  index). This is the only cross-module write N1 needs from E1, and it is a call into the
  notifications module's public API, not a change to Communications code now.
- `STANDARD` title snapshots are the only personal data N1 can hold (for example a customer named after
  a sole trader). They are bounded by the 90-day expiry and removed by subject erasure.
- Notifications are excluded from legal holds by default; a hold on a record does not need its
  pointers. If counsel decides otherwise, that is an E1 §13 decision, not an N1 one.
- **Two different exports** (D-N1-18, revised after audit):
  - *Business data export* (`data-model.md` §7, an owner exporting the business's records): N1
    recommends excluding notifications, because they are pointers to records that are already
    exported, not records themselves. This is a product choice, not a legal exemption.
  - *Personal-data access requests* (a person asking for the data held about them, under GDPR, the
    Australian Privacy Act, CCPA/CPRA or similar): a person's own notifications and `user_notices`
    may well be in scope. N1 does not claim they are exempt. Proposal: include them in a per-user
    export from `/api/v1/me` when that feature is built, subject to the legal assessment in D-N1-17.

### 13.4 Logs

Server logs record type, counts, error codes and ids only. Never params, titles, email addresses or
email bodies (the existing `log` transport already avoids bodies).

---

## 14. Previews, deep links and role-based visibility

### 14.1 What text a notification may show

| Class | List and panel | Email | OS notification (N1-E) |
|---|---|---|---|
| `STANDARD` | Sentence + record title snapshot ("Ana assigned you **Fit kitchen cabinets** in Kelp Renovation") | Sentence only, unless D-N1-16 | Sentence only |
| `FINANCIAL` | Sentence + document number ("Quote **Q-0042** was marked accepted") | "A quote was marked accepted" | Sentence only |
| `PEOPLE` / `PAYROLL` | Sentence only ("A leave request needs your decision") | Sentence only | Sentence only |
| `MAILBOX` | Sentence + the owner's own connection label, to the owner only | Sentence only | Sentence only |
| `SECURITY` | Sentence + time | Sentence + time + "if this wasn't you" | Not sent |

A Zone declares which of its fields may be snapshotted, per type, in its registration. Fields that are
free text written by users (descriptions, notes, comments) are never snapshotted; titles are short and
already visible to everyone with the type's `requiredPermission`.

Actor names: the actor's display name is rendered at read time from the member list (not stored), so
a renamed or removed member is shown correctly ("Someone" if no longer a member).

This matches GS1 (#75 §6.4): no server-generated excerpts of record content.

### 14.2 Role-based previews

The same notification type can be seen by users with different access only if every recipient passes
the type's `requiredPermission`, so a single safe text works for all of them. If two audiences need
different text (for example a leave approver vs an admin override), the producer uses **two types**,
each with its own permission and text, rather than one type with conditional fields.

### 14.3 Deep links

- Stored as a structured target: `{ zone: 'projects', kind: 'project_task', id, parentId? }`, derived
  from `subject` and `parent`. No URLs are stored, so links survive routing changes.
- In-app: the client maps the target to its Zone navigation (the registry's stable `route` ids). The
  record screen loads through the Zone's API, which applies its own permission and record checks. If
  that fails, the screen shows "You don't have access to this record" or "This record was deleted";
  the notification never had the data to show instead.
- Email links: need browser URL routing, which is deferred in `app-shell.md`. N1-D therefore depends
  on URL routing for at least the linked record screens; until then an email can link only to the app
  home with the notification panel open (`/b/:slug/notifications/:id`), which the web app would also
  need to route. Desktop links (`pixa://…`) need a registered URL scheme in Tauri, which is an ADR 0005
  capability change and is N1-E.
- Links in email contain the notification id only (no record ids or tokens). Opening it requires a
  signed-in session; the server then resolves and re-checks the target.

---

## 15. Accessibility and UI

- **Entry point:** a bell button in the top bar (restoring the slot removed by D-V2A-6) with an
  accessible name that includes the count: "Notifications, 3 unread". Count shown as "99+" beyond 99.
  No colour-only signal; the badge has text.
- **Panel:** a non-modal popover (desktop) or full-height sheet (narrow widths), opened with the
  button, closed with Escape, focus moves into the panel and returns to the bell. Keyboard: arrow keys
  between items, Enter opens, a visible "Mark as read/unread" control per item (not hover-only).
- **List semantics:** a list with each item as a single link plus secondary actions; unread state in
  text ("Unread") for screen readers, not only bold weight. Sections "Needs action", "Your account",
  "Earlier".
- **Live updates:** when polling finds new items, update the bell's label; announce through a polite
  `aria-live` region at most once per minute ("2 new notifications"), never for every item, and never
  steal focus. Respect `prefers-reduced-motion` for any badge animation.
- **Time:** relative ("5 min ago") with the absolute time in the business time zone on hover and in
  the accessible name.
- **Dark and light themes, contrast** per the V2-A design system tokens; touch targets ≥ 44 px on
  narrow widths.
- **Empty, error and offline states:** "You're all caught up", "Couldn't load notifications. Retry",
  and an offline note when the client is offline (existing D4 offline banner).
- **Full page:** "All notifications" with filters (Unread, Category, Archived) for users who prefer a
  page to a popover.
- Emails: semantic HTML, one clear link, no images required to understand the message, plain-text
  part always included.

UI implementation is a V2 follow-on and uses the design system; N1 specifies behaviour only.

---

## 16. Rate limits and noise reduction

- **Grouping (N1-A):** rows with the same `group_key` (`type + subject`, or `type + parent` for types
  that group by parent) within 24 hours collapse in the list into one item ("Ana assigned you 4 tasks
  in Kelp Renovation"), newest first; expanding shows each. Grouping is a read-time view; rows stay
  separate.
- **No self-notifications:** the actor never gets a notification about their own action unless the
  type is a security notice.
- **Superseded updates:** for types that opt in, the list shows only the newest unread row per
  subject and type (a read-time view, like grouping; older rows are not changed, because the actor may
  not update recipients' rows).
- **Per-recipient limit (skip, not fold):** at most 50 non-mandatory notifications per recipient per
  type per rolling hour. Before inserting, `notify` counts that recipient's rows of that type created in
  the last hour (index `(business_id, recipient_user_id, type, created_at)`); at 50 or more the
  recipient is skipped with `SKIPPED_CAP` and the producer's change commits. No summary row is written
  or updated, so there is no shared counter to lock. The count is not locked, so concurrent producers
  can overshoot by a few rows: this is a noise limit, not a security boundary. A failing count query is
  `ERROR_DATABASE` (rolls back) like any other database error. Read-time grouping already collapses
  bursts below the limit.
- **Per-business limit:** 5 000 non-mandatory notification rows per business per rolling 24 hours
  (same unlocked count, index `(business_id, created_at)`); beyond that new non-mandatory rows are skipped (`SKIPPED_CAP`, §7.1.1) and an operational counter is raised
  (protects against a runaway import or loop). Mandatory rows are not counted towards it. Values are
  proposals (D-N1-6).
- **Bulk operations:** imports and bulk edits pass `suppressNotifications: true` and the producer emits
  one summary notification instead (for example "12 tasks were assigned to you").
- **Email:** at most one email per recipient per type per 15 minutes; others are batched into the next
  one. Digest option (daily) in N1-D. Quiet hours per user in the user's time zone, except security
  notices.
- **Time-based reminders:** one per stage per subject (§6), never repeated daily unless a type
  explicitly defines repeating stages.

### 16.1 Mandatory notices and caps

- **Exempt from every cap, limit, preference and quiet-hours rule.** Limits apply only to
  non-mandatory types, and non-mandatory volume is counted separately, so one tenant flooding ordinary
  notifications cannot push a security or access notice out.
- **Bounded by registration instead of by cap.** A mandatory type must declare a bounded recipient
  spec: explicit `users` (at most 10) or a fixed role set such as "every OWNER". A registration that
  could fan out without bound is a contract error (`ERROR_CONTRACT`).
- **Fail closed** (§7.1.1): if a mandatory notice cannot be written, the change that triggered it does
  not happen.
- **Durable fallback for email (N1-D):** the delivery row for a mandatory email is created in the same
  transaction as the notice, so it cannot be lost between commit and send; retries follow §7.4 and a
  `DEAD` mandatory delivery raises an operator alert (counts and codes only).
- **Spam resistance:** a mandatory notice is only produced by a real, audited change (a role change, a
  suspension, an ownership transfer, a password change), so its rate is bounded by the rate of those
  changes. N1 proposes a rate limit on the endpoints that produce them (for example 30 membership
  changes per actor per hour), and email for mandatory notices is coalesced (one email summarising
  several changes within 15 minutes) while every in-app row is still written.
- **Monitoring:** counters for `ERROR_MANDATORY`, mandatory rows written, and mandatory email
  deliveries by state, with an alert on any `ERROR_MANDATORY` or `DEAD` mandatory delivery.

---

## 17. Security review summary

| Threat | Control |
|---|---|
| Cross-tenant leak | Business from tenant context only; RLS + recipient policy; composite FK to memberships; isolation tests |
| Same-tenant leak to someone without access | Write-time eligibility; read-time re-check (§5.4); record checks; no create endpoint |
| Sensitive text in snippets | Sensitivity classes; schema check rejecting strings for `PEOPLE`/`PAYROLL`/`MAILBOX`; no amounts in `FINANCIAL`; email sentences only |
| Stale access after demotion, suspension or removal | Read-time re-check; cascade on removal; pre-dispatch re-check for email |
| Enumeration through ids | All endpoints act only on the caller's rows; unknown or foreign ids are ignored silently (same response as success, so ids cannot be probed) |
| Email as a phishing vector | System sender on our own domain with SPF/DKIM/DMARC (existing Resend domain); no credentials in links; generic copy users can learn to trust |
| Account takeover hiding its tracks | Security notices are mandatory and go to email; email change notifies the old address |
| Notification flood (bug or abuse) | Caps (§16); bounded recipients; bounded params size |
| Producer failure due to notifications | `notify` does no I/O, has bounded work; contract tests on every registration |

---

## 18. Roadmap

Each stage: own thread, branch and draft PR, ChatGPT audit, Regan's approval before merge, migration
applied separately with Regan's approval. Stamps must sort after every migration on `main` and in open
PRs at the time; none is reserved by this document.

| Stage | Scope | Depends on | Production effect when merged |
|---|---|---|---|
| **N1-A** | `notifications` module, registry, `notify` (§7.1.1), purge-own cleanup (§13.1); `notifications` table (one migration), the purge function and the two trigger functions of §5.2.1, with subject-erased triggers on the N1-A subject tables (tasks, projects, customers, opportunities, finance documents, scheduling events) (privileged SQL, reviewed and applied with `db:privileged` under Regan's approval); inbox API and contracts; **only the producers in §18.1 marked N1-A** (none mandatory); bell, panel and full page | Regan's approval of this design; V2 bell slot | Table and functions exist; notifications appear in-app. No email, no cron |
| **N1-U** | `user_notices` table and the trigger functions of §11.2; `/api/v1/me/notices`; password, email, role-change and ownership notices (can ship before A2-B: these changes exist today); suspension and reactivation once A2-B adds them | Privileged SQL review; A2-B merged for the last three | In-app account and access notices. No email |
| **N1-B** | Preferences and business defaults; mute record; grouping refinements; opt-in types; cross-business unread counts (if D-N1-8) | N1-A; A3 settings placement | In-app only |
| **N1-C** | Time-based producers (task due/overdue, quote expired, invoice overdue); retention job; `app_private.notifications_due`; job route behind `NOTIFICATIONS_JOBS_ENABLED` | N1-A; Vercel plan cron limits checked; Regan approves turning the job on | **None** until Regan enables the job |
| **N1-D** | Email channel: delivery rows, worker, `EmailTransport` extension, templates, suppression, optional bounce webhook, security notice emails | N1-A, N1-C job pattern; browser URL routing for links; legal check (D-N1-17); Regan approves enabling | **None** until Regan enables email |
| **N1-E** | Desktop OS notifications (Tauri notification plugin, ADR 0005 capability review), web push, SSE/real-time, SMS (paid, separate decision) | N1-D | Per decision |
| With P3-B | `people.leave.*` producers | P3-B and its approver resolver | In-app |
| With A2-B | `communications.mailbox.access_removed` (tenant inbox); suspension notices start firing through the N1-U trigger once A2-B can suspend | A2-B merged | In-app (+ email in N1-D) |
| With C2-C | `finance.reminder.delivery_*` | C2-C | In-app |

### 18.1 Which producers ship in N1-A, and how they run

Only producers whose trigger exists on `main` **and** runs in an ordinary tenant unit of work with a
verified session user. Every one of them calls `notify` inside the same `withTenant` transaction that
makes the change, after the row lock the service already takes.

| Producer | Ships in | Transaction / identity path | Notes |
|---|---|---|---|
| `projects.task.assigned` / `.unassigned`, `projects.project.owner_assigned` | N1-A | Projects service, session user, task/project row locked (existing version check) | Member removal clears assignees without notifying (removal is not reassignment) |
| `customers.customer.owner_assigned` | N1-A | Customers service, session user | |
| `sales.opportunity.owner_assigned` | N1-A | Sales service, session user | |
| `finance.quote.accepted` / `.declined` | N1-A | Finance F1 transition service, session user holding `finance:issue`, document row `FOR NO KEY UPDATE` | Expiry is time-based: N1-C |
| `scheduling.event.overlap_kept` | N1-A | Scheduling S1 write path, session user, inside the S1 lock protocol (notify runs after the locks, adds no new lock) | D-N1-10 |
| `tenancy.membership.role_changed`, `tenancy.ownership.changed` | N1-U, **mandatory**, user-level | Members PATCH (exists today) or the A2-B transfer, session user with `members:manage`; A2 locks the row and checks authority; the `memberships` `AFTER UPDATE` trigger writes the notice in the same statement | Fails closed; never depends on the new role (§7.1.1 rule 3a); no callable writer |
| `tenancy.membership.removed` | N1-U | Existing member removal; `AFTER DELETE` trigger | Purge cascades excluded |
| `tenancy.membership.suspended` / `.reactivated` | N1-U trigger, live once A2-B can suspend | `AFTER UPDATE OF status` trigger | Needs A2-B |
| `account.password.changed`, `account.email.changed` | N1-U | `AFTER UPDATE` triggers on `accounts.password` / `users.email` | No adapter hook needed |
| `tenancy.invitation.accepted` | Later | Acceptance runs inside `app_private.accept_invitation` (pre-tenant SECURITY DEFINER), which cannot call `notify`. Needs either a privileged-SQL insert (reviewed) or a follow-up tenant unit of work after acceptance | Not in N1-A |
| `communications.mailbox.reconnect_required` | With C2-B3 | System path (`withTenant({ userId: null })`) in refresh/sync. Needs an additive RLS insert policy for system notifications limited to registered `communications.system`-sourced types, mirroring `audit_system_write`; agreed with the C2 thread | Not in N1-A; no sync worker runs today |
| `finance.billing.run_failed` | When F6 jobs are enabled | Billing worker system path, same additive policy for `finance.system`-sourced types | |
| `people.leave.*` | With P3-B | People request/decision services, session user; approver from the People resolver | |

### 18.2 MVP (N1-A) acceptance criteria

1. A notification is written only inside the producer's transaction; a rolled-back change leaves no
   notification (tested).
2. A user sees only their own notifications in the current business; RLS proves it with the service
   scope disabled (isolation test S8 style).
3. A recipient who loses the type's permission stops seeing it immediately and it is not counted;
   restoring the role restores it.
4. A suspended or removed member gets nothing new; a removed member's rows are gone.
5. `PEOPLE`, `PAYROLL` and `MAILBOX` registrations with string params fail CI.
6. Duplicate events produce one row.
7. The bell, panel and page meet §15 (keyboard and screen reader pass recorded).
8. No email, cron, queue or provider is added.
9. Every `notify` outcome in §7.1.1 has a test: errors roll the producer back, skips commit (including
   the hourly and daily limits).
10. The badge never counts a row whose record check fails for the reader (§5.4).
11. `bos_app` has no `DELETE` and no `UPDATE (resolved_at)`; purge, erase and resolve work only through
    §5.2.1, and purge never touches another user's rows.

N1-U adds: role changes (every demotion path, and concurrent changes) commit with their user-level
notice and roll back if it cannot be written; `user_notices` isolation as in §11.2.

---

## 19. Testing strategy

| Layer | Tests |
|---|---|
| Contracts (`packages/contracts/tests`) | Every registered `(type, schemaVersion)` has a schema; sensitivity rules (no strings for sensitive classes, no money fields in `FINANCIAL`); snapshot test of the registry so changes are reviewed; unknown-version fallback renders |
| Unit (module) | Recipient resolution order; preferences resolution (mandatory beats everything, locked defaults); grouping and superseded views; `dedupe_key` builders per producer |
| Integration (`tests/integration/notifications.test.ts`) | Each N1-A producer writes the right rows for the right recipients and none for the actor; every §7.1.1 outcome (rollback on each error, commit on each skip, mandatory fail-closed with a forced insert failure); `ON CONFLICT` dedupe; recipient cap on non-mandatory types only; badge never counting a row after record access is revoked with the coarse key kept; purge-own bounds and recipient scoping; hourly and daily limits skip without writing; read/unread/archive idempotency; mark-all with `before`; read-time re-check after role change, suspension and record-check failure; expiry hidden at read; erasure deletes by subject |
| Isolation (`tests/isolation`) | New tables have RLS forced, `business_id`-leading indexes, composite FKs; user A cannot list or update user B's rows in the same business; cross-business ids ignored; `bos_app` cannot delete; `user_notices` visible only to its user, not insertable by `bos_app`, privileged write functions refuse wrong caller, business, target or type (N1-U); §5.2.1 functions tested as the real `bos_app` with RLS forced (no `DELETE` grant, purge cannot reach another user, erase/resolve cannot reach another business) |
| Concurrency | Assignment racing member removal (removal first: no row; assignment first: row then cascade); suspend racing a notify (`FOR SHARE` on membership) using the `pg_blocking_pids` deterministic pattern |
| Boundaries | dependency-cruiser: notifications module imports no Zone module; Zone modules import only `@/modules/notifications` index; record checks wired only in `app` |
| Jobs (N1-C/D) | 503 without secret or switch; claim with `SKIP LOCKED` and lease; lost lease changes nothing; backoff; `UNKNOWN` never resent; pre-dispatch re-check suppresses; counts-only response |
| Email (N1-D) | `log` transport snapshots of every template show no forbidden fields (property test over generated params); plain-text part present; footer present |
| Accessibility (client) | axe checks on bell, panel, page in both themes; keyboard-only flow; live-region throttling |
| Load (before N1-C) | 50-member business, 10 000 rows per user: list and count p95 under 50 ms locally; notify adds under 5 ms to a producer transaction |

---

## 20. Owner decisions

**Status:** Regan accepted the recommended D-N1-1 to D-N1-18 on 2026-11-16 (project thread), subject to
the safeguards in the latest audit; D-N1-18 is accepted conditionally, for the restricted beta only.
Implementing N1-A or N1-U, privileged SQL, any production migration, scheduler or email activation, and
merging this PR each still need Regan's separate approval.

| # | Decision | Recommendation |
|---|---|---|
| D-N1-1 | Approve the two boundaries: inbox row is the single source of truth; notifications are pointers with read-time permission re-checks | **Yes** |
| D-N1-2 | N1-A writes in the producer's transaction, with the outcome table of §7.1.1 (errors and mandatory failures roll back; skips, including non-mandatory cap, commit) | **Yes** |
| D-N1-3 | MVP scope: event-driven, in-app only, no scheduler, no email | **Yes** |
| D-N1-4 | First producer set: only the N1-A rows of §18.1 (none mandatory); role change, account and access notices as user-level notices in N1-U; invitation accepted and mailbox reconnect deferred | **Yes** |
| D-N1-5 | Sensitivity classes and text rules (§3.3, §14.1), including "no People text at all" | **Yes** |
| D-N1-6 | Limits for non-mandatory types, all **skip** (never fold): 100 recipients per event, 50 per recipient per type per rolling hour, 5 000 per business per rolling day, unlocked counts (soft); mandatory types unlimited but bounded by registration and fail closed (§16, §16.1) | **Yes**, revisit with real usage |
| D-N1-7 | Badge is an ACL-safe lower bound: record-scoped types counted only after a batch record check on the newest 20 unread; `complete: false` when truncated; never over-counts (§5.4) | **Yes** |
| D-N1-8 | Cross-business unread indicator (counts only) | **N1-B**, not MVP |
| D-N1-9 | Who hears about an overdue invoice: creator only, or also all `finance:billing` holders | **Creator plus `finance:billing` holders**, each can mute |
| D-N1-10 | Notify creators of events overlapped by "Keep the overlap" | **Yes**, `UPDATE`, can be turned off |
| D-N1-11 | Email provider for N1-D: keep Resend through `core/email` | **Keep Resend**; re-check its current pricing and volume limits before N1-D (not verified here) |
| D-N1-12 | Retry policy: 30 s × 2^n, max 1 h, 8 attempts; `UNKNOWN` never auto-resent | **Yes** |
| D-N1-13 | Email digests (daily) in N1-D | **Yes, opt-in** |
| D-N1-14 | New-device sign-in notices (needs device/session fingerprinting, a privacy decision) | **Later**, separate design |
| D-N1-15 | Name the business in access notices | **Role change: yes while still a member (rendered at read). Suspension/removal: no in-app; yes in email, subject to the legal review in D-N1-17** |
| D-N1-16 | Business name and `STANDARD` record titles in email | **Business name yes; titles off by default, business can enable** |
| D-N1-17 | Legal check that notification emails are transactional in target markets (US, AU, EU/UK, CA) | **Get advice before N1-D**; unverified here |
| D-N1-18 | Retention 90 days (archived 30, `user_notices` 1 year) with purge-own cleanup through `notifications_purge_own`; untouched expired rows can persist indefinitely until the retention job runs (§13.1); exclude notifications from business export as a product choice, include them in personal-data access (§13.3) | **Conditional:** accept the residual storage for the invite-only beta only after the §5.2.1 functions exist and the D-N1-17 privacy review; build and enable the retention job before any wider release |

---

## 21. Out of scope

- Customer- or contact-facing notifications (that is Communications C2-C and future portals).
- Chat, comments, mentions, followers/watchers (no model exists; a later design may add "follow
  record").
- Workflow automation rules ("when X, notify Y") configurable by businesses (W1 territory).
- Marketing or product-announcement messages.
- Any change to Communications, Finance, People, Scheduling or Administration code in this PR.

---

## 22. Files this document relies on

`docs/architecture.md` §5.2, §7; `docs/data-model.md` §4.8, §5, §7.1; `apps/api/src/core/email/index.ts`;
`apps/api/src/core/audit/index.ts`; `apps/api/src/core/db/with-tenant.ts`;
`apps/api/src/modules/access/server/permissions.ts`; `apps/api/src/app/api/internal/jobs/*`;
`apps/api/vercel.json`; `apps/api/prisma/schema/{tenancy,projects,customers,sales,scheduling,finance,mail-connections}.prisma`;
`docs/finance-billing-f6.md` §5, §10.4–10.6; `docs/communications-c2.md` §2; `docs/communications-e1.md`
§7, §13; `docs/people-leave-p3.md` §3.2; `docs/scheduling-s1.md` §4.2; `docs/scheduling-s2.md` §9;
`docs/administration-a2.md` §3.8–3.10 (and PR #76); `docs/ui/app-shell.md`;
`docs/ui/pixa-design-system-v2-a.md` §8, D-V2A-6.

---

## 23. Audit response (ChatGPT audit on PR #80, head `c7424bc`)

| # | Finding | Change |
|---|---|---|
| 1 | HIGH: cap drop vs rollback contradiction | §7.1.1 outcome table: errors and mandatory failures roll back; intentional skips (including non-mandatory cap) commit; mandatory never capped; tests listed; §5.1 step 7, §16, D-N1-2 aligned |
| 2 | MEDIUM/HIGH: approximate badge leaks restricted events | §5.4: badge counts record-scoped rows only after a batch record check (newest 20), may under-count, never over-count; D-N1-7 revised; tests added |
| 3 | MEDIUM: missing hooks and transaction contexts | §18.1 lists every producer with its stage and identity path; N1-A ships only session-user tenant producers; password notice and suspension/removal move to N1-U; invitation accepted and mailbox reconnect deferred with reasons; §11.2 defines the privileged write functions and isolation tests for `user_notices` |
| 4 | MEDIUM: mandatory vs caps | §16.1: mandatory exempt from caps and folding, bounded by registration, fail closed, durable email fallback, endpoint rate limits, monitoring |
| 5 | MEDIUM: retention and export | §13.1: opportunistic bounded deletion without a scheduler, residual exposure stated, gate in D-N1-18; §13.3 separates business export from personal-data access and makes no legal-exemption claim |

### 23.2 Re-audit on head `4850b9d`

| # | Finding | Change |
|---|---|---|
| A | HIGH: cleanup and erasure need `DELETE` that `bos_app` does not have; actor deleting recipients' rows | §5.2.1: three `bos_maint` `SECURITY DEFINER` functions (purge own expired rows, erase by subject, resolve `ACTION`), business-bound RLS for `bos_maint`, no `DELETE` for `bos_app`; `notify` no longer deletes; §9 resolve and §16 "superseded" no longer update recipients' rows; real-role tests in §19 |
| B | MEDIUM: 50/hour fold vs skip | §16: skip (`SKIPPED_CAP`), unlocked soft count, no summary row; §7.1.1, D-N1-6, tests aligned |
| C | HIGH: mandatory role-change notice could block a demotion or become unreadable | Role change, suspension, removal and ownership transfer are user-level notices via `record_access_notice`, written after the update in the same transaction under the membership lock; §7.1.1 rule 3a; moved to N1-U; N1-A has no mandatory producer; demotion and race tests listed |
| — | Badge called exact; indefinite residual storage | §5.4 now "ACL-safe lower bound" with `complete: false`; §13.1 states indefinite persistence without the job, an order-of-magnitude size, and the wider-release gate |

### 23.3 Third audit on head `de7619b`

| # | Finding | Change |
|---|---|---|
| 1 | HIGH: callable erase/resolve functions let any tenant session erase or resolve others' notifications | §5.2.1: erase and resolve are **trigger functions** on the subject/action tables, with no `EXECUTE` grant; they fire only on a real delete, erasure or open→closed transition in the same transaction; mismatched business aborts; tests for direct-call refusal and non-transition updates. Only `purge_own` remains callable, and it touches only the caller's own rows |
| 2 | MEDIUM/HIGH: access-notice ordering and provenance | §11.2: no callable `record_access_notice` or `record_account_notice`. Notices are written by `AFTER` row triggers on `memberships` (role, status, delete), `accounts.password` and `users.email`, with params only from `OLD`/`NEW`; ordering per operation in the §11.2 table; authority, rank and owner checks stay in the A2 services that make the change; tests for demotion, suspension, removal, transfer, concurrency and spoofing |
| — | §7.1.1 mixed `notify` with user-level notices | §7.1.1 now states it covers the tenant-inbox path only and points to the trigger path; `ERROR_MANDATORY` example no longer uses role or ownership; §18.1 rows aligned |
