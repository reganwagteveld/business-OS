# People Zone data model (People P1: Workforce Foundation)

Status: backend only (no client screens yet; the People Zone stays `planned` in the client registry).
Migration: `20261118000000_people` (additive; must follow the Finance F1–F3 migrations).

## 1. Principles

- **Employees are not users.** An employee is a person the business employs or engages. A platform
  user is someone who signs in. An employee record never needs a seat (membership), and it never copies
  a user's name, email or other identity fields. A link to a user is optional (§2.1).
- **Reuse the platform.** Businesses, memberships and users are the tenancy module's own records. People
  tables reference them through composite `(business_id, …)` foreign keys; nothing is duplicated.
- **Same isolation layers as every Zone** (ADR 0004): scoped Prisma client inside `withTenant`, forced
  Row-Level Security with the standard `tenant_isolation` policy, composite foreign keys so a row can
  never point at another business's row, and least-privilege grants for `bos_app` (no `DELETE` on any
  People table). `bos_jobs` and `bos_auth` get nothing.
- **History is never lost.** Employees, departments and locations are never deleted. Department and
  manager assignments are effective-dated rows that are closed, never edited or removed. Status changes
  are written to an append-only history table. Every sensitive change writes an audit event.
- **Collect less.** P1 holds work information plus a small, separately protected set of personal contact
  details. Explicitly out of scope: payroll, tax, superannuation/retirement, leave balances or accrual,
  GPS or geolocation, biometrics, a mobile app, identity documents, bank details and tax identifiers.
  None of these have columns, and the contracts reject unknown fields, so they cannot be stored by accident.
- **No leakage into other Zones.** Customer, Sales, Project and Finance responses never include employee
  data, no other module imports the people module, and no other module reads People tables
  (enforced by `apps/api/tests/unit/people-boundaries.test.ts`).

## 2. Tables

| Table | Purpose |
| --- | --- |
| `people_departments` | Organisational units. `archived_at` = inactive. Active names unique per business (case-insensitive). |
| `people_locations` | Workplace locations: name and a free-text address only (no coordinates). `archived_at` = inactive. |
| `people_employees` | One row per employee: identity within the business, work contact, job, current status, current location, optional user link. |
| `people_employee_personal_details` | 1:1 with an employee, created on first write: personal email/phone, home address, emergency contact. Separate table so directory queries cannot select it by accident (§5). |
| `people_department_assignments` | Effective-dated department membership. At most one open row per employee. |
| `people_manager_assignments` | Effective-dated reporting line (employee → manager employee). At most one open row per employee. |
| `people_employment_status_history` | Append-only: every status an employee has had, with effective date, optional reason and who recorded it. |

### 2.1 Employee

- `employee_number` — optional, trimmed, 1–30 characters. Unique per business, case-insensitive, across
  **all** employees including terminated ones (records are never deleted, so a number in use is never
  reused). Editable by administrators (typo fixes); changes are audited with old and new value.
- `given_name`, `family_name` (required), `preferred_name`, `job_title`, `employment_type`
  (`FULL_TIME`, `PART_TIME`, `CASUAL`, `CONTRACTOR`, `TEMPORARY`, `OTHER`), `work_email`, `work_phone`.
- `status` (§3), `start_date` (start of the current period of employment), `end_date` (set exactly while
  `TERMINATED`).
- `location_id` — current workplace (composite FK). Changes are audited with from/to ids.
- `user_id` — optional link to a platform user who is an **active member of this business**, via a
  composite FK to `memberships (business_id, user_id)`. One employee per user per business. Linking grants
  no permissions and never changes the membership; removing the member from the business clears the link
  (audited), the employee record stays. Employment status never changes platform access.
- `version` — optimistic concurrency. Every change (including assignment and status changes) bumps it, and
  every write names the version it was based on; a stale write gets `409 stale`.

### 2.2 Assignments and reporting lines

Assignment rows are half-open date ranges `[starts_on, ends_on)`. Changing a department or manager closes
the open row at the effective date and opens a new one starting on it; "no department/manager" just closes
the open row. Rows are never updated except to close them once (a guard trigger enforces it) and never
deleted. Effective dates cannot be in the future (business time zone) and cannot precede the open row's
start.

Reporting-line rules (service checks first; the database is the backstop):

- An employee cannot manage themselves (CHECK).
- The manager must be an employee of the same business (composite FK) who is not `TERMINATED` (PE003).
- No cycles: assigning B as A's manager is refused if A is already in B's chain of managers (PE002). The
  check walks open manager rows with a recursive query.
- Concurrency: every reporting-line change and every termination takes a per-business transaction-scoped
  advisory lock (`people_lock_reporting()`) inside the guard trigger, so two simultaneous changes (A→B and
  B→A) cannot both pass the cycle check.

### 2.3 Departments and locations

Archiving (inactive) is refused while anyone is currently assigned (`409 in_use`); restoring makes it
selectable again. New assignments to an archived department or location are refused
(`409 archived_reference`). Both paths lock the department/location row (`FOR UPDATE` to archive,
`FOR SHARE` to assign), so an archive and an assignment racing each other cannot both succeed.

## 3. Lifecycle

```
PENDING ──activate──▶ ACTIVE ◀──return── ON_LEAVE
   │                   │  └──start leave──▶  │
   │                   ▼                     │
   └────withdraw───▶ TERMINATED ◀─terminate──┘
                       │
                       └──rehire──▶ PENDING | ACTIVE
```

Allowed transitions: `PENDING→ACTIVE`, `PENDING→TERMINATED` (offer withdrawn), `ACTIVE→ON_LEAVE`,
`ACTIVE→TERMINATED`, `ON_LEAVE→ACTIVE`, `ON_LEAVE→TERMINATED`, `TERMINATED→PENDING|ACTIVE` (rehire).
Anything else is `409 invalid_transition` (service) / PE001 (database trigger). `ON_LEAVE` is only a
status: there are no leave types, balances or accruals.

- Activation sets `start_date` to the effective date when moving from `PENDING` or `TERMINATED`.
- Termination sets `end_date` to the effective date, closes the employee's own open department and
  manager assignments, and is refused while the employee still has open direct reports
  (`409 has_direct_reports`, PE005) — reassign them first. It does not touch the user link or membership.
- Rehire clears `end_date`. Earlier periods remain in the status history.
- Effective dates cannot be in the future, before the previous status change, or before `start_date`.
- Each transition writes exactly one history row (same unit of work) and one audit event.

## 4. Errors

Standard wrappers (`apps/api/src/app/api/_lib/routes.ts`): 400 `invalid_input`/`invalid_query`, 403
`forbidden`, 404 `not_found` (including another business's ids), 409 conflicts. People adds
`invalid_transition`, `has_direct_reports`, `manager_cycle`, `invalid_manager`, `in_use`,
`duplicate_employee_number`, `user_already_linked`, `terminated`, and rule violations (400)
`invalid_user`, `future_effective_date`, `effective_date_order`, `invalid_dates`. Guard triggers raise
SQLSTATE class `PE`, each mapped to one stable code, never with detail: PE001 `invalid_transition`,
PE002 `manager_cycle`, PE003 `invalid_manager`, PE004 `immutable`, PE005 `has_direct_reports`,
PE006 `terminated`, PE007 `archived_reference`, PE008 `in_use`.

## 5. Permissions

| Key | Covers |
| --- | --- |
| `people:read` | Directory: employees (work fields only), departments, locations, current assignments, reporting lines, status/assignment history without reasons. |
| `people:read_sensitive` | Personal details, and the reason text on status history. |
| `people:manage` | Create and edit employees, change departments/managers/location, lifecycle transitions, link/unlink users. Editing personal details also needs `people:read_sensitive`. |
| `people:configure` | Create, edit, archive and restore departments and locations. |

Default grants: OWNER and ADMIN all four; MANAGER `people:read`; MEMBER none. People keys grant nothing
in any other Zone and no other Zone's key grants People access. Being someone's manager in the reporting
line grants nothing (no record-scoped rules in P1).

**Field-level protection.** Personal details live in their own table, are selected only by the personal
details service, and only after `people:read_sensitive` is checked. The employee DTO has no personal
fields at all. History reasons are nulled in the response unless the caller holds `people:read_sensitive`.
Audit metadata carries field names and ids only, never names, contact details or reasons.

## 6. API

All under `/api/v1/b/:slug/people` (contracts in `packages/contracts/src/people.ts`). Lists use keyset
pagination with opaque cursors (`limit` ≤ 100) and filters.

- `GET|POST /employees` — filters `q` (name, preferred name, number, work email), `status`,
  `departmentId`, `locationId`, `managerEmployeeId`; sorts `name`, `number`, `newest`.
- `GET|PATCH /employees/:id`
- `POST /employees/:id/status` — `{ status, effectiveDate?, reason?, version }`
- `POST /employees/:id/department` — `{ departmentId | null, effectiveDate?, version }`
- `POST /employees/:id/manager` — `{ managerEmployeeId | null, effectiveDate?, version }`
- `GET /employees/:id/history` — status history, department and manager assignments.
- `GET|PATCH /employees/:id/personal`
- `GET|POST /departments`, `PATCH /departments/:id`, `POST /departments/:id/archive|restore`
- `GET|POST /locations`, `PATCH /locations/:id`, `POST /locations/:id/archive|restore`

## 7. Decisions needing approval

Each is the conservative default implemented in this PR; changing one is a small follow-up.

| # | Decision | Default implemented |
| --- | --- | --- |
| PD-1 | Permission keys and role grants | Four keys (§5). OWNER/ADMIN all; MANAGER directory read only; MEMBER nothing. |
| PD-2 | Employee number | Optional; unique per business case-insensitively across all employees ever (never reused while the record exists); editable by admins, audited. No auto-numbering. |
| PD-3 | Lifecycle | Statuses and transitions in §3, including rehire. No future-dated changes. Termination refused while direct reports remain. |
| PD-4 | Employment history storage | Current values on the employee row + append-only status history + effective-dated assignment rows (closed, never edited). Location changes are audit-only (no location history table). |
| PD-5 | Sensitive fields | Separate personal-details table behind `people:read_sensitive`. P1 stores personal email, personal phone, home address and one emergency contact. No date of birth, gender, identity documents, bank or tax data. Reads of personal details are not audited (only changes). |
| PD-6 | User link | Optional; only to an active member of the same business; one employee per user; never grants access; cleared (audited) when the member is removed; employment changes never touch membership. |
| PD-7 | Manager cycles | Refused in the service and by a trigger under a per-business advisory lock. Manager must be a non-terminated employee. |
| PD-8 | Departments | One current department per employee; flat (no parent departments); archive refused while in use. |
| PD-9 | Business purge | People rows cascade with the business (as Projects). No per-employee erasure endpoint in P1. |

## 8. Out of scope / later

Client screens; self-service (an employee viewing their own record); record-scoped visibility for line
managers; department hierarchy; multiple concurrent departments; future-dated changes; per-employee
erasure and retention rules; custom fields; scheduling (`docs/scheduling-data-model.md`) linking to
employees.
