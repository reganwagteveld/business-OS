# Pixa OS — Merge queue

**Status:** Phase 1 of the CI and merge pipeline plan (owner decisions D-CI-1, D-CI-4 and D-CI-5, 2026-11-16), amended for delegated technical approval (owner directive, 2026-11-17) and for CIQ-A3 (owner decisions D-CIQ-2 and D-CIQ-6 on #141, 2026-11-17: verdict detection, event-driven SHA-pinned hand-off, bounded macOS recovery). Process only: no workflow, branch protection or production change. The measurements and later phases are in the CI and merge pipeline proposal (`docs/ci-merge-pipeline-proposal.md`).

This document is the procedure for getting approved PRs onto `main`. Who approves is defined in `docs/agent-task-protocol.md` "Approvals": a verified `APPROVED — EXECUTE: MERGE` verdict on the exact reviewed content authorises the merge-queue thread to merge, with no further approval from Regan unless an escalation condition applies. In this document a **valid approval** means such a verdict that passes the provenance check there (or Regan's own approval for an escalated PR).

## 1. Roles

- **Development threads** build, test and fix their own PR. They **never merge**, never sync for the queue's sake, and never change queue labels on another thread's PR.
- **The merge-queue thread** (one at a time) owns the queue: ordering, the final sync, final CI verification, the merge, post-merge verification, the delegated operation record and the queue table. It is the only thread that merges, and only with a valid approval for that PR's current content.
- **ChatGPT** audits each PR and holds delegated technical approval. Only an `APPROVED — EXECUTE` verdict it posts itself, for the exact reviewed head and the named operation, is approval. A CONDITIONAL PASS, an audit pass, a recommendation or any other verdict is not.
- **Regan** decides every escalation (`docs/agent-task-protocol.md` "Escalate to Regan"), remains the final authority, and may hold, reorder or stop the queue at any time.

## 2. Syncing with `main` (D-CI-1)

Development threads **do not repeatedly merge `main` into their branch**. Every sync triggers a full CI run, and most syncs are redundant because the queue syncs again before merging.

A branch merges `main` only when:

1. **the PR reaches the front of the queue** (the merge-queue thread does this), or
2. there is a **genuine conflict** that GitHub reports or that blocks the work, or
3. the work has a **genuine dependency** on something newly merged (for example it needs a newly merged API, contract or migration).

Always merge `main` into the branch. Never rebase or force-push a shared branch. Push a batch of commits at once rather than commit by commit, so CI is not cancelled and restarted repeatedly.

## 3. Eligibility

The queue is ordered by **priority**: security fixes first, then dependency order (a PR another PR depends on goes first), then approval time. A PR is **eligible** to merge only when all of these hold:

1. **Not a draft**, or its valid approval explicitly says "ready and merge".
2. **A valid approval** is recorded for the current content: an `APPROVED — EXECUTE: MERGE` verdict naming the reviewed head SHA, provenance-checked, and linked from the queue table. Sync merges from `main` are judged by "Approval follows content" in the protocol.
3. **No escalation condition applies**, or Regan's own approval for the escalated part is recorded, with a link to his message.
4. Any **production migration** has been applied and verified under its own `APPROVED — EXECUTE: MIGRATION` verdict (and any **privileged SQL** under Regan's approval), with the mandatory safeguards, following the production migration order in `docs/agent-task-protocol.md`. The queue never merges a migration PR before its migration is recorded as applied.
5. No `queue:held` label and no open blocker in the queue table.

### Detecting existing approvals (CIQ-A3)

Approvals that already exist are found, not requested again:

1. At the start of every queue session and after every merge, run `scripts/merge-queue/verdict-status.sh <PR>...` for every open PR in the queue. It is read-only. For each PR it reports the newest verdict comment that passes the provenance check (connector app slug, unedited, first non-empty line exactly `APPROVED — EXECUTE: MERGE`, exactly one reviewed head SHA, names this PR), whether that verdict covers the current head (`exact head`, or `same patch-id` after sync merges), whether it says "ready and merge", the `CI gate` result on the head and how far the head is behind `main`.
2. A PR reported as `exact head` or `same patch-id` **already has its approval**. Do not ask ChatGPT or Regan for it again. Re-read the verdict comment yourself before the merge (§5 step 1); the script is an aid, never the approval.
3. A PR reported as `NOT COVERED` needs a fresh verdict. Say exactly why in the request (new commit after the verdict, no exact head SHA, verdict line not on the first line, draft without "ready and merge"), so ChatGPT can post a correct one in one round-trip.
4. **Owner decisions already recorded are not re-requested.** Regan's own typed approvals (activation, deploy configuration, other escalations) and owner-decision records stay valid for the content they name. Link them in the queue table. Ask Regan again only if the PR's content changed materially since his approval or the escalation is a different one.

**Independent lanes.** A PR that waits on a migration, a dependency or an escalation never holds up unrelated PRs: §4 already takes the first *eligible* PR, so docs and UI PRs keep merging while a migration PR waits for its migration verdict.

**Approval follows content.** A conflict-free sync merge from `main` keeps the verdict only if the PR's own patch is unchanged (same `git patch-id`) and `CI gate` passes on the final head (protocol, "Approval follows content"). New commits that change content, a conflict resolution, any substantive code change or an unexpected semantic change from a sync **invalidate the earlier verdict**: the PR goes back for a fresh ChatGPT audit (and Regan's approval again if it escalates), and keeps its priority slot while it waits.

## 4. Skipping without bypassing

At each step the merge-queue thread takes the **first eligible PR**, not simply the first PR in the list.

- A blocked, unapproved or held PR is **passed over for now** and **keeps its priority slot**. It returns to the front as soon as it becomes eligible.
- Skipping never means "merge without". No condition in §3 may be waived to keep the queue moving.

## 5. Procedure at the front of the queue

For the first eligible PR (call it PR *k*):

1. **Confirm eligibility** (§3) against GitHub, the PR thread and the queue table, not from memory. Re-run the provenance check on the verdict comment. Check that the approved SHA is the head being merged, or that every later commit is a conflict-free sync from `main` and the PR's patch is unchanged.
2. **Sync:** merge current `main` into the branch. If the merge conflicts, **halt that PR**: resolution is a content change, so it needs a fix in the PR's own thread, then re-audit and re-approval (§3). Move on to the next eligible PR.
3. **Final-head verification (D-CI-5):** wait for `CI gate` to succeed **on the exact final head commit**, and confirm that this commit contains the current `main` (the branch is up to date: `git merge-base --is-ancestor origin/main <head>`). Do this even though branch protection also enforces it (§8). If `main` moves before the merge, sync again and re-verify. Never bypass, re-label or fabricate a green `CI gate`. **How to wait (CIQ-A3):** subscribe to the PR's activity so a completed check suite wakes the thread, and act on the wake straight away. If no wake arrives within 2 minutes of the expected finish, poll the check runs every 2 minutes. Either way, re-read the check runs from GitHub: a wake is a prompt, never evidence. Do not wait idly on a fixed timer while a result is available.
4. **Migration prerequisites:** if the PR has a migration, confirm it was applied and verified under its own migration verdict (protocol, "Production migrations"). A merge verdict never covers it. Then **merge with the head pinned**: call the merge API with `sha` set to the verified final head, so GitHub refuses the merge if anything was pushed after verification. A refusal sends the PR back to step 1, never to a blind retry. Record the approved SHA and the merged commit SHA.
5. **Post-merge verification:** wait for the `main` CI run on the merge commit, the Vercel production deploy and the production smoke check (`GET /api/v1/health` returns `status: ok`, plus any PR-specific check named in the PR). Record the results in the queue table.
6. **Record** the delegated operation record (`docs/agent-task-protocol.md`) as a PR comment, then **continue to the next eligible PR** without asking Regan, unless an escalation or halt condition applies.

### Pipelining

While PR *k*'s final-head CI or post-merge verification is running, the merge-queue thread **prepares PR *k+1***: step 1 (eligibility, verdict detection, migration state) during PR *k*'s CI, and steps 2 and 3 (sync, CI) as soon as PR *k* has merged. It **must not merge PR *k+1*** until PR *k*'s `main` CI run and the required deploy and smoke checks have all succeeded (owner decision D-CIQ-4 on #141: not relaxed, for docs PRs too). If `main` advanced, PR *k+1* is synced and verified again on its new final head before merging. With the CIQ-A1 gate tiers, a docs-tier `main` run finishes in about a minute, so this wait is short for documentation without changing the rule.

Speculative validation of several PRs at once (combined candidates) is **not** part of this procedure (D-CIQ-3 deferred until the CIQ-A measurements are in).

### macOS runner stalls (CIQ-A3, bounded)

The macOS desktop job sometimes never gets a runner and is cancelled at its timeout. Recovery is bounded and fails closed:

1. A queued or running job is pending, never green. A cancelled job is a failure.
2. If the final head's macOS job is still **queued** 15 minutes after the run started, or the run completed with only that job cancelled or failed for infrastructure reasons (no steps ran, runner lost, toolchain download failure), the merge-queue thread may re-run that run **once**: "re-run all jobs" for a run it had to cancel first (wait until it reports `completed`), or "re-run failed jobs" for a completed run. `CI gate` is judged only on the latest attempt, and the thread confirms that attempt re-evaluated every required job.
3. **At most one** operator re-run per head SHA. If a development thread already re-ran it, that is the one. A second stall or failure: report the run links to Regan, pass the PR over and keep its slot.
4. Record the re-run (run id, attempt, reason) in the delegated operation record. Never apply this to `main` runs: a failed `main` run halts the queue (§6) and Regan decides when to resume.

## 6. Halt conditions

The queue **stops all merging** and reports to Regan on any of:

- a failed `main` CI run or a failed production deploy or smoke check,
- an unexpected conflict or unexpected content change,
- a security-sensitive surprise (authentication, admission, RLS, tenant isolation, permissions, financial integrity, migrations, privileged SQL),
- a migration history or checksum mismatch, an unexpected pending migration, a failed recovery branch or an ambiguous target.

Merging resumes only after the cause is understood and Regan says to continue. A failed PR-level check is not a halt: that PR is passed over (§4) and goes back to its own thread. Never improvise production repairs.

## 7. Visibility (D-CI-4)

### Pinned queue issue

One pinned GitHub issue, **#95 "Merge queue"**, mirrors the queue table. The merge-queue thread keeps it current. The table has one row per PR in the queue:

| Pos | PR | Priority | Audit | Approval | Migration | CI (final head) | Blockers | Status |
|---|---|---|---|---|---|---|---|---|

- **Audit:** ChatGPT verdict (APPROVED, CONDITIONAL PASS, …) and the head it applies to.
- **Approval:** a link to the recorded ChatGPT APPROVED verdict, plus a link to Regan's message for any escalated part, or "none".
- **CI (final head):** `CI gate` result and duration on the up-to-date final head.
- **Status:** eligible, blocked, merging, held or merged (with merge SHA and time).

The issue is a mirror, not a source of approval. Only the recorded verdict (and Regan's own messages for escalations) is approval.

### Status labels

| Label | Meaning |
|---|---|
| `queue:eligible` | Meets every condition in §3 at the time it was labelled. |
| `queue:blocked` | Waiting on audit, approval, a migration, a conflict fix or CI. |
| `queue:merging` | The merge-queue thread is syncing, verifying or merging it now. At most one PR. |
| `queue:held` | Regan or the merge-queue thread put it on hold. Never merged while held. |

**Labels are informational only.** They never substitute for a valid approval, and the merge-queue thread re-checks §3 from the source (GitHub, the PR thread, the recorded verdict, Regan's message) before every merge. A label that disagrees with the source is corrected, not trusted. Only the merge-queue thread changes `queue:*` labels, except that Regan may add or remove any label.

## 8. Branch protection (D-CI-5)

Branch protection is **not changed** by this process. It is readable with `GET /repos/{owner}/{repo}/branches/main/protection` (corrected under D-CIQ-6). Measured 2026-11-17: classic protection rule, `strict: true` (branches must be up to date), required check `CI gate` only, `enforce_admins: true`, no required reviews, no rulesets. §5 step 3 still verifies the up-to-date final head itself, so a later settings change cannot silently weaken the queue.

## 9. Reporting

After each queue session the merge-queue thread reports to Regan: PRs merged (with SHAs and links to their delegated operation records), CI duration on each final head, sync runs triggered, macOS re-runs, PRs skipped and why, any halt, outstanding risks, and what needs Regan. The report is oversight after the fact, not a request for approval. "Needs Regan" lists only escalations and halts: never a verdict that already exists, and never an owner decision he has already recorded for the same content.

Throughput is measured the same way each time, so before/after comparisons are honest: median time from the last valid verdict to merge, merge-to-merge time while the queue runs, final-head CI duration by gate tier, re-runs per PR, and PRs merged per hour (CIQ-FAST baseline, 33 merges from 2026-11-16 16:30 to 2026-11-17 16:38 UTC: 39 min, 13.2 min, 7.8 min, 8 re-runs, about 3 PRs an hour while the queue ran).
