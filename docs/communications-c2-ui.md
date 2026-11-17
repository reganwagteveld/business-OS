# Communications C2-UI: functional mailbox interface — audit, gap analysis and plan

**Status:** docs-only, for owner review. No code, schema, migration or deployment changes.
**Base:** `main` at `84271b3`. **Brief:** Regan, 2026-11-17 (C2-UI-1 to C2-UI-6).
**Method:** read of the repository only (schema, services, routes, adapters, contracts, permissions, UI, tests, docs). Nothing was run against Google or Microsoft, and no production state was read. "Verified" below means "verified by reading code and tests in this repository".

## 1. Bottom line

The brief asks for a mailbox where a user can read, search, reply and send real provider mail. **The backend for that does not exist yet.** The repository has the connection layer (C2-A) and mailbox identity and permissions (C2-B1), plus a dormant retention and erasure layer (E1). It has **no inbound sync, no stored provider mail, no attachments, no folders, no read state, no sending and no `communications:send` permission.** Those are the roadmap stages C2-B2, C2-B3, C2-B4 and C2-C (`communications-c2.md` §17), and the roadmap itself lists the interface (C2-D) as depending on B3 and C.

So a literal C2-UI-A "workspace and reading" PR would have nothing real to show, and the brief forbids mocked messages and simulated success. What can be built honestly today is the **mailbox management UI (C2-UI-C)**, and it should come first. The inbox, reader and composer must wait for their backend stages, each of which is a separate owner-gated PR with a migration, a worker or cron, and external effects (§7). I recommend re-sequencing, not skipping (§5).

## 2. Audit: what exists (verified in code)

### 2.1 Provider integrations
| Item | Finding | Evidence |
|---|---|---|
| Google adapter | OAuth code + PKCE, token refresh, userinfo, Gmail `profile` check, revoke. Scopes `openid`, `email`, `gmail.readonly` only. | `providers/google.ts` |
| Microsoft adapter | Same for Graph: `Mail.Read`, `User.Read`, `offline_access`; BUSINESS adds `Mail.Read.Shared`, `User.ReadBasic.All` (shared mailboxes, tenant domains). No revoke endpoint (`unsupported`). | `providers/microsoft.ts` |
| Adapter surface | `authorizationUrl`, `exchangeCode`, `refresh`, `account`, `businessMailbox`, `revoke`. The interface comment says `listChanges`, `fetchMessage` arrive in C2-B and `send` in C2-C. **None exist.** No call lists, reads or sends a message. | `providers/types.ts` |
| Live verification | Adapters are tested only against stubbed `fetch` fixtures ("no network"). **No evidence in the repo that either provider has ever been exercised live**, and Google's `gmail.readonly` is a restricted scope needing verification and a CASA assessment before external users (Gate C). **Google and Microsoft integration must not be described as working beyond "connect and prove access, against fixtures".** | `tests/unit/communications-providers.test.ts`, c2 §14 |

### 2.2 Connection, identity and permission backend (C2-A, C2-B1)
Implemented, with routes under `/api/v1/b/:slug/communications`:
- Providers list, connection list/get/patch (`sharing`, `syncEnabled`), authorize (start OAuth), disconnect, request sync, list sync jobs; OAuth callback is a **plain HTML page** (`browserRoute`), explicitly temporary until C2-D.
- BUSINESS mailboxes: verified DNS domains, designated addresses with OWNER attestation, member list with READ/SEND (`mail_connection_members`), credential-holder handover, departure rules (eager cutoff from A2-B in `credentials.ts`).
- Retention setting (`retention` routes) required before BUSINESS sync and before sharing PERSONAL mail.
- Dormant E1: erasure requests, legal holds, retention reduction, eligibility, an internal cron route that answers 503 unless `COMMUNICATIONS_RETENTION_JOBS_ENABLED=true`.
- Credentials encrypted per record with bound AAD, refresh fenced by version and lease, sync-job state machine with lease checks on DB time.

### 2.3 Message storage (C1 tables)
`conversations`, `messages`, `message_participants` hold **manually recorded or imported** history only. Constraints that block provider mail:
- `conversations.source` and `messages.source` CHECK allow only `MANUAL` or `IMPORT` (no `SYNC`, no `SEND`).
- `conversations_linked`: every conversation needs a `customer_id` or `contact_id`. A mailbox thread with no known customer cannot be stored.
- `messages` has **no `connection_id`**, no provider thread id, no folder or labels, no read state, no HTML body (text `body` only), no attachment metadata, no delivery state. Messages are immutable (no UPDATE/DELETE grant), so read state, delivery state and re-classification need new tables or a writer role, not columns on this table.
- `retention_category` exists on messages but is "not insertable by `bos_app` until C2-B2".
- C1 read paths (`listConversations`, `listMessages`, timeline, search) have **no mailbox-visibility predicate**; c2 §1.1 already names this as the risk of leaking personal mail through C1 reads.

### 2.4 Permission keys
`communications:read`, `:record` (all roles), `:connect` (OWNER, ADMIN, MANAGER), `:manage_connections` (OWNER, ADMIN). **There is no `communications:send` key** (proposed in c2 §4 for C2-C). READ/SEND exists only as a per-member access value on BUSINESS mailboxes. PERSONAL mailboxes are owner-only or business-shared; `manage_connections` never reads an OWNER_ONLY mailbox. Non-visible connections answer 404.

### 2.5 UI and design system
- **There is no Communications Zone, no mailbox screen and no Settings screen.** `registry.ts` has eight zones; `settings` is `availability: 'planned'`. The only communications UI is C1: the customer-page conversation history, the activity timeline and the note/interaction composers (`zones/activity`, `zones/customers`), tested in `packages/app/tests/communications-ui.test.tsx` against an in-memory fake API.
- No client module exists for the connection APIs (`packages/app/src/api/` has none for communications connections).
- Reusable: `packages/ui` (Alert, Badge, Button, Card, Dialog, Field, Layout, Loading, StatusIndicator, Surface, Table), the V2-B1 tokens, the Pixa Rail shell, `zones/zone-frame.tsx`, `use-load`, `use-layout`, `dialog`, `drafts`, `problem`, `states.tsx` (empty, error, loading), per-zone fake-API test harness (`tests/support/fake-api`). No three-pane layout, list virtualisation, HTML sanitiser or iframe sandbox exists.

### 2.6 Tests
Integration: connections (connect, OAuth state, ownership, refresh fencing, sync jobs, isolation), business mailboxes (identity, members, retention gate, departure, isolation), erasure. Unit: adapters, crypto, env. UI: C1 only. Nothing covers mail content because none is stored.

## 3. Gap analysis

| Capability (brief) | Reusable today | Missing backend | Missing UI |
|---|---|---|---|
| C2-UI-4 mailbox management | Almost all: connect, status, sharing, pause, disconnect, members, domains, addresses, attestation, retention, sync-job list | `GET`-able capability flags (is a worker running, is sync real), reconnect UX hooks, callback redirect into the app instead of bare HTML | Everything: zone entry, screens, client module, tests |
| C2-UI-5 access and privacy | Record rules, READ/SEND members, handover, cutoff, 404 on invisible | Mailbox-visibility predicate in **every** message read path (list, thread, search, timeline, activity, GS1) once mail is stored; `communications:send`; READ vs SEND enforced on send | Show only what the API returns; never use UI visibility as the boundary |
| C2-UI-1 workspace, folders, unread, search | Sync-job table and cursor column only | Everything: adapter `listChanges`/`fetchMessage`, worker and cron, message/thread/folder/read-state schema, SYNC source, relaxed `conversations_linked`, retention category writer, erasure-marker check, pagination and search endpoints | Three-pane layout, list, filters, states |
| C2-UI-2 reading, HTML, attachments | Nothing | HTML body storage and **server-side sanitisation**, attachment metadata table, streaming download proxy with permission check, participant roles | Reader, sandboxed HTML view, attachment list |
| C2-UI-3 compose and send | Nothing | Send scopes by re-consent (`gmail.send`, `Mail.Send`), adapter `send`, outbound table and state machine (QUEUED, SENDING, SUBMITTED, ACCEPTED, FAILED, UNKNOWN, BOUNCED), idempotency key, threading headers, per-provider correlation tests, `communications:send`, sender-identity audit | Composer, send states, duplicate-send guard |
| C2-UI-6 customer integration | C1 history on the customer page, `contact_id` on participants | Manual link/unlink endpoint with audit; privacy rule for which synced mail may appear on a customer; contact matching is C2-B3 (see decision D-UI-7) | Link control, per-customer view, contextual navigation |

## 4. Product, security and legal gates that block going live

These are existing gates, restated so the plan does not imply that code alone makes the feature usable:
1. **Gate A engineering:** the B2/B3/C backend and worker.
2. **Gate B legal/privacy:** E1 §13 open items (RETAINED_RECORD durations, marker expiry, off-database erasure record, D-E1-7 required before real mail). E1 activation stays blocked until Regan resolves §13.
3. **Gate C provider verification, per provider:** Google restricted-scope verification and CASA; Microsoft publisher verification; until then Testing mode with named test users only.
4. **STAB-H2** (Neon backups/plan) before real mailboxes (D-C2-10).
5. Owner set-up: OAuth clients, `COMMUNICATIONS_CREDENTIAL_KEYS`, redirect URI, secrets in the API project only (c2 §14).
6. Any worker, cron, ingestion or outbound email is an external effect and needs Regan's own approval, not delegated approval.

## 5. Proposed work packages (re-sequenced)

The brief's A to D labels are kept where they still fit. The change is that the backend stages must precede the screens that need them, and management comes first because it is the only UI backed today.

| Order | Package | Scope | Backend dependency | Migration | Gated by |
|---|---|---|---|---|---|
| 1 | **C2-UI-C** Mailbox management | New Communications entry in the nav (D-UI-1), Mailboxes screen: providers, connect/reconnect (opens provider consent, callback returns into the app), status and error codes, PERSONAL vs BUSINESS, sharing, pause/resume, members READ/SEND, verified domains, designated addresses and attestation, retention setting, disconnect with confirmation. Honest sync status: shows "sync not running" until B3 exists. | None. Optional small additive contract (capabilities, callback redirect). | None | Normal PR audit. Real provider connection still needs Gate C and owner set-up. |
| 2 | **C2-B2 / B3 / B4** backend (separate threads, not UI) | Message schema, sync worker, visibility predicate, categories, intake staging, retention writer, erasure-marker check, attachment metadata, folders/labels, read state. | E1 §13 items, off-DB erasure record | Yes, additive, own preflight | Regan for worker/cron/ingestion and each prod migration. |
| 3 | **C2-UI-A** Workspace and reading | Three-pane inbox, folders actually backed by the provider, unread, search/filter on what the API supports, thread reader, sandboxed HTML, attachment metadata and permitted download. | B3 | None in UI PR | After 2. |
| 4 | **C2-C** backend | Send scopes, `communications:send`, adapter send, outbound state machine, idempotency, correlation tests. | B3 | Yes | Regan for provider scopes and re-consent. |
| 5 | **C2-UI-B** Compose and send | Composer, reply, reply all, forward, identity picker, UNKNOWN handling, no auto-resend. No attachment sending until verified per provider. | C2-C | None in UI PR | After 4. |
| 6 | **C2-UI-D** Customer and contact integration, polish | Manual link of a thread to a customer or contact, per-customer correspondence view, navigation both ways, keyboard and accessibility pass. | B3, D-UI-7 | Maybe (link table) | After 3. |

C2-UI-C touches only new files plus the nav registry and `app.tsx` entry. UI-A, UI-B and UI-D should each own their own directory under the new zone and share only the zone shell, to avoid overlap.

## 6. Design principles carried into every UI PR

- Pixa Hybrid, V2-B1 tokens and `packages/ui` components. No new tokens, no broad shell or zone migration (V2-C and V2-D are not authorised).
- Every control either works or is absent. No simulated success; unsupported actions are hidden or disabled with a reason.
- **Email HTML is never rendered as live HTML in the app origin.** Plan: sanitise on the server (allow-list, strip scripts, forms, event handlers, `javascript:` and data URLs, rewrite links to open externally with `rel="noopener noreferrer"`), then display in a `sandbox` iframe without `allow-scripts` or `allow-same-origin`, with a restrictive CSP, remote images and tracking pixels blocked until the user opts in per message. Plain text is the default fallback. A unit test corpus of hostile messages is part of UI-A.
- Authorisation is always the API. The UI renders what the API returns; a 404 means "not found", never "forbidden".
- States for every screen: loading, empty, error with retry, disconnected, needs reconnection, sync not running, offline.
- Keyboard and focus: list navigation by arrow keys, visible focus rings, labelled regions for the three panes, collapse to a single pane under the narrow breakpoint.
- Light and dark screenshots per PR, using the existing showcase and fake-API harness.
- Tests per PR: component and integration tests against the fake API, permission matrices (MEMBER, MANAGER, ADMIN, OWNER, READ vs SEND member, personal-owner-only), plus API cross-tenant and private-mailbox tests wherever backend behaviour changes.

## 7. Decisions

**Accepted by Regan on 2026-11-17** (recorded on PR #114, confirmed by Regan in the project thread): D-UI-1 to D-UI-10 as recommended below, with the ChatGPT review conditions: (a) D-UI-4 is an explicit, limited amendment of D-C2-6. Unmatched provider mail may be stored only in segregated, mailbox-scoped storage under server-enforced mailbox visibility and tenant isolation; it is never attached to customers or contacts automatically and never appears in C1 activity, timeline, global search or reporting; any link or promotion is explicit, user-directed and audited; the opt-in 30-day enquiry staging is kept; PERSONAL and BUSINESS stay separate; the `conversations_linked` invariant is not removed unless every C1 read path is proven safe, and independent provider-mail tables are preferred. The detailed design is the C2-B2 docs-only thread. (b) Management UI states "sync not available yet" and shows no simulated state; providers are fixture-tested, not live verified. (c) The OAuth return is an allowlisted redirect that keeps PKCE, signed expiring state and session binding and puts no secrets in URLs. (d) Sending needs `communications:send` and per-mailbox SEND, enforced server-side.

**Authorised now:** C2-UI-C as one draft PR; C2-B2 as a docs-only design. Not authorised: C2-UI-A, B, D, C2-C, any worker, cron, ingestion, real mailbox connection, migration or activation. Merges and migrations need their own verified approval.

Original options and recommendations:

| # | Decision | Recommendation |
|---|---|---|
| D-UI-1 | Where does mail live in the nav? A new **Communications** zone (Mailboxes now, Inbox later), versus waiting for Settings (A3) for management only. A zone entry changes the shared registry, a controlled surface. | New Communications zone with children Inbox (hidden until B3), Mailboxes. Small registry change, no shell migration. |
| D-UI-2 | Accept the re-sequencing in §5: management first, backend B2/B3/B4 and C2-C before UI-A and UI-B. | Yes. It is the only way to meet "no mocked messages". |
| D-UI-3 | Start the B2/B3/B4 backend threads now, or hold until E1 §13 and Gate C items are resolved? | Start B2 design now (docs and schema, no worker); hold worker, cron and any real mailbox until §13, STAB-H2 and Gate C. |
| D-UI-4 | Unlinked mail: C1 requires a customer or contact on every conversation. Allow mailbox conversations without one (relaxing `conversations_linked` for SYNC), or store only mail matching a contact (c2 D-C2-6)? The brief says **no automatic customer matching**, which conflicts with D-C2-6's "only mail with a participant matching a known contact is stored". | Relax the constraint for SYNC and stage unmatched mail under mailbox visibility, with matching offered as a suggestion only. Needs Regan's call because it changes an approved decision. |
| D-UI-5 | Read state: write back to the provider (needs modify scopes, not requested) or keep a Pixa-side per-user read state? | Pixa-side per user; no extra provider scope. |
| D-UI-6 | Drafts: no server draft-first (D-C2-13, rejected). Provider Drafts folder as read-only view if the provider read scope allows it (to be verified per provider); no draft saving in Pixa. Unsent compose text is kept in memory for the session only, not in browser storage. | Agree. |
| D-UI-7 | Which synced mail may appear on a customer record? Business mailboxes yes, personal never unless explicitly promoted (E1 category rules). | Manual link only, business mailboxes, per-thread audit event. |
| D-UI-8 | Attachments: download proxied from the provider on demand and never stored (manual saving only, D-C2-12). Sending attachments out of scope until verified: Gmail send accepts MIME, but Graph `sendMail` attachment size limits and upload sessions need checking against the scopes. | Metadata and on-demand download in UI-A; no attachment sending in the first UI-B. |
| D-UI-9 | `communications:send` as a new permission key plus per-mailbox SEND membership, both required. | Yes; independent from READ (brief C2-UI-5). |
| D-UI-10 | The temporary HTML OAuth callback becomes a redirect back into the app with a result code. Small additive API change. | Yes, in UI-C. |

## 8. What I need from Regan to proceed

1. Agree or amend the §5 sequence and D-UI-1 to D-UI-4 (these change scope or an approved decision).
2. Confirm the first implementation PR is **C2-UI-C only**.
3. Say whether to open the B2/B3 backend design thread now (D-UI-3).

## 9. Verification statement

- Verified by reading code: everything in §2 and §3.
- Not verified: any live call to Google or Microsoft, production provider configuration, deployed behaviour, whether `gmail.readonly` or Graph app registrations are approved. These stay unverified until Gate C work and an owner-run test with test users.
- Nothing in this document changes behaviour, schema or deployment.
