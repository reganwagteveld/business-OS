# People P2: employee management interface

Status: client only. **No API changes, no database migration, no new tables.** Everything here uses the People P1 API
described in `docs/people-data-model.md`. The People Zone is now `built` in the client registry and opens with
`people:read`.

## 1. What is implemented

| Area | Screen | Notes |
| --- | --- | --- |
| Directory | Employees | Server-side search (name, preferred name, number, work email), status filter (default: everyone not terminated; Terminated is one filter option), department and location filters, sort (name, number, newest), keyset paging 25 at a time, loading skeleton, empty, no-match and error states. |
| Profile | Employee page | Contact, Employment, Administrative, Personal details (see §3) and status history. Unsupported data is shown as "Not recorded", never invented. |
| Create | Add employee | Field-level validation, values kept on failure, one request per submit, duplicate employee number reported on its field, success opens the new profile. Creating an employee never creates a login, invitation or membership. |
| Edit | Edit | Sends only changed fields plus the version. A concurrent change returns `stale`: nothing is saved, the person's edits are kept, the newer record is loaded underneath and the person is told. Start date is editable only while PENDING. Terminated employees cannot be edited. |
| Status | Action buttons and confirmation dialog | Only the P1 transitions are offered (§4). The dialog explains consequences, takes an optional effective date and reason, and the server's refusal reasons are shown in words. |
| Departments, locations | Tabs inside People | Create, edit, archive and restore with `people:configure`; view with `people:read`. Archive is refused by the server while anyone is assigned (`in_use`). Duplicate active names are refused. |
| Team-member link | Employee form | Optional select of existing active members (needs `members:read` and `people:manage`). Grants nothing and changes no membership. |
| Navigation | Shell | People card and sidebar entry for roles with `people:read`; People is no longer "coming soon". |

## 2. Fields actually supported (from P1)

Given and family name, preferred name (display name), employee number, job title, employment type, work email, work phone,
status, start and end dates, current department, current manager (read-only in P2), current location, optional linked
team member, version, created and updated times. Not stored by P1 and therefore not shown: date of birth, gender, pay,
tax, bank, identity documents, leave balances.

## 3. Permissions (presentation here, enforced again by the API)

| Key | UI effect |
| --- | --- |
| `people:read` | Zone is available; directory, profiles, departments, locations, status history (reasons hidden). |
| `people:manage` | Add employee, Edit, status actions, team-member link, editing personal details (also needs `read_sensitive`). |
| `people:configure` | Add, edit, archive, restore departments and locations. |
| `people:read_sensitive` | Personal details section is rendered and requested. Without the key the screen never calls the personal-details endpoint, and the API answers 403 if called anyway. Status reasons are returned only with this key. |

## 4. Status transitions (P1 rules, unchanged)

PENDING → ACTIVE or TERMINATED; ACTIVE → ON_LEAVE or TERMINATED; ON_LEAVE → ACTIVE or TERMINATED;
TERMINATED → ACTIVE or PENDING (rehire). Termination sets the end date, closes department and manager assignments and is
refused while the person has direct reports (`has_direct_reports`). No status change touches membership or permissions.
History is append-only and shown on the profile. P2 adds no lifecycle rules.

## 5. Architecture

- `packages/app/src/api/people.ts`: typed client over the shared requester; every body is checked against the shared
  contract first; the business is only the `:slug` in the path.
- `packages/app/src/zones/people/`: `people-zone`, `directory`, `profile`, `employee-form`, `status-dialog`,
  `personal-section`, `org-units`. Reuses `ZonePage`, `useLoad`, `Problem`, draft guard and `@business-os/ui`.
- Nothing is cached outside components; the Zone is mounted with `key={slug}` so a business switch discards all state.
- No other Zone imports People and People imports no other Zone (only the existing members client, for the optional link).

## 6. API and database changes

None. Existing endpoints used: employees (list, get, create, patch, status, history, personal), departments and
locations (list, create, patch, archive, restore).

## 7. Tests

`packages/app/tests/people-zone.test.tsx` (36 tests) runs the real client and contracts against an in-memory stand-in
(`tests/support/fake-people.ts`) that mirrors the server's rules, permissions and per-business isolation. Covers: empty,
populated, search, filters, sort, paging, loading, error and offline states; create (valid, invalid, duplicate, double
submit, server failure, unsaved-changes guard); edit and stale conflict; user link; every status path including refusals;
personal details with and without the key; departments and locations (create, duplicate, in-use archive, restore,
read-only); authorization and cross-business isolation at the client/API boundary; navigation from Home.

Server authorization, RLS and database isolation are **not** re-tested with mocks: they are covered by the P1 suites
(`apps/api/tests/integration/people.test.ts`, `apps/api/tests/unit/people-boundaries.test.ts` and the isolation suite),
which P2 does not modify. Three existing client tests that asserted People was "planned" were updated because it is now built.

## 8. Known limitations and deferred

- Manager and department changes after creation (P1 has the endpoints) have no screen yet; the profile shows them read-only.
- No export, bulk actions, org chart, profile photos or custom fields.
- The directory lists work information only; there is no per-field audit viewer.
- Departments are flat, as in P1.

## 9. Not P2 (future People P3 and other Zones)

Leave requests, balances and approvals; workforce scheduling and rosters; payroll; attendance; employee self-service;
record-scoped manager visibility. `ON_LEAVE` remains only a status.
