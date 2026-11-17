# CI-2: runner efficiency, nightly macOS validation and release gate

Status: CI-2A implemented in this PR. CI-2B and CI-2C are planned here and will be separate PRs (owner amendment of 2026-11-17). Parent plan: [ci-merge-pipeline-proposal.md](ci-merge-pipeline-proposal.md) (PR 94, decisions D-CI-1..5). Nothing here changes branch protection: `CI gate` stays the only required check.

## 1. Baseline (measured 2026-11-16 from the Actions jobs API)

Before CI-2A, every push to `main` ran the native desktop matrix (Linux compile check, macOS, Windows), including pushes that merged documentation only. Pull requests already skipped the matrix unless a desktop path changed (old deny-list in `classify-changes.sh`).

Six `main` runs read in full (job created/started/completed times). Run ids are under `actions/runs/<id>`.

| Run | Merged change | macOS queue wait | macOS job | Windows job | Linux compile | Run to green gate |
|---|---|---|---|---|---|---|
| 43926767997 | docs (#96) | 3 s | 2m35s | 3m37s | 2m30s | 6m51s |
| 43923548419 | docs (#80) | **10m03s** | 2m30s | 3m06s | 3m16s | **13m06s** |
| 43921808237 | docs (#94) | 3 s | 2m52s | 2m30s | 2m47s | 7m26s |
| 43914858082 | docs (GS2) | **15m01s, cancelled, gate red**; rerun 5m04 | 3m10s (rerun) | 3m55s | 2m08s | **27m54s** incl. rerun |
| 43872259427 | docs (#79) | 4 s | 3m00s | 3m23s | 2m55s | 7m47s |
| 43867660957 | docs (#78) | **5m02s** | 2m39s | 3m17s | 2m00s | 8m11s |

What this shows:

- **Measured:** a docs-only merge to `main` spent about 8 to 9 runner-minutes on the three desktop jobs (about 2.5 to 3 of them on macOS). The Windows and Linux jobs always started within seconds. Only the macOS job queued: 3 to 4 s in three runs, 5 to 10 minutes in two, and 15 minutes (cancelled) in one.
- **Measured:** the non-desktop jobs finish first. The Database job (about 6m30s) is the critical path, so on a healthy day the matrix adds no wall-clock time. The matrix costs time only when macOS stalls (3 of 6 runs here), and that is what failed `main` CI twice on 2026-11-16 (the 15-minute cancel in run 43914858082 failed the gate; one re-run of the failed jobs fixed it).
- **Measured:** all 30 of the latest `main` push runs executed the matrix, because every non-PR event selected it. 12 of those 30 merged titles say docs only (title-based count, an estimate).
- **Not measured here:** PR-run frequency of the native matrix before CI-2A. The old classifier skipped it for everything except the desktop and toolchain paths, which docs-only PRs never touched.
- The repository is public, so Actions minutes are not billed; runner-minutes are reported as a capacity measure, not a cost.

Current gate behaviour (read from `ci-gate.sh`): every job must be `success`, except that the matrix may be `skipped` when the classifier succeeded and said `desktop=false`. The gate uses `if: always()` so cancelled or failed jobs give a red gate, never a skip.

## 2. CI-2A: skip the native matrix for documentation-only changes

### What changed

| File | Change |
|---|---|
| `.github/scripts/classify-changes.sh` | Deny-list replaced by an **allow-list**. Reads NUL-separated paths. Outputs `desktop`, `tier` (`docs`, `server`, `full`) and `desktop_reason`. |
| `.github/scripts/changed-files.sh` (new) | Lists changed files for a pull request (merge commit) or a push (single step from the previous tip). Uses `--no-renames -z`. Exits non-zero whenever the diff is not certain. |
| `.github/scripts/ci-gate.sh` | A skipped matrix passes only for tier `docs` or `server` with a successful classifier. |
| `.github/workflows/ci.yml` | Detect-changes step uses the two scripts, now also on pushes; any failure selects `full`. Tier appears in the gate summary. No change to permissions, triggers, concurrency or job set. |
| `*.test.sh` | Self-tests (run in "Detect changes" on every run). |

### Classification

| Change | Tier | Native matrix |
|---|---|---|
| `docs/**` markdown and images, root `*.md` only | `docs` | skipped (PR and push) |
| Plus `apps/api/**`, `apps/web/**` source (not manifests, JSON, `*.config.*`) | `server` | skipped on PR only |
| Desktop source, desktop build config, `packages/**` (shared code), manifests and lockfiles anywhere, root and tool config, `.github/**`, any unknown path | `full` | runs |
| Empty list, undeterminable diff, odd path names, classifier error, scheduled/manual/tag/release runs | `full` | runs |

Static checks, lint, typecheck, boundaries, unit, database (including RLS isolation and pooler suites) and build verification run on every tier. Documentation-only classification therefore never bypasses typecheck, lint or security checks.

### Safety analysis

- **Allow-list, not deny-list.** Only listed documentation paths skip anything. A new top-level directory, a tool config file or a manifest is `full` until someone deliberately lists it.
- **Renames and deletions.** `git diff` hides the source of a rename by default; moving `apps/desktop/src-tauri/src/lib.rs` to `docs/lib.md` would have looked docs-only. `--no-renames` lists both paths. Covered by a fixture.
- **Hidden code inside docs.** Only markdown and image extensions count under `docs/`; `docs/package.json`, `docs/run.sh` and `docs/*.patch` are `full`. Markdown inside `apps/` or `packages/` is `full` (a native build could include it).
- **Mixed changes** are `full` as soon as one path is off the allow-list.
- **Push runs.** The diff is trusted only when `HEAD^1` equals the push's `before` commit (a squash merge). Multi-commit pushes, force pushes, new branches and a missing `before` select `full`.
- **Gate.** Unchanged authority: the gate fails if any required job is not `success`. The skip needs three agreeing facts: classifier job `success`, `desktop=false`, tier `docs` or `server`. A failed classifier, a missing or unknown tier, or `desktop=true` with a skipped matrix is red. A genuinely failed check is red in every tier.
- **Permissions.** Unchanged and least-privilege: workflow `contents: read`; only the gate has `actions: read` (summary only). No new triggers, no secrets, no write tokens, no auto-merge.
- **Not claimed:** green CI does not prove production safety.

### Deliberate policy differences (for Regan to confirm)

1. **Shared code now runs the native matrix on pull requests** (`packages/**`, `apps/desktop/src/**`), as the CI-2 brief requires. Previously those PRs deferred it to the push to `main`. This adds macOS load on code PRs and is the opposite of the stall problem. If wanted, the alternative is to keep deferring shared code to the push to `main` and list those paths in `server`. I implemented the brief as written.
2. **API and web-only source still skips the matrix on PRs** (existing behaviour, kept), but not on the push to `main`. It is a visible tier (`server`) so it cannot hide behind the docs rule. If you prefer docs-only to be the only skip, delete the `is_server_only` branch.
3. The old classifier treated unknown paths as "skip"; they are now `full`. This is the fail-closed requirement and increases matrix runs for repo areas such as `tests/**`, `ops/**`, `docker/**` and root config.

### Known limitations

- A docs-only push to `main` does not re-run the native matrix. The last code push to `main` still did, and a docs commit cannot change the native build. A weekly scheduled full run remains.
- The `server` tier assumes `apps/api` and `apps/web` stay outside the desktop dependency closure (`@business-os/desktop` depends on `@business-os/app` and `@business-os/ui`). A new dependency from desktop to those apps must be accompanied by a classifier change; its manifest edit is `full` anyway.
- Rate of macOS queue stalls is a GitHub runner capacity matter that CI-2A reduces exposure to but does not remove for code merges.

### Rollback

Revert the PR (one squash commit). The previous classifier and gate return, and docs-only pushes to `main` run the matrix again. No settings, secrets or branch protection are touched, so nothing else needs undoing.

## 3. CI-2B: nightly full macOS validation (planned, separate PR)

Owner requirements of 2026-11-17 (CI-2-F). Proposed design:

- New workflow `nightly.yml`, trigger `schedule: cron '0 18 * * *'` (02:00 AWST = 18:00 UTC) plus `workflow_dispatch`. `concurrency: nightly` with `cancel-in-progress: false`, so a scheduled run never runs twice at once (GitHub keeps one pending run).
- **macOS job:** production-configured unsigned Tauri build (`tauri:build --bundles app`), `cargo test`, desktop frontend typecheck, lint and tests, then verify the `.app` bundle exists, its `Info.plist` identifier and version, an artifact checksum, and a short launch smoke test if a window server is available on the runner (spike needed; reported as "not validated" if not).
- **Linux job (same workflow):** the complete existing suite including integration and RLS isolation. Tenant isolation and permission coverage need PostgreSQL service containers, which macOS runners cannot provide, so they run on Linux in the same nightly run. This is a documented limitation, not a pass claimed for macOS.
- Not testable without credentials or an interactive desktop: code signing, notarisation, auto-update and anything needing a real production API. They are listed in the run summary as `not validated`, never as passed (ADR 0005 decisions are still open).
- Recording: per-job duration, runner-minutes per OS and failures in the job summary, uploaded test reports and `.app` checksum as artifacts (30 days).
- Visibility: on failure the workflow opens or updates one `nightly-failure` issue (needs `issues: write` on that job only). Nightly failures do not block unrelated PRs; the release gate (CI-2C) treats an unresolved relevant failure as blocking.

## 4. CI-2C: mandatory full-platform release gate (planned, separate PR)

Owner requirements of 2026-11-17 (CI-2-G, CI-2-H). Proposed design:

- New workflow `release-validation.yml`, triggered by `v*` tags and `workflow_dispatch` with the candidate SHA. Each run checks out that exact SHA and fails if `git rev-parse HEAD` differs from the requested one.
- Jobs **macOS, Windows, Linux**: install, full applicable test suite, `tauri build` with bundles (`.app`/dmg, NSIS, `.deb`/AppImage), SHA-256 of every artifact, artifact upload (90-day retention) and an automated startup smoke test where the platform supports it.
- Final job **Release gate** (`if: always()`): passes only if all three platform jobs are `success` (cancelled, failed or skipped is red), the run's `head_sha` equals the candidate, and the nightly status has no unresolved relevant failure. It writes the evidence summary (per-OS minutes, checksums, test counts).
- **Freshness:** consumers verify by `head_sha` of the exact release commit. A successful run for an older commit cannot satisfy a newer one. Release validation runs use their own concurrency group keyed by SHA with `cancel-in-progress: false`, so a PR update never cancels them.
- Manual owner approval before public release stays outside the workflow: a GitHub Environment with Regan as required reviewer, once a publish workflow exists (none exists today).
- **Needs Regan, not enforceable in code:** blocking administrative overrides and label bypasses requires repository settings (tag protection, an environment with required reviewers, no bypass actors). I will not change settings; the PR will list the exact settings.
- PR cost (CI-2-H): superseded PR runs are already cancelled (`concurrency` on `pull_request`). The gate summary already shows durations per category; 2B/2C add runner-minutes per OS.

## 5. Verification (CI-2A)

Local fixtures: `classify-changes.test.sh` (58 cases), `changed-files.test.sh` (20 cases built from throwaway git repositories), `ci-gate.test.sh` (all gate combinations including failed required checks). They run in "Detect changes" on every run, so a broken rule fails CI.

Brief item to evidence:

| # | Requirement | Where proved |
|---|---|---|
| 1 | Markdown edit skips native | classifier cases "markdown edit under docs", PR fixture, demo run |
| 2 | Desktop source triggers native | "desktop frontend source", "Rust source", PR fixture |
| 3 | Shared code triggers native | "shared app package" and siblings, PR fixture |
| 4 | Dependencies and lockfiles cannot bypass | "root lockfile", "nested package manifest", hidden manifests in docs |
| 5 | Workflow changes cannot bypass | `.github/**` cases (this PR itself runs `full`) |
| 6 | Mixed docs plus source keeps checks | "docs + ..." cases, PR fixture |
| 7 | Unknown paths fail closed | "unknown ...", traversal, empty, malformed |
| 8 | Failing required check fails the gate | gate cases, demo run |

Real Actions demonstrations and the before/after report are in the PR description.

CI-2 demo: documentation-only change (not for merge).
