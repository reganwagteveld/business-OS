# Neon recovery-branch housekeeping

Every production migration cuts a Neon recovery branch (`pre-<thing>-migration`) first. They are cheap, but
they pile up. This is a small, read-only-by-default workflow for deciding which ones can go.

**Status: Phase 1 (audit-only).** Nothing deletes branches automatically, and nothing is scheduled.

## Files

| File | What it is |
|---|---|
| `scripts/neon-branches/policy.mjs` | The retention rules. Pure functions, no I/O. |
| `scripts/neon-branches/run.mjs` | Inventory (via `neonctl api`), audit, report, audit log, guarded deletion. |
| `scripts/neon-branches/cli.mjs` | Command line entry point. |
| `ops/neon/recovery-points.json` | Registry: which branch protects which migration/PR, verification status, incidents, holds, billing figures, and the `cleanupEnabled` switch. |
| `ops/neon/audit-log.jsonl` | Append-only log of audits, decision changes and deletions. |
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
8. **Keep:** the two most recent restore-verified recovery points. If fewer than two have a restore check,
   the newest usable points are kept instead and the report warns. The newest usable point is always kept.
9. Otherwise **eligible**: `review` between 48 hours and 7 days, `cleanup` after 7 days.

"Eligible" only means "may be proposed". Deletion always needs Regan's approval.

## Running the audit (read-only)

```bash
node scripts/neon-branches/cli.mjs audit --report /tmp/neon-report.md --snapshot /tmp/neon-snapshot.json
```

- Writes one `audit` line to the log every run, and a `decision` line only for branches whose decision changed,
  so repeated runs do not flood the log.
- `--github-issue N` posts the report as a comment on the operations issue, **only when the decision set changed**.
- If any Neon call fails, the run stops, logs `outcome: failed` and decides nothing.

## Keeping the registry current

Whoever cuts a recovery branch adds an entry to `ops/neon/recovery-points.json` in the same PR/thread:
branch ID and name, migrations, PRs, `appliedAt`, `migration.status`, `deployment.status`, `restoreCheck.status`.
Set `deployment.status` to `verified` once the post-deploy check passes. Record an incident in `incidents` to freeze branches.

A **restore check** means: attach a temporary read-only compute to the recovery branch, confirm it connects and
`_prisma_migrations` shows the expected last migration, then delete that compute. Record it as
`restoreCheck: { "status": "verified", "at": "...", "evidence": "..." }`. Creating the temporary compute changes
Neon resources, so it needs Regan's OK.

## Phase 2: controlled cleanup (not enabled)

Enabling Phase 2 is a reviewed commit that sets `cleanupEnabled: true`. After that, each cleanup is:

1. Run the audit with `--snapshot`, and share the report.
2. Regan approves specific branch IDs in writing.
3. Dry run, then execute:

```bash
node scripts/neon-branches/cli.mjs delete --snapshot /tmp/neon-snapshot.json --ids br-a,br-b --approval "<link to approval>"
node scripts/neon-branches/cli.mjs delete --snapshot /tmp/neon-snapshot.json --ids br-a,br-b --approval "<link to approval>" --execute
```

Safeguards: a lock file stops two runs at once; before **each** deletion the full inventory is fetched again and
re-evaluated; the branch must still be `eligible` and unchanged since the reviewed snapshot; an inventory or delete
failure stops the run; an already-deleted branch is logged as `already-absent`. Every outcome is logged with the approval reference.

## Proposed schedule

Weekly, Sunday 09:00 (Regan's time), audit-only, on the Mac where `neonctl` is signed in (a Claude scheduled task or
launchd). It posts to a single "Neon branch housekeeping" GitHub issue only when decisions change, and commits the
audit log when it changed. Not activated; needs Regan's approval. A GitHub Actions schedule would need a Neon API
key stored as a repository secret, which is avoided for now.
