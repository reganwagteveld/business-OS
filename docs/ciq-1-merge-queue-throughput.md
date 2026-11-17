# CIQ-1 — Merge queue throughput investigation

**Status:** Audit and design only. Revision 2 (2026-11-17) answers ChatGPT's design audit of `d7b9cb8` (CONDITIONAL DESIGN PASS, seven corrections); the changes are listed in §11. This document changes no workflow, branch protection, required check, repository setting, merge-queue procedure or production setting. Every proposal in it needs its own PR, a ChatGPT audit and, where marked, Regan's decision (§10).
**Measured:** 2026-11-17 15:00 UTC, `main` at `b1732b8`. Data: all 164 runs of `.github/workflows/ci.yml` created since 2026-11-16 16:30 UTC (the end of the previous measurement window in `docs/ci-merge-pipeline-proposal.md` §3), their 1,254 job records, and the 30 PRs merged in that window. Every number below is labelled **measured** (from the GitHub API), **derived** (arithmetic on measured data) or **assumed**.

## 0. Summary

- **The queue is CI-bound, not approval-bound.** Over the 28 queue merges in the window, one queue cycle (merge *k* → merge *k+1*) took a **median of 12–13 minutes**: the head PR is synced with `main` within a minute of the previous merge, its final-head CI takes **7–10 minutes**, and the hand-off from green CI to the merge takes a **median of 3.5 minutes** (measured).
- **The final-head run is unavoidable today for a structural reason, not a procedural one.** Branch protection on `main` has **`strict: true`** (require branches to be up to date) with `CI gate` as the only required check (measured, read from the API in this session). GitHub's merge button never fast-forwards, so after PR *k* merges, every other PR is behind `main` and needs a new head commit with its own green `CI gate`. No speculative result on any other commit can satisfy that.
- **Most of each cycle is one serial job.** The Database job is the critical path of every run (p50 **7.0 min**, p90 8.7 min), and 5.5 minutes of it is the integration step running 33 files one at a time. It runs even for documentation-only PRs: **18 of the 28 queue merges were docs-only PRs** that each spent 7–10 minutes on a Database job that cannot be affected by their change (measured).
- **The approved but unbuilt fixes are the largest lever.** D-CI-2 (docs and client tiers) and D-CI-3 (Database shards) were approved on 2026-11-16 and are not implemented yet (only the desktop-matrix skip, CI-2A, exists). In the model they take the 12-PR backlog from **≈2.5 hours to ≈100 minutes** on their own, and to **≈70 minutes** if the queue thread also reacts to a green check within about a minute instead of the measured 3.5. These are model scenarios, not guarantees (§5), and the merge model and the post-merge `main` CI, deploy and smoke gates stay exactly as they are.
- **Speculative validation (B) can roughly halve that again, but only by changing how `main` is updated** (the coordinator fast-forwards `main` to a validated candidate commit instead of pressing the merge button) and by relaxing one pipelining rule. That is a material change to the trust model and is recommended only as a later, separately approved phase, if Approach A's measured result is not enough.
- **GitHub's native merge queue (C) is not available to this repository** as it stands: it is user-owned (`owner.type: User`), and GitHub documents merge queues for organisation-owned repositories. Using it would mean transferring the repository to an organisation, and even then it would not enforce our verdict, migration or per-merge deploy checks by itself.

**Recommendation:** implement Approach A now, in three small PRs (§6), measure, and decide on B with the measurements in hand. Decisions needed from Regan are in §10.

## 1. Repository evidence

### 1.1 Settings read in this session (measured, read-only API)

| Setting | Value | Source |
|---|---|---|
| Owner type, visibility | `User`, public | `GET /repos/{owner}/{repo}` |
| Branch protection on `main` | Classic rule. `required_status_checks.strict: true`, contexts `["CI gate"]` (app id 15368, GitHub Actions), `enforce_admins: true`, no required reviews, no required signatures, linear history off, force pushes and deletions off, conversation resolution off | `GET /repos/{owner}/{repo}/branches/main/protection` |
| Rulesets | None (`[]` for the repository and for `main`) | `GET /rules/branches/main`, `GET /rulesets` |
| Merge methods | squash, merge and rebase all allowed; queue uses squash | repository settings |
| Auto-merge | **Off** (`allow_auto_merge: false`) | repository settings |
| "Update branch" button | Off (`allow_update_branch: false`) | repository settings |
| Native merge queue | Not configured (no ruleset, no `merge_group` trigger) | as above, `ci.yml` |

`docs/merge-queue.md` §8 and `docs/ci-merge-pipeline-proposal.md` §10 say the protection setting cannot be read by the integration. With this session's credentials it can; §10 D-CIQ-6 proposes correcting that in a docs PR.

**Could not be inspected:** the merge-queue thread's own internal logic (it is a Claude thread, not code in the repository; its behaviour is inferred from GitHub timestamps), the GitHub Actions concurrency limits on this account (documented limits are used as assumptions), Vercel deploy durations and the production smoke-check timing (not exposed through GitHub; assumed 2 minutes), and whether native merge queue would be offered after a transfer (documented, not tested).

### 1.2 Workflows

| Workflow | Triggers | Concurrency | Relevance |
|---|---|---|---|
| `ci.yml` | `pull_request` (opened, synchronize, reopened), `push` to `main` / `release/**` / `v*`, `workflow_dispatch` (any ref, always full tier), `workflow_call`, weekly schedule | PRs: group `ci-pr-<n>`, cancel in progress. Everything else: group per run id, never cancelled | The only gate. **No `merge_group` trigger.** |
| `nightly.yml` | 18:00 UTC daily, manual, PRs touching itself | one at a time | Not a merge gate |
| `visual.yml` | PRs touching UI paths, manual | per PR | Non-gating |

Key mechanics, all from `ci.yml` and `.github/scripts/`:

- **A `pull_request` run already tests the combination.** The checkout is GitHub's merge commit of the PR head into the base tip at the time the run starts (`changed-files.sh` requires a 2-parent `HEAD`). So every PR run validates "base at that moment + PR", but only that base.
- **Base changes do not start runs.** `pull_request` fires on pushes to the PR branch, not on pushes to `main`. A green result simply goes stale when `main` moves, and with `strict: true` GitHub then refuses the merge until the branch is updated and re-run.
- **Tiering exists only for the desktop matrix** (CI-2A). `classify-changes.sh` returns `docs`, `server` or `full`, but `static`, `unit`, `database` and `build` always run. The docs and client tiers (D-CI-2) are not built.
- **The Database job is one job.** `apps/api/vitest.integration.config.ts` sets `fileParallelism: false`; 33 integration files run serially against one PostgreSQL service, then seven suites again behind PgBouncer. Sharding (D-CI-3) is not built.
- **Database test isolation per run is total.** Each run's Database job gets its own `postgres:16.10` service container on its own runner VM, provisioned from `docker/init/01-roles.sql`, migrated from scratch, and thrown away. CI uses no shared database, no Neon branch and no external service. Inside one job, suites isolate rate-limit state through per-suite IP blocks (`*_TEST_IP_BLOCK`). **Concurrent runs therefore cannot interfere with each other's database.** The shared resources are runner capacity (notably macOS) and, for pushed branches, Vercel preview builds.
- **The migration-order check runs only on `pull_request`** (it diffs `HEAD^1` against `HEAD`). Any new trigger (`merge_group`, a candidate branch) would need it added explicitly.
- **`CI gate`** (`ci-gate.sh`) fails closed: every applicable job must be `success`; a skipped desktop matrix is accepted only with a successful classifier, `desktop=false` and tier `docs` or `server`.

### 1.3 Process documents

`CLAUDE.md`, `docs/agent-task-protocol.md` ("Approvals", "Approval follows content", "Production migrations") and `docs/merge-queue.md` define: development threads never merge or sync for the queue; one merge-queue thread syncs the head PR, verifies `CI gate` on the exact up-to-date final head, checks the `APPROVED — EXECUTE: MERGE` verdict's provenance and the patch-id, merges, then verifies `main` CI, the Vercel deploy and `/api/v1/health`. It may prepare PR *k+1* while PR *k*'s post-merge checks run, but may not merge *k+1* until they pass. There is no `AGENTS.md` at the repository root (only `apps/api/AGENTS.md`, about Next.js). PR #53 (a coded coordinator) is idle and not part of the workflow.

## 2. Current-state workflow

```text
 development thread                    ChatGPT (connector)            merge-queue thread (one PR at a time)
 ───────────────────                    ───────────────────            ──────────────────────────────────────
 push commits ──► pull_request CI       audit exact head
 (base = main@push time)       │        AUDIT PASS / CHANGES REQUIRED
        │                      │        APPROVED — EXECUTE: MERGE (head SHA)
        ▼                      ▼                        │
   green on head H ◄───────────┘                        ▼
        │                                     waits in queue (others ahead)
        │                                               │
        │            ┌──────────────────────────────────┘
        │            ▼
        │   (1) previous PR merged → main moves → H is stale (strict: true)
        │   (2) sync: merge main into branch → new head F  ──► pull_request CI on F (7–10 min, full suite)
        │   (3) verify CI gate on F, F contains main, patch-id(F) = patch-id(H), verdict provenance
        │   (4) merge (squash)  ──► push to main ──► main CI (7–9 min) ┐
        │                                     └──► Vercel deploy ─► smoke   ├─ must pass before next merge
        │   (5) operation record; next PR's step (2) starts immediately ┘   (pipelined with its CI)
```

### 2.1 One PR traced: #132 (WP-R1), measured

| Time (UTC) | Event | Elapsed |
|---|---|---|
| 12:34:59 | Commit `12a34ca` pushed | |
| 12:39:32 | PR opened (draft); CI run 1 on `main`+`12a34ca` | |
| 12:47:38 | CI run 1 green (8.0 min) | |
| 12:51:44 | ChatGPT `AUDIT PASS` | +4 min |
| 12:52:55 | ChatGPT `APPROVED — EXECUTE: MERGE` | +1 min |
| 12:54:40 | Marked ready for review | |
| 12:54 → 14:40 | **Waiting in the queue** behind 7 other PRs | **106 min** |
| 14:40:44 | Previous PR (#137) merged; `main` = `b7fd5eb` | |
| 14:40:47 | Queue syncs: merge commit `00cb0c5` (3 s after `main` moved) | |
| 14:40:54 → 14:54:31 | Final-head CI on `00cb0c5`: **13.6 min**, of which the macOS desktop job **waited 10.1 min for a runner** | |
| 14:58:07 | Merged as `b1732b8` | hand-off 3.6 min |
| 14:58:10 | `main` CI starts; next PR (#133) synced at 14:58:19 | |

Total from approval to merge: **2 h 05 min**, of which 17 minutes were this PR's own queue cycle and 106 minutes were other PRs' cycles.

### 2.2 Answers to the brief's questions

1. **Where CI starts and why.** On every push to a PR branch (`pull_request` synchronize), on PR open/reopen, and on every push to `main`. The PR run tests the merge commit of head into the current base.
2. **What triggers re-runs.** New commits on the PR (cancelling the previous run), the queue's sync merge (a new commit), manual re-runs after an infrastructure fault (3 `main` runs needed a second attempt in the window), and each merge to `main`. A move of `main` does **not** trigger a PR run; it only makes the earlier one insufficient.
3. **Does the whole suite re-run after every sync?** Yes. The sync commit's diff against the base is the PR's whole diff, so the tier is the same as the PR's; static, unit, database and build always run; the desktop matrix runs for every `full`-tier PR. 32 of the 106 successful PR runs in the window were sync runs (measured); 28 of them were the queue's final-head runs, so D-CI-1 (no repeated development syncs) is working.
4. **Does the coordinator serialise only merges, or CI too?** Both, in effect. The procedure allows preparing PR *k+1* while PR *k*'s post-merge checks run, and the data shows it does (sync within 0–3 s of the previous merge). But PR *k+1*'s final-head run cannot start before PR *k* merges, because it must contain the new `main`. So final-head CI runs strictly one at a time. Only `main` CI for *k* and PR CI for *k+1* overlap.
5. **Can multiple PRs share integration-test infrastructure safely?** Yes, across runs: each run has its own disposable PostgreSQL and PgBouncer on its own VM. There is no shared database to protect. The constraints are runner concurrency (documented free-plan limits: 20 concurrent jobs, 5 concurrent macOS jobs per account, assumption) and the macOS runner pool, which stalled 4 of 67 macOS jobs by more than 5 minutes in the window (max 10.1 min, measured).
6. **What makes a green result insufficient?** Only a new `main` commit (enforced by `strict: true` and by `docs/merge-queue.md` §5 step 3), or new PR content (which also invalidates the verdict). The green run validated `oldmain + PR`; GitHub requires a passing `CI gate` on a commit that contains the current `main`.
7. **Does approval add waiting after the checks pass?** Little. Verdicts arrived within minutes of audit for #127 and #132. After the sync, "Approval follows content" lets the queue keep the verdict through a conflict-free sync with an unchanged patch-id, so no re-audit is needed at the head. The remaining waits are the **hand-off** after green CI (median 3.5 min, max 9.3 min in normal operation; measured) and PRs that are **not yet eligible** (missing verdict, draft without "ready and merge", unapplied migration, escalation), which the queue skips without delay.

## 3. Measurements

### 3.1 CI durations (measured, successful first attempts unless stated)

| Population | n | p50 | p90 | max |
|---|---|---|---|---|
| PR runs, desktop matrix ran | 43 | 7.7 min | 9.2 min | 13.6 min |
| PR runs, desktop matrix skipped | 59 | 7.3 min | 9.2 min | 10.0 min |
| PR sync runs (all attempts) | 32 | 8.3 min | 9.7 min | 13.6 min |
| `main` push runs | 25 | 7.2 min | 9.3 min | 13.1 min |

### 3.2 Job durations and runner waits (measured, 1,254 job records)

| Job | n | duration p50 / p90 / max | wait p50 / p90 / max | waits > 5 min |
|---|---|---|---|---|
| Detect changes | 158 | 0.2 / 0.3 / 0.3 | 0.0 / 0.2 / 1.4 | 0 |
| Static checks | 155 | 1.5 / 1.8 / 2.0 | 0.0 / 0.2 / 1.6 | 0 |
| Unit, contract, architecture | 153 | 1.3 / 1.6 / 1.8 | 0.0 / 0.1 / 1.7 | 0 |
| Build verification | 155 | 1.2 / 1.4 / 1.6 | 0.0 / 0.1 / 1.3 | 0 |
| **Database** | 136 | **7.0 / 8.7 / 10.4** | 0.0 / 0.1 / 1.4 | 0 |
| Desktop Linux | 67 | 2.5 / 3.0 / 5.1 | 0.0 / 0.2 / 1.3 | 0 |
| Desktop Windows | 67 | 3.2 / 3.6 / 4.3 | 0.0 / 0.2 / 1.3 | 0 |
| Desktop macOS | 67 | 2.7 / 3.2 / 4.8 | 0.1 / 0.6 / **10.1** | **4** |
| CI gate | 135 | 0.1 / 0.3 / 0.3 | 0.0 / 0.1 / 1.1 | 0 |

Database job steps (run on `32bc003`, 9.2 min): container start 15 s, workspace setup 22 s, migrations and privileged SQL 3 s, **integration tests 332 s (33 files, serial)**, RLS spike behind PgBouncer 16 s, seven pooler suites 147 s, `db:check-migrations` 3 s. The Database job has grown from ≈6.5 min (2026-11-16) to a 7.0 min median as suites were added.

### 3.3 Queue activity (measured, 28 merges with a final run in the window)

| Measure | Value |
|---|---|
| Sync start after previous merge | 0–3 s when the queue is running |
| Final-head CI | p50 ≈ 7.8 min, range 6.7–13.6 min |
| Green CI → merge (hand-off) | median 3.5 min, range 0.2–9.3 min (excluding two waits on an external step: #110 164 min for its migration, #118 22 min) |
| Merge-to-merge while the queue ran continuously | median 12–13 min; 13:12–14:58 UTC: 9 merges in 106 min (11.8 min each) |
| Docs-only share of merges | 18 of 28 |
| PR CI failures in the window | 1 of 107 completed PR runs (25 more were cancelled by newer commits) |
| `main` CI failures in the window | 0 (3 runs needed a re-run of a failed infrastructure job) |
| Queue syncs that conflicted | not determinable from the API (a conflicted sync never produces a run); none recorded in the queue's merge records |

### 3.4 The backlog being modelled (measured at 15:00 UTC)

Twelve open PRs: #113, #114, #119, #120, #122, #124, #127, #129, #130, #133, #135, #136. Running `classify-changes.sh` over each PR's changed files: **1 `docs`** (#114) and **11 `full`** (desktop matrix required). Three touch `apps/api` (#120, #133, #135); #135 carries a migration and cannot merge until its migration is applied under its own verdict. Several are drafts without a current verdict, and #119, #122 and #124 are activations. The model below assumes all twelve are eligible, which overstates real throughput: **today eligibility, not CI, will often be the binding constraint.**

## 4. Approaches

### 4.A Improve the existing sequential queue

Keep one integration candidate at a time, exactly as today, and shorten each cycle:

| Lever | Status | Effect on a queue cycle |
|---|---|---|
| **A1 Docs tier (D-CI-2)**: when every changed path is ordinary documentation prose or images, run only Detect changes and a docs check; governance and operational documents are never in this tier (§4.A.1) | Approved, not built | Docs-only cycle 7–10 min → ≈1–1.5 min CI. 18 of the last 28 merges were docs-only |
| **A2 Client tier (D-CI-2)**: client-only source changes skip **only** the Database job; static, unit, contract, architecture, build, bundle-leak and (where the desktop closure is touched) native desktop checks all still run (§4.A.2) | Approved with conditions, not built | Client-only cycle limited by the desktop matrix (≈3.5–4 min) |
| **A3 Database shards (D-CI-3)**: three integration shards plus one RLS/PgBouncer job, each with its own fresh PostgreSQL, roles, migrations and privileged SQL, and an executable completeness check (§4.A.3) | Approved, not built | Database critical path 7.0 → ≈3–3.5 min (derived: 332 s / 3 + ≈60 s setup; pooler job ≈3 min) |
| **A4 Faster hand-off with a SHA-pinned merge**: the queue thread subscribes to PR activity so a completed check suite wakes it, re-verifies everything, and merges with the REST `sha` precondition. This is a conversational operator woken by an event, not a durable daemon (§4.A.4) | Procedure change only | Hand-off 3.5 min median → ≈1 min **if** wakes arrive and are acted on promptly (assumption, to be measured); otherwise unchanged |
| **A5 Pre-flight before sync**: the queue confirms eligibility (verdict provenance, patch-id, draft flag, migration state) for the next PR while the current one's CI runs, so step (2) starts the second `main` moves | Mostly done today | Small; prevents occasional multi-minute gaps |
| **A6 macOS stall recovery**: one bounded, whole-run cancel-and-re-run per head SHA, with explicit fail-closed mechanics (§4.A.5) | Procedure change only | Caps the macOS tail (4 of 67 jobs waited > 5 min) |

Not proposed: GitHub auto-merge. It has no head-SHA pin, so a commit pushed after arming could merge on green without a verdict for it, which breaks "Approval follows content". The `sha` precondition in A4 gives the same latency without that risk.

Safety: unchanged merge model; every merge still has a green `CI gate` on the exact up-to-date head; tiers are fail-closed allow-lists with self-tests; shards keep every suite and every pooler suite. **Approach A keeps every post-merge gate exactly as today:** PR *k+1* is not merged until PR *k*'s `main` CI run, Vercel deploy and smoke check have succeeded (`docs/merge-queue.md` §5 and §6). A tier never grants merge permission: it only decides which jobs `CI gate` requires; approval still comes only from a verified verdict.

#### 4.A.1 Docs tier: ordinary documentation only

The existing CI-2A classifier treats every `docs/**/*.md` and every root `*.md` (including `CLAUDE.md`) as `docs`. That is acceptable for skipping a Tauri build, but **must not be reused** for a tier that skips static, unit, database and build. CIQ-A1 adds a separate classifier output, so the CI-2A desktop decision is unchanged:

| Path | Tier |
|---|---|
| `docs/**` markdown and images **not** listed below | `docs` |
| `CLAUDE.md`, any `AGENTS.md`, `docs/agent-task-protocol.md`, `docs/agent-context.md`, `docs/merge-queue.md`, `docs/active-workstreams.md`, `docs/ci*.md`, `docs/migration-readiness.md`, `docs/deployment.md`, `docs/private-beta-lockdown.md`, `docs/operations/**`, `docs/adr/**`, any other root `*.md` | `full` (governance, policy and operational instructions) |
| any `.github/**`, `*.sql`, `*.prisma`, migration, code-generation input or unknown path, anywhere | `full` |
| a mix of `docs` and anything else; an empty, unreadable or unestablished diff; a rename or deletion (listed as both paths) | `full` |

Governance documents get the full suite plus their own governance review (owner approval where the approval model changes), never a lighter path. The list is an allow-list for `docs`: a new document type is `full` until it is added deliberately with self-tests.

#### 4.A.2 Client tier: exactly what may be skipped

The CI-2A `server` tier (skip the desktop matrix for API/web-only source) is **not** generalised. The client tier is a new, separate outcome, and its only effect is to skip the Database job:

| Job | `docs` | `client` | `full` |
|---|---|---|---|
| Detect changes (incl. all classifier and gate self-tests) | runs | runs | runs |
| Static checks (contracts snapshot, typecheck, lint, boundaries) | skipped | **runs** | runs |
| Unit, contract and architecture tests (`pnpm test`, every package) | skipped | **runs** | runs |
| Build verification (API, web, desktop frontend, boot, bundle leak scan) | skipped | **runs** | runs |
| Database (roles, migrations, integration, RLS, pooler suites) | skipped | **skipped** | runs |
| Desktop matrix | skipped | runs if any path is in the desktop dependency closure (existing CI-2A rule) | runs |
| Docs check (links, no secrets pattern) | runs | runs | runs |

`client` requires **every** path to be source (`.ts`, `.tsx`, `.css`) under `packages/app/src/`, `packages/ui/src/` or `apps/web/src/`, and **none** under any path that is `full`: `apps/api/**`, `packages/contracts/**`, any auth, session, admission or permission module (named in the classifier, e.g. `packages/app/src/auth/**`), any `package.json`, lockfile, `tsconfig*`, `*.config.*`, hidden file, `.github/**`, `apps/desktop/src-tauri/**`, or an unknown path. The proof that skipping the Database job is safe is structural and already enforced on every run: clients reach data only through `/api/v1` (`pnpm boundaries` and the architecture tests forbid database or server imports in client packages), and the client tier still runs those checks. Self-tests must cover: lockfile and manifest changes inside client paths, contracts, auth paths, shared packages, mixed diffs, renames into and out of client paths, deletions, odd path names, an empty list, and a classifier failure, each expecting `full`.

#### 4.A.3 Shards: executable completeness and negative proofs

- **Manifest job** (no database): enumerates the integration test files (`vitest list --config vitest.integration.config.ts --json` or the same glob vitest uses), writes `manifest.json` (file ids, expected count) as an artifact, and fails if the list is empty or differs from a committed snapshot without the snapshot being updated in the same PR.
- **Three shard jobs** (`strategy.fail-fast: false`, `--shard=i/3`): each has its own PostgreSQL service, provisions roles from `docker/init/01-roles.sql`, runs `prisma migrate deploy` as the owner role and `db:privileged` as the admin role, so role separation is identical to today, then writes a JSON reporter file as an artifact even on failure (`if: always()` upload).
- **Pooler job**: own PostgreSQL and PgBouncer; runs S1–S13 and the seven pooler suites from a fixed, committed list of eight entries, and reports per-suite results.
- **Completeness job** (`needs` all of the above, `if: always()`): downloads every report and fails unless each manifest file appears in exactly one shard report, every file executed at least one test, no report is missing, empty, unreadable or truncated, no test failed or was skipped by a filter, the totals match, and all eight pooler entries ran. `db:check-migrations` runs here or in a shard, never dropped.
- **`CI gate`** `needs` the manifest, every shard (matrix result aggregated by `needs.<job>.result`, which is `failure` if any shard failed and `cancelled`/empty if one did not finish), the pooler job and the completeness job, and requires `success` for each on any non-`docs`/`client` tier. A missing job result fails closed.
- **Negative proofs** (on a throwaway branch, linked in the PR): a failing test in each shard, in the pooler job, a deleted shard report, an extra unlisted test file and an empty shard each turn `CI gate` red.

#### 4.A.4 Hand-off: who acts, on what trigger, with what guarantees

The merge-queue thread is a **conversational Claude operator**, not a durable worker. The mechanism available today, and the one CIQ-A3 would document:

| Concern | Mechanism |
|---|---|
| Actor | The merge-queue thread only, as today. No new worker, bot or GitHub App. |
| Trigger | A PR-activity subscription on the head PR: GitHub delivers a `check_suite.completed` event that wakes the thread (observed for this PR: the wake arrived about 10 seconds after the run finished). If no wake arrives within a set time, the thread falls back to polling. Either way it re-reads the check runs from GitHub; the event is a prompt, never evidence. |
| Authorisation | Unchanged: verdict provenance, patch-id, eligibility, escalation, migration state and `main` post-merge gates re-checked from source before every merge. |
| Idempotency | The merge call carries `sha` = the verified final head. GitHub rejects it if the head moved; a repeated call on an already merged PR fails harmlessly. A rejection sends the PR back to eligibility checks, never a retry without re-verification. |
| State | Issue #95 table and the delegated operation record on each PR, as today; the thread re-derives state from GitHub after any restart. |
| Limits | A wake can be missed or delayed, and the thread may be busy. The faster hand-off is therefore an **expected** gain to be measured (§9), not a guarantee; §5 models both outcomes. Nothing merges unattended. |

#### 4.A.5 macOS stall recovery: bounded and fail closed

1. A job that is queued or running is never treated as anything but pending; a stall is not a green check.
2. If the macOS job of the head PR's final run is still **queued** 15 minutes after the run started (the measured maximum wait was 10.1 minutes), the queue thread may **cancel the whole workflow run**, wait until the run reports `completed` (conclusion `cancelled`), then **re-run all jobs** of that run once. This creates a new attempt on the same head SHA; every required job runs again, and `CI gate` is judged only on the latest attempt.
3. Partial re-runs ("re-run failed jobs") are used only for a run that has **completed** with an infrastructure failure of a desktop job, and the thread confirms that the new attempt's `CI gate` re-evaluated every required job's result.
4. At most **one** operator-initiated recovery per head SHA. A second stall or failure is reported to Regan with the run links, and the PR is passed over, keeping its slot.
5. The recovery is recorded in the delegated operation record (run id, attempts, reason). It never changes a required check, never re-labels a result, and never applies to `main` runs, which are left to finish (a failed `main` run halts the queue as today).

### 4.B Speculative validation

Validate cumulative candidates `C1 = main + PR1`, `C2 = main + PR1 + PR2`, … concurrently, and land them in order.

**The blocking fact.** With the merge button and `strict: true`, a green `C2` cannot be used: after PR1 merges, GitHub requires PR2's *own head* to contain the new `main` and to carry a green `CI gate`. A speculative result therefore saves time only if `main` is advanced **to the validated candidate commit itself**. Two ways exist:

1. **Fast-forward push by the coordinator** (bors-style). Branch protection does not require pull requests, and `enforce_admins: true` with a required `CI gate` means a direct push to `main` is accepted only if the pushed commit already has a green `CI gate` and contains `main` (fast-forward). The coordinator pushes `C1`, verifies deploy and smoke, then pushes `C2`, and so on.
2. Native merge queue (Approach C), which does the same thing internally.

Disabling `strict` would also make speculation usable, but it would remove the only platform-enforced guarantee that the merged combination was tested, so it is not considered (D-CI-5 stands).

**Design if B is chosen later.**

| Concern | Design |
|---|---|
| Candidate construction | For queue positions 1..*c*: `C_k = merge(C_{k-1}, PR_k approved head)` with `--no-ff`, starting from the current `main` tip. Pushed to a reserved namespace `queue/candidate/<main-sha7>/<k>`. Built only from PRs that are eligible now (verdict verified, patch-id computed). |
| CI on candidates | Today, `workflow_dispatch` on the candidate ref runs the full tier with no workflow change. A proper implementation adds `push` on `queue/candidate/**` with the tier classified against the candidate's first parent, plus the migration-order check for that event. |
| Identities | Each PR has a **reviewed identity**: PR number, approved head SHA, `git patch-id --stable` of `approved-base...approved-head`. Each candidate has an **integration identity**: candidate commit SHA, tree SHA, base `main` SHA, and the ordered list of reviewed identities, written as commit trailers (`Queue-Base:`, `Queue-PR: #n <sha> <patch-id>`). The merge record links both: "verdict covered patch P of #n; CI covered candidate commit X containing exactly patches P1..Pk on base B". |
| Landing | Fast-forward `main` to `C_k` only if `main` is exactly the commit `C_k` was built on (`C_{k-1}`, or the original tip for k = 1), `C_k` has a green `CI gate`, every PR in it is still eligible with an unchanged head, and `C_{k-1}`'s deploy and smoke checks passed. Using merge commits (not squash) keeps each PR's head as an ancestor of `main`, so GitHub marks the PR merged. This changes `main`'s history style from squash to merge commits. |
| Invalidation | Any of: a candidate fails CI; a PR in it gets a new commit, loses its verdict, becomes held or ineligible; `main` moves by anything other than the expected fast-forward; the queue is reordered above position *k*. Effect: cancel `C_k` and every later candidate, delete their refs, rebuild from the first invalid position. A failed `C_k` sends PR *k* back to its thread; its successors are rebuilt without it. |
| Conflicts | A merge conflict while building `C_k` means PR *k* is not speculatively mergeable: it is passed over (§4 of the queue doc) and goes back for a fix and re-audit, never resolved by the queue. |
| Reordering | Allowed only above the first in-flight candidate, or by cancelling all candidates. Priority rules are unchanged. |
| Migrations | A PR with a migration (or privileged SQL) is never speculated past: it runs alone at depth 1 after its migration is applied, so no candidate ever combines unapplied schema with other changes. |
| Escalations and activations | Same: depth 1, alone, after Regan's approval is recorded. |
| Post-merge checks | Each fast-forward is one production deploy and one smoke check, as today. The rule "do not merge *k+1* until *k*'s `main` CI passed" becomes "until *k*'s deploy and smoke passed, and `main` CI on `C_k` is not failed"; the `main` run on `C_k` is a re-test of an identical tree (same tree SHA as the green candidate), so waiting for it adds ≈7 minutes per PR without new information. A failing `main` run still halts the queue. This relaxation is a decision for Regan (D-CIQ-4). |
| Runner limits | Each full candidate uses 5 Linux jobs and 3 desktop jobs. Depth 4 plus normal development traffic can reach the 5-job macOS limit, which is where the measured 10-minute stalls come from. |
| Side effects | Pushing candidate branches triggers Vercel preview builds for both projects unless an ignore rule is added (a deploy-config change, Regan only). `workflow_dispatch` also needs the candidate ref to exist on GitHub, so it has the same effect. |

### 4.C Native GitHub merge queue

| Aspect | Finding |
|---|---|
| Availability | GitHub documents merge queues for public repositories **owned by organisations** (and private ones on Enterprise Cloud). This repository is owned by a user account (measured `owner.type: User`). Not available as is. Not tested: enabling it is out of scope. |
| What it would take | Transfer `business-OS` to a (free) organisation; re-check the Vercel Git integration, the `chatgpt-codex-connector` and Claude GitHub App installations, and the remote-control checkout, all of which are bound to the repository; replace the classic rule with a ruleset or protection that requires the merge queue; add `merge_group:` to `ci.yml`; teach `changed-files.sh` the `merge_group` event (today it would fail closed to `full`, which is safe but loses tiering); run `check-migration-order` on `merge_group` too. Settings: merge method, build concurrency, minimum and maximum group size, wait time, "only merge non-failing pull requests", status check timeout. |
| Compatibility with our gates | **Verdict:** anyone with write access can add a PR to the queue, and GitHub then merges automatically. Our `APPROVED — EXECUTE: MERGE` rule would have to be enforced either by discipline (only the queue thread enqueues) or by a new required `merge_group` check that reads the PR's verdict comment, checks the app slug, unedited state, head SHA and patch-id, and fails closed. **Migrations:** the same check would have to fail when a PR's migration is not recorded as applied. **Post-merge halt:** GitHub merges each passing group on its own; with concurrency above 1, several merges can land before our deploy and smoke checks for the first one finish, and a group lands as one push (one deploy for several PRs). With group size 1 and concurrency 1 the gain over Approach A disappears. |
| Verdict | Possible only after a repository transfer, and even then it automates the mechanics while our approval, migration and per-deploy checks would need custom required checks. More moving parts than A, less control than B. Not recommended now. |

### 4.D Comparison

| | A Optimised sequential | B Speculative (fast-forward) | C Native merge queue |
|---|---|---|---|
| Available now | Yes | Yes, with a new merge mechanism | No (user-owned repository) |
| Changes to merge model | None | `main` updated by coordinator push; merge commits instead of squash | GitHub merges automatically |
| Workflow changes | Tiers, shards (already approved) | Candidate trigger, migration-order on candidates | `merge_group` trigger, verdict and migration checks |
| Settings changes | None | None required (push already permitted under protection); Vercel ignore rule advisable | Transfer, ruleset, merge queue |
| Modelled 12-PR time (p = 0.05, scenarios) | ≈100 min (polling hand-off) to ≈68 min (prompt wake) | ≈45 min (on A's CI, depth 2, needs D-CIQ-4) | Not modelled (unavailable) |
| Main risk | Tier classifier mistakes (mitigated: fail-closed allow-list, self-tests) | Coordinator push rights and candidate bookkeeping; invalidation logic bugs | Loss of per-merge control; approval enforcement moves into a custom check |

## 5. 12-PR backlog throughput model

**These are model scenarios, not performance guarantees.** They compare designs under the same assumptions; only a measured before/after window (§9) shows real gains, and that window is required before B is considered.

**Method.** A Monte Carlo model (4,000 runs per scenario) of the 12-PR backlog (1 docs, 11 full-tier, §3.4), with CI durations, `main` CI durations and hand-off times drawn from the measured distributions in §3. Every sequential scenario keeps today's rule: PR *k+1* merges only after PR *k*'s `main` CI has succeeded. Assumptions, all labelled:

- Every PR is eligible and audited (assumption; real eligibility is lower).
- Per-PR probability of a failed final-head run or a sync conflict: **p = 0.05** and **p = 0.15** (assumption; the window shows 1 failed PR run in 107, but conflicts at the head cannot be measured). A failed PR leaves the queue and goes back to its thread; in B it also invalidates every later candidate.
- Deploy plus smoke: 2 min (assumption).
- Optimised CI: docs 1–1.5 min; full and client runs at 55% of today's duration (derived from A2/A3: Database 7.0 → ≈3.3 min, desktop matrix ≈3.5 min becomes the critical path), pessimistic bound 70%; `main` CI at 60%.
- Hand-off: either the measured distribution (median 3.5 min, "polling") or 0.5–1.5 min ("prompt wake", assumption for A4).
- Speculative scenarios start each round of *c* candidates together from the current `main` and do not overlap rounds (conservative for B). Rows marked "+ contention" add a 0–10 min macOS wait to 30% of candidates (assumption, from the 5-job macOS limit and the measured stalls).

**Calibration.** The "existing sequential" scenario gives 12.8 min per merged PR, against 11.8–13 min measured for the live queue (§3.3).

**How to read the columns.** Elapsed time alone is misleading: at a higher failure rate fewer PRs merge, and a removed PR stops consuming queue time, so the total can even fall. Each row therefore shows merged and failed (returned) PRs and minutes per merged PR.

| Scenario | p = 0.05: elapsed p50 / p90 | merged / returned | min per merged PR | p = 0.15: elapsed p50 / p90 | merged / returned | min per merged PR |
|---|---|---|---|---|---|---|
| 1 Existing sequential CI | 147 / 159 | 11.4 / 0.6 | 12.8 | 145 / 157 | 10.3 / 1.7 | 14.1 |
| 2a A: tiers + shards, measured hand-off | 100 / 110 | 11.4 / 0.6 | 8.7 | 99 / 109 | 10.3 / 1.7 | 9.5 |
| 2c A pessimistic: CI at 70%, measured hand-off | 108 / 119 | 11.4 / 0.6 | 9.5 | 108 / 119 | 10.3 / 1.7 | 10.5 |
| 2b A: tiers + shards + prompt wake hand-off | **68 / 72** | 11.5 / 0.5 | **5.9** | 67 / 72 | 10.4 / 1.6 | 6.5 |
| 3 B depth 2, today's CI, keep "wait for `main` CI" | 124 / 134 | 11.4 / 0.6 | 10.8 | 122 / 133 | 10.3 / 1.7 | 11.8 |
| 3b B depth 2, today's CI, D-CIQ-4 relaxation | 87 / 97 | 11.5 / 0.5 | 7.6 | 91 / 103 | 10.4 / 1.6 | 8.8 |
| 4 B depth 4, today's CI, relaxation | 60 / 71 | 11.4 / 0.6 | 5.3 | 67 / 81 | 10.3 / 1.7 | 6.5 |
| 4p same + contention | 67 / 81 | 11.4 / 0.6 | 5.8 | 75 / 91 | 10.3 / 1.7 | 7.2 |
| 5 B depth 2 on optimised CI, relaxation | 45 / 49 | 11.4 / 0.6 | 3.9 | 46 / 50 | 10.3 / 1.7 | 4.4 |
| 6 B depth 4 on optimised CI, relaxation | 36 / 39 | 11.4 / 0.6 | 3.2 | 37 / 41 | 10.3 / 1.7 | 3.6 |
| 6p same + contention | 44 / 52 | 11.4 / 0.6 | 3.8 | 45 / 55 | 10.3 / 1.7 | 4.4 |

**Reading the model.**

- Tiers and shards alone (2a) give **≈1.5×** (147 → 100 min). With a prompt hand-off (2b) the model gives **≈2.2×** (→ 68 min), because once CI is short the 3.5-minute hand-off is a large share of each cycle. Whether 2b is reachable depends on how reliably the conversational operator acts on wakes, which must be measured; the planning figure is the range **≈70–110 minutes**.
- Speculation on today's CI, keeping today's rule of waiting for `main` CI before the next merge, gives only ≈15%: the 7–9 minute `main` run becomes the bottleneck. B only pays off with the D-CIQ-4 relaxation, which is **not** part of A and not approved.
- On optimised CI, depth 2 adds ≈1.5× over 2b (68 → 45 min). Depth 4 adds little once runner contention is included (6p ≈ 5). **Depth 2 is the sensible ceiling** if B is ever adopted.
- A real 12-PR backlog takes longer than any row because PRs reach eligibility at different times; at today's verdict cadence, A is likely to make the queue wait on eligibility rather than CI.

## 6. Recommended architecture

**Approach A, then measure, then decide on B.** Concretely:

1. **CIQ-A1, tiers (implements approved D-CI-2).** A new classifier output (`gate_tier`: `docs`, `client` or `full`) beside the unchanged CI-2A desktop decision, following §4.A.1 and §4.A.2 exactly; `ci.yml` makes `static`, `unit`, `database` and `build` conditional on it; `ci-gate.sh` accepts a skipped job only when the classifier succeeded and its explicit output permits that skip for that job (extend `ci-gate.test.sh` for every combination: each tier × each job result including cancelled, skipped and missing; failed classifier; missing tier). On a `push` to `main` a `docs`-tier commit still produces a complete, non-pending `CI gate` (skipped jobs are explicitly permitted, never left pending), and the queue still waits for that `main` run, the Vercel deploy and the smoke check before the next merge.
2. **CIQ-A2, shards (implements approved D-CI-3).** Manifest job, three isolated shards, the pooler job and the completeness job wired into `CI gate` as in §4.A.3, with the negative proofs listed there.
3. **CIQ-A3, queue procedure (docs, approval-model change, so Regan's own approval).** The hand-off mechanism in §4.A.4 (PR-activity wake plus polling fallback, SHA-pinned merge, re-verification from source); pre-flight eligibility for the next PR during the current run; the bounded macOS recovery in §4.A.5; no change to the post-merge `main` CI, deploy and smoke gates; correct §8 of `docs/merge-queue.md` (protection is readable: `strict: true`, `enforce_admins: true`) and refresh issue #95, which still carries pre-delegation wording and an empty table. The delegated approval model is preserved unchanged.

**Why not B now.** B's extra ≈1.5× requires the queue thread to push directly to `main`, a change of history style, a new candidate namespace, invalidation bookkeeping and a relaxed post-merge rule. Each is manageable, but together they move the queue from "press the merge button on a verified head" to "maintain a correct integration stack", which is exactly where an agent mistake would be costly. With A in place the queue cycle is ≈6 minutes, and the backlog is likely to be limited by audits and eligibility, which B does not help.

**If B is approved later (CIQ-B, after A's measurements):** depth 2 only; never past a migration, privileged SQL, escalation or activation PR; candidates under `queue/candidate/**` with a Vercel ignore rule; fast-forward pushes only; merge commits; identity trailers; full invalidation rules in §4.B; a one-week shadow run where candidates are validated but `main` is still updated by the existing procedure, comparing outcomes, before any fast-forward is used.

### 6.1 Proposed configuration changes (for later PRs, not made here)

```yaml
# ci.yml, CIQ-A1 (sketch): every gated job reads the tier; skipping is decided once, fail closed.
  database:
    needs: changes
    if: needs.changes.outputs.run_database == 'true'      # classifier: false only for docs/client tiers
  # same pattern for static, unit, build; desktop keeps its existing condition
  gate:
    needs: [changes, static, unit, database, build, desktop]
    # ci-gate.sh: a skipped job passes only if CHANGES == success AND the classifier's explicit
    # output said that job was not needed for that tier; anything else requires success.

# ci.yml, CIQ-A2 (sketch)
  database:
    strategy: { fail-fast: false, matrix: { shard: [1, 2, 3] } }
    # each shard: own postgres service, roles, migrate deploy, db:privileged, then
    # vitest run --config vitest.integration.config.ts --shard=${{ matrix.shard }}/3 --reporter=json
  database-pooler:
    # RLS spike S1–S13 and all seven pooler suites, own postgres + PgBouncer
  gate:
    # adds: union of shard reports == list of integration files; counts recorded in the summary
```

No change to branch protection, required checks (`CI gate` stays the only one), auto-merge, rulesets, merge methods or Vercel in Approach A.

For B (only if approved): a `push` trigger on `queue/candidate/**` with its own concurrency group (`ci-candidate-<sha>`, never cancelled by another candidate), the migration-order check on that event, and a Vercel ignore rule for `queue/**` (deploy config, Regan only).

## 7. Migration plan from the current process

The live queue keeps running unchanged throughout. Each step is its own PR, audited by ChatGPT, merged through the queue.

| Step | Change | Gate to proceed |
|---|---|---|
| 0 | This report merged (docs only) | ChatGPT audit, verdict |
| 1 | CIQ-A1 tiers | Self-tests cover every tier boundary; dry-run on a docs PR, a client PR and a mixed PR shows the expected jobs; `CI gate` fails for each injected failure |
| 2 | CIQ-A2 shards | Negative proof: a deliberately failing test in each shard and in the pooler job fails `CI gate` (on a throwaway branch); completeness check matches file ids and counts; three consecutive green runs on `main` |
| 3 | CIQ-A3 queue procedure | Regan's own approval (changes `docs/merge-queue.md`) |
| 4 | Measure for one working day | Queue cycle, hand-off, CI p50/p90 per tier, failures, re-runs, compared with §3 |
| 5 | Decide B (D-CIQ-3) | Only if the queue is still CI-bound after step 4 |

## 8. Failure and rollback strategy

| Failure | Response |
|---|---|
| Tier classifier selects a smaller tier wrongly | Fail-closed design means unknown paths are `full`; if a mistake is found, revert CIQ-A1 (one PR) and the workflow returns to running every job. Any PR merged on a reduced tier during the faulty period gets a full `workflow_dispatch` run on `main` |
| A shard silently drops tests | The completeness step fails `CI gate`; rollback is reverting CIQ-A2, which restores the single Database job |
| Flaky shard or pooler job | Treated as today: fix the test, never skip or quarantine; the queue passes the PR over |
| macOS stall | One whole-run cancel and re-run per head SHA (§4.A.5); a second stall is reported to Regan, the PR is passed over, nothing is bypassed |
| Hand-off merge rejected because the head changed (`sha` precondition) | Expected fail-closed behaviour: the PR goes back to eligibility checks |
| `main` CI or smoke fails after a merge | Unchanged halt (`docs/merge-queue.md` §6); Regan decides when to resume |
| (B only) candidate invalidated | Cancel it and every later candidate, delete refs, rebuild; never land a candidate whose trailers do not match current PR heads and verdicts |
| (B only) anything unexpected in candidate bookkeeping | Fall back to depth 1 (which is Approach A) by policy, without a workflow change |

## 9. Acceptance criteria and regression-test plan

**Approach A is accepted when:**

1. Every job that ran before still runs for every `full`-tier change; `ci-gate.test.sh` covers every tier and job-result combination, including cancelled and missing results.
2. Docs-only PR runs finish in ≤ 2 min p90; client-only in ≤ 5 min p90; full runs in ≤ 5.5 min p90 (targets, to be measured). Governance documents (§4.A.1) always get `full`.
3. Sharded integration runs execute the same set of test files and the same test count as the unsharded baseline on the same commit, proven by the completeness job (§4.A.3).
4. A deliberately failing test in each shard, the pooler job, the static job and the unit job, a deleted shard report, an unlisted test file and an empty shard each turn `CI gate` red (negative proofs on a throwaway branch, results linked in the PR).
5. Tenant isolation, RLS spike S1–S13, all pooler suites, finance integrity, auth and admission tests, `check-migration-order` and `db:check-migrations` run for every change that is not docs or client tier.
6. A measured before/after window: the §3 baseline against at least one working day after A1–A3, reporting queue cycle, hand-off (wake versus polling), CI p50/p90 per tier, merged and returned PRs, macOS recoveries and re-runs. Target: queue cycle ≤ 8 min median, with no merge whose final head lacked a green `CI gate`, no merge before the previous PR's `main` CI, deploy and smoke succeeded, and every operation record complete.

**Regression-test plan:** the existing self-tests (`classify-changes.test.sh`, `ci-gate.test.sh`, `changed-files.test.sh`, `check-migration-order.test.sh`) extended for each new tier; a fixture table of real PR file lists from this window (all 30 merged PRs and the 12 open ones) with their expected tiers; a weekly scheduled full run (exists) and the nightly full suite (exists) as backstops that ignore tiers.

**For B (if ever approved):** a week of shadow candidates with zero disagreement between candidate results and the subsequent real final-head results; a test harness for invalidation (new commit, lost verdict, reorder, conflict, failure at each depth) run against a scratch repository, not this one.

## 10. Decisions needed from Regan

| ID | Decision | Recommendation |
|---|---|---|
| D-CIQ-1 | Proceed with Approach A as three separately audited PRs (CIQ-A1 tiers, CIQ-A2 shards, CIQ-A3 queue procedure), in that order, following §4.A.1–§4.A.5. A1 and A2 implement the already-approved D-CI-2 and D-CI-3 | **Yes** |
| D-CIQ-2 | The hand-off mechanism in §4.A.4 (wake plus polling fallback, `sha`-pinned merge) and the bounded macOS recovery in §4.A.5, keeping every post-merge halt gate (changes `docs/merge-queue.md`, so needs your own approval) | **Yes** |
| D-CIQ-3 | Speculative validation (B): defer until A is measured | **Defer** |
| D-CIQ-4 | If B is ever adopted: allow merging *k+1* after *k*'s deploy and smoke pass, without waiting for `main` CI on a tree identical to the green candidate (a failing `main` run still halts) | **Not authorised; not part of A.** Decide only with D-CIQ-3, after a separate B threat review |
| D-CIQ-5 | Native merge queue (C): do not transfer the repository to an organisation for it | **Do not pursue** |
| D-CIQ-6 | Correct `docs/merge-queue.md` §8 and `docs/ci-merge-pipeline-proposal.md` §10 (protection is readable: `strict: true`, `enforce_admins: true`, `CI gate` only) and refresh issue #95's stale text, in CIQ-A3 | **Yes** |

Nothing in this report authorises a workflow, setting, branch protection, merge or production change.

## 11. Revision 2: response to the design audit of `d7b9cb8`

| # | Audit point | Change |
|---|---|---|
| 1 | Docs tier must fail closed for governance and operational documents | §4.A.1: separate `gate_tier` output; governance, policy, CI, migration and operational documents are `full`; CI-2A desktop rule untouched; tiers never grant merge permission |
| 2 | Client tier needs exact mandatory jobs and a boundary proof | §4.A.2: per-tier job table (only Database skipped for `client`), path rules, structural boundary proof, required self-tests |
| 3 | Shard completeness and negative proofs must be executable | §4.A.3: manifest, isolated shards with roles, migrations and privileged SQL, pooler job, completeness job, gate wiring, failure injections |
| 4 | Hand-off gain is a model; name the actual mechanism | §4.A.4: conversational operator woken by a PR-activity event with polling fallback, SHA-pinned idempotent merge, state and limits; §5 models both polling and prompt-wake outcomes |
| 5 | macOS retry needs fail-closed mechanics | §4.A.5: whole-run cancel, wait for completion, re-run all jobs once per head SHA, latest attempt only, escalate after one |
| 6 | Model interpretation and baseline | §5: scenarios not guarantees, merged and returned counts, pessimistic bound, contention rows, required before/after window (§9 item 6) |
| 7 | Keep `main` CI, deploy and smoke gates; D-CIQ-4 not bundled | §4.A and §6: A keeps every post-merge gate; docs-tier `main` runs never leave `CI gate` pending; D-CIQ-4 marked not authorised |

