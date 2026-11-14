# Projects Zone data model (Phase 5, PR 18; board ordering PR 19)

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
| `position` | Spaced integers (1000, 2000, …): a new task goes to the end. Order is `(position, id)`, so it is total even if two concurrent creates pick the same position. Board moves (PR 19) place a task between two others, renumbering only when no gap is left (§4, "Ordering"). |
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
- **Archive and task changes at the same time.** Every task change (create, edit, archive, restore) first reads its project row `FOR SHARE` in the same transaction. If an archive is already in flight, the task change waits for it and is then refused (`409 project_archived`). If the task change got there first, the archive waits until it commits. So a task change can never commit after its project was archived. Regression-tested in `projects.test.ts` ("PR 18 audit").
- **Removing a member while they are being assigned.** Member removal locks the membership row (`FOR UPDATE`) before clearing owners and assignees. An assignment already in flight commits first and is then cleared; one that starts later fails its foreign key. Either way no owner or assignee points at a removed member, and the removal does not fail.
- **Archive and restore take no version.** They only change `archived_at` and never overwrite edited fields. They are conditional on the current archive state, and they bump the version, so an edit prepared before them is refused (`stale`/`archived`) rather than applied to an archived record.
- **Ordering (PR 19 board).** A project's tasks have ONE order, `(position, id)`, archived tasks included. A board column is a presentation choice: the tasks whose status is in that column's set, in that order. The default board (To Do; In Progress, which also shows Blocked; Done) lives in the client (`packages/app/src/zones/projects/board-stages.ts`), not in the database, so another layout needs no schema change.
  - `POST …/tasks/:taskId/move` with `{ version, status, afterTaskId | null }` sets the status and places the task directly after the anchor in the project's order (null: first). Because the order is project-wide, "after the card above it" is right in every column that shows both, whatever statuses a column holds.
  - In one tenant transaction: load the task and check `version` (409 `stale`); read the project `FOR SHARE` (409 `project_archived`; same archive guarantee as every task change); take a transaction-level advisory lock on the project id so order changes in one project run one at a time (creates take it too); check the anchor is an active task of this project in the committed state the move reads (409 `order_changed` otherwise, so a stale board reloads); write a position strictly between the anchor and the next task. Archive and restore of the anchor are not serialised with moves (§4.1).
  - When no integer gap is left the project's positions are renumbered (1000, 2000, …) in their current order first. Renumbering changes no task's `version`: position is not part of an edit, so it never makes someone else's pending edit stale.
  - The write is conditional on `version` and `archived_at IS NULL`, like PATCH. Moving into DONE stamps `completed_at`, out of it clears it. A move to where the task already is changes nothing (no version bump, no audit). Audit: `projects.task.moved` (`from`, `to`, and `order: renumbered` when it happened), plus `projects.task.status_changed` when the status changed.
  - PATCH can still change a task's status; the task keeps its place in the project order.
- **Concurrency.** PATCH must send the `version` it was based on. The write is a conditional `UPDATE … WHERE version = $v AND archived_at IS NULL`, so of several simultaneous edits exactly one wins and the rest get `409 stale`.
- **Customer access.** Customer names are joined into project responses only for people holding `customers:read`. Without it, `customerId` still shows a customer is linked but `customer` is `null`. Linking, changing or unlinking a customer, and listing a customer's projects, need `customers:read` (403 otherwise).
- **Progress** (`taskCounts: { total, done }`) counts non-archived tasks, computed in one grouped query per page (no N+1).
- **Audit.** Every mutation writes an audit entry in the same unit of work with ids and structured facts only (status, from/to, field names), never names, titles or descriptions.

### 4.1 Invariants and locks (PR 19)

Every task change runs in one READ COMMITTED tenant transaction. These are the invariants, and what protects each one.

| # | Invariant | Protected by |
|---|---|---|
| I1 | No task change commits after its project was archived | Every task write reads the project row `FOR SHARE`; archive/restore/edit of a project take `FOR NO KEY UPDATE` on it, so each waits for the other |
| I2 | No edit is applied on top of a version it did not see | Conditional `UPDATE … WHERE version = $v AND archived_at IS NULL` on the one row written |
| I3 | Positions are written from an order nobody else is rewriting (no two moves, or a move and a create, compute from the same stale order) | Transaction-level advisory lock per project (`lockOrder`), taken by move and create, after the project `FOR SHARE` |
| I4 | A renumber never loses a concurrent change to another column of a task | Renumber writes only `position`; PostgreSQL re-applies it to the latest row version, and no other writer touches `position` |
| I5 | No owner or assignee points at a removed member | Member removal locks the membership `FOR UPDATE` before clearing owners and assignees |
| I6 | Two multi-row writers of `project_tasks` cannot deadlock | Renumber and member removal both lock their task rows in id order (`SELECT … ORDER BY id FOR UPDATE`) before updating |

**What is deliberately not serialised.** Archiving or restoring a single task changes no position: positions span archived tasks too, so the project order is unchanged and only visibility changes. A move validates its anchor against the committed state it reads; an archive or restore of that anchor committing at the same moment is not waited for. The outcome is always the same as running the move first and the archive/restore just after (they write different rows, and archive/restore read none of the move's writes). Case by case: anchor archived after the move read it → 200, the task sits where the anchor was; anchor archive still in flight when a renumber reaches its row → the move waits, re-reads and answers 409 `order_changed`; anchor restore in flight → 409 `order_changed` at once. Regression-tested ("PR 19 review" in `projects.test.ts`). Serialising them would make every archive and restore in a project wait behind board moves to protect a placement that is already correct; if a stricter "anchor still active at commit" rule is ever needed, the narrow fix is `FOR SHARE` on the anchor row inside the move.

**Lock order.** membership → project row → project order lock → task rows (multi-row writers in id order). Single-row task writers (edit, archive, restore) hold one task row and then wait only on their audit insert. Moves and creates are serialised by the order lock, always taken after the project share lock. A project archive waits for the share holders, which never wait on it. So there is no cycle.

| Operation | Locks, in order |
|---|---|
| create task | project `FOR SHARE` → order lock → insert |
| move task | project `FOR SHARE` → order lock → (renumber: all project task rows, id order) → the moved row |
| edit, archive, restore task | project `FOR SHARE` → the task row |
| edit, archive, restore project | the project row (`FOR NO KEY UPDATE`) |
| remove member | membership `FOR UPDATE` → owned project rows → assigned task rows (id order) |
| list tasks | none |

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
| `PATCH /projects/:projectId/tasks/:taskId`, `POST …/archive`, `…/restore`, `POST …/move` (PR 19) | `projects:manage_tasks` |

Lists are keyset-paginated with opaque cursors bound to their list and sort order; a cursor from another list is `400 invalid_cursor`. Bodies are strict. Another business's project, task or customer answers exactly like a missing id (`404 not_found`).

## 7. Migration

`20261114120000_projects` is additive only: three enum types, two tables, indexes, foreign keys, CHECKs, grants (`SELECT, INSERT, UPDATE` to `bos_app`; nothing to other runtime roles) and forced RLS with the standard `tenant_isolation` policy. No existing table or row changes, and no privileged SQL (`prisma/privileged`) changes are needed. Production rollout: `prisma migrate deploy` as `bos_owner`, only with the owner's approval, as for earlier Zone migrations.

## 8. Future integration path

Automatic Sales-to-Projects conversion is not built. When it is, a nullable `source_opportunity_id` with a composite FK to `opportunities(business_id, id)` can be added without changing anything here.
