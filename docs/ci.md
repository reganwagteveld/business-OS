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

- Every push to `main` or `release/**`, every `v*` tag, every manual run (Actions → CI → Run workflow) and the weekly scheduled run on `main`.
- On pull requests, when any changed path matches `.github/scripts/classify-changes.sh`:
  - `apps/desktop/src-tauri/**` (Rust, Cargo files, `tauri.conf.json`, capabilities, icons, `build.rs`)
  - `apps/desktop/scripts/**`, `apps/desktop/package.json`, `apps/desktop/vite.config.*`, `apps/desktop/index.html`
  - `pnpm-lock.yaml`, `pnpm-workspace.yaml`, root `package.json`, `.nvmrc`, `rust-toolchain*`
  - `.github/**`
- If the changed files cannot be listed, the classifier selects the desktop matrix (fail closed).

Desktop frontend source (`apps/desktop/src/**`) and shared packages (`packages/**`) do not trigger the native matrix: the build verification job type-checks and builds the desktop frontend on every pull request, and the boundary and client-security tests cover them. The native build is repeated on the next push to `main`.

When you change the rules, update the self-test (`classify-changes.test.sh`) in the same commit.

## Nightly validation (CI-2B)

`.github/workflows/nightly.yml` runs daily at 02:00 AWST (18:00 UTC) and on demand (Actions → Nightly → Run workflow). It is not a required check and does not block pull requests. An unresolved failure blocks release approval (CI-2C, separate PR).

| Job | What it does |
|---|---|
| Full CI suite | Calls `ci.yml` (`workflow_call`) so the complete suite runs: static, unit, database with RLS isolation and pooler suites, build verification and the Linux, macOS and Windows desktop matrix. A scheduled or manual event is always the full tier. Skipped on pull requests (normal CI covers them). |
| macOS native validation | Desktop typecheck and lint, release-profile `tauri build --bundles app,dmg`, `cargo test`, `verify-macos-bundle.sh` (bundle id and version, Mach-O executable, no server configuration, disk image verify, SHA-256 checksums), a 10-second launch smoke test, evidence upload (14 days). |
| Nightly report | Runner-minutes and longest queue wait per OS in the run summary; on a failed scheduled run it opens or comments on one issue titled "Nightly validation failed". |

Concurrency: one nightly run at a time (`nightly` group, never cancelled by a newer scheduled run). Database tests and tenant-isolation suites run on Linux in the full suite; macOS runners cannot host the PostgreSQL service containers.

Not validated, and never reported as passed: code signing, notarisation, auto-update, and anything needing production credentials or an interactive signed-in session. Set the repository variable `DESKTOP_API_BASE_URL` to make the macOS build production-configured; without it the summary says the placeholder origin was used.

## The gate

`.github/scripts/ci-gate.sh` (self-tested by `ci-gate.test.sh`) fails when any of these is not `success`: Detect changes, Static checks, Unit tests, Database tests, Build verification. The desktop matrix must also be `success` unless the classifier explicitly reported `desktop=false`. The gate uses `if: always()`, so it reports a failure (not a skip) when jobs before it fail or are cancelled. A run that never completes leaves `CI gate` pending, which blocks merge.

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
