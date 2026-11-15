# Communications C2: Email provider connections, sync, sending and interface

Status: architecture for all of C2. **C2-A** (provider foundation) is merged. **C2-B1** (mailbox
identity, PERSONAL/BUSINESS classification, permissions and lifecycle) is implemented in §16, pending
audit and owner approval.
C2-A migration: `20261121000000_communications_providers` (additive, new tables only, plus one new
audit policy).
C2-B1 migration: `20261125000000_communications_mailbox_identity` (§16.10).

C2 connects real mailboxes (Google Workspace/Gmail and Microsoft 365/Outlook) to a business, brings
relevant mail into C1's canonical conversation, message and activity model, sends replies through
the connected mailbox, and gives people an interface to work with it. It is split into four stages
that can each be reviewed, merged and rolled back on their own:

| Stage | What it delivers | Talks to a provider? | Stores mail content? |
|---|---|---|---|
| **C2-A** Provider foundation | Connection model, OAuth (server-side, PKCE), encrypted credentials and refresh, mailbox ownership and sharing, provider adapter contracts (Gmail, Microsoft Graph), connection API, sync-job table and state machine, permissions, audit | OAuth and profile endpoints only | No |
| **C2-B** Inbound sync | Worker and cron dispatch, initial and incremental sync (Gmail history, Graph delta), contact matching, writes into C1 conversations/messages/activities, mailbox visibility in every read | Read mail | Yes |
| **C2-C** Outbound sending | Compose/reply API, outbound message state machine, idempotent submission through the mailbox, send scopes | Send mail | Yes (outbound) |
| **C2-D** Interface | Connection settings screen, inbox/conversation views, composer, states for reauth/sync errors | No (via API) | No (via API) |

Nothing in C2-A reads, stores or sends a message. With no provider configured in the environment the
whole feature is inert: the API answers `provider_not_configured` and no network call is made.

---

## 1. Inspection findings (main at 1b65e74)

**C1 state, checked, not assumed.** PR #39 is merged: `0a3610b Communications C1` is an ancestor of
main `1b65e74` (STAB-01, #40). Its migration `20261119300000_communications` is on main. It is applied
to production according to the read-only production migration report written at 06:17–06:20 UTC on
2026-11-15 (`_prisma_migrations` has 11 rows; C1 checksum `dcccbd39` matches main; `prisma migrate
status` "up to date"). This cloud session cannot reach Neon, so that part was read from the report, not
re-queried here. Locally, all 11 migrations plus the privileged SQL apply cleanly and the C1 suite
passes (25/25).

| Area | What exists | Consequence for C2 |
|---|---|---|
| Tenancy | `withTenant` unit of work sets `app.business_id`/`app.user_id`; forced RLS on every tenant table; composite tenant FKs; services receive a scoped `TenantDb` and can never pass a business id. Business slug is immutable (`bos_app` may update only name/legal name). | All C2 tables follow the same template. The OAuth `state` names the business by **slug**, which the callback resolves through the caller's own memberships, exactly like `tenantRoute`. |
| RBAC | Permission keys per Zone, role map in `access/permissions.ts`, code never checks roles. | Two new keys (§4). Mailbox *ownership* is a record rule, checked in the service, like C1's author-only rules. |
| API | `tenantRoute` (authn, CSRF, membership, permission, zod input, one unit of work, generic error mapping, `afterCommit` for network calls). Boundary rule: every `/api/v1/b/**` handler is a `tenantRoute`, others `publicRoute`. | Connection API is all `tenantRoute`. The OAuth callback is a browser redirect target and must return HTML, so a third wrapper `browserRoute` is added and allowed by the boundary rule for that one path. |
| Service boundaries | Modules talk through `index.ts`; only the owning module writes its tables. | C2 lives in the existing `communications` module. Sync (C2-B) writes timeline entries only through `activity.recordMessageActivity`. |
| C1 model | `conversations` (`external_source` + `external_thread_id` reserved, unique per business), immutable `messages` with `source` `MANUAL`/`IMPORT` (deliberately no "sent by Business OS"), `content_hash`, unique `(external_source, external_message_id)`, immutable participants, one `message.recorded` activity per message. RLS requires `created_by_id`/`recorded_by_id` = session user. | Reused unchanged by C2-A. C2-B and C2-C need additive changes (§3.2). |
| Audit | `recordAudit` in the same unit of work, ids and types only. The insert policy requires `actor_user_id = app.user_id`, so a **system** event (no user) cannot be written by `bos_app`. | C2-A adds one narrow policy for `communications.system.*` events with no actor (§6). |
| Jobs | Architecture §9 / data-model §7.1: platform cron → internal route; `bos_jobs` is **purge-only** (SELECT/DELETE on purgeable businesses, no INSERT/UPDATE). "A queue only when user-facing async work appears." | Mail sync *is* user-facing async work that writes tenant data, so it cannot run as `bos_jobs` (conflict 1). |
| Secrets | Secrets live in the host's secret store, validated at boot (`core/config/schema.ts`). Session tokens are stored hashed. No encryption-at-rest helper exists. | C2-A adds `core/crypto/secret-box.ts` (AES-256-GCM with key ids) and optional env settings. |
| Email | `core/email` sends Business OS's own transactional mail through Resend. | Unrelated to C2: customer mail is sent from the user's mailbox through the provider (C2-C), never through Resend. |
| Frontend | Shared Vite/React client in `packages/app`; Customer detail shows C1's timeline and conversations; shell location is not in the URL. Desktop (Tauri) authenticates with bearer tokens, so the system browser has no Business OS session. | No UI in C2-A. C2-D adds a settings screen and inbox inside the Communications/Customer surfaces only. Desktop connection flow is conflict 4. |
| Deploy | STAB-H1: Vercel deploys main before migrations run. STAB-H2: Neon Free, 6 h PITR, backup region unverified. | C2-A is safe under either sequencing (new tables only, code path unreachable without env). C2-B must not store real mail until STAB-H2 is resolved (D-C2-10). |

### 1.1 Architectural conflicts and how C2 resolves them

1. **Sync needs a writer that is not a request.** `bos_jobs` must stay purge-only. *Resolution
   (proposed, C2-B):* the worker runs as `bos_app` through `withTenant` **acting as the mailbox
   owner** (`userId = owner_user_id`), so every RLS authorship policy (`recorded_by_id = app.user_id`)
   and audit policy keeps holding, and the worker can do exactly what the owner could. Finding which
   businesses have due jobs is cross-tenant, so C2-B adds one `SECURITY DEFINER` function in
   `app_private` that returns only `(business_id, connection_id)` pairs. C2-A builds the tenant-side
   job table, claim/lease/complete/fail and tests them; it adds no worker and no privileged SQL.
2. **C1 history has no mailbox visibility.** C1 shows every conversation, message and
   `message.recorded` timeline entry to anyone with `communications:read`. A personal mailbox's mail
   must not appear on a customer timeline for the whole business. *Resolution (C2-B):* synced
   conversations carry `connection_id`; C1's single read predicates (`visibleTo` in activity and the
   conversation/message queries) gain one more clause: rows with a connection are visible only if
   the viewer may read that mailbox (§5). Rows without a connection (all C1 data) behave exactly as
   today. Enforced in the service (consistent with Regan's C1 decision on restricted notes), with RLS
   staying tenant-only, and covered by "every read path" tests like C1-02.
3. **C1 says no message is "sent by Business OS".** That stays true for C1 rows. C2-C adds an explicit
   outbound record with a delivery state machine (§8) and a `source` value `SENT` that is written only
   after the provider accepted the message. "Accepted by the provider" is the strongest state shown;
   there is never a "delivered" state, because neither Gmail nor Graph confirms delivery.
4. **Desktop has no browser session.** An OAuth callback authenticated only by `state` lets an
   attacker start a flow in their business and trick a victim into consenting, which would attach the
   victim's mailbox to the attacker's business. *Resolution:* the callback **requires a signed-in
   Business OS session in the same browser, for the same user who started the flow** (cookie; GET is
   a top-level navigation so `SameSite=Lax` cookies are sent). On desktop, "Connect mailbox" opens the
   web app in the system browser, where the user signs in (D-C2-5). A loopback/deep-link desktop flow
   can be added later without schema changes.
5. **System audit events.** Provider-side revocation or an owner leaving the business must be audited
   with no acting user. *Resolution:* one additive policy on `audit_events` (§6), limited to
   `communications.system.*` actions with `actor_user_id IS NULL` and no session user.
6. **Shared files with Finance F5.** `access/permissions.ts`, `core/db/app-client.ts`,
   `app/api/_lib/routes.ts`, `contracts/index.ts` get additive edits on both branches; expect trivial
   textual conflicts. F5 uses migration `20261122000000_finance_documents`; C2-A uses
   `20261121000000_communications_providers`. Whichever merges second rebases and keeps its migration
   sorting last (agreed with the F5 thread).

## 2. Stages, scope and risks

| Stage | Scope | Main risks |
|---|---|---|
| C2-A | §3.1 schema; OAuth start + callback; encrypted credentials; token refresh with a lease; adapters for Google and Microsoft (auth, token, profile, revoke); connection list/get/update/disconnect; enqueue sync; job claim/complete/fail (no worker); permissions; audit; tests. | OAuth CSRF/fixation; token leakage (logs, responses, other tenants); refresh races with Microsoft's rotating refresh tokens; key management. All covered by tests (§11). |
| C2-B | Worker route + cron; `app_private.mail_sync_due`; Gmail `history.list` / Graph `delta` with initial backfill window; contact matching; writes to C1 tables with `source = SYNC`, `connection_id`, idempotency on provider ids; mailbox visibility predicate in every C1 read; attachment metadata; provider deletions; rate limits/backoff; retention. | Leaking personal mail through C1 read paths (conflict 2); duplicate or lost messages on cursor expiry; quota exhaustion; very large mailboxes; storing real customer mail before backups are fixed (STAB-H2). |
| C2-C | Send scopes via re-consent; `POST …/messages/send`; outbound state machine (`DRAFT → QUEUED → SUBMITTING → ACCEPTED | FAILED`, `UNKNOWN` on timeouts); idempotency key per send; reconciliation of `UNKNOWN` through inbound sync (Sent folder); threading headers (`In-Reply-To`, `References`, Gmail `threadId`, Graph `conversationId`). | Double send on retry/timeouts; showing unconfirmed mail as sent; sending from a mailbox the user may not send as; spam/abuse limits. |
| C2-D | Settings → Mailboxes (connect, reconnect, share, pause, disconnect, sync status); inbox and conversation views; composer; empty/reauth/error/offline states; accessibility. | Scope creep into the app shell; showing content the viewer may not read; confusing delivery wording. |

Out of scope for all of C2: IMAP/SMTP, AI replies, marketing campaigns, SMS/social, cross-Zone
notification feed.

## 3. Schema

### 3.1 C2-A tables (`20261121000000_communications_providers`)

Same template as every tenant table: `business_id` first in every key, PK `(business_id, id)`,
composite tenant FKs, `ON DELETE CASCADE` from `businesses` (purge), forced RLS `tenant_isolation`,
least-privilege column grants, guard triggers with SQLSTATE class CM.

**`mail_connections`** — one connected mailbox in one business.

| Column | Notes |
|---|---|
| `provider` | `GOOGLE` or `MICROSOFT` (CHECK). |
| `owner_user_id` | The member who connected it and on whose behalf the provider is called. Fixed. RESTRICTIVE insert policy: must equal the session user. |
| `provider_account_id` | Google OIDC `sub`; Microsoft Graph user `id` (object id). Fixed. |
| `mailbox_address`, `display_name` | From the provider profile, refreshed on reconnect. Lower-cased address. |
| `status` | `ACTIVE`, `NEEDS_REAUTH`, `DISCONNECTED`. `DISCONNECTED` is final (CM006); reconnecting after a disconnect creates a new row. |
| `sharing` | `OWNER_ONLY` (default) or `BUSINESS` (§5). |
| `granted_scopes` | What the provider actually granted (Google lets users untick scopes). |
| `sync_enabled`, `sync_cursor`, `last_synced_at` | Sync state for C2-B. `sync_cursor` (Gmail `historyId`, Graph `deltaLink`) is never returned by the API. |
| `last_error_code` | A stable code (`reauth_required`, `owner_inactive`, `rate_limited`, …), never provider text. |
| `connected_at`, `status_changed_at`, `disconnected_at`, `disconnected_by_id`, `version` | Lifecycle; `version` for optimistic concurrency on PATCH. |

Unique: one live connection per mailbox per business: `(business_id, provider, provider_account_id)
WHERE status <> 'DISCONNECTED'`. The same mailbox can be connected in two different businesses (two
tenants, two independent credential sets).

Guard `mail_connections_guard_update` (CM005): `id`, `business_id`, `provider`,
`provider_account_id`, `owner_user_id`, `created_at` never change; a `DISCONNECTED` row never changes
again (CM006). Trigger `mail_connections_drop_credentials`: when the status leaves `ACTIVE`, the
credential row is deleted in the same statement, so tokens can never outlive a disconnect or a
revoked grant even if service code forgets.

**`mail_connection_credentials`** — 1:1 with a connection, `PK (business_id, connection_id)`.

| Column | Notes |
|---|---|
| `refresh_token_enc`, `access_token_enc` | Envelope `v1.<keyId>.<iv>.<ciphertext+tag>` (base64url), AES-256-GCM. CHECK on the format, so plaintext cannot be stored by mistake. |
| `access_token_expires_at` | Refresh when less than 5 minutes remain. |
| `key_id` | Key that encrypted the row (rotation). |
| `credential_version` | Random uuid replaced on every write of the tokens (connect, reconnect, refresh). A refresh may store, or invalidate, only the version it read (§7.3, audit finding C2A-01). |
| `refresh_lease_id`, `refresh_lease_until` | Single-flight refresh (§7.3), on database time. |

Only the credentials service (`modules/communications/server/credentials.ts`) may reference this model
(new boundary rule). No API response type has a field for it.

Trigger `mail_connection_credentials_guard` (CM006) refuses credentials for a connection that is not
`ACTIVE`, so tokens cannot be re-attached to a disconnected or reauth-needed mailbox.

**`mail_oauth_states`** — one pending authorization. `state_hash` = SHA-256 of the random nonce
(the raw nonce exists only in the provider URL); `user_id` (RESTRICTIVE insert policy = session user),
`provider`, optional `connection_id` (reconnect target), `code_verifier_enc` (PKCE verifier, encrypted),
`expires_at` (≤ 15 min after creation, CHECK; 10 min used; `created_at` is stamped with database time
by a trigger so the window cannot be widened), `consumed_at` (single use).

**`mail_sync_jobs`** — durable sync work items. `kind` `INITIAL`/`INCREMENTAL`/`FULL_RESYNC`;
`status` `QUEUED → RUNNING → SUCCEEDED | FAILED | CANCELLED`, `RUNNING → QUEUED` for a retry;
`attempts`/`max_attempts` (5); `run_after` (backoff); `lease_id` + `lease_expires_at` (required while
`RUNNING`, CHECK); `requested_by_id` (null for system); `last_error_code`. At most one `QUEUED` or
`RUNNING` job per connection (partial unique index), which makes enqueueing idempotent. Guard CM007
rejects any other transition and any change to a finished job.

`bos_app` grants: SELECT, INSERT and column-level UPDATE on all four tables; DELETE only on
`mail_connection_credentials` (revocation) and `mail_oauth_states` (pruning). No DELETE on
connections or jobs: they are the audit trail of what was connected and run.

### 3.2 Later stages (proposed, not in C2-A)

- **C2-B** (additive): `conversations.connection_id` and `messages.connection_id` (nullable composite
  FKs to `mail_connections`); `messages.source` gains `SYNC`; `messages.provider_message_id`,
  `provider_thread_id`, `rfc822_message_id`; unique `(business_id, connection_id, provider_message_id)`
  for idempotent sync; `message_attachments` (metadata only: name, type, size, provider attachment id;
  no content); `mail_sync_items` if per-message processing state is needed. `recorded_by_id` of a
  synced message is the mailbox owner (RLS holds because the worker acts as the owner).
- **C2-C** (additive): `outbound_messages` (draft and send state, idempotency key unique per
  business, `provider_message_id` once accepted, `failure_code`); `messages.source` gains `SENT`,
  written only once the provider accepted the message (§8).

## 4. Permissions

| Key | OWNER | ADMIN | MANAGER | MEMBER |
|---|---|---|---|---|
| `communications:read` / `communications:record` (C1) | ✓ | ✓ | ✓ | ✓ |
| `communications:connect` (new): connect, reconnect, share, pause and disconnect **your own** mailbox; see your own and business-shared mailboxes | ✓ | ✓ | ✓ | – |
| `communications:manage_connections` (new): see every mailbox's metadata in the business, pause it, make it `OWNER_ONLY`, disconnect it, request a sync | ✓ | ✓ | – | – |
| `communications:send` (C2-C, proposed) | ✓ | ✓ | ✓ | ✓ (from mailboxes they may send from) |

Record rules (service, tested):

| Action | Mailbox owner (with `connect`) | `manage_connections` | `communications:read` only |
|---|---|---|---|
| See the connection (address, status) | own | all | `BUSINESS`-shared only |
| Reconnect (new consent) | ✓ | – (only the owner can consent for their mailbox) | – |
| Set `sharing = BUSINESS` | ✓ | – (an admin never exposes someone's personal mailbox) | – |
| Set `sharing = OWNER_ONLY`, pause/resume sync | ✓ | ✓ | – |
| Disconnect | ✓ | ✓ | – |
| Request a sync, see sync jobs | ✓ | ✓ | – |
| Read synced mail (C2-B) | ✓ | only if `BUSINESS` | only if `BUSINESS` |

Holding `manage_connections` never grants reading an `OWNER_ONLY` mailbox's content. Someone else's
connection that the viewer may not see answers 404, exactly like a missing one.

These rules are for PERSONAL mailboxes. BUSINESS mailboxes (C2-B1) follow §16.4. Sharing a PERSONAL
mailbox (`sharing = BUSINESS`) now also requires the business's retention period (§16.6).

## 5. Mailbox ownership and sharing

- Every connection belongs to exactly one member (`owner_user_id`), the person who consented at the
  provider. Business Os calls the provider only on that person's behalf and with their grant.
- `OWNER_ONLY`: synced mail is visible to the owner alone (C2-B). Others see nothing, not even counts.
- `BUSINESS`: synced mail is visible to every member with `communications:read` (and
  `customers:read` for timeline entries, as in C1). Intended for shared role mailboxes such as
  `sales@`, connected by one member.
- Per-member grants (share with three people) are deliberately not in C2-A. C2-B1 adds them for
  BUSINESS mailboxes only (`mail_connection_members`, §16.4); a PERSONAL mailbox keeps the two
  settings above.
- C2-B1 adds the mailbox **kind** (PERSONAL or BUSINESS, fixed at creation) and a replaceable
  credential holder for BUSINESS mailboxes (§16). This section describes PERSONAL mailboxes.
- **Owner leaves or is suspended:** the next sync claim finds no active membership with
  `communications:connect`, cancels the job, sets the connection to `NEEDS_REAUTH` with
  `owner_inactive` (credentials are deleted by the trigger) and writes a `communications.system.*`
  audit event. Already-synced `OWNER_ONLY` mail stays hidden; transfer is an owner decision (D-C2-8).

## 6. Audit logging

Every C2-A mutation writes one audit event in the same unit of work. Metadata holds ids, provider,
enum values and stable codes only: **never** a mailbox address, display name, token, scope string,
authorization code, provider error text or message content.

| Action | When | Metadata |
|---|---|---|
| `communications.connection.authorization_started` | Start of OAuth | `provider`, `connectionId` (reconnect) |
| `communications.connection.authorization_failed` | Callback refused (declined, bad state, missing scope, account mismatch, already connected, provider error) | `provider`, `reason` |
| `communications.connection.connected` / `.reconnected` | Callback succeeded | `provider` |
| `communications.connection.updated` | Sharing or sync toggle changed | `fields`, `sharing`, `syncEnabled` |
| `communications.connection.disconnected` | Disconnect | `provider`, `revocation` (`requested`/`unsupported`) |
| `communications.sync.requested` | A new sync job was queued by a person | `kind` |
| `communications.system.reauth_required` | Refresh refused by the provider (`invalid_grant`) | `provider` |
| `communications.system.owner_inactive` | Sync claim found the owner no longer an active member | `provider` |

The `communications.system.*` events are written with no actor, which the existing audit policy does
not allow; the migration adds `audit_system_write` for exactly that (`actor_user_id IS NULL`, no session
user, `action LIKE 'communications.system.%'`, this business only). Job lifecycle transitions are
recorded on the job row itself, not in the audit log.

## 7. OAuth and credentials

### 7.1 Flow (authorization code + PKCE, server-side only)

1. `POST /api/v1/b/:slug/communications/connections/authorize {provider, connectionId?}`
   (`communications:connect`). The server creates a 256-bit nonce and a PKCE verifier, stores
   `sha256(nonce)` and the encrypted verifier in `mail_oauth_states` (10 minutes, single use), and
   returns the provider's authorization URL with `state = <slug>.<nonce>` and the S256 challenge.
   The client secret, verifier and tokens never leave the server.
2. The browser goes to Google/Microsoft, the user consents, and the provider redirects to
   `GET /api/v1/communications/oauth/callback?code&state` (the one redirect URI to register).
3. The callback requires a Business OS session in that browser (conflict 4), resolves the slug through
   the caller's memberships, and in one unit of work consumes the state row (hash, same user, same
   provider, not expired, not used; conditional update so a replay loses). It re-checks
   `communications:connect`.
4. Outside any transaction it exchanges the code (with the verifier), checks the granted scopes, and
   reads the account (Google OIDC `userinfo`; Graph `/me`).
5. In a second unit of work it creates the connection (or reactivates the owner's `NEEDS_REAUTH`
   connection for the same account), stores the encrypted tokens, queues the `INITIAL` sync job and
   audits. Another member's live connection of the same mailbox → `already_connected`; reconnecting
   with a different account → `account_mismatch`. If this step fails after tokens were issued, the
   new tokens are discarded, never revoked: Google revocation is grant-wide (it ends every token of
   that account for this app, in every business), so revoking here would break the legitimate
   existing connection (audit finding C2A-03). The failure is audited with its stable reason.
6. The callback answers with a minimal static HTML page (no-store, `default-src 'none'`) saying
   connected or not, with a stable reason code and no echo of any input. C2-D replaces it with a
   redirect into the app.

### 7.2 Encryption at rest

`core/crypto/secret-box.ts`: AES-256-GCM, 96-bit random IV, 128-bit tag, keys from
`COMMUNICATIONS_CREDENTIAL_KEYS` (`keyId:base64-32-bytes`, comma-separated; the first is used to
encrypt, all are accepted to decrypt). **Associated data** binds each ciphertext to
`business id + connection id + field`, so a ciphertext copied into another row or another business
does not decrypt (tested). Rotation: add a new key first in the list, keep the old one until a rewrap
job (or natural refresh, which re-encrypts) has moved every row, then remove it. Plaintext tokens
exist only in memory for the duration of one provider call; they are never logged, audited, returned,
or put in error messages (tests scan responses, audit rows and console output).

### 7.3 Refresh strategy

`obtainAccessToken(run, connectionId)`, used by sync (C2-B) and send (C2-C):

1. Unit of work: read the credential; if the access token has more than 5 minutes left, decrypt and
   return it.
2. Otherwise take a 30-second refresh lease with one conditional UPDATE on database time
   (`lease_until is null or < now()`, set to `now() + 30 s`). It returns the refresh token and the
   current `credential_version`.
3. The lease holder refreshes over the network (no transaction or lock held). Microsoft rotates the
   refresh token on every use, so two concurrent refreshes would invalidate each other; the lease makes
   refresh single-flight. Google usually returns no new refresh token; the old one is kept.
4. **Fencing (C2A-01).** The lease alone is not enough: it can expire while a slow attempt is still
   waiting on the provider, and a second attempt can take over. Every outcome is therefore written
   with a check of **both** the `credential_version` and the exact `refresh_lease_id` that the attempt
   holds, in the same statement:
   - success: `UPDATE … SET tokens, credential_version = new uuid, lease cleared WHERE
     credential_version = read version AND refresh_lease_id = own lease`; zero rows means the attempt
     is obsolete, its tokens are dropped and the caller gets a retryable `busy`.
   - `invalid_grant`: in one transaction, the same conditional `UPDATE` and, only if it matched,
     `NEEDS_REAUTH` with `reauth_required`, credentials deleted, pending jobs cancelled and a system
     audit event. Otherwise nothing changes and the caller gets `busy`. The check and the
     invalidation are atomic (the row lock makes the second condition re-check after any concurrent
     writer commits).
   - The version catches an attempt that was overtaken by a newer write (replacement refresh,
     reconnect). The lease id catches an attempt whose lease was taken over by another worker that has
     not written anything yet, so the version is still the same.
   - **Expired but not taken over:** the holder of an expired lease may still complete, as long as its
     lease id is unchanged. Taking over always replaces the lease id, so an unchanged id proves no
     other attempt started. Refusing would be harmful here: Microsoft has already rotated the refresh
     token, so dropping the response would lose the only valid token and force a reconnect. This
     differs on purpose from sync jobs (§9), where an expired lease authorises nothing, because sync
     work can simply be redone.
5. Others poll briefly for the fresh token, then give up with a retryable `busy` error.
6. `invalid_grant` for the current credentials (user revoked access, password change, admin policy,
   Google's 7-day expiry for apps in testing mode) requires reauthorisation. Only the owner can
   reconnect.

### 7.4 Revocation, disconnection, reconnection

- **Disconnect** (owner or `manage_connections`): status `DISCONNECTED` (final), queued/running jobs
  `CANCELLED`, credentials deleted by the trigger in the same transaction. C2-A makes **no revocation
  call** to either provider (C2A-03). Google's revoke endpoint ends the whole grant for that Google
  account and this app, which would also break the same mailbox connected in another business or by
  a later reconnect. Microsoft has no per-application revocation endpoint (`revokeSignInSessions`
  would sign the user out of everything). Deleting the stored tokens is what disconnects; users who
  want the grant itself gone remove the app in their Google account or My Apps. The audit event
  records `revocation: not_requested`, and `revokesOnDisconnect` is `false` for both providers. A
  safe, explicit "also revoke at Google" option (only when no other live connection uses the account)
  can come later as an owner decision.
- **Revoked at the provider:** detected on the next refresh (§7.3).
- **Reconnect:** a new consent by the owner for the same account reactivates the same connection,
  keeping its id, sharing and history. A different account is refused.
- **Already-synced mail after disconnect** (C2-B): kept as business history by default; deleting it
  needs the erasure pathway C1 deferred (D-C2-9).

## 8. Provider adapters

`modules/communications/server/providers/types.ts` defines one contract; `google.ts` and
`microsoft.ts` implement it with `fetch`, 10-second timeouts and no SDKs.

```ts
interface MailProviderAdapter {
  provider: 'GOOGLE' | 'MICROSOFT';
  capabilities: { tokenRevocation: boolean; rotatesRefreshTokens: boolean };
  requiredScopes(purpose: 'read' | 'send'): string[];
  authorizationUrl(input: { state; codeChallenge; redirectUri; loginHint? }): string;
  exchangeCode(input: { code; codeVerifier; redirectUri }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  account(accessToken: string): Promise<{ providerAccountId; address; displayName }>;
  revoke(token: string): Promise<'revoked' | 'unsupported'>;
  // C2-B: listChanges(cursor), fetchMessage(id), initialCursor(). C2-C: send(mime, threadRef).
}
```

Errors are normalised into `ProviderError` with a stable code: `invalid_grant`,
`insufficient_scope`, `unauthorized`, `rate_limited` (with `retryAfterMs`), `unavailable`,
`invalid_response`. Response bodies are never kept in the error.

Differences deliberately not hidden:

| | Gmail (Google) | Microsoft 365 (Graph) |
|---|---|---|
| Read scope | `gmail.readonly` + `openid email` | `Mail.Read` `User.Read` `offline_access` `openid email` |
| Send scope (C2-C) | `gmail.send` | `Mail.Send` |
| Scope class | `gmail.readonly` is a **restricted** scope: production use needs Google app verification and an annual third-party security assessment (CASA). Unverified apps are limited to 100 test users and refresh tokens expire after 7 days in "Testing" status. | Delegated scopes; some tenants require admin consent; publisher verification recommended. |
| Granular consent | Users may untick scopes; the callback checks `scope` and refuses with `insufficient_scope`. | All-or-nothing consent. |
| Refresh tokens | Long-lived, normally not rotated. | Rotated on every refresh (single-flight needed). |
| Revocation | Revoke endpoint. | None per app (see §7.4). |
| Account id | OIDC `sub` | Graph user `id` (object id) |
| Change feed (C2-B) | `history.list` from `historyId`; history can expire (404) → full resync | `messages/delta` per folder with `deltaLink`; can expire (410) → full resync |
| Threading | `threadId` | `conversationId` |

## 9. Sync-job foundation (C2-A) and sync strategy (C2-B)

C2-A provides the durable job table and the tenant-side operations; no worker runs yet, so queued
jobs simply wait.

- `requestSync(connection, kind)`: idempotent. If a job is already `QUEUED`/`RUNNING` for the
  connection it is returned (200); otherwise a new one is created (201). `INSERT … ON CONFLICT DO
  NOTHING` on the partial unique index makes concurrent requests safe.
- `claimSyncJob(db, leaseSeconds)`: picks the oldest due job (`QUEUED` and `run_after <= now()`, or
  `RUNNING` with an expired lease) with `FOR UPDATE SKIP LOCKED`, sets a fresh `lease_id`, increments
  `attempts`. A job whose lease expired with no attempts left becomes `FAILED lease_expired`. Before
  handing a job out it checks that the connection is `ACTIVE`, sync is enabled and the owner is still
  an active member with `communications:connect`; otherwise the job is cancelled (and the owner case
  handled as in §5).
- `heartbeatSyncJob`, `completeSyncJob` and `failSyncJob` only act while the caller holds an
  **unexpired** lease, checked on database time (`lease_id = caller AND status = RUNNING AND
  lease_expires_at > now()`) in the same statement as the change (C2A-02). An expired lease authorises
  nothing, even before another worker reclaims the job. `completeSyncJob` writes the job and the
  connection's cursor in one statement, and the cursor only if the job update matched and the
  connection is still `ACTIVE` with sync enabled, so a cancelled, reclaimed or paused job can never
  leave an obsolete cursor. Failure with a
  retryable code re-queues with exponential backoff (30 s × 2^(attempt-1), capped at 1 h, or the
  provider's `Retry-After`), otherwise `FAILED`. `reauth_required` also moves the connection to
  `NEEDS_REAUTH`.

C2-B strategy (proposed): Vercel Cron every minute calls `POST /api/internal/jobs/mail-sync`
(secret, constant-time compare); it lists due `(business, connection)` pairs through
`app_private.mail_sync_due(limit)`, then per pair runs `withTenant({business, owner})` to claim and
process within the function time budget, checkpointing the cursor after each page so a timeout loses
nothing. Idempotency: provider message id unique per connection; re-processing a page is a no-op.
Initial backfill is bounded (D-C2-7). Only mail with at least one participant matching a known contact
is stored (D-C2-6). Cursor expiry → `FULL_RESYNC`. Provider push (Gmail Pub/Sub watch, Graph
subscriptions) is a later optimisation, not needed for correctness.

## 10. API (C2-A)

All under `/api/v1/b/:slug/communications`, all `tenantRoute`, bodies strict.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/providers` | `communications:connect` | Which providers are configured on this deployment |
| GET | `/connections?includeDisconnected` | `communications:read` | Visible connections (§4) |
| GET | `/connections/:connectionId` | `communications:read` | 404 if not visible |
| POST | `/connections/authorize` | `communications:connect` | `{provider, connectionId?}` → `{authorizationUrl, expiresAt}` |
| PATCH | `/connections/:connectionId` | `communications:read` + record rules | `{sharing?, syncEnabled?, version}` |
| POST | `/connections/:connectionId/disconnect` | `communications:read` + record rules | Revocation after commit |
| POST | `/connections/:connectionId/sync` | `communications:read` + record rules | `{kind?}` → job (201 new, 200 existing) |
| GET | `/connections/:connectionId/sync-jobs` | `communications:read` + record rules | Latest 20 |
| GET | `/api/v1/communications/oauth/callback` | signed-in session | `browserRoute`, HTML |

Error codes: 404 `not_found`, 403 `forbidden`, 409 `provider_not_configured`, `already_connected`,
`account_mismatch`, `disconnected`, `not_active`, `sync_disabled`, `stale`, `immutable`,
`invalid_transition`; 400 `invalid_input`. Callback reasons: `declined`, `invalid_state`,
`insufficient_scope`, `account_mismatch`, `already_connected`, `provider_error`, `not_allowed`,
`unauthenticated`.

Environment (all optional; feature off when absent; validated at boot):

| Variable | Meaning |
|---|---|
| `COMMUNICATIONS_CREDENTIAL_KEYS` | `keyId:base64(32 bytes)[,…]`; required if any provider is configured |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Both or neither |
| `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_TENANT` | Both or neither; tenant defaults to `common` |

The redirect URI is derived: `${APP_BASE_URL}/api/v1/communications/oauth/callback`.

## 11. Tests (C2-A)

- Unit: secret box (round trip, wrong AAD/business/connection, tampering, unknown key, rotation),
  environment rules, both adapters against recorded fixture responses (URL parameters incl. PKCE and
  scopes, error normalisation, no token in errors), permission matrix.
- Integration (real PostgreSQL, real route handlers, provider HTTP replaced by a fetch stub): full
  connect flow; tokens never in the database in plaintext, never in responses, audit rows or logs;
  state single-use / expired / other user / other business / forged / no session; role matrix;
  visibility and sharing rules; reconnect and account mismatch; another member's mailbox;
  disconnect (credentials gone by trigger, jobs cancelled, no revocation call, the same mailbox in
  another business keeps working); a refused second connection never revokes the legitimate one
  (C2A-03); refresh single-flight under concurrency and `invalid_grant`; refresh fencing races with a
  delayed provider (expired lease + replacement success + late `invalid_grant`, late success, reconnect
  in between) (C2A-01); idempotent enqueue under concurrency; claim with `SKIP LOCKED`, lease expiry,
  backoff and terminal failure; expired-but-unreclaimed leases refused for heartbeat, complete and fail,
  no cursor from a cancelled, reclaimed or paused job (C2A-02); owner removed;
  cross-tenant RLS on all four tables; database guards and grants; business purge cascade; system audit
  policy limits.

## 12. Migration ordering, deploy and rollback

- **Depends on:** `20261113150000_tenancy` (businesses, audit_events) only. It references no C1,
  finance, people or scheduling table, so it is independent of F5 (`20261122000000_finance_documents`).
  It must sort after the newest migration on main when it merges (CI guard).
- **Precondition:** none. No existing row changes. No privileged SQL (`db:privileged` not needed).
- **Deploy:** safe under STAB-H1 option A or B. If code is live before the migration, only the new
  connection endpoints fail (500) and only if a provider is configured; nothing else touches the new
  tables. Recommended order: take a Neon recovery branch, apply the migration, then deploy/promote.
  Leave provider env vars unset in production until D-C2-10 is satisfied.
- **Rollback** (no data to keep before real use):
  ```sql
  BEGIN;
  DROP POLICY IF EXISTS audit_system_write ON audit_events;
  DROP TABLE IF EXISTS mail_sync_jobs, mail_oauth_states, mail_connection_credentials, mail_connections CASCADE;
  DROP FUNCTION IF EXISTS mail_connections_guard_update(), mail_connections_drop_credentials(), mail_connection_credentials_guard(),
    mail_oauth_states_stamp_insert(), mail_sync_jobs_guard_update();
  DELETE FROM _prisma_migrations WHERE migration_name = '20261121000000_communications_providers';
  COMMIT;
  ```
  Verified locally (2026-11-15): a database with all 12 migrations plus this script has a
  `pg_dump --schema-only` identical to a database with main's 11 migrations. Code
  rollback is a revert of the PR; once real connections exist, disconnect them first (tokens are
  deleted; grants stay until users remove the app, §7.4).
- **Audit remediation (C2A-01):** the only schema change is one added column,
  `mail_connection_credentials.credential_version uuid NOT NULL`, plus its column grant for `bos_app`.
  The migration is still additive and has not been applied anywhere except local and CI databases.

## 13. Security and privacy considerations

- Provider authentication is server-side only: client secrets, PKCE verifiers, codes and tokens never
  reach the browser or desktop app (the client only receives the provider URL).
- Defence in depth for credentials: encrypted with tenant-bound AAD, RLS tenant isolation, a single
  module allowed to touch the table (boundary rule), deleted by trigger on any non-active state, no API
  field, no logging.
- OAuth CSRF/fixation: state is single-use, hashed, short-lived, bound to user, business and provider,
  and the callback demands the same signed-in user (conflict 4).
- Least privilege at the provider: read-only scopes until C2-C; send scope only by explicit re-consent.
  Least privilege in the product: `OWNER_ONLY` default, admins see metadata not content.
- Tenant isolation: every table RLS-forced; cross-tenant 404s; ciphertexts do not decrypt in another
  row/business.
- Personal data: mailbox address and name are personal data, kept only on the connection row, never
  in audit metadata or logs. Mail content (C2-B) is kept only for contact-matched threads.
- Not privacy-complete: erasure of synced mail depends on the erasure pathway C1 deferred. Real
  mailboxes must not be connected in production until backups (STAB-H2) and provider verification are
  done (D-C2-10).

## 14. Owner decisions (recommended defaults; C2-A is built on these)

| # | Decision | Recommended default | Needed by |
|---|---|---|---|
| D-C2-1 | Providers | Google (Gmail API) and Microsoft 365 (Graph) only; IMAP/SMTP later | C2-A |
| D-C2-2 | Who may connect a mailbox | `communications:connect` for OWNER, ADMIN, MANAGER; not MEMBER | C2-A |
| D-C2-3 | Ownership and sharing | Owned by the connecting member; `OWNER_ONLY` by default; only the owner may share `BUSINESS`-wide; admins see metadata, may restrict and disconnect, never read `OWNER_ONLY` mail | C2-A |
| D-C2-4 | Credential encryption | App-level AES-256-GCM, keys in Vercel environment (sensitive), key ids for rotation; a cloud KMS later for enterprise | C2-A |
| D-C2-5 | Desktop connection flow | Connect from the web app (same browser session required); desktop opens the web app | C2-A |
| D-C2-6 | What gets synced | Only threads with a participant matching a known contact; the rest of the mailbox is never stored | C2-B |
| D-C2-7 | Initial backfill | 90 days, contact-matched only | C2-B |
| D-C2-8 | Owner leaves | Connection stops (`owner_inactive`), credentials deleted; `OWNER_ONLY` mail stays hidden; no transfer in C2 | C2-B |
| D-C2-9 | After disconnect | Keep synced history as business record; deletion waits for the erasure pathway | C2-B |
| D-C2-10 | Real-mailbox gate | No real mailbox in production until STAB-H2 (backups) is fixed and the Google app is verified (CASA) or used only by ≤100 test users | before enabling |
| D-C2-11 | Sync execution | Vercel Cron (Pro) every minute + Postgres job table + worker acting as mailbox owner + one `app_private` dispatcher function; no new queue vendor | C2-B |
| D-C2-12 | Attachments | Metadata only; content fetched on demand from the provider, not stored | C2-B |
| D-C2-13 | Delivery wording | "Sent from your mailbox" only after the provider accepted it; "Sending…", "Not sent" and "Unknown, checking" otherwise; never "Delivered" | C2-C |
| D-C2-14 | Who may send from a `BUSINESS` mailbox | Members with `communications:send`; the owner's mailbox sends "as" the mailbox | C2-C |

### Approved register (Regan, 2026-11-15)

The table above records the defaults C2-A was built on. The final decision register approved on
2026-11-15 supersedes it where they differ. The changes that matter for C2-B onwards:

- **Mailbox kinds (D-C2-3, D-C2-8, D-C2-14):** `PERSONAL` and `BUSINESS` mailboxes; the credential
  holder is separate from the controlling business; `mail_connection_members` grant READ or SEND.
  A `BUSINESS` mailbox needs a verified domain (DNS TXT) or a designated business address; a
  consumer-domain address may be a `BUSINESS` mailbox only with an OWNER attestation, a live access
  check and an audit event. Departure gives a 30-day grace before the mailbox stops.
- **Sync (D-C2-6, D-C2-7):** `BUSINESS` mail is staged in intake for 30 days; `PERSONAL` mail is
  never staged. Backfill defaults to 90 days (30, 90, 180 or 365 selectable).
- **Retention (D-C2-9):** retention applies per message copy in four categories. Retained AU records
  are kept 7 years. Ordinary communications have **no default**: each business must set an explicit
  period. Provider-side deletion is not mirrored. Erasure goes through an erasure ledger with legal
  hold.
- **Attachments (D-C2-12):** manual saving first; automatic saving is deferred.
- **AI processing:** opt-in only.
- **Sending (D-C2-13):** direct sending with minimal scopes (`gmail.send`, `Mail.Send`); draft-first
  was rejected because Gmail drafts need the restricted `gmail.compose` scope and Graph drafts need
  `Mail.ReadWrite`. Outbound states are `QUEUED`, `SENDING`, `SUBMITTED` (Graph 202), `ACCEPTED`,
  `FAILED`, `UNKNOWN` and `BOUNCED`. `UNKNOWN` is never turned into `FAILED` automatically and is
  never resent automatically. Sender identity is configurable, with a mandatory audit event.
- **Gates:** A (engineering), B (legal and privacy) and C (provider verification, tracked per
  provider) are separate and each must pass before real customer mailboxes are connected.
- **Sequence:** C2-B1 (mailbox kinds, domains, members), then E1 (erasure), then C2-B2, C2-B3 and
  C2-B4. C2-C (sending) and C2-D are separate stages.

**Acceptance criteria added at approval:**

1. **Retention before business use.** An explicit ordinary-communications retention period must be
   set for the business before `BUSINESS` mailbox sync starts, **and** before any `PERSONAL` mailbox
   content can be shared with the business or promoted into an ordinary business record. Without a
   period both actions are refused.
2. **Outbound correlation is tested per provider (C2-C).** C2-C must test, for each provider, how
   reliably a sent message can be matched back: whether custom headers survive, whether the Sent
   folder can be read, and how Microsoft shared mailboxes behave. It must not assume that custom
   headers are directly searchable, and it must not treat absence from the Sent folder as proof
   that a message was not delivered (such a message stays `UNKNOWN`).

### What Regan must set up before any real connection (owner actions, not done by C2-A)

1. **Google:** a Google Cloud project owned by Pixakova; OAuth consent screen (external, app name,
   support email, privacy policy and terms URLs on pixakova.com, authorised domain); scopes
   `openid`, `email`, `gmail.readonly` (later `gmail.send`); a "Web application" OAuth client with
   redirect URI `https://app.pixakova.com/api/v1/communications/oauth/callback`; start in Testing with
   named test users; plan Google verification and the CASA assessment before external users.
2. **Microsoft:** an Entra ID app registration (multi-tenant "accounts in any organizational directory
   and personal Microsoft accounts" or organisational only), web redirect URI as above, delegated
   permissions `Mail.Read`, `User.Read`, `offline_access`, `openid`, `email` (later `Mail.Send`), a
   client secret with an expiry reminder; publisher verification.
3. **Secrets:** in the Vercel API project (`business-os`) only, marked sensitive, Production and
   Preview separately: `COMMUNICATIONS_CREDENTIAL_KEYS` (generate with `openssl rand -base64 32`, e.g.
   `k2026a:<value>`; never reuse between Preview and Production), and the client id/secret pairs.
   Never in the web project, the desktop build, the repo or chat.
4. Resolve STAB-H2 (Neon backups/plan) before real mailboxes (D-C2-10).

## 15. Known risks (C2-A)

- Keys live in the hosting environment: anyone with Vercel production env access can decrypt tokens
  together with database access. A KMS removes that later (D-C2-4).
- Without a worker, queued jobs accumulate (one per connection at most). Harmless; C2-B drains them.
- The callback's HTML page is temporary until C2-D.
- Shared files conflict textually with F5 (additive on both sides).
- No grant is revoked by the app (C2A-03): after disconnect the Google or Microsoft grant stays until
  the user removes the app. The stored tokens are gone, so Business OS can no longer use it.
- A refresh holder stalled past its 30-second lease while a second attempt refreshes a Microsoft
  token: both send the same rotating refresh token, so the provider may reject the second. Fencing
  keeps the lease owner in charge and drops the stalled attempt's answer; if the owner's refresh is
  then refused, the mailbox correctly asks for reconnection. Rare, and never silent.

---

## 16. C2-B1: mailbox identity, classification, permissions and lifecycle

Implements the C2-B1 brief from the decision register (approved by Regan 2026-11-15) with his two
acceptance criteria (§16.6, §16.11). Standalone PR; it stores no mail, syncs nothing, sends nothing
and adds no real provider connection. The E1 erasure foundation, B2 storage/retention, B3 sync and
B4 matching/intake are later PRs.

### 16.1 Mailbox kinds and the four identities (T-C2-1)

Every connection has a **kind**, fixed when it is created and never converted:

- **PERSONAL**: a member's own mailbox. Unchanged C2-A rules (§4, §5): `OWNER_ONLY` by default, only
  the owner may share it `BUSINESS`-wide, only the owner reconnects.
- **BUSINESS**: one of the business's own mailboxes (`sales@`, `accounts@`, a shared mailbox). It must
  match a designated business address (§16.3), is visible only to `manage_connections` and its
  members (§16.4), and its grant can be replaced by another admin (§16.5). `sharing` is `MEMBERS`.

A connection records four separate identities, which C2-A collapsed into one:

| Column | Meaning | PERSONAL | BUSINESS |
|---|---|---|---|
| `principal_account_id` | The provider account that signed in and granted access | = target | Any member's own account (Microsoft); = target (Google) |
| `provider_account_id`, `mailbox_address` | The target mailbox | Member's own | The designated address |
| `owner_user_id`, `kind` | The controller | The member | The business (`owner_user_id` is who first connected it) |
| `credential_holder_id` | The member whose grant is stored | Always the owner (CHECK) | Replaceable on reconnect (§16.5) |
| `provider_tenant_id` | Microsoft directory (tid) | Recorded | Required; a reconnect must stay in it |

PERSONAL and BUSINESS never mix: a designated address cannot be connected personally (refused,
audited `business_address`); an address with a live personal connection cannot be designated until
that connection is disconnected, and a later business connection is a new row (the old personal row
stays `DISCONNECTED` as the record). Nothing is carried across.

### 16.2 Schema (`20261125000000_communications_mailbox_identity`)

- `mail_connections`: `kind`, `credential_holder_id`, `principal_account_id`, `provider_tenant_id`,
  `business_address_id` (backfilled for C2-A rows as PERSONAL: holder = owner, principal = target).
  CHECKs pair kind with sharing, address and tenant. Insert guard: the creator holds the grant
  (CM008), PERSONAL is refused for a designated address and BUSINESS needs a live designation with a
  verified domain or attestation (CM010). The update guard adds kind and address to the fixed
  identity (CM005), allows a holder/principal change only on a BUSINESS reconnect to the session user
  (CM008) and refuses sharing a PERSONAL mailbox before retention is set (CM009).
- `mail_business_domains`: domain, sha256 of the verification token, verified/removed stamps. Always
  inserted unverified; verification recorded once; consumer domains refused (CHECK).
- `mail_business_addresses`: designated address with exactly one basis (verified domain or OWNER
  attestation with statement version).
- `mail_connection_members`: per-mailbox `READ` / `SEND` for BUSINESS mailboxes, cascading from the
  membership.
- `mail_retention_settings`: one row per business, `ordinary_retention_days` 1 to 36525, no default.
- `mail_oauth_states.business_address_id` (a business connect) and `mail_sync_jobs` insert guard (CM009).
- Every new table is RLS-forced with tenant isolation and restrictive "written by the session user"
  policies. No DELETE grant except on members. Address checks take a transaction advisory lock per
  business and address, so the personal/business checks cannot race.
- New SQLSTATEs: CM008 holder change refused, CM009 retention not set, CM010 business mailbox rule.

### 16.3 Business domains and designated addresses (T-C2-2, D-C2-3)

Business OS cannot tell from an address alone whether a mailbox belongs to the business, so an
address becomes BUSINESS only by explicit designation:

1. **Custom domain** (`manage_connections`): add the domain, publish the TXT record shown once
   (`_business-os-verification.<domain>` = `business-os-verification=<token>`), then verify. The
   server does the DNS lookup outside any transaction and stores only the token's hash. A missing
   record is audited and answers 409 `dns_record_not_found`. Addresses on a verified domain can then
   be designated.
2. **Consumer address** (gmail.com, outlook.com and the other domains in `CONSUMER_MAIL_DOMAINS`,
   mirrored in SQL `mail_is_consumer_domain`): only the OWNER may designate it, by accepting
   attestation text v1 (`MAIL_BUSINESS_ATTESTATION_V1`). The attestation is stored (who, when,
   version) and audited. A consumer domain can never be added as a business domain.
3. **Live access check at connect** (both cases): the signed-in account must actually reach the
   designated mailbox.
   - Google: the signed-in account must be the mailbox (Gmail `users/me/profile`), and for a custom
     domain its Workspace `hd` claim must equal the verified domain.
   - Microsoft: `tid` from the id_token; the mailbox is looked up in that directory
     (`/users/{address}`), its inbox must be readable through Full Access (`Mail.Read.Shared`), and the
     verified domain must be one of the tenant's verified domains (`/organization`). For a personal
     Microsoft account (consumer tenant) the signed-in account must be the mailbox.

A domain cannot be removed while a designated address is on it; an address cannot be removed while a
business connection uses it. Removal is final.

### 16.4 Permissions and record rules

No new permission key. `canAttestBusinessMailbox` (OWNER only) is a role rule in the access module.

| Action | PERSONAL owner (`connect`) | `manage_connections` (OWNER, ADMIN) | BUSINESS member (READ/SEND) | Others |
|---|---|---|---|---|
| Add, verify, remove a domain; designate, remove a custom-domain address | – | ✓ | – | – |
| Designate a consumer address (attestation) | – | OWNER only | – | – |
| Connect, reconnect (take over) a BUSINESS mailbox | – | ✓ | – | – |
| See a BUSINESS mailbox (metadata) | – | ✓ | ✓ | 404 |
| Grant or revoke members, pause, disconnect, request sync | – | ✓ | – | – |
| Set the retention period | – | ✓ | – | – |
| Read or send business mail (B3, C2-C) | – | through membership, later stages | READ / SEND | – |
| PERSONAL mailboxes | §4 unchanged | §4 unchanged | – | §4 |

`SEND` is recorded now so the member model does not change in C2-C; nothing sends in C2-B1.

### 16.5 Lifecycle: connect, handover, departure (D-C2-8)

- **Connect**: a `manage_connections` member starts authorization with `businessAddressId`. The
  callback checks the live access proof (§16.3), creates the BUSINESS row with that member as holder
  and audits `business_connected` with the basis.
- **Handover** (no token transfer): another `manage_connections` member reconnects with their own
  sign-in. In one unit of work the row goes `ACTIVE → NEEDS_REAUTH` (the C2-A trigger deletes the old
  tokens and open jobs are cancelled), then `NEEDS_REAUTH → ACTIVE` with the new holder and principal,
  who must be the session user. Target mailbox and Microsoft tenant must not change. Audited
  `reconnected` and `holder_changed` (previous and new holder ids). The database refuses any other
  holder change.
- **Holder departs or loses `manage_connections`**: detected at the next sync claim. The job is
  cancelled, the mailbox goes to `NEEDS_REAUTH` with `holder_inactive` (tokens deleted), and
  `communications.system.holder_inactive` is audited. Another admin can take it over. PERSONAL
  mailboxes keep the C2-A rule (`owner_inactive`). The 30-day departure grace in the approved
  register is read here as the grace before unshared personal mail is purged, which belongs to B2
  (it needs stored mail and E1); the departing member's grant stops at once. Regan to confirm.

### 16.6 Retention gate (D-C2-9, Regan's acceptance criterion 1)

There is no product default for ordinary communications retention. Until the business sets one:

- no sync job can be queued for a BUSINESS mailbox (service `retention_not_set` and database CM009),
  so a business mailbox connects but does not sync;
- no PERSONAL mailbox can be shared with the business (`sharing = BUSINESS`, same two layers).

The period is set and changed (never unset) by `manage_connections`, with optimistic versioning and
audit `communications.retention.ordinary_set` (new and previous days). C2-B2 must add the same
requirement to sharing a single personal thread and to "Keep as record" (promoting personal content
into an ordinary business record), and applies the period to stored copies (`retain_until`, purge).

### 16.7 Audit events (new)

Metadata is ids, enums and codes only; never an address, domain, token or DNS value.

| Action | Metadata |
|---|---|
| `communications.domain.added` / `.verified` / `.verification_failed` / `.removed` | `method: dns_txt`, `reason` |
| `communications.address.designated` / `.attested` / `.removed` | `basis`, `domainId`; `statement` (attestation version) |
| `communications.connection.business_connected` | `provider`, `businessAddressId`, `basis`, `syncQueued` |
| `communications.connection.holder_changed` | `provider`, `previousHolderId`, `newHolderId` |
| `communications.member.granted` / `.revoked` | `userId`, `access`, `previousAccess` |
| `communications.retention.ordinary_set` | `ordinaryRetentionDays`, `previousDays` |
| `communications.system.holder_inactive` | `provider` |

Existing events gain `kind` / `businessAddressId` where relevant. New callback failure reasons:
`business_address`, `not_designated`, `mailbox_not_found`, `mailbox_access_denied`, `domain_mismatch`.

### 16.8 API

Under `/api/v1/b/{slug}/communications/`: `business-domains` (GET, POST), `business-domains/{id}/verify`
and `/remove` (POST), `business-addresses` (GET, POST), `business-addresses/{id}/remove`, `retention`
(GET, PUT), `connections/{id}/members` (GET), `connections/{id}/members/{userId}` (PUT) and `/remove`.
`connections/authorize` accepts `businessAddressId`. 409 codes: `retention_not_set`, `not_personal`,
`not_business`, `consumer_domain`, `domain_exists`, `domain_not_verified`, `domain_in_use`,
`already_verified`, `dns_record_not_found`, `dns_unavailable`, `removed`, `attestation_required`,
`attestation_not_applicable`, `already_designated`, `personal_connection_exists`, `address_in_use`,
`holder_change_not_allowed`, `business_mailbox_rule`. The verify route is the only one that uses
`tenantRunRoute` (two units of work around the DNS lookup); the boundary script allows it there only.

### 16.9 Tests

`tests/integration/communications-business-mailboxes.test.ts` (23 tests, fake Google, Microsoft and
DNS) covers retention, domains, designation and attestation, the database rules for any caller,
personal/business separation, business connect for Microsoft shared mailboxes, Google and consumer
addresses with every refusal, members and visibility, handover, CM008, holder and owner departure,
RLS across businesses, no secret in any response, and business purge. C2-A suites were updated for
the retention gate and the new identity columns.

### 16.10 Migration ordering, deploy and rollback

- Name `20261125000000_communications_mailbox_identity` sorts after main's newest (R1
  `20261124000000_reporting`) and after F6 (`20261123000000_…`, not merged). If this merges before F6,
  F6 must be renamed to sort after it (CI guard). Whoever merges later sorts last.
- Depends on C2-A. Backfills existing connections; production had none when this was written. No
  privileged SQL.
- Deploy: apply before or with the code (the new code reads the new columns). Take a Neon recovery
  branch first. Not applied anywhere except local and CI databases; production needs Regan's approval.
- Rollback (before any BUSINESS mailbox exists):
  ```sql
  BEGIN;
  ALTER TABLE "mail_connections" NO FORCE ROW LEVEL SECURITY;
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM "mail_connections" WHERE "kind" = 'BUSINESS') THEN
      RAISE EXCEPTION 'business mailboxes exist: disconnect and remove them before rolling back C2-B1';
    END IF;
  END $$;
  ALTER TABLE "mail_connections" FORCE ROW LEVEL SECURITY;
  DROP TABLE "mail_connection_members", "mail_retention_settings";
  DROP TRIGGER mail_connections_guard_insert ON "mail_connections";
  DROP TRIGGER mail_sync_jobs_guard_insert ON "mail_sync_jobs";
  ALTER TABLE "mail_oauth_states" DROP COLUMN "business_address_id";
  ALTER TABLE "mail_connections" DROP CONSTRAINT mail_connections_sharing_values,
    DROP COLUMN "kind", DROP COLUMN "credential_holder_id", DROP COLUMN "principal_account_id",
    DROP COLUMN "provider_tenant_id", DROP COLUMN "business_address_id";
  ALTER TABLE "mail_connections" ADD CONSTRAINT mail_connections_sharing_values CHECK ("sharing" IN ('OWNER_ONLY', 'BUSINESS'));
  DROP TABLE "mail_business_addresses", "mail_business_domains";
  DROP FUNCTION mail_connections_guard_insert(), mail_sync_jobs_guard_insert(), mail_business_domains_stamp_insert(),
    mail_business_domains_guard_update(), mail_business_addresses_guard_insert(), mail_business_addresses_guard_update(),
    mail_connection_members_guard(), mail_address_is_designated(uuid, text), mail_lock_address(uuid, text), mail_is_consumer_domain(text);
  -- then re-create mail_connections_guard_update() exactly as in 20261121000000_communications_providers
  DELETE FROM _prisma_migrations WHERE migration_name = '20261125000000_communications_mailbox_identity';
  COMMIT;
  ```
  Verified locally (2026-11-15): all migrations plus this script (with the C2-A function restored)
  give a `pg_dump --schema-only` identical to the migrations without C2-B1.

### 16.11 C2-C acceptance criterion: outbound correlation (Regan's acceptance criterion 2)

Not built in C2-B1. C2-C must test, per provider, how reliably a sent message can be correlated
with what the provider later reports: whether our headers (`Message-ID`, `In-Reply-To`, `References`,
any custom header) are preserved; whether the Sent folder is accessible with the granted scopes; and
Microsoft shared-mailbox behaviour (Send As / Send on Behalf, which mailbox's Sent folder receives the
copy). C2-C must **not** assume custom headers are directly searchable, and must **not** treat absence
from Sent as proof of non-delivery (an `UNKNOWN` send stays `UNKNOWN`, D-C2-13).

### 16.12 Technical disagreements and deviations (challenge protocol)

1. **Attestation lives on the address, not the connection.** The attestation is about whether the
   address is the business's, and must hold across reconnects and holders.
2. **No new permission key for attestation.** OWNER-only through a role rule
   (`canAttestBusinessMailbox`), because a permission key would let a custom role grant it. Reviewer
   may prefer a key.
3. **Retention is set with `manage_connections`** (OWNER and ADMIN), not OWNER only. Changeable,
   never unset, audited with the previous value. Regan may prefer OWNER only.
4. **Domain verification is one-time.** No periodic re-check in C2-B1; a lapsed domain keeps its
   designations until removed. A re-check can come with B3's worker.
5. **Address matching is exact on the primary address.** Aliases and secondary Workspace domains are
   not recognised (a Google Workspace mailbox on a secondary domain fails the `hd` check).
6. **Departure is detected lazily** at the next sync claim, not by a membership trigger. Without sync
   (B3) nothing uses the stale grant anyway.

### 16.13 Known risks and Gate C (provider) items

- Microsoft: `Mail.Read.Shared` and `User.ReadBasic.All` need consent; tenants that block user
  consent need admin consent first. There is no fallback if `User.ReadBasic.All` is refused (the
  connect fails with `mailbox_access_denied`). Verify with a real tenant.
- Microsoft: `tid` comes from the id_token in the token response (received directly from the token
  endpoint over TLS, OIDC Core §3.1.3.7(6)); it is cross-checked against the signed-in user's id.
- Google: confirm with a real Workspace account that `hd` appears in userinfo for the scopes used.
- The consumer domain list is fixed in code and SQL and must be changed in both together (a test
  checks they match).
- Legal/privacy readiness (Gate B) and provider verification (Gate C) remain independent launch
  gates. No production mailbox may be connected without separate authorisation.
