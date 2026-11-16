# Settings A3: architecture for the Pixa OS Settings experience

Status: **Proposal, documentation only.** Nothing here is implemented, and nothing here changes code, the schema, RLS,
grants, admission, secrets, migrations or production. Owner decisions D-A3-1 to D-A3-16 (§14) are **pending**.

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
15. Staged plan
16. Test strategy
17. Handoff

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
  docs-only task (§9, G-A3-2).

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
| Account menu › **Account settings** | Settings › Account | Every signed-in user, including users with no business and not-yet-admitted users (Profile and Sign-in & security only, see §8) |
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
  not-yet-admitted user (who may see Profile and Sign-in & security only). That needs a shell route that does not
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
| Account › Profile, Sign-in & security | Self | Self | Self | Self | Self (needed to fix a password or sign out a device) |
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
| G-A3-2 | **Better Auth built-in account endpoints are probably reachable through `/api/v1/auth/[...all]`** (no path allow-list in `handleAuthRequest`), but none is in contracts, client or tests. They write through `bos_auth` without a Pixa audit event and have no custom rate-limit rule | identity | A3-A preflight enumerates the mounted Better Auth 1.7.22 paths and tests them under the CSRF and bearer rules. Then **either** wrap the ones adopted (change-password, update-user name, list and revoke sessions) in explicit contracts with audit and rate limits, **or** block the unadopted paths with an allow-list. Recommend the allow-list in all cases (D-A3-7) | A3-A (security first) |
| G-A3-3 | No session list or revoke contract; desktop sessions need a readable label | identity | `GET /api/v1/me/sessions` (id, created, last refreshed, client kind from the issuing path, current flag; never the token), `DELETE /me/sessions/{id}`, `POST /me/sessions/revoke-others`. No IP or user-agent storage unless decided (privacy) | A3-A |
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
4. **No new route bypasses admission.** Account endpoints use `publicRoute` (admission checked) except those needed by
   not-yet-admitted users. Those are limited to sign-out, password change and session revocation, and must be
   listed explicitly next to the existing `/me` and invitation-redemption exceptions in
   `docs/private-beta-lockdown.md` §2. This is an admission-policy change and needs Regan's review (D-A3-7).
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
    tests prove it per section (§16).

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

All pending. "Flag" marks the decisions the brief asked to bring for review (account deletion, ownership transfer,
invitations, sensitive settings).

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D-A3-1 | Settings structure | (a) one Settings with Account and Business scopes; (b) separate "My account" and "Business settings" destinations | **(a)**, with two account-menu entries that open each scope |
| D-A3-2 | Zone-owned configuration | (a) hub with links, forms stay in Zones; (b) move all configuration into Settings | **(a).** Single owner per setting, no duplicated forms or permission logic |
| D-A3-3 | Sequencing against V2 | (a) A2-D and A3 UI wait for V2-B1/B3 and V2-C; (b) build on current components now and migrate later | **(a)** for A3 UI. A2-D follows whatever Regan decides for V2-B timing. Backend parts of A3-A (G-A3-2 to 4) can start before V2 |
| D-A3-4 | Avatar and business logo | (a) defer both; (b) avatars now (needs storage); (c) reuse the Finance branding logo as the app logo | **(a)** for avatars; **(c)** later for the logo, read-only in General |
| D-A3-5 | Personal preferences | (a) theme stays device-local; no personal locale or time zone in v1; (b) store theme, locale and time zone on the account now | **(a).** A personal time zone raises "whose today" questions for business dates. Revisit when a Zone needs it |
| D-A3-6 | Email-address change (**flag**) | (a) defer; (b) build with verification of the new address and notice to the old one | **(a)** in the private beta. Invitations, member emails and reset all key on email |
| D-A3-7 | Better Auth built-in endpoints and pre-admission access (**flag, security**) | (a) allow-list the auth catch-all to the paths in use plus the adopted account paths, each tested; (b) leave Better Auth's defaults reachable | **(a).** Also explicitly list which account actions a not-yet-admitted user may take (sign-out, password change, session revoke) as an admission-policy addendum |
| D-A3-8 | Business archive and deletion (**flag**) | (a) OWNER archive with typed confirmation, operator-only unarchive, no self-service delete; (b) also allow OWNER unarchive; (c) self-service delete | **(a).** Deletion conflicts with Finance retention and open E1 legal decisions |
| D-A3-9 | Personal account deletion (**flag**) | (a) operator-handled requests in beta, defined rules (G-A3-11); (b) self-service now | **(a).** Self-service later, refused while the person is a last owner |
| D-A3-10 | Pixa subscription billing authority | (a) OWNER only, through a role rule like `canAttestBusinessMailbox`; (b) a new key `platform_billing:manage` granted to OWNER (ADMIN read?); (c) defer entirely | **(c)** now, with **(b)** as the design when billing starts. A key keeps future custom roles possible. Never reuse `finance:billing` |
| D-A3-11 | Step-up re-authentication (**flag, sensitive settings**) | (a) none (A2 v1 decision stands); (b) password re-entry within the last 10 minutes for archive, revoke-all-sessions and account deletion; (c) extend (b) to ownership transfer | **(b)** when those actions are built, and **(c)** as a follow-up review of the A2 transfer decision (D-A2-8). No change to A2-B now |
| D-A3-12 | Identity audit | (a) new platform-level append-only `identity_events`; (b) no Pixa audit for account changes | **(a)** |
| D-A3-13 | Business data export | (a) defer to its own design; (b) basic CSV per Zone now | **(a).** It needs jobs, storage and email, which are off today |
| D-A3-14 | Who may open Business settings | (a) `business:read` (all roles; read-only for most, as A2 §5); (b) `business:manage` only | **(a).** Members see the profile and member names read-only, as already approved in A2 |
| D-A3-15 | Invitations in Settings (**flag**) | (a) Invitations is a Team tab visible to `members:invite` holders, with rank-filtered role choices and `delivery: failed` → Resend; (b) a separate top-level page | **(a).** No change to the A2 rules (D-A2-5 to 7, 13) |
| D-A3-16 | Ownership transfer UI (**flag**) | (a) Ownership & lifecycle danger area, typed business name, explains step-down and the last-owner rule; (b) an action in the member row | **(a)**, with the member row linking to it. Mechanics stay as A2-B built them |

## 15. Staged plan

Each stage is its own thread, branch and draft PR, audited before merge. None includes production steps unless
separately approved.

| Stage | Scope | Depends on | Migration | Status label |
|---|---|---|---|---|
| **A2-B** | Membership lifecycle (as in PR #76) | — | `20261205000000` (approval pending) | Dependent: A2-B |
| **A2-C** | Roles read API, matrix tests | A2-B | no | Dependent: A2-C |
| **A2-D = Settings stage 1** | Settings Zone `built`; registry children per §6.3; Business › General, Team (Members, Invitations, Roles & access), Ownership (transfer, step down, leave); confirmations per §10; Zone settings hub cards (links only) | A2-A to A2-C APIs; V2 decision D-A3-3 | no | Requires implementation (UI) |
| **A3-A Account security** | Security preflight and allow-list of the auth catch-all (G-A3-2); `PATCH /me` name; password change; sessions list and revoke; identity audit (D-A3-12); Account › Profile and Sign-in & security UI; business-less Account route (C7) | D-A3-7, D-A3-12; V2-C for the route | possibly (identity audit table) | Requires implementation |
| **A2-E** | Audit viewer API, security suite | A2-B to A2-D | no | Dependent: A2-E |
| **A3-B Integrations, privacy and preferences** | Integrations and Data & privacy pages linking to C2 and E1 screens; Finance retention read-only card; personal preferences only if D-A3-5(b) | C2 UI, E1 activation, N1 for notifications | possibly (grant or definer) | Dependent: C2, E1, N1 |
| **A3-C Audit log UI** | Security & audit › Audit log: filters, paging, actor names, metadata allow-list, empty and denied states | A2-E | no | Dependent: A2-E |
| **A3-D Lifecycle** | Archive business (definer function, typed confirmation, step-up per D-A3-11), account-deletion request flow (D-A3-9), data export design (D-A3-13) | D-A3-8, D-A3-9, D-A3-11, D-A3-13; legal review for deletion | yes (definer function) | Requires implementation |
| **Later, separate** | Pixa plan and billing (D-A3-10), notification preferences (N1), bank connections (F8), email change (D-A3-6) | own workstreams | — | Dependent / deferred |

Model guidance from the A2 pattern: Opus for A3-A and A3-D (security and lifecycle), Sonnet for UI-only stages unless
Regan says otherwise.

## 16. Test strategy

- **Permission matrix per section:** for each of OWNER, ADMIN, MANAGER and MEMBER (and a non-admitted user for
  Account), the section is visible or hidden as §8 says, **and** the underlying API answers 403 when hidden. The
  existing unit test of `ROLE_PERMISSIONS` stays the single source.
- **Navigation:** registry and palette show the same Settings children (V2-A §8.2). Rebuilt on business switch and
  role change. Scheduling card hidden before its readiness check.
- **Account:** password change requires the current password and revokes other sessions; session revoke works for
  browser and desktop and is effective on the next request; the auth allow-list rejects unadopted Better Auth paths;
  CSRF rules hold for each new path; identity audit rows contain no secrets.
- **Business:** stale version handling, confirmed regional save, typed confirmations send `confirm: true` only after
  the dialog, conflict codes rendered, member emails absent for MEMBER.
- **Isolation:** switching businesses never shows the previous business's members, emails or audit rows (no
  cross-business cache keys).
- **Visual:** light and dark, 390 px and the 900 × 600 Tauri minimum, using the V2-B harness once it exists.

## 17. Handoff

```text
TASK / BRANCH / BASE SHA: A3 Settings architecture / claude/project-thread-m3veky / b2f308b
CHANGED FILES: docs/settings-a3-architecture.md (new). No other file.
VERIFIED REPO FACTS: §2 and §4 (A2-A and #71 merged; A2-B draft #76 restamped 20261205000000; V2-A merged;
  audit:read and business:delete unused; users.locale/time_zone unused; auth catch-all has no path allow-list)
DECISIONS / RECOMMENDATIONS: D-A3-1..16 (§14), all pending
DEPENDENCIES / POTENTIAL CONFLICTS: §13 (A2-D overlap resolved by treating A2-D as Settings stage 1; N1, C2, E1, F8, V2-C)
TESTS RUN / RESULTS: none (docs only)
MIGRATIONS / PROD ACTIONS: none
KNOWN LIMITATIONS: Better Auth endpoint reachability inferred from code, not exercised (G-A3-2)
NEXT ACTION / FILES TO READ: Regan's decisions on §14; then A2-D and A3-A threads read §6–§12
```
