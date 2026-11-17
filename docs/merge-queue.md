# Pixa OS — Merge queue

**Status:** Phase 1 of the CI and merge pipeline plan (owner decisions D-CI-1, D-CI-4 and D-CI-5, 2026-11-16). Process only: no workflow, branch protection or production change. The measurements and later phases are in the CI and merge pipeline proposal (draft PR #94).

This document is the procedure for getting approved PRs onto `main`. It does not change who approves anything: **Regan approves every merge, and nobody else can** (see `CLAUDE.md` and `docs/agent-task-protocol.md`).

## 1. Roles

- **Development threads** build, test and fix their own PR. They **never merge**, never sync for the queue's sake, and never change queue labels on another thread's PR.
- **The merge-queue thread** (one at a time) owns the queue: ordering, the final sync, final CI verification, the merge, post-merge verification and the queue table. It is the only thread that merges, and only with Regan's explicit approval for that PR.
- **ChatGPT** audits each PR. An audit recommendation is information, never approval.
- **Regan** gives the explicit merge approval for each PR, and separately approves any production migration or privileged SQL.

## 2. Syncing with `main` (D-CI-1)

Development threads **do not repeatedly merge `main` into their branch**. Every sync triggers a full CI run, and most syncs are redundant because the queue syncs again before merging.

A branch merges `main` only when:

1. **the PR reaches the front of the queue** (the merge-queue thread does this), or
2. there is a **genuine conflict** that GitHub reports or that blocks the work, or
3. the work has a **genuine dependency** on something newly merged (for example it needs a newly merged API, contract or migration).

Always merge `main` into the branch. Never rebase or force-push a shared branch. Push a batch of commits at once rather than commit by commit, so CI is not cancelled and restarted repeatedly.

## 3. Eligibility

The queue is ordered by **priority**: security fixes first, then dependency order (a PR another PR depends on goes first), then approval time. A PR is **eligible** to merge only when all of these hold:

1. **Not a draft**, or Regan explicitly approved "ready and merge" for it.
2. **ChatGPT audit sign-off** is recorded for the current head. Conflict-free sync merges from `main` are ignored when comparing heads.
3. **Regan's explicit merge approval** is recorded, with a link to his message. The approval covers that PR's content as audited.
4. Any **production migration or privileged SQL** has been applied and verified under its own separate approval, following the production migration order in `docs/agent-task-protocol.md`. The queue never merges a migration PR before its migration is recorded as applied.
5. No `queue:held` label and no open blocker in the queue table.

**Approval follows content.** A conflict-free sync merge from `main` keeps the audit and the approval. New commits that change content, a conflict resolution, or any substantive code change **invalidate the earlier sign-off**: the PR goes back for re-audit and fresh approval from Regan, and keeps its priority slot while it waits.

## 4. Skipping without bypassing

At each step the merge-queue thread takes the **first eligible PR**, not simply the first PR in the list.

- A blocked, unapproved or held PR is **passed over for now** and **keeps its priority slot**. It returns to the front as soon as it becomes eligible.
- Skipping never means "merge without". No condition in §3 may be waived to keep the queue moving.

## 5. Procedure at the front of the queue

For the first eligible PR (call it PR *k*):

1. **Confirm eligibility** (§3) against GitHub, the PR thread and the queue table, not from memory.
2. **Sync:** merge current `main` into the branch. If the merge conflicts, **halt that PR**: resolution is a content change, so it needs a fix in the PR's own thread, then re-audit and re-approval (§3). Move on to the next eligible PR.
3. **Final-head verification (D-CI-5):** wait for `CI gate` to succeed **on the exact final head commit**, and confirm that this commit contains the current `main` (the branch is up to date: `git merge-base --is-ancestor origin/main <head>`). Do this **regardless of the branch protection setting**, because the integration cannot read whether "Require branches to be up to date" is enabled. If `main` moves before the merge, sync again and re-verify. Never bypass, re-label or fabricate a green `CI gate`.
4. **Merge** only with Regan's explicit approval for this PR, recording the merged commit SHA.
5. **Post-merge verification:** wait for the `main` CI run on the merge commit, the Vercel production deploy and the production smoke check (`GET /api/v1/health` returns `status: ok`, plus any PR-specific check named in the PR). Record the results in the queue table.

### Pipelining

While PR *k*'s post-merge verification (step 5) is running, the merge-queue thread **may prepare PR *k+1*** (steps 1 to 3: confirm eligibility, sync, run CI). It **must not merge PR *k+1*** until PR *k*'s `main` CI run and the required deploy and smoke checks have all succeeded. If `main` advanced, PR *k+1* is synced and verified again on its new final head before merging.

## 6. Halt conditions

The queue **stops all merging** and reports to Regan on any of:

- a failed `main` CI run or a failed production deploy or smoke check,
- an unexpected conflict or unexpected content change,
- a security-sensitive surprise (authentication, admission, RLS, tenant isolation, permissions, financial integrity, migrations, privileged SQL),
- a migration history or checksum mismatch, an unexpected pending migration, a failed recovery branch or an ambiguous target.

Merging resumes only after the cause is understood and Regan says to continue. Never improvise production repairs.

## 7. Visibility (D-CI-4)

### Pinned queue issue

One pinned GitHub issue, **#95 "Merge queue"**, mirrors the queue table. The merge-queue thread keeps it current. The table has one row per PR in the queue:

| Pos | PR | Priority | Audit | Owner approval | Migration | CI (final head) | Blockers | Status |
|---|---|---|---|---|---|---|---|---|

- **Audit:** ChatGPT sign-off and the head it applies to.
- **Owner approval:** a link to Regan's approval message, or "none".
- **CI (final head):** `CI gate` result and duration on the up-to-date final head.
- **Status:** eligible, blocked, merging, held or merged (with merge SHA and time).

The issue is a mirror, not a source of approval. Regan's own messages are the only approval.

### Status labels

| Label | Meaning |
|---|---|
| `queue:eligible` | Meets every condition in §3 at the time it was labelled. |
| `queue:blocked` | Waiting on audit, approval, a migration, a conflict fix or CI. |
| `queue:merging` | The merge-queue thread is syncing, verifying or merging it now. At most one PR. |
| `queue:held` | Regan or the merge-queue thread put it on hold. Never merged while held. |

**Labels are informational only.** They never substitute for ChatGPT's audit or Regan's explicit approval, and the merge-queue thread re-checks §3 from the source (GitHub, the PR thread, Regan's message) before every merge. A label that disagrees with the source is corrected, not trusted. Only the merge-queue thread changes `queue:*` labels, except that Regan may add or remove any label.

## 8. Branch protection (D-CI-5)

Branch protection is **not changed** by this process. Whether "Require branches to be up to date before merging" is enabled on `main` is a **manual check for Regan**, because the GitHub integration cannot read the setting. §5 step 3 enforces up-to-date final-head verification either way.

## 9. Reporting

After each queue session the merge-queue thread reports to Regan: PRs merged (with SHAs), CI duration on each final head, sync runs triggered, PRs skipped and why, any halt, and what needs Regan.
