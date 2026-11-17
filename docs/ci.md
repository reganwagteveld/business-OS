# Continuous integration

One workflow, `.github/workflows/ci.yml`. **The only check to require in branch protection is `CI gate`.**

## Jobs

| Job | Runs | What it checks |
|---|---|---|
| Detect changes | always | Self-tests the change classifier and the gate verdict, then decides whether the desktop matrix is needed |
| Static checks | always | Contract snapshot, typecheck, lint, boundaries (dependency-cruiser + source rules) |
| Unit, contract and architecture tests | always | `pnpm test` (every package plus `tests/architecture`) |
| Database tests | always | PostgreSQL roles, `prisma migrate deploy` as the owner role, privileged SQL, integration tests (API, RBAC, tenancy), RLS spike and isolation tests behind PgBouncer, the finance integrity and payments suites again with `bos_app` behind PgBouncer (F2), migrations match schema |
| Build verification | always | `pnpm build` (API, web, desktop frontend), API boots without owner credentials, client bundles contain no server configuration |
| Desktop shell (Linux, macOS, Windows) | see below | Unsigned Tauri build (Linux compile only, macOS `.app`, Windows NSIS) and the Rust unit tests |
| CI gate | always, even after failures or cancellation | Passes only if every applicable job succeeded |

Static, unit, database and build jobs never depend on which files changed. Only the desktop matrix is conditional.

## When the desktop matrix runs

The native desktop matrix (Linux compile check, macOS, Windows) is the only conditional job. Static checks, unit tests, database tests and build verification run on every run, including documentation-only ones. `.github/scripts/changed-files.sh` lists the changed paths and `.github/scripts/classify-changes.sh` classifies them (CI-2A, design in [ci-2-runner-efficiency.md](ci-2-runner-efficiency.md)). The result is a **tier**:

| Tier | Paths (every changed path must match) | Matrix |
|---|---|---|
| `docs` | `docs/**` markdown and images, root `*.md` | skipped on pull requests and on pushes to `main` |
| `server` | `docs` paths plus `apps/api/**` and `apps/web/**` source, but not manifests, JSON or `*.config.*` files | skipped on pull requests only; the push to `main` still runs it |
| `full` | anything else: desktop source, `packages/**`, manifests and lockfiles anywhere, tool config, `.github/**`, unknown paths | runs |

Always `full`: pushes to `release/**`, `v*` tags, manual runs and the weekly schedule. Fail-closed rules: an empty list, a diff that cannot be established (checkout is not a merge commit, a push that is not a single step from the previous tip, missing or zero `before`), a path with `..`, `//` or a leading `/`, and a classifier error all select `full`. Renames and copies are listed as a deletion plus an addition, so moving code into `docs/` still lists the code path. A mixed change is `full` as soon as one path is not on the allow-list.

Change the rules only together with `classify-changes.test.sh` (and `changed-files.test.sh` for diff handling). The self-tests run in "Detect changes" before the classifier is used.

## The gate

`.github/scripts/ci-gate.sh` (self-tested by `ci-gate.test.sh`) fails when any of these is not `success`: Detect changes, Static checks, Unit tests, Database tests, Build verification. The desktop matrix must also be `success` unless the classifier job succeeded and explicitly reported `desktop=false` with tier `docs` or `server`; a skip with any other tier, a missing tier or a failed classifier fails the gate. The gate uses `if: always()`, so it reports a failure (not a skip) when jobs before it fail or are cancelled. A run that never completes leaves `CI gate` pending, which blocks merge.

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
