# Settings A3: architecture for the Pixa OS Settings experience

Status: **Proposal, documentation only.** Nothing here is implemented, and nothing here changes code, the schema, RLS,
grants, admission, secrets, migrations or production. Owner decisions D-A3-1 to D-A3-17 (§14) were **approved by Regan on 2026-11-16**, with the gates in §15–§16.

Revision 2 (2026-11-16): addresses ChatGPT architecture audit round 1 on PR #81 (conditional approval, docs
only). The nine required amendments are in the new §15, which sets the gates. §9, §14, §16 and §17 changed to match.
The audit's positions are recorded beside each decision in §14. They are **not** owner decisions.

Base: `main` at `b2f308b` (People P3-A, #68), 2026-11-16. Branch `claude/project-thread-m3veky`.

This document designs **where every setting lives, who may see and change it, what it reads and writes, and in what
order the missing parts get built**. It builds on Administration A2 (`docs/administration-a2.md`) and does not
reopen any A2 decision (D-A2-1 to D-A2-13 were approved on 2026-11-16). It also defers to the UI V2-A spec
(`docs/ui/pixa-design-system-v2-a.md`, merged in #74) for the shell, navigation and components.

---

## Contents

1. Summary
2. Preflight: what was verified
3. Status labels
4. What exists today
5. Design principles
6. Information architecture and navigation
7. Settings catalogue (each setting: source, owner, keys, status)
8. Role and permission matrix
9. API and persistence gaps
10. Validation and confirmation rules
11. Defaults and migration needs
12. Audit and security constraints
13. Ownership boundaries and conflicts
14. Owner decisions
15. Security gates and lifecycle designs (audit round 1)
16. Staged plan
17. Test strategy
18. Handoff

---

## 1. Summary

- **Settings becomes one destination with two scopes.** *Account* covers the signed-in person, across every
  business. *Business* covers the current tenant. The person's role decides what they can see and change in each
  section. A platform-operator area is **not** part of tenant Settings (§13, C6).
- **Settings is a hub, not a second copy.** Zone-owned configuration (Finance numbering and tax rates, Sales
  pipelines, People departments and leave policies, Scheduling calendars and resources) stays in its Zone, with its
  Zone's permission keys and audit. Settings lists it and links to it, and never re-implements those forms (D-A3-2).
- **Most business-side data and APIs already exist.** That covers the business profile and regional settings
  (A2-A), members and invitations (on main, with A2-B in draft PR #76), and Finance, Sales, People, Scheduling and
  Communications configuration APIs. What is missing is the **Settings UI**, a **roles read API** (A2-C), an
  **audit viewer API** (A2-E) and, on the account side, **almost everything**: there is no profile edit API, no
  password-change or session-management contract, and no stored personal preferences.
- **Four areas have nothing yet and need owner decisions before any design is final:** Pixa subscription billing,
  business archive and deletion, personal account deletion, and email-address change. Each is flagged in §14.
- **One verified security item for A3-A preflight:** the `/api/v1/auth/[...all]` route forwards every path to
  Better Auth with no allow-list. Better Auth's built-in account endpoints (for example `update-user`,
  `change-password`, `list-sessions`, `revoke-session`) are therefore probably reachable, but nothing in the client,
  contracts or tests uses them, and they write without a Pixa audit event. This was **not** exercised in this
  docs-only task (§9, G-A3-2). Following audit round 1, closing this comes **first**, as its own small security
  PR (A3-0, §15.1), before any Settings UI.

## 2. Preflight: what was verified

| Item | Finding | How it was checked |
|---|---|---|
| `main` | `b2f308b`, People P3-A (#68) merged 2026-11-16 11:51 UTC | `git log origin/main` |
| A2-A business profile | **Merged** (#70, `cea8459`). `GET/PATCH /api/v1/b/{slug}/business`, migration `20261202000000_business_profile` | route files, `modules/tenancy/server/business-profile.ts` |
| Private-beta admission | **Merged** (#71). Admission ledger and operator CLI, with no in-app operator console | `docs/private-beta-lockdown.md` |
| A2-B membership lifecycle | **Draft PR #76**, not merged and not applied to production. Re-stamped to `20261205000000_membership_lifecycle` plus privileged `005_member_emails.sql` | `git diff origin/main...origin/claude/project-thread-dyn16d` |
| UI V2-A spec | **Merged** (#74). D-V2A-1 to 13 recorded. V2-B waits for Regan's go-ahead | `docs/ui/pixa-design-system-v2-a.md` §8, §11, §13 |
| Agent context pack | `docs/agent-context.md`, `active-workstreams.md` and `agent-task-protocol.md` are **not on main**. They were read from draft PR #78. Its snapshot still lists P3-A (#68) as open; it merged at 11:51 UTC | branch `claude/project-thread-ibvyn8` |
| Related open docs PRs | GS1 #75 (search), F8 #77 (banking). The N1 notifications and W1 workflows lanes are queued, with no PR seen | PR list |

Files inspected (read only): `modules/access/server/permissions.ts`, `modules/tenancy/server/*`,
`modules/identity/server/{auth-adapter,handler,admission}.ts`, `prisma/schema/identity.prisma`, the identity migration
grants, the `/api/v1` route tree, `packages/contracts/src/{auth,tenancy}.ts`, `packages/app/src/shell/{registry,preferences}.ts`,
`packages/app/src/api/*`, `zones/finance/settings.tsx`, `docs/administration-a2.md`, `docs/private-beta-lockdown.md`,
`docs/ui/app-shell.md`, `docs/communications-e1.md` (§2, §7) and `docs/sales-data-model.md` §5.

## 3. Status labels

Every setting in §7 carries exactly one of these:

| Label | Meaning |
|---|---|
| **Existing** | Persistence and API are on `main` today. The note says whether a UI exists. Existing does **not** mean enabled in production, for example E1 is dormant. |
| **Requires implementation** | Nothing exists, or only a column exists with no API. A3 proposes the design. |
| **Dependent: \<workstream\>** | Being designed or built elsewhere. A3 decides only where it appears in Settings and who sees it. |

## 4. What exists today

| Surface | State on `main` |
|---|---|
| Settings Zone | Registry entry `settings` is `availability: 'planned'`, `requires: []`, route `/settings`. Shown on Home as "coming soon" and cannot be opened (`shell/registry.ts`). |
| Account menu | Theme (System, Light, Dark), sidebar mode, business switcher and sign out. The theme and sidebar are **device-local** (`localStorage` keys `bos.theme` and `bos.sidebar`) and never sent to the server (`shell/preferences.ts`). |
| Personal profile | `users` has `name`, `image_url`, `locale`, `time_zone` and `deactivated_at`. `bos_app` may read `id, name, image_url` only. `GET /api/v1/me` returns `id, email, name, emailVerified`. **No profile update in contracts or the client.** `users.locale` and `users.time_zone` are not read or written anywhere in `apps/api/src`. |
| Password | Sign-up, sign-in, sign-out, request-reset and reset are used and tested (12-character minimum, sessions revoked on reset). **No change-password flow** exists in the client or contracts. |
| Sessions | 30-day database sessions with a 1-day refresh and no cookie cache, so revocation applies on the next request. The desktop uses bearer tokens (ADR 0005). **No list or revoke UI or contract.** |
| Business profile and regional settings | **Existing API** (A2-A): identity, contact, address, country, time zone, locale, currency, financial-year start month, optimistic `version`, audited. No UI (A2-D). |
| Members and invitations | **Existing API**: list, role change, remove, invite, revoke and accept. **A2-B (draft #76)** adds suspend and reactivate, transfer ownership, step down, leave, resend, `delivery` status and member emails. No UI (A2-D). |
| Roles | Four fixed roles. `GET /b/{slug}` returns the caller's role and permission keys. There is **no roles-matrix read API** (A2-C). |
| Audit | `audit_events` is append-only and tenant-isolated. The `audit:read` key is granted to OWNER and ADMIN but **used by no route** (A2-E). |
| Business archive or delete | `businesses.archived_at` exists and `my_memberships` hides archived businesses. The `business:delete` key is granted to OWNER but **used by no route**. Nothing archives or deletes a business. |
| Zone configuration | Finance: settings, number series, tax rates, expense categories, document branding, reminder policies and catalog, all with APIs. Finance has its own **Settings child page** in the client. Sales: create pipelines and initialise the default (`sales:manage`); stage editing and reordering are planned in `sales-data-model.md` and have no route. People: departments, locations, leave types and leave policies. Scheduling: calendars and resources. Reporting: saved views (personal and shared). |
| Communications | C2 mailbox connections, business domains and addresses, retention, legal holds and erasures have **APIs but no client UI**. E1 retention and erasure is merged but **dormant** (legal decisions in `communications-e1.md` §13). OAuth providers are configured by environment variables and are off when unset. |
| Notifications | None. No bell (removed by D-V2A-6) and no preferences. Platform email covers auth and invitations only. |
| Pixa subscription billing | None: no plan, seats, payment method or provider. (Finance F6 "billing" means the **business's** recurring invoices to its customers, which is a different thing.) |
| Platform operator | CLI only (`db:beta-admission`). An in-app console is a proposed follow-up in `private-beta-lockdown.md` §4. |

## 5. Design principles

1. **Server truth, client visibility only.** Settings shows or hides sections by permission keys from
   `GET /b/{slug}`. Every write is authorised again on the server, inside the transaction where A2 already does that
   (`lockActor`). The UI never decides access (ADR 0005).
2. **One owner per setting.** Each setting has exactly one owning module, one write key and one audit action. Settings
   may display a value it does not own (for example the business currency inside Finance settings), but only the
   owner writes it.
3. **Account is not tenant data.** Personal settings follow the person across businesses and must be reachable when
   the person has **no** business ("No workspace yet") or is not yet admitted. That rules out putting them only
   behind the per-business Zone registry.
4. **No settings for features that do not exist.** A section with no backend is left out of the UI, not shown
   disabled, in line with the V2-A data rule (§10 there) and D-V2A-6.
5. **History is never rewritten.** Regional changes affect only new records and "today" (A2 §3.3). Every Settings
   screen that edits a default says so.
6. **Dangerous actions are separate from forms.** Ownership, leaving, suspension, removal, archive and deletion live
   in a clearly separated "danger" area with their own confirmation. They are never a field in a form saved with
   other changes.
7. **Read-only is a real state.** A MEMBER opening Business settings sees the profile and member names (A2 §5) in a
   read-only layout, not a form with disabled inputs.

## 6. Information architecture and navigation

### 6.1 Entry points

| Entry | Opens | Visible to |
|---|---|---|
| Account menu › **Account settings** | Settings › Account | Every signed-in user, including users with no business. A not-yet-admitted user sees only sign-out and "sign out everywhere" (§15.2) |
| Account menu › **Business settings** | Settings › Business › General | Members of the current business (`business:read`) |
| Sidebar or Home tile **Settings** (registry entry becomes `built`) | Settings › Business › General | `requires: ['business:read']`, which every role holds |
| Command palette | "Settings › …" commands generated from the same resolved navigation (V2-A §8.2, one source of truth) | Same as the sidebar |
| Zone pages | Zone-owned settings stay reachable from their Zone. Finance keeps **Finance › Settings** | Unchanged |

URL routing and deep links are still deferred (`docs/ui/app-shell.md`). Until they exist, a link from Settings to a
Zone page is a shell route change (`{ zone: 'finance', child: 'settings' }`), guarded by the unsaved-changes guard
like any other navigation (V2-A §8.1).

### 6.2 Navigation tree

Labels are proposed copy. The status in brackets is that section's **overall** state. §7 has the per-setting
detail.

```
Settings
├── Account                                      (the signed-in person, every business)
│   ├── Profile                                  [Requires implementation]
│   ├── Sign-in & security                       [Requires implementation; Existing for password reset]
│   │   ├── Password
│   │   ├── Signed-in devices (sessions)
│   │   └── Email address (read-only in v1)
│   ├── Preferences                              [Existing on device: theme, sidebar]
│   │   ├── Appearance (theme, sidebar)
│   │   └── Language, region and time zone       [Requires implementation, D-A3-5]
│   ├── Notifications                            [Dependent: N1]
│   ├── Your mailbox                             [Dependent: C2 UI; API Existing]
│   └── Your businesses (switch, leave)          [Existing switcher; leave Dependent: A2-B]
│
└── Business: <current business>
    ├── General
    │   ├── Business profile                     [Existing API, A2-A; UI A2-D]
    │   └── Regional settings                    [Existing API, A2-A; UI A2-D]
    ├── Team
    │   ├── Members                              [Existing API; lifecycle Dependent: A2-B; UI A2-D]
    │   ├── Invitations                          [Existing API; resend etc. Dependent: A2-B; UI A2-D]
    │   └── Roles & access                       [Dependent: A2-C (read API); UI A2-D]
    ├── Zone settings (hub: links only)
    │   ├── Finance: documents, numbering, taxes, categories, branding, reminders, catalog   [Existing, Finance Zone]
    │   ├── Sales: pipelines                     [Existing (create); stage edit Requires implementation, Sales]
    │   ├── People: departments, locations, leave types and policies   [Existing, People Zone]
    │   └── Scheduling: calendars, resources     [Existing API; Dependent: V2-C readiness check, D-V2A-8]
    ├── Integrations
    │   ├── Mailboxes                            [Existing API; Dependent: C2 UI]
    │   ├── Business domains and addresses       [Existing API; Dependent: C2 UI]
    │   ├── Bank connections                     [Dependent: F8 (#77)]
    │   └── (calendar sync, accounting export)   [not designed; left out]
    ├── Notifications (business defaults)        [Dependent: N1]
    ├── Data & privacy
    │   ├── Communications retention, holds, erasure   [Existing API, dormant; Dependent: E1 §13]
    │   ├── Finance record retention (read-only)       [Existing, Finance]
    │   └── Data export                          [Requires implementation, D-A3-13]
    ├── Security & audit
    │   └── Audit log                            [Dependent: A2-E (API); UI A3-C]
    ├── Plan & billing (Pixa subscription)       [Requires implementation, D-A3-10; left out until it exists]
    └── Ownership & lifecycle  (danger area)
        ├── Transfer ownership / step down       [Dependent: A2-B]
        ├── Leave this business                  [Dependent: A2-B]
        └── Archive business                     [Requires implementation, D-A3-8]
```

### 6.3 Placement inside the V2 shell

- Settings uses the **same registry `children`** mechanism as Finance and Reporting. On wide screens the children
  appear in the sidebar, at medium width in the section bar with "More", and on phones as a section select (V2-A
  §8.1, D-V2A-5). There is no second, Settings-only sidebar.
- Settings has more destinations than the V2 section bar comfortably holds. The registry therefore lists only the
  **second level** (Account, General, Team, Zone settings, Integrations, Data & privacy, Security & audit,
  Ownership). The third level is tabs or a list inside each page.
- Account settings must render **outside a business context**: for a user with no business, and for a
  not-yet-admitted user (who may only sign out and sign out everywhere, §15.2). That needs a shell route that does not
  require a `slug`. This is new shell work in V2-C or later, and an interface proposal for the V2 owner (§13, C7).
- Children are permission-filtered by `requires`, exactly like other Zones. A child whose backend does not exist is
  not registered at all (principle 4).

## 7. Settings catalogue

Columns: **Source** is where the value is persisted and which route reads and writes it. **Owner** is the owning
module. **Read** and **Write** are permission keys (`—` means any signed-in user acting on themselves). **Status**
uses §3.

### 7.1 Account

| Setting | Source | Owner | Read | Write | Status |
|---|---|---|---|---|---|
| Display name | `users.name` (column exists); Better Auth `update-user` probably reachable (G-A3-2) | identity | self | self | **Requires implementation** (contract, audit, UI) |
| Avatar | `users.image_url` (column exists) | identity | self, members of shared businesses (existing `bos_app` grant) | self | **Requires implementation** (needs file storage design; recommend defer, D-A3-4) |
| Email address | `users.email`, unique, lower-cased | identity | self | none in v1 | **Existing** (read via `/me`); change **Requires implementation**, deferred (D-A3-6) |
| Password change | Better Auth `accounts.password`; reset flow exists | identity | — | self, current password required | **Requires implementation** (contract, rate limit, audit, UI; G-A3-2) |
| Password reset by email | Better Auth `request-password-reset` / `reset-password` | identity | — | — | **Existing** (sign-in screen; revokes sessions) |
| Signed-in devices | `sessions` (hashed token; browser and desktop) | identity | self | self: revoke one, revoke others | **Requires implementation** (G-A3-3) |
| Theme | `localStorage` `bos.theme` | shell | device | device | **Existing** (account menu). Move to the account: D-A3-5 |
| Sidebar mode | `localStorage` `bos.sidebar` | shell | device | device | **Existing** (account menu) |
| Personal language and region | `users.locale` (column exists, unused) | identity | self | self | **Requires implementation**, D-A3-5 |
| Personal time zone | `users.time_zone` (column exists, unused) | identity | self | self | **Requires implementation**, D-A3-5 |
| Notification preferences | none | N1 | self | self | **Dependent: N1** |
| Your mailbox (connect, reconnect, share, pause, disconnect your own) | `mail_connections`, `/communications/connections*` | communications | `communications:read` | `communications:connect` | **Existing API; Dependent: C2 UI.** It is per business (the connection belongs to a membership), so it shows under the current business with an Account shortcut |
| Your businesses | `GET /businesses` | tenancy | self | — | **Existing** (switcher) |
| Leave a business | `POST /b/{slug}/membership/leave` | tenancy | — | `business:read`, not the last owner | **Dependent: A2-B (#76)** |
| Delete my account | none; Better Auth `deleteUser` is not enabled in `auth-adapter.ts` | identity | — | — | **Requires implementation**, flagged (D-A3-9) |

### 7.2 Business › General

| Setting | Source | Owner | Read | Write | Status |
|---|---|---|---|---|---|
| Display name, legal name, trading name | `businesses.name/legal_name/trading_name`; `GET/PATCH /business` | tenancy (A2-A) | `business:read` | `business:manage` | **Existing API**; UI A2-D |
| Contact email, phone, website | `businesses.contact_*`, `website` | tenancy | `business:read` | `business:manage` | **Existing API**; UI A2-D |
| Address | `businesses.address_*` | tenancy | `business:read` | `business:manage` | **Existing API**; UI A2-D |
| Registration and tax identifiers | `finance_settings.seller_identifiers` (D-A2-2) | finance | `finance:read` | `finance:manage` | **Existing**. Settings shows a link to Finance settings, not a copy |
| Slug (URL name) | `businesses.slug` | tenancy | `business:read` | none (no UPDATE grant) | **Existing**, read-only. Renaming the slug is not proposed |
| Data region | `businesses.home_region` | tenancy | `business:read` | none | **Existing**, read-only |
| Country | `businesses.country_code` | tenancy | `business:read` | `business:manage` + confirmation | **Existing API**; UI A2-D |
| Time zone | `businesses.time_zone` | tenancy | `business:read` | `business:manage` + confirmation | **Existing API**; UI A2-D |
| Locale | `businesses.locale` | tenancy | `business:read` | `business:manage` + confirmation | **Existing API**; UI A2-D |
| Default currency | `businesses.currency` | tenancy | `business:read` | `business:manage` + confirmation | **Existing API**; UI A2-D |
| Financial year start month | `businesses.fiscal_year_start_month` (nullable) | tenancy | `business:read` | `business:manage` | **Existing API**; no reader yet (Reporting can adopt it later) |
| Business logo (app identity) | none (document logo is Finance branding) | — | — | — | **Requires implementation** if wanted; recommend reusing the Finance branding logo, D-A3-4 |

### 7.3 Business › Team

| Setting | Source | Owner | Read | Write | Status |
|---|---|---|---|---|---|
| Member list (names, roles, status) | `GET /members` | tenancy | `members:read` | — | **Existing API**; UI A2-D |
| Member emails | `app_private.member_emails()` | tenancy | `members:invite` (D-A2-11) | — | **Dependent: A2-B** |
| Change role | `PATCH /members/{id}` `{ role }` | tenancy + access rules | — | `members:manage` + rank rules | **Existing API**; UI A2-D |
| Suspend / reactivate | `PATCH /members/{id}` `{ status }` | tenancy | — | `members:manage` + rank rules | **Dependent: A2-B** |
| Remove member | `DELETE /members/{id}` (clears assignments; A2-B adds mailbox cutoff) | tenancy | — | `members:manage` + rank rules | **Existing API** (cutoff Dependent: A2-B); UI A2-D |
| Invite | `POST /invitations` | tenancy | — | `members:invite` + rank rules | **Existing API** (`delivery`, duplicates Dependent: A2-B); UI A2-D |
| Pending invitations | `GET /invitations` | tenancy | `members:invite` | — | **Existing API**; UI A2-D |
| Resend / revoke invitation | `POST /invitations/{id}/resend`, `DELETE /invitations/{id}` | tenancy | — | `members:invite` + rank rules | Revoke **Existing**; resend **Dependent: A2-B** |
| Roles & access matrix | `ROLE_PERMISSIONS`; proposed `GET /access/roles` | access | `business:read` | none (fixed roles, D-A2-1) | **Dependent: A2-C** |
| Custom roles | none | access | — | — | Not proposed (D-A2-1). Left out |

### 7.4 Business › Zone settings (hub)

All are **Existing** and owned by their Zone. Settings shows a card per Zone that the person can read, with a link.
The card is hidden when the person lacks the Zone's read key.

| Zone settings | Routes | Read | Write | Notes |
|---|---|---|---|---|
| Finance settings (seller, terms, default tax rate, retention view) | `/finance/settings` | `finance:read` | `finance:manage` | UI exists (Finance › Settings) |
| Number series | `/finance/number-series` | `finance:read` | `finance:manage` | |
| Tax rates, expense categories | `/finance/tax-rates`, `/finance/expense-categories` | `finance:read` | `finance:manage` | |
| Document branding | `/finance/document-branding` | `finance:read` | `finance:documents_branding` | UI exists |
| Reminder policies | `/finance/reminder-policies` | `finance:read` | `finance:billing` | Sending stays **off** (F6 jobs) |
| Products and services | `/finance/catalog-items` | `finance:read` | `finance:catalog` | Its own Finance child, not a setting. Linked only |
| Sales pipelines | `/sales/pipelines` | `sales:read` | `sales:manage` | Stage edit and reorder: **Requires implementation** (Sales-owned, `sales-data-model.md` §5) |
| Departments, locations | `/people/departments`, `/people/locations` | `people:read` | `people:configure` | |
| Leave types, leave policies | `/people/leave-types`, `/people/leave-policies` | `people:read` | `people:configure` (+ `people:manage` for assignments) | P3-A merged; later P3 stages People-owned |
| Calendars, resources | `/scheduling/calendars`, `/scheduling/resources` | `scheduling:read` | `scheduling:manage_calendars`, `scheduling:manage_resources` | Card hidden until Scheduling passes its V2-C readiness check (D-V2A-8) |

### 7.5 Business › Integrations, Notifications, Data & privacy, Security & audit, Billing, Lifecycle

| Setting | Source | Owner | Read | Write | Status |
|---|---|---|---|---|---|
| All mailboxes (metadata, restrict, pause, disconnect, sync) | `/communications/connections*` | communications | `communications:manage_connections` | same | **Existing API; Dependent: C2 UI** |
| Business domains and addresses | `/communications/business-domains`, `/business-addresses` | communications | `communications:manage_connections` | same; consumer-address attestation is OWNER only (`canAttestBusinessMailbox`) | **Existing API; Dependent: C2 UI** |
| Bank connections | none | finance (F8) | — | — | **Dependent: F8 (#77)** |
| Business notification defaults | none | N1 | — | — | **Dependent: N1** |
| Communications retention period | `/communications/retention` (GET, PUT), `apply-reduction` | communications (E1) | `communications:read` | `communications:manage_connections`; reduction needs an OWNER single-use code | **Existing API, dormant; Dependent: E1 §13** |
| Legal holds, erasure requests | `/communications/legal-holds`, `/erasures`, `/authorizations` | communications (E1) | `communications:manage_connections` | same + single-use code | **Existing API, dormant; Dependent: E1 §13** |
| Finance retention years, legal hold | `finance_settings.retention_years`, `legal_hold` | finance | `finance:read` | none from the app (shown read-only today) | **Existing**, read-only |
| Business data export | none | proposed new `tenancy` export | `business:manage`? | — | **Requires implementation**, D-A3-13 |
| Audit log | `audit_events`; proposed `GET /audit-events` | core/audit | `audit:read` | none (append-only) | **Dependent: A2-E** (API); UI A3-C |
| Platform admission history | `app_private.beta_admission_events` | platform | operator only | operator only | **Not tenant Settings** (§13, C6) |
| Pixa plan, seats, payment method, invoices from Pixa | none | proposed `platform-billing` | OWNER (D-A3-10) | OWNER | **Requires implementation**, D-A3-10. Left out until it exists |
| Transfer ownership / step down | `POST /members/{id}/transfer-ownership`, `POST /membership/step-down` | tenancy | — | OWNER role rule + `members:manage` | **Dependent: A2-B** |
| Archive business | `businesses.archived_at` (exists, no grant, no route) | tenancy | — | `business:delete` (OWNER) | **Requires implementation**, D-A3-8 |
| Delete business permanently | none | tenancy + every Zone | — | — | **Requires implementation**, flagged and blocked by retention (D-A3-8) |

## 8. Role and permission matrix

This reflects **current grants** (`permissions.ts`) and the A2-approved role rules. A3 proposes **no new key and no
grant change** for A3-A to A3-C. The only possible new authority is Pixa billing (D-A3-10), which is decided
separately.

✔ = full, R = read-only, — = hidden. "Self" = only for their own account or membership.

| Settings area | Owner | Admin | Manager | Member | Not admitted / no business |
|---|---|---|---|---|---|
| Account › Profile, Sign-in & security | Self | Self | Self | Self | No business: Self. Not admitted: sign out and revoke-all only (§15.2) |
| Account › Preferences | Self | Self | Self | Self | Self (device only) |
| Account › Your mailbox | ✔ (`connect`) | ✔ | ✔ | — (no `communications:connect`) | — |
| Account › Leave business | ✔ unless last owner | ✔ | ✔ | ✔ | — |
| General: profile and regional | ✔ | ✔ | R | R | — |
| Team › Members | ✔ any (except self) | ✔ below own | ✔ MEMBERs only | R (names, roles) | — |
| Team › Member emails | ✔ | ✔ | ✔ | — | — |
| Team › Invitations | ✔ (ADMIN, MANAGER, MEMBER) | ✔ (MANAGER, MEMBER) | ✔ (MEMBER) | — | — |
| Team › Roles & access | R | R | R | R | — |
| Zone settings: Finance | ✔ | ✔ | R (`finance:read`) | — | — |
| Zone settings: Sales pipelines | ✔ | ✔ | R | R | — |
| Zone settings: People | ✔ | ✔ | R (directory key; config pages read-only) | — | — |
| Zone settings: Scheduling | ✔ | ✔ | ✔ (Manager holds `manage_calendars`/`manage_resources` via DATA) | R | — |
| Integrations: all mailboxes, domains | ✔ (+ consumer attestation) | ✔ | — | — | — |
| Data & privacy: Communications retention, holds, erasure | ✔ (+ OWNER-only reduction) | ✔ | R (retention view only, `communications:read`) | R (retention view only) | — |
| Data & privacy: Finance retention | R | R | R | — | — |
| Security & audit: Audit log | ✔ (`audit:read`) | ✔ | — | — | — |
| Ownership: transfer, step down | ✔ | — | — | — | — |
| Archive business (proposed) | ✔ (`business:delete`) | — | — | — | — |
| Plan & billing (proposed) | ✔ (D-A3-10) | — (or R, decision) | — | — | — |

Two facts from the matrix that the UI must not hide:

- MANAGER holds `scheduling:manage_calendars` and `scheduling:manage_resources` (they are in the shared `DATA` set).
  The People and Finance config pages are read-only for MANAGER.
- Read access to Communications retention comes from `communications:read`, which every role holds. If showing
  retention to MEMBER is unwanted, that is an E1 decision, not an A3 one.

## 9. API and persistence gaps

| ID | Gap | Owner | Proposed resolution | Stage |
|---|---|---|---|---|
| G-A3-1 | No Settings shell (registry entry is `planned`; no account-scoped route without a slug) | shell | Registry `settings` → `built`, `requires: ['business:read']`, children per §6.3. Add a business-less Account route | A2-D (business side), A3-A (account side) |
| G-A3-2 | **Better Auth built-in account endpoints are probably reachable through `/api/v1/auth/[...all]`** (no path allow-list in `handleAuthRequest`), but none is in contracts, client or tests. They write through `bos_auth` without a Pixa audit event and have no custom rate-limit rule | identity | A3-0 enumerates the method and path pairs the pinned Better Auth 1.7.22 registers, adds an explicit allow-list, and tests rejected paths, CSRF and bearer handling, and backwards compatibility (§15.1). Account actions adopted later (A3-A) are added to the list one by one, each with its own contract, audit and rate limit (D-A3-7) | **A3-0**, independent and first (§15.1) |
| G-A3-3 | No session list or revoke contract; desktop sessions need a readable label | identity | `GET /api/v1/me/sessions`, `DELETE /me/sessions/{id}`, `POST /me/sessions/revoke-others`, `POST /me/sessions/revoke-all` (§15.3). `sessions` already has `ip_address`, `user_agent` and `revoked_at` columns (Better Auth fields). Whether IP and user agent are populated, and whether to show them, is a privacy decision for A3-A | A3-A |
| G-A3-4 | No profile update contract | identity | `PATCH /api/v1/me` `{ name }` with strict validation and an audit event (identity has no tenant, so the event needs a platform-level audit home, §12) | A3-A |
| G-A3-5 | Personal locale and time zone columns exist but are unused and not granted to `bos_app` | identity | Decide first (D-A3-5). If adopted: expose via `/me`, a column grant or definer function, and define precedence (personal for display only; business time zone stays authoritative for business dates) | A3-B |
| G-A3-6 | Device-only theme | shell | Keep it device-local in v1 (D-A3-5). Optional later sync | — |
| G-A3-7 | Roles read API | access | `GET /access/roles` (A2-C as approved) | A2-C |
| G-A3-8 | Audit viewer API | core/audit | `GET /audit-events` (A2-E as approved): cursor paging, action-prefix filter, actor name resolution, metadata allow-list per action | A2-E, UI in A3-C |
| G-A3-9 | No business archive route; `business:delete` unused; `bos_app` has no UPDATE grant on `archived_at` | tenancy | OWNER-only archive through a reviewed definer function (it changes what `my_memberships` returns for every member), with typed confirmation, audit, effect on scheduled jobs (none run today) and C2 credential cutoff. Unarchive by operator only in beta | A3-D, after D-A3-8 |
| G-A3-10 | No permanent business deletion | tenancy + all Zones | Not proposed for self-service. Finance records are never deleted (Finance retention policy shown in-app), and E1 legal decisions are open. Operator-run process only, after legal review | Out of A3 build scope |
| G-A3-11 | No account deletion | identity | Not enabled. Needs rules: refused while the person is the last OWNER anywhere; memberships removed through the A2 paths; authored records keep a "former user" display; admission ledger keeps the id. Recommend operator-handled requests in beta | A3-D design, D-A3-9 |
| G-A3-12 | No email change | identity | Defer (D-A3-6). It touches verification, invitations (matched by email), `member_emails`, admission (by id, unaffected) and password reset | — |
| G-A3-13 | No data export | tenancy | Defer to a dedicated design (per-Zone exporters, async job, signed download, audit). Jobs and email are off today | D-A3-13 |
| G-A3-14 | No Pixa subscription billing | platform | Separate workstream: provider choice, cost and tax review, webhooks, OWNER authority. Not in A3 build scope | D-A3-10 |
| G-A3-15 | No notification preferences | N1 | N1 defines the model and API. A3 reserves two places (Account, Business) | N1 |
| G-A3-16 | No Communications client UI | communications | C2 UI stage owns the screens. Settings links to them | C2 |
| G-A3-17 | Sales stage edit and reorder | sales | Already planned by Sales (`sales-data-model.md` §5 row 17) | Sales |

## 10. Validation and confirmation rules

### 10.1 Interaction classes

| Class | Examples | Rule |
|---|---|---|
| **Instant** | Theme, sidebar mode | `Switch` or `SegmentedControl` (V2-A §9.2), applied immediately, no save button, nothing sent to the server |
| **Form save** | Business profile, Finance settings, profile name | Explicit Save. Unsaved-changes guard. Send `version` or `expectedVersion` where the API has it (409 `stale` → reload prompt that keeps the draft visible). Server validation errors map to fields (400 `invalid_input`, A2 §7) |
| **Confirmed save** | Country, time zone, locale, currency (A2-D requirement from the PR 70 audit) | Before saving, a `ConfirmDialog` lists **what changes now** ("today", day boundaries, reporting periods, finance date checks) and **what does not** (stored currencies, issued document snapshots, recurring schedules' time zones). The audit stores old and new values (A2-A does this) |
| **Confirmed action** | Role change, suspend, reactivate, revoke invitation, resend, revoke a session | `ConfirmDialog` naming the person and the effect. Suspension and removal state the **mailbox cutoff** (A2-B) and that removal clears assignments while suspension keeps them |
| **Typed confirmation** | Transfer ownership, step down, leave business, remove member, archive business | The person types the business name (or the member's name for removal). The client then sends `confirm: true` (A2-B contracts already require it for transfer, step-down and leave) |
| **Re-authentication** | Change password (current password), revoke all other sessions, archive business, delete account | Password change always needs the current password. For the rest, see D-A3-11 (no step-up in A2 v1) |
| **Single-use authorisation code** | E1 erasure, hold release, retention reduction | Existing E1 pattern (`POST /communications/authorizations`). Settings uses it unchanged when E1 is activated |

### 10.2 Field validation

Settings reuses server validators and never duplicates rules in the client beyond hints:

- Business profile: `isCountryCode`, `isTimeZone` (also checked by a DB trigger against `pg_timezone_names`),
  `isCurrency`, `isLocale`, CHECK constraints on lengths, email shape, URL scheme and month 1–12 (A2-A).
- Display name: trimmed, 1–200 characters (same as `SignUpRequest.name`).
- Password: 12–128 characters (`Password` contract), current password required, all other sessions revoked on change
  (recommended, matching the existing `revokeSessionsOnPasswordReset`).
- Invitations: lower-cased email, rank rules, one open invitation per address (A2-B), resend throttle 60 s.

### 10.3 Error and empty states

Every Settings page handles: loading, permission denied (403 shows "You don't have access to this setting", not a
blank page), stale (409), conflict codes from A2 (`last_owner`, `already_member`, `invitation_exists`,
`invitation_closed`, `member_not_active`, `already_owner`), rate limit (429 with retry time), offline and session
ended (existing `problem.tsx` states), and an empty state that only appears when the backend exists.

## 11. Defaults and migration needs

### 11.1 Defaults (current behaviour, unchanged by A3)

| Setting | Default today | Set by |
|---|---|---|
| Country, time zone, locale, currency | Chosen at business creation (`create_business`) | onboarding |
| Financial year start | `null` (not set) | A2-A |
| Finance retention | 7 years, legal hold off | Finance defaults |
| Theme | System | device |
| Sidebar | Expanded | device |
| Personal locale and time zone | `null` (unused) | — |
| Invitation expiry | 7 days (D-A2-13) | tenancy |
| Session lifetime | 30 days, refreshed daily | identity |

### 11.2 Migration needs by stage

| Stage | Schema change | Notes |
|---|---|---|
| A3-A | **None expected.** Session and profile endpoints use existing tables through `bos_auth`, or definer functions if a `bos_app` read is needed (privileged SQL, reviewed) | An identity audit home may need a table (§12, D-A3-12). If so, A3-A gains a migration |
| A3-B | Possibly a `bos_app` column grant on `users.locale`/`time_zone`, or a definer function (D-A3-5) | Privileged SQL, not Prisma, if a function |
| A3-C | None (audit viewer API is A2-E's) | |
| A3-D | Archive needs a definer function and a decision on unarchive. Data export needs job tables (if decided) | Each one separate and reviewed |

Any migration must sort after every stamp on `main` **and** in open PRs. Today that is `20261205000000` (A2-B, #76).
The stamp is chosen at PR time and checked with `pnpm db:check-migrations` and against production
`_prisma_migrations` (read-only) before any approval request. No backfill is needed, since production has no
businesses yet.

## 12. Audit and security constraints

1. **Every settings write is audited by its owner module** with the acting user. Tenant writes use `recordAudit`
   (RLS requires the session user as actor). Audit metadata carries field **names**, plus old and new values only for
   codes (regional settings, roles, statuses). Never free text, emails, tokens, passwords or content (E1 rule).
2. **Identity events have no tenant.** Password change, session revocation and name change are not business events,
   and `audit_events` is tenant-scoped under RLS. Options: (a) a new platform-level `identity_events` table written by
   `bos_auth` (append-only, like `beta_admission_events`), (b) write nothing beyond Better Auth's own rows. Recommend
   (a), small and append-only (D-A3-12).
3. **Re-check authority inside the transaction** (A2 requirement 5, `lockActor`) for every business setting
   mutation. This already holds for A2-A and A2-B. New Settings APIs follow it.
4. **No new route bypasses admission except one.** Account endpoints use `publicRoute` (admission checked). The
   only proposed exception is `POST /me/sessions/revoke-all` (§15.2), listed next to the existing `/me` and
   invitation-redemption exceptions in `docs/private-beta-lockdown.md` §2. This is an admission-policy change and
   needs Regan's review (D-A3-7).
5. **Settings never weakens admission or platform roles.** Tenant OWNER and ADMIN never see or change admission,
   business-creation grants or operator status (private-beta-lockdown §4).
6. **Member emails** only through `member_emails()` and only for `members:invite` holders (D-A2-11). The Settings UI
   must not cache them outside the current business context.
7. **Mailbox credentials** are cut off eagerly on removal, suspension, demotion and leave (A2-B §13.3). Settings copy
   must say so and must not offer "keep mailbox connected".
8. **Sessions UI shows no token or token hash**, and nothing that would let one session impersonate another.
   "Current session" is detected server-side.
9. **Rate limits:** password change and session revocation get explicit Better Auth custom rules (today only
   sign-in, sign-up, reset and verification have them).
10. **CSRF:** account writes go through the existing `/api/v1/auth` CSRF policy (exact Origin for cookies, signed
    bearer for desktop) or through `/api/v1` route wrappers with the same rules. No new origin is allowed.
11. **Client gating is cosmetic.** Every hidden section's API still answers 403 for a caller without the key. A3
    tests prove it per section (§17).

## 13. Ownership boundaries and conflicts

| # | Conflict or boundary | Resolution proposed |
|---|---|---|
| C1 | **A2-D already plans the Settings UI** (profile, members, invitations, roles) | A2-D **is** the first Settings stage. A3 does not duplicate it. A3 gives A2-D the IA (§6) and the shell rules. A3-A onward cover what A2-D does not |
| C2 | Finance has its own **Settings child** (`/finance/settings`) | Keep it. The Settings hub links to it (D-A3-2). No Finance form is re-hosted |
| C3 | Registration and tax identifiers live in Finance (D-A2-2) but users look for them in the business profile | Show them read-only in General with "Edit in Finance settings" for `finance:manage` holders |
| C4 | The theme is device-local; `docs/ui/app-shell.md` lists "storing the theme in account settings" as future | Keep device-local in v1 (D-A3-5) |
| C5 | Notification preferences: N1 owns the model; A3 owns the placement | Two reserved places (Account › Notifications, Business › Notifications). No UI until N1's backend exists |
| C6 | Platform operator console (private-beta-lockdown §4) vs tenant Settings | Keep it **outside** tenant Settings: separate `/platform` area, `platformOperatorRoute`, never under `/b/:slug`. A3 does not design it |
| C7 | Account settings need a shell route **without a business**; the V2-C shell work is owned by UI V2 | Interface proposal only: A3 asks V2-C for a business-less route and account-menu entries. Sequencing: A3-A UI after V2-C, or a minimal route before it if Regan prefers (D-A3-3) |
| C8 | Scheduling is not in navigation until its V2-C readiness check (D-V2A-8) | The Scheduling card in Zone settings stays hidden until then. Settings must not describe Scheduling as reachable |
| C9 | Communications has APIs but no UI; E1 is dormant | The Integrations and Data & privacy pages link to C2 or E1 screens when those exist. Until then those cards are left out (principle 4) |
| C10 | F8 bank connections | Placement under Integrations is reserved. F8 owns everything else |
| C11 | Removal clears assignments (existing behaviour) | Settings recommends suspension first in the removal dialog. No behaviour change |
| C12 | Pixa subscription "billing" vs Finance F6 `finance:billing` (the business's own recurring invoices) | Naming: Settings says "Plan & billing" for Pixa. Finance keeps "Recurring invoices" and "Reminders". The new authority must **not** reuse `finance:billing` (D-A3-10) |
| C13 | `docs/administration-a2.md` is edited by A2-B (#76) | A3 does not edit it. Cross-references only |
| C14 | Agent context pack (#78) snapshot lists P3-A as open | Informational. The refresh belongs to whoever refreshes `active-workstreams.md` |
| C15 | Business deletion vs Finance retention ("Finance records are never deleted") and open E1 legal decisions | No self-service permanent deletion. Archive only (D-A3-8) |

## 14. Owner decisions

**Owner decisions recorded 2026-11-16:** D-A3-1 through D-A3-17 are approved as recommended below, with the conditions in §§15–16. D-A3-7 authorises the separate A3-0 security implementation PR for independent review; it does **not** authorise merging auth code. D-A3-17(a) is a hard release gate: transfer step-up must be implemented and tested before any wider/external beta. Business archive/deletion remains deferred pending its dedicated security and legal gates.

**Decision register (approved choices):** D-A3-1(a), D-A3-2(a), D-A3-3(a), D-A3-4(a now / c later for read-only logo), D-A3-5(a), D-A3-6(a), D-A3-7(a), D-A3-8(a conditional), D-A3-9(a), D-A3-10(c), D-A3-11(b), D-A3-12(a), D-A3-13(a), D-A3-14(a), D-A3-15(a), D-A3-16(a), D-A3-17(a with mandatory before-wider-beta implementation gate).

The table preserves the original recommendations and round-one audit rationale for traceability. "Flag" marks the decisions the brief asked to bring for review: account deletion,
ownership transfer, invitations and sensitive settings. The **Audit R1** column records the ChatGPT round 1
position, which Regan posted on PR #81. It is a reviewer's input, not Regan's decision.

| ID | Decision | Options | Recommendation | Audit R1 |
|---|---|---|---|---|
| D-A3-1 | Settings structure | (a) one Settings with Account and Business scopes; (b) separate "My account" and "Business settings" destinations | **(a)**, with two account-menu entries that open each scope | (a) |
| D-A3-2 | Zone-owned configuration | (a) a hub with links, with forms staying in Zones; (b) move all configuration into Settings | **(a).** One owner per setting, no duplicated forms or permission logic | (a) |
| D-A3-3 | Sequencing against V2 | (a) A2-D and the A3 UI wait for V2-B1/B3 and V2-C; (b) build on current components now and migrate later | **(a)** for the UI. The A3-0 security preflight does **not** wait for V2 (§15.1) | (a), with the security preflight independent of V2 |
| D-A3-4 | Avatar and business logo | (a) defer both; (b) avatars now (needs storage); (c) reuse the Finance branding logo as the app logo | **(a)** for avatars; **(c)** later for the logo, read-only in General | Defer avatars; reuse the Finance logo read-only later |
| D-A3-5 | Personal preferences | (a) theme stays device-local, with no personal locale or time zone in v1; (b) store theme, locale and time zone on the account now | **(a).** A personal time zone raises "whose today" questions for business dates. Revisit when a Zone needs it | (a) |
| D-A3-6 | Email-address change (**flag**) | (a) defer; (b) build it with verification of the new address and a notice to the old one | **(a)** in the private beta. Invitations, member emails and password reset all key on email | (a) |
| D-A3-7 | Better Auth built-in endpoints and pre-admission access (**flag, security**) | (a) allow-list the auth catch-all, with a tested method and path matrix, as an independent first PR; (b) leave Better Auth's defaults reachable | **(a)**, as A3-0 (§15.1). The pre-admission account actions are fixed in §15.2 | (a), **security priority** |
| D-A3-8 | Business archive and deletion (**flag**) | (a) OWNER archive with typed confirmation and step-up, operator-only unarchive, no self-service delete; (b) also allow OWNER unarchive; (c) self-service delete | **(a), conditional** on the archive semantics in §15.5 being accepted. The build is deferred to A3-D after a dedicated security review | (a), conditional |
| D-A3-9 | Personal account deletion (**flag**) | (a) operator-handled requests in the beta, under the process in §15.6; (b) self-service now | **(a)** | (a) |
| D-A3-10 | Pixa subscription billing authority | (a) OWNER only, through a role rule like `canAttestBusinessMailbox`; (b) a new dedicated key (for example `platform_billing:manage`) granted to OWNER; (c) defer entirely | **(c)** now. Design a dedicated permission, never `finance:billing`, before any billing work | (c) now; dedicated permission before billing |
| D-A3-11 | Step-up re-authentication (**flag, sensitive settings**) | (a) none; (b) server-verified password re-entry, bound to the session, for archive, revoke-other-sessions and account-deletion requests (§15.3) | **(b)**, built in A3-A (the mechanism) and used by A3-D | (b), with a separate transfer decision (D-A3-17) |
| D-A3-12 | Identity audit | (a) a new platform-level append-only `identity_events`, designed in §15.4; (b) no Pixa audit for account changes | **(a)** | (a) |
| D-A3-13 | Business data export | (a) defer to its own design; (b) basic CSV per Zone now | **(a).** It needs jobs, storage and email, which are off today | (a) |
| D-A3-14 | Who may open Business settings | (a) `business:read` (all roles, read-only for most, as in A2 §5); (b) `business:manage` only | **(a).** Read-only views show only what the viewer's keys return (§15.8) | (a) |
| D-A3-15 | Invitations in Settings (**flag**) | (a) Invitations is a Team tab for `members:invite` holders, with rank-filtered role choices and `delivery: failed` leading to Resend; (b) a separate top-level page | **(a).** No change to the A2 rules (D-A2-5 to 7, 13) | (a) |
| D-A3-16 | Ownership transfer UI (**flag**) | (a) the Ownership & lifecycle danger area, with typed business name, explaining step-down and the last-owner rule; (b) an action in the member row | **(a)**, with the member row linking to it | (a) |
| D-A3-17 | Step-up for ownership transfer (**flag, new in revision 2**) | (a) keep D-A2-8 (no step-up in v1) for the private beta, and require step-up before the beta widens beyond invited operators' own businesses; (b) require step-up from the first A2-D release; (c) never | **(a).** A2-B already re-checks actor and target authority under lock at commit. Typed confirmation is **not** step-up, and the doc no longer calls it that. The gate is recorded in §16 as "before wider beta". Option (b) would change the build order, because A2-D's transfer UI ships before A3-A's step-up | Re-audit: (a), with a **hard gate**: transfer step-up implemented and tested before any wider or externally recruited beta |

## 15. Security gates and lifecycle designs (audit round 1)

These sections answer the nine required amendments from audit round 1. They are **binding gates** for the stages
in §16: a stage may not start while a gate it depends on is open.

### 15.1 A3-0 security preflight: auth path allow-list (amendment 1)

**Verified (code reading, base `b2f308b`):** `handleAuthRequest` (`modules/identity/server/handler.ts`) classifies a
request for CSRF only. That means safe methods pass, a bearer token must verify, and cookie requests need the exact
app Origin. It then forwards **every** method and path under `/api/v1/auth/*` to `getAuth().handler`.
`apps/api/src/app/api/v1/auth/desktop/{authorize,token}` are separate Next routes and are not part of the catch-all.
**Not verified:** which Better Auth 1.7.22 endpoints actually answer.

A3-0 is a small, independent security PR. It is **not** bundled with any UI, and it has no dependency on V2, A2-C or
A2-D. Its scope:

1. **Enumerate.** Build an inventory of every method and path pair the pinned Better Auth version registers. Take it
   from the installed package's endpoint registry, not from documentation, and check it in as a test fixture. A
   version bump that changes the inventory fails the test.
2. **Allow-list.** Add an explicit `(method, path)` allow-list in `handleAuthRequest`, checked before CSRF
   classification and before forwarding. Candidate entries, from the client, the tests and the emailed links, to be
   confirmed by step 1:
   - `POST sign-up/email`
   - `POST sign-in/email`
   - `POST sign-out`
   - `POST request-password-reset`
   - `GET reset-password/:token` (the emailed link)
   - `POST reset-password`
   - `GET verify-email` (the emailed link)
   - `POST send-verification-email`
   - any session read the server itself uses (none found in the client)

   Account endpoints that A3-A later adopts are added **in A3-A**, each with its own tests, never pre-emptively.
3. **Rejected paths.** Anything not on the list gets `404` JSON `{ error: "not_found" }` with `Cache-Control:
   no-store`. The body is identical for every rejected path, the request never reaches Better Auth, and the result
   is logged as a counter without the path's query string.
4. **CSRF and bearer.** Tests cover the existing rules (exact Origin for cookie requests, a verified signed bearer
   for desktop, cookies stripped on bearer requests) on every allowed path, and confirm that an allowed path with a
   bad Origin or an invalid bearer is still refused.
5. **Backwards compatibility.** The whole existing suite keeps passing: sign-up through an invitation, sign-in,
   sign-out, verification and resend, reset request and completion, invitation redemption, desktop authorize and
   token exchange, and the admission hooks. The PR lists each of these flows and the test that proves it.
6. **Probes.** A regression test calls a representative set of non-allowed built-ins, at least `update-user`,
   `change-password`, `change-email`, `delete-user`, `list-sessions`, `revoke-session`, `revoke-sessions`,
   `revoke-other-sessions`, `set-password` and `link-social` (whichever exist in the inventory), plus an unknown
  path. Each is tried with a cookie and
   with a bearer token, and must get `404` with no database write.

There is no migration, no admission change and no contract change. Merging still needs Regan's approval (it changes
authentication behaviour, a protected surface).

### 15.2 Admission and account access (amendment 2)

Three access levels apply to account routes. None of them ever grants business access or creation rights.

| Action | Signed in, **not admitted** | Admitted, **no business** | Admitted member | Mechanism |
|---|---|---|---|---|
| Read own identity (`GET /me`) | ✔ (exists) | ✔ | ✔ | existing exception |
| Redeem an invitation | ✔ (exists) | ✔ | ✔ | existing `invitationRedemption` flag |
| Sign out (this session) | ✔ | ✔ | ✔ | Better Auth `sign-out` (allow-listed) |
| Password reset by email | ✔ (signed out) | ✔ | ✔ | Better Auth (allow-listed) |
| Change password | — | ✔ | ✔ | A3-A route under `publicRoute` (admission required) |
| List and revoke own sessions | **revoke-all only** (see below) | ✔ | ✔ | A3-A route under `publicRoute`; one narrow exception |
| Edit display name | — | ✔ | ✔ | A3-A, `publicRoute` |
| Everything under `/b/:slug` | — | — | by role | unchanged |
| Create a business | — | only with the grant | only with the grant | unchanged (#71) |

- The **only new pre-admission exception** proposed is `POST /me/sessions/revoke-all`. It lets a person whose
  admission was revoked, or who was never admitted, end every session on their identity, for example after a stolen
  password. It returns nothing about businesses. It is declared with a dedicated route flag, like
  `invitationRedemption`, listed in `docs/private-beta-lockdown.md` §2, and needs Regan's approval as an
  admission-policy change.
- Account routes have **no slug and no tenant context**. They must never call `resolveTenant`, set
  `app.business_id`, read `ROLE_PERMISSIONS`, or accept a business id from the client. A source rule and a test
  enforce this: account route modules may not import `modules/tenancy` or `modules/access`.
- An admission failure returns the existing 403 `invite_required`. It never falls through to a weaker check.

### 15.3 Sessions and step-up (amendment 3)

- **Opaque ids.** The list returns `sessions.id` (a random UUID), never the token or its hash. It also returns
  `createdAt`, `lastRefreshedAt` (the session's `updated_at`), `expiresAt`, a client kind (`browser` or `desktop`)
  and `current: true` for the caller's session, decided on the server from the verified token. The `sessions` table
  already has `ip_address` and `user_agent` columns. A3-A checks whether they are populated and either derives the
  client kind from them or adds a nullable `client_kind` column stamped at creation. Showing an IP address or device
  string is a privacy decision.
- **Current-session protection.** `DELETE /me/sessions/{id}` refuses the caller's own session (409
  `use_sign_out`). Signing out stays the way to end the current session, so a stray click can't lock someone out
  mid-action.
- **Revoke others** ends every session for the user except the caller's, in one statement inside one transaction.
  It either deletes the rows or sets `revoked_at`. `revoked_at` exists and is readable by the definer functions, and
  A3-A must confirm that **every** per-request check (Better Auth's session lookup and `app_private` session
  resolution) honours it before relying on it. Otherwise it deletes the rows. There is no cookie cache (`cookieCache: { enabled: false }`) and every route checks the session in the
  database, so revoked sessions fail on their **next request**, browser and desktop alike. The desktop's signed
  bearer wraps a session token, so ending the row is enough. A test proves both clients.
- **Step-up (D-A3-11).** `POST /me/reauthenticate { password }` verifies the password on the server through Better
  Auth's password verification. It then stamps `sessions.reauthenticated_at = now()` on the **caller's session row**
  (another A3-A column). Sensitive actions require `reauthenticated_at > now() - 10 minutes` on the same session, read
  in the same transaction. The client never sends a timestamp, and the proof cannot move to another session. Failed
  attempts are rate-limited with the sign-in rule (5 per minute) and audited (§15.4).
- **Stolen-session scenario.** A thief holding a session cannot change the password (that needs the current
  password) or pass step-up. They can see the session list. Revoke-others from the real owner's session ends theirs.
  A password reset also revokes all sessions (existing behaviour). Changing the password revokes all other sessions
  (A3-A).
- **Limits.** Session list: at most 50 rows. Revoke actions: rate-limited (10 per hour per user).

### 15.4 Identity audit (amendment 4)

- **Table:** `app_private.identity_events` is append-only, with an immutability trigger like `beta_admission_events`.
  Columns: `id`, `user_id`, `actor_kind` (`self`, `operator` or `system`), `actor_session_id` (nullable, the opaque
  id), `operator` (nullable text), `event`, `metadata jsonb` (allow-listed keys per event), `created_at`.
- **Grants:** no SELECT for any runtime role. Inserts go only through a `SECURITY DEFINER` function, executable by
  `bos_auth` and `bos_app`, that validates the event name and the metadata keys. Reading is operator-only, as
  admission history is today. A later user-facing "recent security activity" view would use a definer function that
  returns only the caller's own rows.
- **Events:** `password.changed`, `password.change_failed` (counted, with no password data), `password.reset`,
  `session.revoked` (target opaque id), `sessions.revoked_others` (count), `sessions.revoked_all`,
  `reauth.succeeded`, `reauth.failed`, `profile.name_changed` (field name only, no values),
  `account.deletion_requested`, `account.deletion_completed` (operator). Sign-in failures stay in Better Auth's rate
  limiter and are **not** copied, to keep volume and personal data low (open to Regan).
- **Never stored:** passwords, tokens, token hashes, bearer values, emails, names, IP addresses or user agents
  (unless separately decided), and request bodies.
- **Failure behaviour:** for password change, revoke-others, revoke-all, re-auth success and deletion requests, the
  audit insert runs **in the same transaction** as the change. If it fails, the change rolls back (fail closed).
  Failed-attempt events are written best effort, so an audit outage can never turn into an account lockout.
- **Migration:** A3-A (with the session column or columns from §15.3). The privileged function goes in a new privileged
  file. The stamp must sort after every stamp on `main` and in open PRs.

### 15.5 Business archive semantics (amendment 5)

Hiding a business from `my_memberships` is **not** the same as revoking authority, so archive is defined by its
effects. All of them happen in one transaction, in this order:

1. Lock the actor's membership `FOR SHARE` and re-check that it is an ACTIVE OWNER. Take the per-business owner
   advisory lock (the same one A2-B uses) so that archive serialises with transfer, step-down and removal. Require a
   fresh step-up (§15.3) and the typed business name.
2. Set `businesses.archived_at` and `archived_by` through a reviewed definer function (`bos_app` has no UPDATE grant
   on it and gets none).
3. **Access:** every tenant route already resolves through `my_memberships`, which excludes archived businesses, so
   access ends on the next request for all members. Sessions are **not** revoked, because members may belong to
   other businesses.
4. **Invitations:** open invitations are revoked (marked, history kept). Acceptance already refuses archived
   businesses (#71).
5. **Mailboxes:** every ACTIVE mail connection moves to NEEDS_REAUTH through the existing C2 path, which deletes
   token ciphertext and cancels queued and running sync jobs. This is audited under the archiving owner.
6. **Background jobs:** F6 billing and reminders and E1 jobs are off today. Before any of them is enabled, each job
   must skip archived businesses at claim time. That is a **gate on enabling those jobs**, recorded here.
7. **Billing and third parties:** no Pixa billing exists. When it does, archive must state its effect on the
   subscription (D-A3-10). Future F8 bank connections must be revoked like mailboxes.
8. **Memberships and data:** kept unchanged. Nothing is deleted. Finance records are kept per the Finance retention
   policy, and Communications per E1.
9. **Audit:** `business.archived` is recorded in the tenant audit log by the owner, inside the same transaction.

**Recovery:** in the beta, only an operator can unarchive, through a definer function with an operator name and
reason, audited. Unarchive restores access but **not** mailbox credentials or revoked invitations; those need
reconnecting and re-inviting. There is **no delete path**; permanent removal is out of scope (C15).

### 15.6 Account deletion process (amendment 6)

In the beta this is an **operator-handled request**, not self-service.

1. **Request:** the signed-in, admitted user passes step-up (§15.3) and submits a request. This is recorded as
   `account.deletion_requested`. The user sees what will and will not be removed.
2. **Pre-checks (operator, read-only):** the user is not the last ACTIVE OWNER of any unarchived business (they must
   transfer or archive first); they hold no connected mailbox; no E1 legal hold names them; no unresolved Finance
   obligation refers to them as a user. That last check is narrow, since customers are not users.
3. **Execution (operator, separate approval):**
   - end their memberships through the A2 removal path, so assignments are cleared and mailboxes cut off;
   - revoke all sessions;
   - deactivate the identity (`users.deactivated_at`), so sign-in and admission fail;
   - replace the name with "Former user" and the email with a unique non-routable placeholder;
   - log `account.deletion_completed` with the operator and reason.
4. **What remains, and why:** audit events and authored business records keep the user **id**. Finance records and
   documents that sealed a name keep it, because they are financial records under retention. The admission ledger
   keeps the id. Communications content follows E1. The confirmation tells the person this, so the product never
   promises irreversible erasure of records that must be retained.
5. **Evidence:** the request, the pre-check results and the execution are recorded in `identity_events`. Nothing
   personal goes into chat or docs.

Self-service deletion is out of scope until legal review (the E1 §13 decisions) settles retention for identities.

### 15.7 Ownership transfer (amendment 7)

- Placement stays the Ownership & lifecycle danger area (D-A3-16). Typed confirmation is **intent confirmation,
  not step-up**, and the doc no longer treats it as authentication.
- **Authority at commit (verified in A2-B as built, PR #76 §13.2):** the service locks the actor `FOR SHARE` and the
  target `FOR UPDATE`, re-reads both roles after the locks, requires an ACTIVE OWNER actor and an ACTIVE non-owner
  target, and the deferred last-owner trigger holds the per-business advisory lock. A3 adds no change. A2-D's UI must
  surface `member_not_active`, `already_owner` and `last_owner`.
- **Step-up:** decision D-A3-17. Once the A3-A step-up mechanism exists, adding it to transfer is a small, additive
  change: the route checks `reauthenticated_at`.

### 15.8 Cross-workstream boundaries (amendment 8)

- **A2-D is Settings stage 1**, not a parallel Settings UI. Any A3 screen is added to the same registry entry.
- **V2-C interface:** A3 needs one shell capability from V2-C, a route with no slug for Account settings (C7). This
  is a written interface request to the V2 owner. A3-A's UI waits for it.
- **Hidden until gated:** Integrations (C2 UI), Data & privacy cards (E1 activation), bank connections (F8),
  notifications (N1) and Scheduling cards (D-V2A-8 readiness) are **not registered** until their backend, permission
  and readiness gates are met. "Coming soon" placeholders are not allowed (principle 4).
- **No leakage in read-only views:** a read-only screen renders only fields the API returned for the viewer's keys.
  Specifically: member emails only from `member_emails()` for `members:invite` holders, never derived elsewhere;
  invitations never shown to MEMBER; Finance identifiers only for `finance:read`; audit rows only for `audit:read`.
  The client never requests a field "just in case" and hides it in the UI.

### 15.9 Implementation gates from the revision 2 re-audit

The re-audit of revision 2 (conditional pass, docs only) set five gates. Each stage carries them forward:

1. **A3-0** inventories the **installed** Better Auth 1.7.22 method and path pairs, not documentation. It rejects
   unsupported routes **before** forwarding, and tests path normalisation, trailing slashes, percent-encoding and
   query strings. It keeps the desktop `authorize` and `token` routes, which sit outside the catch-all, working.
   Verification and reset links are tested end to end. Admission stays a separate check from the allow-list, and
   every rejected path is proven to have no side effect.
2. **Step-up (A3-A)** is stored on the server, per session. For each high-risk action the design states how the
   proof is validated, whether it is consumed or reusable within its window, and what happens when two actions race
   on one proof. Password change and session revocation are verified against both Better Auth's session lookup and
   desktop bearer resolution. The source rule from §15.2 stops account routes importing tenant authority.
3. **Archive (A3-D)** must not commit an archived state while credentials are still usable. Before building it,
   A3-D confirms that the Communications revocation path (`revokeHeldConnections` and the NEEDS_REAUTH status
   trigger, as built in A2-B #76) runs inside the archive transaction and stops **both** queued and running jobs.
   If it can't, the archive is redesigned, for example as a preflight that revokes first and then archives under
   the same owner lock.
4. **Account deletion** is described as deactivation plus pseudonymisation, never as irreversible erasure. Each
   operator execution is separately authorised and audited, and legal and retention review stays a precondition.
5. **D-A3-17** is a release gate, not just a paper decision: transfer step-up is **implemented and tested** before
   a wider beta. Authority is checked at commit (already true in A2-B).

## 16. Staged plan

Revised to the gate order from audit round 1. Each stage gets its own thread, branch and draft PR, audited before
merge. No production step happens without separate approval.

| Order | Stage | Scope | Gate to start | Migration | Status label |
|---|---|---|---|---|---|
| 1 | **A3-0 Security preflight** | Auth path inventory, allow-list, rejected-path behaviour, CSRF and bearer tests, probe tests, compatibility proof (§15.1) | D-A3-7 | no | Requires implementation |
| 2 | **A2-B** | Membership lifecycle (PR #76) | its own audit | `20261205000000` | Dependent: A2-B |
| 3 | **A2-C** and **V2 foundations** | Roles read API and matrix tests; V2-B1/B3, then V2-C including the no-slug account route | A2-B; Regan's V2-B go-ahead | no | Dependent: A2-C, V2 |
| 4 | **A2-D = Settings stage 1** | Settings Zone `built`; Business › General, Team (Members, Invitations, Roles & access), Ownership (transfer, step-down, leave); confirmations per §10; Zone settings hub cards | A2-A to A2-C, V2-C, A3-0 merged | no | Requires implementation (UI) |
| 5 | **A3-A Account** | Account routes (§15.2), name edit, password change, sessions with opaque ids (§15.3), step-up mechanism, identity audit (§15.4), Account UI on the no-slug route | A3-0 merged; D-A3-11, D-A3-12; V2-C route | yes (session columns, `identity_events`, privileged function) | Requires implementation |
| 6 | **A2-E + A3-C** | Audit viewer API and security suite (A2-E), then the Audit log UI (A3-C) | A2-D | no | Dependent: A2-E |
| 7 | **A3-B** | Integrations and Data & privacy pages, each card registered only when its gate passes (§15.8) | C2 UI, E1 activation, N1, F8 | possibly | Dependent: C2, E1, N1, F8 |
| 8 | **A3-D Lifecycle (deferred)** | Archive (§15.5) and the account-deletion request flow (§15.6). Data export only after D-A3-13 | **dedicated implementation security review**; D-A3-8, D-A3-9; legal review for deletion; A3-A step-up | yes (definer functions, `archived_by`) | Requires implementation |
| — | **Before wider beta (hard gate)** | Transfer step-up implemented and tested on top of the A3-A mechanism (D-A3-17, §15.9 gate 5) | A3-A merged | no | Gate |
| — | Later, separate | Pixa plan and billing (D-A3-10), email change (D-A3-6), notification preferences (N1) | own workstreams | — | Deferred |

Model guidance from the A2 pattern: Opus for A3-0, A3-A and A3-D (security and lifecycle). Sonnet for UI-only
stages unless Regan says otherwise.

## 17. Test strategy

- **Allow-list matrix (A3-0):** every inventoried Better Auth `(method, path)` pair has an expected outcome (allowed
  or 404). Probes of non-allowed built-ins use a cookie and a bearer token, with no database write. CSRF and bearer
  rules hold on every allowed path. The inventory fixture fails on a Better Auth version change. Existing auth,
  verification, reset, invitation and desktop flows all pass unchanged.
- **Permission matrix per section:** for each of OWNER, ADMIN, MANAGER and MEMBER, plus a not-admitted user and an
  admitted user with no business for Account, the section is visible or hidden as §8 and §15.2 say, **and** the API
  answers 403 or 404 when hidden. The existing `ROLE_PERMISSIONS` unit test stays the single source.
- **Cross-business and unauthorised access:** switching businesses never shows the previous business's members,
  emails or audit rows. Ids from another business answer 404. Account routes reject a client-supplied business id
  and import no tenant modules (source rule).
- **Sessions:** list shows opaque ids only. The current session can't be revoked by id. Revoke-others is atomic and
  ends other browser and desktop sessions on their next request. Revoke-all works pre-admission and leaks nothing.
  Step-up proof is bound to the session and expires after 10 minutes. A client-sent timestamp is ignored.
- **Races (two connections):** archive against transfer, step-down, removal and role change. Exactly one order
  commits, and no business ends without an active owner or with an archived-but-mailbox-active state.
- **Audit redaction:** tenant and identity events contain no secrets, tokens, emails, names or free text beyond the
  allow-listed metadata. High-risk changes roll back when the audit insert fails.
- **Identity-event privileges:** runtime roles cannot SELECT, UPDATE or DELETE `identity_events`. The insert
  function rejects unknown events and metadata keys.
- **Navigation:** registry and palette show the same Settings children (V2-A §8.2), rebuilt on business switch and
  role change. Gated cards (C2, E1, F8, N1, Scheduling) are absent until their gates pass.
- **Visual:** light and dark, 390 px and the 900 × 600 Tauri minimum, with the V2-B harness once it exists.

## 18. Handoff

```text
TASK / BRANCH / BASE SHA: A3 Settings architecture / claude/project-thread-m3veky / b2f308b
CHANGED FILES: docs/settings-a3-architecture.md (new). No other file.
REVISION: 2 + re-audit gates (§15.9). Round 1 amendments 1–9 in §15; re-audit of revision 2: conditional pass
VERIFIED REPO FACTS: §2 and §4 (A2-A and #71 merged; A2-B draft #76 re-stamped 20261205000000; V2-A merged;
  audit:read and business:delete unused; users.locale/time_zone unused; auth catch-all has no path allow-list)
DECISIONS / RECOMMENDATIONS: D-A3-1..17 (§14), owner-approved 2026-11-16 with staged gates; audit R1 positions recorded beside each
DEPENDENCIES / POTENTIAL CONFLICTS: §13, §15.8 (A2-D is Settings stage 1; V2-C no-slug route; C2, E1, F8, N1, Scheduling gated)
TESTS RUN / RESULTS: none (docs only)
MIGRATIONS / PROD ACTIONS: none
KNOWN LIMITATIONS: Better Auth endpoint reachability inferred from code, not exercised; A3-0 closes it
NEXT ACTION / FILES TO READ: Regan's decisions on §14 (D-A3-7 first); then an A3-0 thread reads §15.1–15.2
```
