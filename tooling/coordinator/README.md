# Business OS local delivery coordinator

## Verified and unverified status

A real host-terminal run completed Codex planning → Claude implementation → Codex audit → independent content QA on 15 November 2026. Evidence: `docs/evidence/coordinator/live-handoff.json`. The persistent host worker and live audit → fixes → re-audit loop are verified; see `docs/evidence/coordinator/live-fix-loop.json`. The full product-release flow still requires live qualification. The first trial log confirms the Sonnet alias resolved to `claude-sonnet-5-5`; the queued fixes trial pins that identifier. Offline tests cover state transitions, real Git snapshots, release gates, interrupted-write protection, credential filtering and a real supervisor/QA child process.

Implemented components:

- `coordinator.py`: durable jobs, isolated checkouts, structured handoffs, audit/fix loop, bounded turns, independent QA, logs and pause/resume.
- `worker.py`: persistent serial supervisor, job locks, status heartbeat, clean interruption and bounded external waits. Completed and paused jobs are skipped.
- `release.py`: exact reviewed-tree publication, PR creation, strict head/base/CI checks, re-audit after base changes, production ledger/checksum checks, target binding to the Neon branch, recovery branch, migration/privileged adapter, SHA-guarded merge, Vercel deployment checks and authenticated post-deploy reads. Writes are journaled before execution; an uncertain write is never blindly retried.
- `operations.py`: dedicated ephemeral Docker PostgreSQL for local QA and fresh/representative upgrade qualification, synthetic data only, administrative SQL adapter, and read-only signed-in cross-Zone checks.
- `start-local.sh`: installs a user launchd service from the ordinary authenticated host Terminal; queues the controlled real fixes-loop trial. `caffeinate -i` prevents idle system sleep while the worker runs; closing the lid, logging out, or losing power can still stop work.
- `doctor.py`: readiness checks without showing credentials.
- `qualify-live.sh`: updates the idle host runtime without restarting the service, starts the installed Docker engine if needed, validates existing access without asking for credentials again, and queues a bounded coordinator release qualification. Default release stays disabled; only this job receives release authority. Database connection failures receive a credential-free diagnosis instead of a generic release failure.

**Production release is disabled by default.** Implementation is not a claim of successful production execution. No existing feature checkout is modified. A background worker cannot run until the host installation command succeeds.

## One-time host start

Run in the normal authenticated Terminal:

```bash
bash "/Users/Regan/Documents/ChatGPT/Business OS/coordinator-work/tooling/coordinator/start-local.sh"
```

This clones the committed runner into `~/Library/Application Support/Pixakova/BusinessOSCoordinator` and registers its plist with the current user's launchd session. Its jobs, configuration and status files live there. It needs no background access to the Documents folder. Installation/update refuses to overwrite tracked local edits in the managed runtime. It does not use sudo, bypass agent permissions or apply migrations. It creates a durable `.coordinator-local/config.local.json`, `.coordinator-local/readiness.json`, status files and worker logs. A pre-existing config is preserved. The controlled fixes test uses its own small QA configuration; it never inherits production release configuration.

The worker status is `.coordinator-local/status.md`; machine-readable heartbeat is `status.json`. Host readiness is `readiness.json`. The installer waits for a fresh heartbeat before reporting verification. A recent heartbeat and observed job transitions prove the worker is active; launchd registration alone is not enough. The user does not relay findings between agents.

Stop: `launchctl bootout gui/$(id -u)/com.pixakova.business-os.coordinator`. Restart with the start script (which also queues another controlled fixes trial).

## Production access configuration

Run the source checkout's `tooling/coordinator/configure-access.py` from the normal Terminal. It discovers Neon/Vercel targets, requires explicit selection when ambiguous, accepts secrets through hidden prompts, optionally creates a smoke session with an existing email/password login, and saves only the session cookie rather than the password. It enforces the existing CI gate/up-to-date/admin branch protection while preserving other existing restrictions. Production releases remain disabled. This is a one-time account-access setup, not a request for new feature or architecture decisions. Do not paste its credentials into chat.


Set identifiers in `.coordinator-local/config.local.json`: both Vercel project IDs, optional team ID, Neon project ID and exact production branch ID. The configured hooks already point to `operations.py`. Strict main branch protection must require `CI gate`, require an up-to-date branch, and apply to administrators. The broker checks this before production changes and never uses an admin merge bypass.

Keep host secrets in `.coordinator-local/host.env` (mode 600), never chat or git:

- `BOS_MIGRATION_DATABASE_URL`: direct `bos_owner` URL for production.
- `BOS_ADMIN_DATABASE_URL`: administrative URL for the same endpoint/database, only required for privileged SQL.
- `BOS_VERCEL_TOKEN`: provider access for verifying both deployments.
- `BOS_SMOKE_COOKIE`: valid cookie for the dedicated test business user.
- `BOS_SMOKE_BUSINESS_SLUG`: dedicated test business slug.
- Optional `BOS_SMOKE_ORIGIN`: defaults to `https://app.pixakova.com`.

Neon and GitHub CLI authentication must work for the same host user. Enable `release.enabled` only after identifiers, host access and live qualification are verified. Run `doctor.py --config .coordinator-local/config.local.json` to see missing checks without exposing values. No credentials are automatically extracted from other applications.

Agent and local QA subprocesses receive an allowlisted environment without production or API-billing keys. Claude currently receives file tools only; independent host QA executes tests. This is environment separation, not an OS security boundary against an intentionally malicious same-user process. Use a separate OS identity/container and credential broker before treating agents as untrusted code.

The current production sequence implements the documented additive-before-merge route. Codex must audit compatibility and transactions and set `release_strategy` accordingly. Destructive/incompatible changes stop for an explicit expand/contract plan. Applied migrations are never rewritten. No automatic destructive database restore is attempted.

Representative upgrade qualification runs baseline integration tests to retain synthetic records, applies candidate migrations and privileged SQL, verifies that business count is preserved, and runs candidate integration/schema checks. It stops if baseline tests retain no representative data. Pooler/isolation and platform-specific desktop checks remain mandatory in the canonical CI gate; local QA does not claim to replace them.

## Approved work queue

Create a bounded approved brief, then:

```bash
python3 tooling/coordinator/coordinator.py --config .coordinator-local/config.local.json add task-id /absolute/path/approved-brief.md
```

The worker discovers the saved job. Product jobs clone current repository main independently; the original F6-2 work stays untouched. Proposed roadmap rows are not automatically approved. Root authority delegates engineering, QA, routine migrations and merges under existing project rules; important product/business decisions still go to Regan.

`status task-id` prints saved state. `resume task-id` retries a paused stage after its blocker has been reconciled; it also cancels any pending automatic retry, so a later blocker stays paused. Never clear an interrupted production journal entry without checking the actual remote/database result. Local publication/PR uncertainty may also need reconciliation; the worker preserves it instead of guessing.

## Remaining operational qualification

Live handoffs, the fixes/re-audit loop, a running host service and production access setup have been observed. The complete release qualification remains outstanding. From the ordinary authenticated Terminal:

```bash
bash "/Users/Regan/Documents/ChatGPT/Business OS/coordinator-work/tooling/coordinator/qualify-live.sh"
```

This imports only the coordinator paths, roadmap/evidence, CI test registration and ignore rules into a fresh checkout of current GitHub main. It excludes unrelated feature commits and leaves the developer's existing checkout alone. State is published to the worker only after read-only baseline database, smoke and branch-protection checks pass. A per-job configuration authorizes this one release; the ordinary configuration is preserved. A second invocation retains any existing qualification instead of silently duplicating it.

The job starts at independent Codex audit, uses Claude Opus for corrections if needed, runs Python tests plus full local database/app QA, and publishes only the bounded diff. Production migration or app changes are outside this qualification's approved paths. The broker requires successful exact-commit PR CI, strict branch protection and database invariants before merge. Completion additionally requires main CI (including native desktop builds), both current promoted production targets at the merged SHA, health and signed-in read smoke checks. Vercel alias assignment accepts its documented boolean or numeric timestamp representation; a historical READY deployment cannot pass as the current production target.

Billing/sync activation is separate: a deployed worker route does not imply cron is enabled. Jobs that change service activation need explicit activation criteria in their feature brief. A successful no-schema release trial does not establish live migration/upgrade qualification for a future schema-changing job; that job must pass the separate fresh/upgrade and recovery checks.

The coordinator is not fully operational until those checks pass. Recognised rate-limit/network failures receive at most four delayed retries (15, 30, 45 and 60 minutes); unclassified failures and login problems remain paused. A delayed retry is bound to the exact failure that scheduled it: a new attempt, a manual resume or any different pause discards it, and the worker only clears a pause whose message matches that failure. The worker makes that decision on state reloaded under the same per-job lock used by `run`/`resume`, skips any job whose lock is held (it neither starts a competing child nor rewrites that job's state). If a manual run takes the lock between that check and the child starting, the child exits with status 3 without reading or writing state and the job is treated as skipped, not failed. Each run records a `run_attempt` token (the worker passes its own via `BOS_WORKER_ATTEMPT`); an unexpected child exit is recorded under the lock only when the saved state still carries that child's token or is unchanged since the child was spawned, and never on a terminal stage, so a failure cannot land on state written by a later manual run. `resume` replaces the token with a fresh `resume-…` value in the same locked write that clears the pause, so a previous child's failure handler cannot match during the brief gap before `run` takes the lock and assigns its own token. Interrupted release writes are never retried this way. The host worker posts local macOS notifications when jobs complete or pause, alongside durable status files. It cannot post progress messages into this chat.

Tests: `python3 -m unittest discover -s tooling/coordinator -p 'test_*.py' -v`.
