# Neon recovery-branch housekeeping

Every production migration cuts a Neon recovery branch (`pre-<thing>-migration`) first. They are cheap, but
they pile up. This is a small, read-only-by-default workflow for deciding which ones can go.

**Status: Phase 1 (audit-only).** The code has no way to delete a branch, and nothing is scheduled.

## Files

| File | What it is |
|---|---|
| `scripts/neon-branches/policy.mjs` | The retention rules. Pure functions, no I/O. |
| `scripts/neon-branches/run.mjs` | Read-only inventory (via `neonctl api`), audit, report, audit log, and the read-only pre-deletion check. |
| `scripts/neon-branches/cli.mjs` | Command line entry point. |
| `ops/neon/recovery-points.json` | Registry: which branch protects which migration/PR, verification status, restore drills, incidents, holds and billing figures. Validated on every run (no duplicates, known kinds and statuses). |
| `ops/neon/audit-log.jsonl` | Append-only log of audits, decision changes, notification outcomes and (later) deletions. Its integrity rests on Git history and PR review; it is not a tamper-proof ledger. Entries marked `reconstructed: true` were written after the fact from notes. |
| `tests/ops/neon-branches.test.ts` | Mocked-Neon tests. No test can reach a real Neon project. |

No new dependencies. It reuses the Mac's existing `neonctl` sign-in; no API key is stored.

## Retention rules

Applied in this order; the first rule that matches decides, and every matching rule is listed as a reason.

1. **Production is never deleted** (Neon default/primary branch, or named `production`).
2. **Protected:** Neon "protected" flag, branches with child branches, branches not in `ready` state.
3. **Protected: younger than 48 hours.**
4. **Needs approval:** a compute endpoint is attached (someone may be using it).
5. **Protected:** an open incident names the branch (`incidents[].branchIds`, `"*"` freezes everything),
   or the registry entry has an open incident.
6. **Protected:** the production migration or deployment it guards is not recorded as `verified`, or it has a `hold`.
7. **Needs approval:** unknown, development or testing branches; `pre-*` branches missing from the registry;
   a registry entry whose branch ID no longer matches (branch recreated under the same name).
8. **Keep:** the two most recent restore-drilled recovery points (see below). If fewer than two have a drill,
   the newest usable points are kept instead and the report warns. The newest usable point is always kept.
9. Otherwise **eligible**: `review` between 48 hours and 7 days, `cleanup` after 7 days.

"Eligible" only means "may be proposed". Deletion always needs Regan's approval.

## Running the audit (read-only)

```bash
node scripts/neon-branches/cli.mjs audit --report /tmp/neon-report.md --snapshot /tmp/neon-snapshot.json
```

- Writes one `audit` line to the log every run, and a `decision` line only for branches whose decision changed,
  so repeated runs do not flood the log.
- `--github-issue N` posts the report as a comment on issue N in `reganwagteveld/business-OS` (the repo is named
  explicitly, not taken from the current checkout). A comment is posted whenever the decision set differs from the
  last one **successfully delivered**, so a failed post is retried on the next run. Each audit logs
  `notification: sent | failed | not-needed | not-configured`; a failure also sets a non-zero exit code.
- If any Neon call fails, the run stops, logs `outcome: failed` and decides nothing.
- The snapshot binds each branch's Neon fields to the registry revision (`registryHash`) that was reviewed.

## Keeping the registry current

Whoever cuts a recovery branch adds an entry to `ops/neon/recovery-points.json` in the same PR/thread:
branch ID and name, migrations, PRs, `appliedAt`, `migration.status`, `deployment.status`, `restoreDrill.status`.
Set `deployment.status` to `verified` once the post-deploy check passes. Record an incident in `incidents` to freeze branches.

A recovery point counts as **independently verified** only after a **restore drill**: restore the recovery branch
to a temporary branch/compute, run the application-level data checks (expected last migration, per-table row counts
and key totals matching the values recorded at the branch's LSN), then remove the temporary resources. Being able to
connect and read `_prisma_migrations` is not enough. Record it as
`restoreDrill: { "status": "verified", "at": "...", "dataIntegrityChecked": true, "evidence": "..." }`.
A drill creates Neon resources, so each one needs Regan's OK.

### Restore drill gap (status 2026-11-17)

No recovery point has an evidenced restore drill yet: `restoreDrill.status` is `not-run` on every entry. Being reachable, healthy and matching production's `_prisma_migrations` at cut time does **not** prove a restore. Until at least two drills are recorded:

- the audit keeps the newest usable recovery points and warns on every run;
- no recovery point may be described as restore-verified;
- every recovery branch stays protected unless Regan approves its deletion by name after a fresh eligibility check. This holds even when the policy marks it eligible (as for `pre-c2b1-migration` and `pre-f6-migration` on 2026-11-17).

Plan, not yet run (each drill creates Neon resources and needs Regan's OK). Drill the two newest verified points, `pre-workflow-links-migration` and `pre-search-indexes-migration`:
1. Restore each to a temporary branch with compute.
2. Check the expected last migration and per-table row counts against the values recorded at the branch's LSN.
3. Delete the temporary resources.
4. Record `restoreDrill` with `dataIntegrityChecked: true`.

## Phase 2: controlled cleanup (not built yet)

Phase 1 ships no deletion code. Phase 2 is a separate, audited change that must add:

1. **Trusted, branch-specific approval.** A free-text reference proves nothing. Approval must be a record that
   names exact branch IDs and the snapshot's `registryHash`, and lands through a reviewed, merged PR (or another
   channel the tool can verify), not a command-line string.
2. **The fresh eligibility gate before every deletion.** This already exists and is tested: `checkDeletion` /
   `node scripts/neon-branches/cli.mjs check --snapshot s.json --ids br-a,br-b`. It re-reads the whole inventory for
   each branch and refuses anything no longer eligible, changed since the snapshot, missing from it, or evaluated
   against a different registry revision. It stops on any API failure.
3. A lock against concurrent runs, one deletion at a time, and a log line per outcome.

## Proposed schedule

Weekly, Sunday 09:00 (Regan's time), audit-only, on the Mac where `neonctl` is signed in (a Claude scheduled task or
launchd). It posts to a single "Neon branch housekeeping" GitHub issue only when decisions change, and commits the
audit log when it changed. Not activated; needs Regan's approval. A GitHub Actions schedule would need a Neon API
key stored as a repository secret, which is avoided for now.

Before activating:

- **Authentication.** Both `neonctl` and `gh` must be signed in on the Mac. If either sign-in has expired, the run
  fails: a Neon failure logs `outcome: failed`; a GitHub failure logs `notification: failed`. Either way the exit code
  is non-zero and nothing is decided or deleted.
- **Missed runs.** If the Mac is asleep or off on Sunday, that week's run is skipped. The next run evaluates the
  current inventory from scratch, so nothing is lost. A failed comment is re-posted on the next run.
- **Repeats.** Re-running is safe: decision lines are logged only on change, and comments are posted only for a new,
  undelivered decision set.
