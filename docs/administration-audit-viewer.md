# Administration audit viewer (A-AUD): architecture and UI plan

Status: **Proposal, documentation only.** Revision 2 (2026-11-17) folds in ChatGPT's conditional design pass on PR
#125 (five corrections: target default-deny, bounded date windows, former-actor privacy, dotted prefix and safe
display, RLS facts verified first). Decisions remain proposals until Regan accepts them. Nothing here changes code, schema, RLS, grants, migrations, contracts or
production. Base: `main` at `06405a5`. Open PRs checked for overlap: #119 and #122 (Settings shell and Team, both
touch `packages/app/src/zones/settings/pages.ts` and `app.tsx`), #118 (C2-B2 docs), #110 (WF-1B-1, links, not audit
rows). No open PR touches `core/audit`. This plan **refines** the A2-E and A3-C rows of
`docs/administration-a2.md` §5 and `docs/settings-a3-architecture.md` (G-A3-8, §7.5); where they differ, this
document proposes the detail and the decisions in §10 settle it.

## 1. Summary

Pixa OS already writes a tenant audit trail from every Zone, but nobody can read it: `audit:read` is granted to OWNER
and ADMIN and used by no route. The viewer is **one read-only API and one Settings page**, with no migration:

- `GET /api/v1/b/{slug}/audit-events`, key `audit:read`, cursor-paged, filterable, with **default-deny metadata**
  (only allow-listed keys per action leave the server).
- Settings › Security & audit › **Audit log**, shown only to `audit:read` holders, read-only, no export in v1.

It never writes, never edits, never deletes, and shows no platform events.

## 2. What is recorded today (verified in `main`)

Table `audit_events`: `id`, `business_id`, `actor_user_id`, `action`, `target_type`, `target_id`, `metadata jsonb`,
`ip_address`, `user_agent`, `created_at`. Indexes: `(business_id, created_at DESC)` and `(actor_user_id, created_at
DESC)`. **Nothing writes `ip_address` or `user_agent`** (the only `userAgent` hit is the desktop session helper), so
the viewer neither selects nor shows them.

Writers (all inside the same unit of work as the change):

| Writer | Role / policy | Actions |
|---|---|---|
| `recordAudit` (`core/audit`), and `members.ts` helper | `bos_app`, `audit_tenant_write`: `actor_user_id` must equal the session user | every Zone below |
| `recordSystemAudit` | `bos_app`, `audit_system_write` / `audit_finance_system_write`: no actor, no session user, only `communications.system.*` and `finance.system.*` | provider revocation, holder departure, billing worker |
| Privileged definer paths | `bos_definer`, `bos_maint` (`maint_erasure_audit`) | `business.created`, `invitation.accepted`, `communications.erasure.*`, `communications.legal_hold.*`, retention events. A RESTRICTIVE policy stops `bos_app` forging `communications.erasure.*` |
| Platform events | `bos_auth`, `business_id IS NULL` | invisible to tenant reads (RLS), operator-only. **Out of scope** |

Action families on `main` (from `recordAudit` call sites, 2026-11-17): `business.*`, `membership.*`, `invitation.*`,
`customer.*`, `contact.*`, `activity.*`, `sales.pipeline.*`, `sales.opportunity.*`, `projects.project.*`,
`projects.task.*`, `scheduling.calendar|event|resource.*`, `people.employee|leave_policy|leave_type.*`,
`finance.document|document_pdf|statement_pdf|payment|allocation|credit_application|expense|expense_allocation|
catalog|recurring|reminder|reminder_policy|reminder_hold|settings|branding.*`, `reporting.view.*`,
`communications.address|domain|connection|member|sync|retention|legal_hold|erasure|system.*`, plus legacy
`message.recorded`, `conversation.created`, `messages.imported`.

**Coverage gaps (stated, not fixed here):**

- Audit is **write-only coverage by convention**: nothing enforces that a new mutation audits. The viewer must not be
  described to users as a complete record. Copy: "Recorded changes", not "everything that happened".
- Reads are not audited, except PDF previews and downloads (`finance.document_pdf.*`, `finance.statement_pdf.downloaded`).
- Sign-in, password and session events have **no tenant home** (identity audit is `identity_events`, A3-A, operator-only).
- Membership events exist (A2-B). Reporting saved views audit. Search, notifications and workflow links (WF-1B) do not
  exist yet; they add actions later and the viewer must tolerate unknown actions (§5).
- Event naming is inconsistent (`activity.created` vs `finance.document.created`, `member_removed` appears as an error
  code, not an action). The viewer groups by the **first dotted segment** and treats anything else as "Other".

## 3. Access: RBAC and RLS

- **Permission:** `audit:read`, held by OWNER and ADMIN only (`ROLE_PERMISSIONS`; unit test asserts MANAGER is denied).
  The route uses `tenantRoute({ permission: 'audit:read' })`. The membership and key are re-checked on every request,
  so a removed or suspended member loses access on the next call.
- **RLS:** `audit_tenant_read` already limits a `bos_app` read to `app.business_id`. No policy or grant change is
  needed. The route reads through `TenantDb` only, never `bos_definer`/`bos_maint`.
- **No cross-business reads:** the slug picks the business, as for every route. A foreign `id` filter answers an empty
  page, not a distinguishable error.
- **Not for MANAGER/MEMBER.** A member-visible "my recent activity" or per-record history is a different surface
  (§9) and is not part of v1 (D-AUD-4).
- **Actor names:** `users` RLS exposes only the signed-in user and **current** members. A departed actor resolves to
  nothing, so the viewer shows "Former member" (no id, no email). `actor_user_id IS NULL` shows "System" (only
  `*.system.*` actions can produce it). Emails are never joined: names only.

## 4. API

`GET /api/v1/b/{slug}/audit-events`

| Query | Rule |
|---|---|
| `limit` | 1..100, default 50 (shared `Limit` helper) |
| `cursor` | opaque base64url encoding of `(created_at, id)` of the last row; invalid cursor answers 400 `invalid_cursor` |
| `actionPrefix` | optional, `^[a-z_]+(\.[a-z_]+)*$`, max 60. Matched on a **dotted boundary**: `action = $1 OR action LIKE $1 \|\| '.%'` with `%`, `_` and `\` escaped, so `sales` never matches `salesforce` |
| `actorUserId` | optional UUID of a **current member** (taken from the `userId` the response returns). An id that is not a current member of this business, including a departed member's, answers the same empty page as an unused id: no distinguishable error, no count, no hint (D-AUD-9) |
| `targetType`, `targetId` | optional, together or `targetType` alone |
| `from`, `to` | optional ISO timestamps. **Always bounded to 92 days:** neither given means `to = now`, `from = to - 92 d`; only `to` means `from = to - 92 d`; only `from` means `to = min(now, from + 92 d)`; both must satisfy `from <= to` and `to - from <= 92 d` (else 400). "Older history" means moving the window back in 92-day slices, never a wider window. Ties on `created_at` are ordered by `id`, and the cursor binds `(created_at, id)` plus the filter set, so a cursor reused with different filters answers 400 `invalid_cursor` |

Response: `{ events: AuditEventView[], nextCursor: string | null }` where an `AuditEventView` is
`{ id, createdAt, action, actor: { kind: 'member' \| 'former_member' \| 'system', userId?: string, name?: string },
target: { type, id } \| null, metadata }` (target disclosure is rule-driven, §5). `userId` is returned only for `kind: 'member'` (to enable the actor filter), never
for a former member. Contract lives in a new `packages/contracts/src/audit.ts` (strict zod, additive), exported from
`index.ts`, with the `api-v1.json` snapshot regenerated (shared files, §8).

**Ordering and paging.** Order `created_at DESC, id DESC`; keyset paging, never `OFFSET`. The existing
`(business_id, created_at DESC)` index serves it. **Known limitation:** `created_at` defaults to `now()`, which is the
*transaction start*, so a long transaction can commit an event with an older timestamp after a reader has paged past
it. The UI shows an "as of" time and offers Refresh; it does not claim to be a live tail. A tie-break column or a
commit-ordered sequence is **not** proposed.

**Performance.** The prefix filter scans the business's slice in time order. At beta volume that is fine; the plan
adds **no index in v1** and sets a measured trigger: if a business exceeds ~100k events or the p95 of a filtered page
passes 300 ms, a follow-up migration adds `(business_id, action text_pattern_ops, created_at DESC)`. A hard cap of 92
days per query and 100 rows per page bounds work. Statement timeout is the route default.

**Errors.** 401/403 through the normal envelope; 400 for invalid filters; 429 from the shared route limiter (60
requests per minute per user is proposed; confirm against the limiter's existing configuration). Reads are not
themselves audited (D-AUD-6).

## 5. Metadata: default-deny

Existing metadata is written by many modules and was never designed for display. Rules:

1. **A registry** `AUDIT_VIEW_RULES` (new file in `core/audit`) maps an exact action or prefix to `{ label, group,
   allowedKeys, target: 'show' \| 'type_only' \| 'hidden' }`. The server drops every metadata key not in `allowedKeys` and every non-primitive value
   except string arrays, truncates strings to 200 characters, and returns `{}` for an action with no rule.
2. **Unknown actions are still listed** (action string, time, actor, target), with a generic label and **no
   metadata**. A new Zone's events appear immediately and safely.
3. **Never exposed, whatever a module writes:** tokens, hashes, emails, message subjects or bodies, free text, names of
   customers or contacts, provider payloads. E1 already requires that its events carry only ids, counts, reason codes
   and scopes; this is enforced here as well, with a test that seeds a forbidden key and expects it dropped.
4. **Known sensitive case:** `membership.removed` stores the removed person's `userId` in metadata. It is on the
   deny side (not in `allowedKeys`): the removal row shows role and `mailboxesStopped` only.
5. **Role/status codes only:** `from`/`to` roles, statuses, regional codes (`business.updated`), field *names*.
   This matches Settings A3 §12.1.
6. **Targets are default-deny too.** `target_type` and `target_id` can name erased subjects, private mailbox
   references, People records or other entities the viewer should not learn about. An action's rule must say `show`
   (type and id), `type_only` (id suppressed) or `hidden`. Unknown actions get `type_only` at most; erasure,
   mailbox-address and People-personal actions start as `type_only` or `hidden`. The server applies this before
   serialising, and tests seed rows directly in SQL to prove an id never leaves for a `hidden` or `type_only` rule.
7. **Safe display.** Action strings and labels are bounded (60 and 200 chars) and the UI renders all of them as
   text, never as HTML.
8. `ip_address`, `user_agent` are not selectable by the route's `select` list (§2).

A **registry coverage test** lists every action literal found in `apps/api/src` (the same scan used in §2) and fails
when one is neither in the registry nor in an explicit `UNLABELLED_OK` list, so adding an audited action forces a
display decision in review. That is the mechanism that keeps the viewer honest as Zones grow.

## 6. Retention, erasure and E1

- **Kept as long as the business exists** (E1 §13 item 4, still open). The viewer **adds no delete, redact or purge**,
  and the table keeps no UPDATE/DELETE grant. Changing retention is Regan's decision with legal review, not part of A-AUD.
- **Erasure:** `communications.erasure.*`, `communications.legal_hold.*` and retention events are evidence that content
  was erased. They show **ids, counts, reason codes and scopes** only. The viewer displays them like any other group
  and renders erased targets as "Erased record" (the target row may no longer resolve). It must never try to fetch the
  erased entity.
- **Account deletion** (A3-D, deferred): audit rows keep the user id. After deletion the actor resolves to "Former
  member" automatically; no viewer change needed.
- **Backups and recovery branches** hold audit rows too (E1 §10). Not affected.
- The viewer itself stores nothing and has no cache beyond the browser's in-memory page state.

## 7. UI plan (Settings › Security & audit › Audit log)

Built after #119 and #122 merge, as a **Settings page, not a Zone** (A3 §7.5). One new entry in `SETTINGS_PAGES`:
`{ id: 'audit', scope: 'business', label: 'Audit log', description: 'Who changed what, and when.', requires:
['audit:read'] }`, plus `packages/app/src/zones/settings/audit-log.tsx`, a small `audit-rules.ts` (labels and groups,
mirrored from the server registry through the contract's `label`/`group` fields so there is a single source) and
tests. No new design token, no new shell concept; it uses `states.tsx`, the Settings page frame and V2 tokens.

- **Layout:** a table (time, who, what, target) on desktop; a stacked list on 390 px. Newest first. A header strip:
  "Showing recorded changes as of 14:02 · Refresh". Rows are not clickable cards; a row has a "Details" disclosure
  that shows the allow-listed metadata as labelled key/value pairs (never raw JSON).
- **Filters:** Group (Team, Customers, Sales, Projects, Scheduling, People, Finance, Communications, Settings, Other),
  Person (members plus "System"), Date range (24 h, 7 d, 30 d, custom up to 92 d). Filters live in the URL query.
  Empty-filter copy: "No recorded changes match".
- **Time:** shown in the business time zone (`business.timeZone`), with the UTC ISO in the row's `title`.
- **Targets:** a label (customer, invoice, member) and, when the viewer's own permissions open the target Zone route,
  a link to it. No link when the viewer lacks the Zone key or when the target is gone.
- **States:** loading skeleton; empty ("No changes recorded yet"); permission denied (page is simply not listed, a
  direct URL shows the standard "not available" state); error with retry; load-more button (keyset), 50 rows at a time,
  with a "You've reached the 92-day window" end state.
- **Accessibility:** real `<table>` semantics, filters as labelled controls, disclosure with `aria-expanded`, no
  colour-only meaning, works in forced-colours and dark.
- **Read-only copy:** "Audit entries can't be edited or deleted." No export button in v1 (D-AUD-5).

## 8. Ownership, sequencing and conflicts

| Stage | Scope | Migration | Depends on | Owner model |
|---|---|---|---|---|
| **A-AUD-1** | API: contract, `core/audit/read.ts`, `AUDIT_VIEW_RULES`, route, unit + integration + isolation tests | none | none (independent of #119/#122) | Sonnet; ChatGPT audit |
| **A-AUD-2** | Settings page, filters, states, UI tests, screenshots | none | A-AUD-1, #119, #122 merged | Sonnet |
| A-AUD-3 (optional) | Action-prefix index | one additive index migration | only if the §4 trigger is hit | needs its own design |

Claimed paths (A-AUD-1): `apps/api/src/core/audit/**`, `apps/api/src/app/api/v1/b/[slug]/audit-events/**`,
`packages/contracts/src/audit.ts`, `apps/api/tests/{unit,integration}/audit-*.test.ts`. **Shared, needs
coordination:** `packages/contracts/src/index.ts` and `api-v1.json` (one additive line each; rebase at the front of the
queue). A-AUD-2 touches `pages.ts` and `app.tsx` owned by #119/#122, so it starts after they merge. No file under
`apps/api/prisma` changes in either stage. A2-E's concurrency and escalation suite is a separate stage and unchanged.

## 9. Not in v1 (and why)

- **CSV or JSON export:** a data egress feature with its own retention and approval questions. Later, per-Zone.
- **Per-record history panels** (an invoice's own history), **"my activity"** for MEMBER: different permission model
  (Zone key, not `audit:read`); the A-AUD read helper is built so a Zone can reuse it with its own gate.
- **Identity and sign-in events:** `identity_events` (A3-A) is operator-only and separate.
- **Search inside metadata, full-text, alerting, anomaly detection, webhooks/SIEM streaming.**
- **Platform/operator events** (admission, business creation grants).
- **Any write or redact path**, including "hide this entry".

## 10. Decisions for Regan (recommended option first)

| ID | Decision | Recommendation |
|---|---|---|
| D-AUD-1 | Who can read the audit log | OWNER and ADMIN via the existing `audit:read`; no grant change |
| D-AUD-2 | Metadata exposure | Default-deny allow-list per action, unknown actions shown without metadata |
| D-AUD-3 | Depth of history | 92-day query window, keyset paging, no export; older events stay stored and are reached by widening the window |
| D-AUD-4 | Member-visible history | Not in v1; revisit with Zone-owned record history |
| D-AUD-5 | Export | Deferred (separate approval) |
| D-AUD-6 | Audit the act of viewing | No in v1. Revisit if the beta widens; adding `audit.viewed` would write in a GET |
| D-AUD-7 | Index | None now; add only at the measured trigger in §4 |
| D-AUD-9 | Departed and unknown actor filter | Safe empty page, no leakage (§4); the UI offers only current members plus "System" |
| D-AUD-8 | Coverage wording | UI says "recorded changes"; registry coverage test enforces labels for new actions |

None of these is a security escalation under `docs/agent-task-protocol.md`: the plan adds a read path under existing
RLS and an existing permission, and no migration, grant, admission or external effect. If ChatGPT identifies an
unresolved authorisation or tenant-isolation risk, that part escalates to Regan.

## 11. Test plan (for A-AUD-1 and A-AUD-2)

API/integration (`pnpm test:integration`, `pnpm test:isolation`):

- Implementation fact check first: confirm `bos_app` has SELECT on `audit_events` and that `audit_tenant_read` and the
  RESTRICTIVE erasure policy are unchanged. If an access assumption is false, **stop for security review**; never add
  a grant or loosen a policy to make a test pass.
- Window defaults (§4): no params, only `from`, only `to`, both, over 92 days, reversed; cursor reused with other
  filters; `sales` vs `salesforce` prefix; departed or random `actorUserId` returns the same empty page.
- OWNER and ADMIN read; MANAGER, MEMBER, suspended, removed and unauthenticated are refused (403/401).
- Business A events never appear for business B, with and without filters, with a foreign `actorUserId`/`targetId`,
  and through a tampered cursor from another business (cursor carries no business, the query is RLS-scoped).
- Paging: no duplicates or gaps across pages with identical `created_at`; invalid cursor 400; `limit` bounds.
- Filters: prefix escaping (`%`, `_`, quotes), invalid prefix 400, date window > 92 days 400.
- Metadata: forbidden key dropped, long strings truncated, unknown action returns `{}`, `membership.removed`
  does not expose `userId`, `ip_address`/`user_agent` never present.
- Actors: current member name, departed member "Former member", system event "System", no email anywhere in the payload.
- Append-only still holds (no route or role can update/delete); coverage test over action literals.
- Erasure events render ids/counts only; forged `communications.erasure.*` by `bos_app` still refused.

UI (`packages/app/tests`): page hidden without `audit:read`; loading, empty, error, denied, end-of-window states;
filters round-trip through the URL; target links only when permitted; time zone formatting; 390 px layout, dark mode and
forced-colours screenshots (docs/ui/screenshots, reusing the Settings harness).

## 12. Handoff

```text
TASK / BRANCH / BASE SHA: A-AUD plan / claude/project-thread-p2pfnz / 06405a5
DRAFT PR: this PR (docs only)
CHANGED FILES: docs/administration-audit-viewer.md
VERIFIED REPO FACTS: audit_events schema, RLS (tenant read, actor-bound write, system and erasure restrictions),
  audit:read held by OWNER/ADMIN and used by no route, ip_address/user_agent never written, action families (§2),
  Settings pages model in #122 (pages.ts)
DECISIONS: D-AUD-1..8 (§10), recommended options only, none approved
DEPENDENCIES / CONFLICTS: #119, #122 (pages.ts, app.tsx) for A-AUD-2; contracts index/snapshot shared
TESTS RUN / RESULTS: none (docs only)
MIGRATIONS / PROD ACTIONS: None
KNOWN LIMITATIONS: audit coverage depends on each module calling it; created_at is transaction-start time (§4)
NEEDS REGAN: decisions D-AUD-1..8, or confirmation that A-AUD-1 may start
NEXT ACTION: ChatGPT audit, then A-AUD-1 thread (API)
```
