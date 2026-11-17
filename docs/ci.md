# Continuous integration

One workflow, `.github/workflows/ci.yml` (plus the separate, non-gating visual-regression workflow at the end of this page). **The only check to require in branch protection is `CI gate`.**

## Jobs

| Job | Runs | What it checks |
|---|---|---|
| Detect changes | always | Self-tests the classifiers, the credential scan and the gate verdict; checks migration order; decides the gate tier and whether the desktop matrix is needed; scans added documentation lines for credentials |
| Static checks | unless gate tier `docs` | Contract snapshot, typecheck, lint, boundaries (dependency-cruiser + source rules) |
| Unit, contract and architecture tests | unless gate tier `docs` | `pnpm test` (every package plus `tests/architecture`) |
| Database tests | gate tier `full` only | PostgreSQL roles, `prisma migrate deploy` as the owner role, privileged SQL, integration tests (API, RBAC, tenancy), RLS spike and isolation tests behind PgBouncer, the finance integrity and payments suites again with `bos_app` behind PgBouncer (F2), migrations match schema |
| Build verification | unless gate tier `docs` | `pnpm build` (API, web, desktop frontend), API boots without owner credentials, client bundles contain no server configuration |
| Desktop shell (Linux, macOS, Windows) | see below | Unsigned Tauri build (Linux compile only, macOS `.app`, Windows NSIS) and the Rust unit tests |
| CI gate | always, even after failures or cancellation | Passes only if every applicable job succeeded |

Two independent decisions, both fail closed, select the conditional jobs: the **gate tier** (CIQ-A1, below) for static, unit, database and build, and the **desktop tier** (CI-2A) for the native matrix.

## Gate tiers (CIQ-A1)

Design: `docs/ciq-1-merge-queue-throughput.md` §4.A.1 and §4.A.2 (owner decisions D-CI-2 and D-CIQ-1). `.github/scripts/classify-gate-tier.sh` reads the same changed-file list as the desktop classifier and prints `gate_tier`:

| Gate tier | Paths (every changed path must match) | Static | Unit | Build | Database |
|---|---|---|---|---|---|
| `docs` | ordinary documentation: `docs/**` `.md`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.svg`, `.webp`, **excluding** governance documents (below) | skipped | skipped | skipped | skipped |
| `client` | at least one client source file, i.e. `.ts`, `.tsx` or `.css` under `packages/app/src/`, `packages/app/tests/`, `packages/ui/src/`, `packages/ui/tests/` or `apps/web/src/`, plus optionally ordinary documentation; **excluding** the HTTP transport (`packages/app/src/api/http.ts`, `client.ts`), `packages/app/src/config.ts`, `packages/app/src/auth/**`, test `setup` files, hidden files, `*.config.*`, `tsconfig*`, manifests and lockfiles, and any path containing `auth`, `session`, `admission`, `permission`, `tenant`, `tenanc`, `rbac`, `role`, `csrf`, `token`, `secret` or `credential` (case-insensitive) | runs | runs | runs | skipped |
| `full` | anything else | runs | runs | runs | runs |

**Governance documents are never `docs` tier** (case-insensitive): `CLAUDE.md`, `AGENTS.md` and `SECURITY.md` anywhere, every root `*.md` (including `README.md`), and under `docs/`: `agent-*`, `agents/`, `merge-queue*`, `active-workstreams*`, `ci*`, `*-ci-*`, `*release*`, `*migration*`, `deployment*`, `vercel*`, `*neon*`, `operations/`, `ops/`, `private-beta*`, `*security*`, `*lockdown*`, `*admission*`, `adr/`. They run the full suite and keep their own governance review (Regan's own approval where they change the approval model).

**Why `client` may skip the Database job:** clients reach data only through `/api/v1`. `pnpm boundaries` and `tests/architecture` forbid database or server imports in client packages, no API or database test imports a client package, and both checks still run in the `client` tier.

**Events:** only `pull_request` and a `push` to `refs/heads/main` may use `docs` or `client`. Release branches, tags, manual runs, the weekly schedule and `workflow_call` (nightly, release validation) are always `full`.

**Fail closed:** an empty list, a diff that cannot be established, an unsafe path name (`..`, `.` segments, `//`, a leading `/`, control characters, backslashes), any path not on an allow-list, a mix with a `full` path and a classifier error all select `full`. Jobs run unless the classifier explicitly said `docs` (or `client` for Database), so a missing output runs them.

**Credential scan (every tier):** `scan-doc-credentials.sh` fails Detect changes when a line *added* to `docs/**`, `*.md`, `*.mdx` or `*.txt` matches a provider credential pattern (AWS, GitHub, private keys, Slack, Stripe live, npm, Resend, Neon URL with a password). The match is never printed. The range is never a single commit and the scan is never skipped (`doc-credential-gate.sh`): a pull request is scanned over GitHub's merge commit against the base tip, so every commit in the PR counts and a credential added then removed inside the PR does not; the merge commit's second parent must be the PR head. A push to `main` is scanned over its single step from the previous tip. Any other case (no merge commit, PR head mismatch, multi-commit or force push, new branch, schedule, manual run) scans every documentation file at `HEAD`, and the gate tier is `full`. `doc-credential-gate.test.sh` covers these with throwaway repositories, including a multi-commit PR whose credential is in an earlier commit.

Change the rules only together with `classify-gate-tier.test.sh` and `ci-gate.test.sh`. A tier only decides which jobs `CI gate` requires: it never grants merge permission, which still comes only from a verified verdict (`docs/agent-task-protocol.md`).

## When the desktop matrix runs

The native desktop matrix (Linux compile check, macOS, Windows) runs according to the desktop tier, which is independent of the gate tier. `.github/scripts/changed-files.sh` lists the changed paths and `.github/scripts/classify-changes.sh` classifies them (CI-2A, design in [ci-2-runner-efficiency.md](ci-2-runner-efficiency.md)). The result is a **tier**:

| Tier | Paths (every changed path must match) | Matrix |
|---|---|---|
| `docs` | `docs/**` markdown and images, root `*.md` | skipped on pull requests and on pushes to `main` |
| `server` | `docs` paths plus files under `apps/api/{src,tests,prisma}/` or `apps/web/src/` whose extension is `.ts`, `.tsx`, `.sql`, `.prisma` or `.css`, at any depth (hidden files, `*.config.*`, `tsconfig*`, manifests and lockfiles are never `server`) | skipped on pull requests only; the push to `main` still runs it |
| `full` | anything else: desktop source, `packages/**`, manifests and lockfiles anywhere, tool config, `.github/**`, unknown paths | runs |

Always `full`: pushes to `release/**`, `v*` tags, manual runs and the weekly schedule. Fail-closed rules: an empty list, a diff that cannot be established (checkout is not a merge commit, a push that is not a single step from the previous tip, missing or zero `before`), a path with `..`, `//` or a leading `/`, and a classifier error all select `full`. Renames and copies are listed as a deletion plus an addition, so moving code into `docs/` still lists the code path. A mixed change is `full` as soon as one path is not on the allow-list.

Change the rules only together with `classify-changes.test.sh` (and `changed-files.test.sh` for diff handling). The self-tests run in "Detect changes" before the classifier is used.

## Nightly validation (CI-2B)

`.github/workflows/nightly.yml` runs daily at 02:00 AWST (18:00 UTC) and on demand (Actions → Nightly → Run workflow). It is not a required check and does not block pull requests. An unresolved failure blocks release approval (CI-2C, separate PR).

| Job | What it does |
|---|---|
| Full CI suite | Calls `ci.yml` (`workflow_call`) so the complete suite runs: static, unit, database with RLS isolation and pooler suites, build verification and the Linux, macOS and Windows desktop matrix. A scheduled or manual event is always the full tier. Skipped on pull requests (normal CI covers them). |
| macOS native validation | Desktop typecheck and lint, release-profile `tauri build --bundles app,dmg`, `cargo test`, `verify-macos-bundle.sh` (bundle id and version, Mach-O executable, no server configuration, disk image verify, SHA-256 checksums), a 10-second launch smoke test, evidence upload (14 days). |
| Nightly report | Runner-minutes and longest queue wait per OS in the run summary; on a failed scheduled run it opens or comments on one issue titled "Nightly validation failed". |

Concurrency: one nightly run at a time (`nightly` group, never cancelled by a newer scheduled run). Database tests and tenant-isolation suites run on Linux in the full suite; macOS runners cannot host the PostgreSQL service containers.

Not validated, and never reported as passed: code signing, notarisation, auto-update, and anything needing production credentials or an interactive signed-in session. Set the repository variable `DESKTOP_API_BASE_URL` to make the macOS build production-configured; without it the summary says the placeholder origin was used.

## Release validation (CI-2C)

`.github/workflows/release-validation.yml` is the three-platform release gate (design: [ci-2-runner-efficiency.md](ci-2-runner-efficiency.md) section 4). It **validates** a release candidate and **cannot publish**: workflow permission is `contents: read`, no job has a write permission, secret, environment, release step or deploy step, and `release-workflow-guard.test.sh` fails CI if one is added. It is not a required check, does not run for ordinary pull requests and leaves `CI gate` unchanged.

Triggers: push of a `v*` tag; manual run (Actions → Release validation → Run workflow) with `expected_sha`; pull requests that change this workflow or its scripts (self-validation only, **not release evidence**).

| Job | What it does |
|---|---|
| Resolve candidate commit | Self-tests the release scripts. Fixes the commit under validation: the run's commit must be on `main` (ancestor of `origin/main`), and for manual runs `expected_sha` (40 lower-case hex) must equal it. Otherwise the run fails. |
| Full CI suite | Calls `ci.yml`: static, unit, database with RLS isolation and pooler suites, build verification, and the Linux, macOS and Windows desktop matrix. Tag and manual events are always the `full` tier. Skipped on pull-request self-validation runs only. |
| Package and verify (Linux, macOS, Windows) | Each platform, on the exact candidate commit: desktop typecheck, lint and package tests; `tauri build` in the release profile (unsigned) with `.deb` and AppImage, `.app` and `.dmg`, NSIS installer; `cargo test`; package verification and SHA-256 checksums (`verify-release-bundle.sh`, `verify-macos-bundle.sh`); install-and-launch smoke test (Linux `.deb` under Xvfb, Windows silent NSIS install, macOS app launch); candidate packages and evidence uploaded as Actions artifacts for 30 days. |
| Release gate | `if: always()`. Passes only if Resolve, Full CI suite, Linux, macOS and Windows are all exactly `success` (`release-gate.sh`; failed, cancelled, skipped and missing all fail) **and** there is no unresolved nightly failure (`release-nightly-status.sh`: no open "Nightly validation failed" issue across **all** pages of open issues, and the latest completed nightly run on `main` succeeded; an unreadable status or no completed nightly run yet is not clear). Writes per-OS runner-minutes, queue wait and slowest-job durations to the summary. |

Freshness: every job checks out the resolved SHA and asserts `git rev-parse HEAD` equals it. A run is evidence for exactly that commit. Release validations are keyed by commit and never cancelled by a newer run.

What a consumer must check before releasing: a successful **Release gate** job of a `push` (tag) or `workflow_dispatch` run of `release-validation.yml` whose `head_sha` equals the release commit, and the build summaries must say `production-configured: true` (set the `DESKTOP_API_BASE_URL` variable).

Not validated, never reported as passed: code signing, notarisation, Authenticode, SmartScreen, MSI, auto-update, and anything needing production credentials or an interactive signed-in session. The smoke tests prove only that the installed app starts and stays running for 10 to 13 seconds.

Nothing publishes. Any future publish workflow must be a separate PR with a GitHub Environment that has required reviewers (see the settings list in PR 113 and the CI-2 doc).

## The gate

`.github/scripts/ci-gate.sh` (self-tested by `ci-gate.test.sh`) fails when Detect changes is not `success`, and when Static checks, Unit tests, Database tests or Build verification is not `success`, except that a job may be `skipped` when Detect changes succeeded and the gate tier permits that skip (`docs`: static, unit, build, database; `client`: database only). A permitted job that ran anyway must succeed; a missing result, an unknown or empty tier, or a failed classifier requires success. The desktop matrix must also be `success` unless the classifier job succeeded and explicitly reported `desktop=false` with tier `docs` or `server`; a skip with any other tier, a missing tier or a failed classifier fails the gate. The gate uses `if: always()`, so it reports a failure (not a skip) when jobs before it fail or are cancelled. A run that never completes leaves `CI gate` pending, which blocks merge.

Do not mark individual jobs as required: GitHub treats a skipped required job as passing.

## Caches

| Cache | Key | Written by | Invalidated by |
|---|---|---|---|
| pnpm store (`actions/setup-node`) | OS, arch, hash of `pnpm-lock.yaml` | any run on a miss | lockfile change |
| Rust `target/` and Cargo registry (`Swatinem/rust-cache`) | job, OS, rustc version, Cargo.lock/Cargo.toml hashes | `main` only | Rust toolchain update, Cargo changes |
| PgBouncer `.deb` files | pinned version, runner image OS and version | any run on a miss | version pin change, weekly runner image update |

`node_modules` is never cached; installs always use `--frozen-lockfile`. PgBouncer packages come from the signed Ubuntu archive through apt and are unpacked, not installed, so no system service starts.

## Cancellation

A new commit on a pull request cancels that pull request's previous run. Pushes to `main` or release branches, tags, manual and scheduled runs each get their own concurrency group and are never cancelled by another run.

## Visual regression (separate, non-gating)

`.github/workflows/visual.yml` runs the Chromium golden-screenshot suite in `tooling/visual` (UI V2-B2-1) on pull requests that touch the UI packages, the harness or the lockfile, and on demand. It is **not** part of `CI gate` and must not be made a required check until it has a reviewed baseline and a documented flake rate (D-V2A-11). A difference shows as a warning with the diffs as an artifact; it never fails the run. Chromium goldens do not replace the macOS WKWebView and Windows WebView2 checks. See `tooling/visual/README.md`.
