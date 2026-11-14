# Projects Zone data model (Phase 5, PR 18)

The Projects Zone's data model, written with its foundation. It follows [data-model.md](./data-model.md) and [sales-data-model.md](./sales-data-model.md): same tenancy, RLS, composite foreign keys, roles, audit and migration conventions.

## 1. Principles

- **Industry independent.** A project is a name, a description, a status, a priority, dates, an optional customer and an optional owner. There are no sprint, site, campaign or other trade-specific fields.
- **One business data model.** A project links to the Customer Zone's own `customers` row. No customer name, contact detail or address is copied. Names are read through a join at request time, so a renamed customer shows its new name everywhere.
- **Customers are optional.** Internal work (an office move, onboarding a new hire, an operational improvement) needs no customer. No sales opportunity is needed either.
- **Tenant isolation in three layers**, as in data-model §5:
  - the scoped Prisma client injects `business_id`;
  - forced RLS policies check it again;
  - composite `(business_id, …)` foreign keys make a cross-business link impossible even with raw SQL.
- **History is kept.** Tenant code has no DELETE on either table. Projects and tasks are archived and restored, so archiving never loses tasks and "removing" a task never loses its history.
- **Assignments are not permissions.** A project owner or task assignee is a work assignment. Being one grants nothing: every read and write is checked against the permission keys of the person's role.

## 2. Project (`projects`)

| Column | Notes |
|---|---|
| `id`, `business_id` | UUID; `(business_id, id)` unique, for composite FKs from tasks |
| `name` | 1–200 characters after trimming (CHECK) |
| `description` | ≤ 5000 characters (CHECK) |
| `status` | `ProjectStatus`: `PLANNED`, `ACTIVE`, `ON_HOLD`, `COMPLETED`, `CANCELLED`; default `PLANNED` |
| `priority` | `WorkPriority`: `LOW`, `MEDIUM`, `HIGH`, `URGENT`; default `MEDIUM`. Shared with tasks. |
| `customer_id` | FK `(business_id, customer_id) → customers(business_id, id)`, nullable |
| `owner_user_id` | FK `(business_id, owner_user_id) → memberships(business_id, user_id)`, nullable; the service also requires the membership to be ACTIVE |
| `start_date`, `due_date` | `date` (calendar dates, no time zone). CHECK `due_date >= start_date` when both are set. |
| `completed_at` | Set exactly while the status is `COMPLETED` (CHECK). Stamped by the server on entering COMPLETED, cleared on leaving it; never sent by a client. |
| `version` | Starts at 1, +1 on every change (edit, archive, restore, owner cleared by member removal). Optimistic concurrency, as for opportunities. |
| `created_by_id`, `updated_by_id`, `created_at`, `updated_at`, `archived_at` | Authorship, timestamps, reversible archive |

Indexes: `(business_id, created_at DESC, id)` for the default list, `(business_id, due_date, id)` for the due-date sort, and `(business_id, status)`, `(business_id, customer_id)`, `(business_id, owner_user_id)`, `(business_id, archived_at)` for filters.

## 3. ProjectTask (`project_tasks`)

| Column | Notes |
|---|---|
| `id`, `business_id`, `project_id` | FK `(business_id, project_id) → projects(business_id, id)`: a task always belongs to exactly one project of the same business |
| `title` | 1–200 characters after trimming (CHECK) |
| `description` | ≤ 5000 (CHECK) |
| `status` | `ProjectTaskStatus`: `TODO`, `IN_PROGRESS`, `BLOCKED`, `DONE`; default `TODO` |
| `priority` | `WorkPriority`; default `MEDIUM` |
| `assignee_user_id` | FK `(business_id, assignee_user_id) → memberships(business_id, user_id)`, nullable; ACTIVE checked by the service |
| `due_date` | `date` |
| `position` | Spaced integers (1000, 2000, …): a new task goes to the end. Order is `(position, id)`, so it is total even if two concurrent creates pick the same position. A later reorder can place a task between two others without renumbering. |
| `completed_at` | Set exactly while the status is `DONE` (CHECK). Entering DONE stamps it, staying in DONE keeps it, leaving DONE clears it. |
| `version`, authorship, timestamps, `archived_at` | As for projects |

Indexes: `(business_id, project_id, position, id)`, `(business_id, project_id, status)`, `(business_id, assignee_user_id)`.

Out of scope for this version: subtasks, cross-project tasks, dependencies, checklists, recurring tasks.

## 4. Rules the services enforce

- **Archived projects are read-only.** Editing an archived project answers `409 archived`. Adding, editing, archiving or restoring any of its tasks answers `409 project_archived`. Its tasks stay readable.
- **Task removal policy.** "Remove" archives the task (`POST …/tasks/:taskId/archive`). It leaves the list and the progress count, keeps its history, and can be restored. Nothing is hard-deleted.
- **Archiving a project** keeps every task as it was. Restoring makes it editable again.
- **Archiving a customer** leaves its projects linked (the FK is NO ACTION and customers are archived, not deleted). The project shows the customer as archived. A *newly* linked customer must be active (`409 archived_reference`).
- **Removing a member** clears them as project owner and task assignee (version bumped), so the membership FK never blocks the removal and an edit prepared before is refused as stale.
- **Concurrency.** PATCH must send the `version` it was based on. The write is a conditional `UPDATE … WHERE version = $v AND archived_at IS NULL`, so of several simultaneous edits exactly one wins and the rest get `409 stale`.
- **Customer access.** Customer names are joined into project responses only for people holding `customers:read`. Without it, `customerId` still shows a customer is linked but `customer` is `null`. Linking, changing or unlinking a customer, and listing a customer's projects, need `customers:read` (403 otherwise).
- **Progress** (`taskCounts: { total, done }`) counts non-archived tasks, computed in one grouped query per page (no N+1).
- **Audit.** Every mutation writes an audit entry in the same unit of work with ids and structured facts only (status, from/to, field names), never names, titles or descriptions.

## 5. Permissions

| Key | OWNER | ADMIN | MANAGER | MEMBER |
|---|---|---|---|---|
| `projects:read` | ✓ | ✓ | ✓ | ✓ |
| `projects:create` | ✓ | ✓ | ✓ | ✓ |
| `projects:update` | ✓ | ✓ | ✓ | ✓ |
| `projects:archive` (archive and restore a project) | ✓ | ✓ | ✓ | |
| `projects:manage_tasks` (create, edit, archive, restore tasks) | ✓ | ✓ | ✓ | ✓ |

Keys follow the repository's `<zone>:<action>` convention. Code checks keys, never roles, so a future read-only or no-Projects role only changes this table. The integration suite already exercises such roles by giving a role a custom key set.

## 6. API

All under `/api/v1/b/:slug`, all `tenantRoute` (tenant from the URL against the caller's verified membership, never from a body):

| Method and path | Permission |
|---|---|
| `GET /projects` (`q`, `status`, `archived`, `customerId`, `ownerUserId`, `sort` = `newest`/`name`/`due`, `cursor`, `limit` ≤ 100) | `projects:read` |
| `POST /projects` | `projects:create` |
| `GET /projects/summary` (active projects by status) | `projects:read` |
| `GET /projects/:projectId`, `PATCH /projects/:projectId` | `projects:read`, `projects:update` |
| `POST /projects/:projectId/archive`, `…/restore` | `projects:archive` |
| `GET /customers/:customerId/projects` | `projects:read` + `customers:read` |
| `GET /projects/:projectId/tasks` (`status`, `archived`, `cursor`, `limit` ≤ 200), `POST` | `projects:read`, `projects:manage_tasks` |
| `PATCH /projects/:projectId/tasks/:taskId`, `POST …/archive`, `…/restore` | `projects:manage_tasks` |

Lists are keyset-paginated with opaque cursors bound to their list and sort order; a cursor from another list is `400 invalid_cursor`. Bodies are strict. Another business's project, task or customer answers exactly like a missing id (`404 not_found`).

## 7. Migration

`20261114120000_projects` is additive only: three enum types, two tables, indexes, foreign keys, CHECKs, grants (`SELECT, INSERT, UPDATE` to `bos_app`; nothing to other runtime roles) and forced RLS with the standard `tenant_isolation` policy. No existing table or row changes, and no privileged SQL (`prisma/privileged`) changes are needed. Production rollout: `prisma migrate deploy` as `bos_owner`, only with the owner's approval, as for earlier Zone migrations.

## 8. Future integration path

Automatic Sales-to-Projects conversion is not built. When it is, a nullable `source_opportunity_id` with a composite FK to `opportunities(business_id, id)` can be added without changing anything here.
