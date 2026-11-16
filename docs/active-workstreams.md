# Pixa OS — Active Workstreams Registry

**Purpose:** Prevent cross-agent file collisions and repeated PR archaeology.
**Status snapshot:** 2026-11-16 ~12:00 UTC, checked against `main` at `b2f308b` and GitHub's open PR list at that time. **Update before every new agent starts** (see "Keeping this file current").

## Important rules

- A status row is **not** a lock, and this registry is **not** authoritative about remote Git branches or production state.
- Before claiming files, check current `main`, active PRs, branch/worktree ownership, and changed filenames relevant to the task.
- Never silently overwrite another agent's edits. Assign ownership by paths and interfaces. If overlap is unavoidable, coordinate or sequence the change.
- Do not equate a merged PR with a completed production migration or deployment, or a draft PR with an approved one.
- Before calling any migration "pending" in production, read the production `_prisma_migrations` table (read-only). This file only records the last known state.

## Open PRs on 2026-11-16

| PR | Topic | Status | Owns / implication |
|---|---|---|---|
| #76 | Administration A2-B: membership lifecycle, invitations, owner lock, mailbox cutoff | **Draft**, awaiting ChatGPT audit | Membership and invitation services and routes, migration `20261203000000_membership_lifecycle`, privileged `005_member_emails.sql`, edits privileged `001`. Not applied to production. Avoid membership/RBAC files. |
| #75 | GS1 global search architecture and plan | **Draft**, docs only | `docs/global-search-gs1.md`. Decisions D-GS1-1..14 pending; nothing to implement yet. |
| #53 | Claude and Codex delivery coordinator (`tooling/coordinator`) | Open, idle since 2026-11-16 04:00 UTC | Not part of the current workflow. Do not build on it without Regan. |
| #48 | Docs: post-merge status and migration order (12–16) | Open, stale (superseded by `docs/migration-readiness.md` §9) | Ignore unless Regan asks. |

Migration stamps: `20261203000000` is reserved by A2-B (#76) and `20261204000000` is P3-A (merged). New migrations must sort after every stamp on `main` **and** in open PRs (CI `check-migration-order`).

## Recently merged (2026-11-16)

#68 People P3-A leave policies (migration applied first), #66 Neon housekeeping (audit-only), #74 UI V2-A spec, #71 invite-only beta admission (deployed), #70 A2-A business profile, #72 E1 migration record, #69 F7-B catalog in documents, #64 E1 retention/erasure (dormant), #67 F5 PDF preview fix, #63 F7-A catalog, #65 ADR 0008 and S2 migration record, #61 S2 resources, #62 R2 dashboards, #56 People P2, #54/#57/#59 F6-3 reminders.

**Production database (last recorded, verify before relying on it):** 22 migrations applied, through `20261204000000_people_leave_policies`, matching `main`. A2-B's `20261203000000` is not applied; it sorts before P3-A, so its order must be resolved before its migration.

## Planned / concurrent task lanes

| Lane | Assigned scope | Expected output | Reserved / avoid areas | State |
|---|---|---|---|---|
| A2-B | Membership lifecycle | Draft PR #76 | Membership, invitations, owner lock, privileged SQL 001/005 | In audit |
| P3 | People leave management | P3-A merged (#68); next P3-C before P3-B | Leave schema, leave policy files, migration files | P3-C needs decisions D-P3-20/21/25 |
| GS1 | Global search | Docs PR #75 | Search specs, command palette proposals | Waiting on Regan's decisions |
| F8 | Bank connectivity and reconciliation | Architecture (docs-only) PR | Finance integration design docs | Draft in progress, no PR yet |
| UI V2 | Design-system rollout | Phased implementation (V2-B, V2-C…) | Design tokens, shared navigation and shell components | Spec merged; V2-B waits for Regan's go-ahead |
| A3 | Settings architecture | Documentation-only PR | No edits to live A2 APIs, RBAC or Settings UI | Ready to queue |
| W1 | Cross-Zone workflow mapping | Documentation-only PR | No edits to Zone implementations | Ready to queue |
| N1 | Notifications architecture | Documentation-only PR | No notification migrations or runtime framework | Ready to queue |

Switched off and not to be enabled without Regan: F6 billing and reminder scheduled jobs, E1 erasure/retention jobs, outbound email beyond existing auth and invitation mail, any worker or cron.

## Claim and release protocol

Before editing, report:

```text
TASK: <ID/title>
AGENT: <thread or session>
BASE: <commit SHA>
BRANCH/WORKTREE: <name/path>
OWNED PATHS: <specific files/directories>
RELATED OPEN PRS: <numbers + changed filenames checked>
SHARED CONTRACTS TO READ: <interfaces/specs>
PLANNED OUTPUT: <docs-only | implementation>
MIGRATION: <none | stamp + why it sorts last>
BLOCKERS: <none | details>
```

On handoff: release claimed paths and note the PR, commit, dependencies and changed contracts. A merge or file move invalidates earlier ownership assumptions and needs a fresh check.

## Collision response

1. Stop editing the overlapping files.
2. Read the other workstream's changed filenames and intended contract.
3. Prefer a documentation-only interface proposal, a separate path, or dependency ordering.
4. Ask Regan for a decision if independent implementation is impossible.
5. Do not resolve conflicts by force-pushing, cherry-picking unrelated work, or merging an unreviewed branch.

## Keeping this file current

- Agents do **not** edit this file as part of their feature PR, because concurrent edits to one shared file conflict. They report their claim and handoff in their thread instead.
- When Regan asks, one thread refreshes this file in a small docs-only PR: open PRs table, merged list, lanes and the last recorded production migration.
- The live GitHub state always wins over this file.
