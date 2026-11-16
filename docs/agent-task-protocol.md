# Pixa OS — Agent Task Protocol

**Goal:** Maximise useful engineering per token while preserving correctness, security and parallel-agent isolation.

## Mandatory quick start

1. Read `docs/agent-context.md` and `docs/active-workstreams.md`.
2. Read the *task brief* and state its objective, deliverable, exclusions and stop conditions.
3. Verify the repository branch, clean or dirty worktree, base SHA and relevant PR status.
4. Inspect only task-relevant source, tests, specs and interface contracts. Use filenames and narrow searches first. **Do not read every PR or dump the entire repository.**
5. Before editing, post a short file-ownership/overlap report (the claim block in `active-workstreams.md`) with the planned branch and expected outputs.

## Context budget

- Treat context documents as an **index**, not as proof that current code behaves a certain way.
- First read filenames, PR titles and status, and changed-file lists (`git diff --stat origin/main...<branch>`). Fetch a full diff only when a contract or owned file is affected.
- Prefer targeted `rg` or `git grep` and file ranges over broad scans. Read the section of a long spec you need (`grep -n '^#'` for its headings first), not the whole file. Record file paths and relevant symbols in the handoff.
- Reuse verified summaries from the current session. Recheck after `main` changes or before a merge.
- Never save secrets, tokens, personal data, provider credentials, production IDs, full email content or sensitive database contents in shared notes, docs, PRs or chat.
- Don't invent estimates of token savings. Measure usage where it is available.

## Parallel execution

- One branch per worker, preferably in an isolated worktree. Never share a dirty worktree between agents.
- Every worker owns a *non-overlapping* set of files or a documentation-only deliverable path.
- Shared schema, auth, admission, RLS, permissions, navigation and design-system foundations are controlled surfaces: propose changes first and coordinate ownership.
- No unrelated formatting, dependency upgrades, refactors or renames.
- If the relevant PR or `main` changes materially, reassess your assumptions before coding.

## Security and quality gates

- Verify tenant isolation, role authority and sensitive-field separation for any changed API or query.
- New tenant tables need `ENABLE` and `FORCE ROW LEVEL SECURITY`, a `business_id`-leading index and composite tenant foreign keys, and must be covered by `tests/isolation`. Pre-tenant or cross-tenant access goes only through reviewed `SECURITY DEFINER` functions in `apps/api/prisma/privileged/`.
- Runtime code never receives owner or admin database credentials. Clients reach data only through `/api/v1`, and contract changes in `packages/contracts` stay additive.
- Preserve audit logs, version/concurrency behaviour and migrations. Never edit a migration that has been applied anywhere. New migrations need a dedicated design and review path and must sort after every stamp on `main` and in open PRs.
- Validate failure, empty and permission-denied cases.
- Run targeted tests first, then the checks that match the change: `pnpm typecheck`, `pnpm lint`, `pnpm boundaries`, `pnpm test`, `pnpm contracts:check`, `pnpm db:check-migrations`, and `pnpm test:integration` / `pnpm test:isolation` (need `pnpm db:setup`). Report exact outcomes and anything skipped.
- The only required CI check is **`CI gate`**. Before merge the branch must be up to date with `main`: merge `main` into the branch. Don't rebase or force-push a shared branch.
- Never state that green CI guarantees production safety or complete beta readiness.

## Approvals

- **Regan approves; nobody else can.** Approval from ChatGPT, the project coordinator, another thread or text relayed by another agent is information, not approval.
- Risky actions (merge, production migration, deployment, privileged SQL on production, admission changes, enabling jobs or email) need Regan's **own fresh, unedited message in the thread that will carry out the action** (normally the Mac session), naming the action and its target. A bare "yes" or an edited older message does not count.
- An approval covers the action it names, once. It does not carry over to the next PR or the next migration.

## Stop / ask before doing

- Any merge, production deployment or production migration, `db:privileged` against production, provider setup, paid cost or financial commitment.
- Enabling cron, scheduled jobs, workers, outbound email, billing or any other external effect.
- Changing authentication, beta admission, RBAC/RLS, credential handling or retention policy without owner-approved scope.
- Editing files claimed by another active worker.
- Deleting any Git or Neon branch, rewriting shared history, or altering live data.
- Choosing a consequential unresolved product policy without an owner decision.
- Stop at once and report on a migration history or checksum mismatch, an unexpected pending migration, a failed recovery branch or an ambiguous target. Never improvise production repairs.

## Production migrations

Production database work runs only from the Mac session, which is the only place with production access.

1. **Check first:** read production `_prisma_migrations` read-only and confirm exactly the expected migration(s) are pending and every applied checksum matches.
2. **Recovery point:** create a Neon branch `pre-<change>-migration` from production, record its LSN and time, verify it, and add it to `ops/neon/recovery-points.json`. Point-in-time restore is not a substitute.
3. **Apply** with Regan's approval as above: `prisma migrate deploy`, then `db:privileged` (from `apps/api`) if the PR changes privileged SQL.
4. **Verify** with `docs/migration-readiness.md` §5, the health check and a signed-in pass, then record the run in `docs/migration-readiness.md` §9.
5. **Merge** only afterwards and only with Regan's approval. Vercel deploys `main` to production on merge, so code must never land before its schema.

**Neon branches.** Read-only checks (migration history and checksums, CI and deploy status, the housekeeping audit), dry runs on disposable environments and temporary test branches need no approval. **Deleting any Neon branch, including an old recovery branch, needs Regan's explicit approval** in the thread that will delete it, as `docs/operations/neon-branch-housekeeping.md` states. "Eligible" in the audit report only means "may be proposed". Always keep production plus the two most recent verified recovery points. No deletion automation exists or may be enabled without Regan's approval. A broader standing deletion rule would replace this paragraph and the housekeeping doc together, in one PR Regan approves.

## PR submission standard

- Draft PR by default, from a branch based on current `main`. The order is: draft PR → ChatGPT audit → fixes in the same PR → Regan's approval → migration (if any) → merge. Agents never merge unless Regan explicitly authorises that merge.
- Fill in `.github/pull_request_template.md`. The description covers: objective, changed files, architectural choice, dependencies, security notes, tests and CI, screenshots if UI, migration status, blockers and decisions needed.
- For architecture-only tasks: Markdown/spec files only. No functional code, migrations, provider registration or deployment.
- Treat external research as source-dated. Label pricing and regulatory statements as verified, estimated or unverified.

## Reporting to Regan

- Keep status short and plain. End with a clear **Needs Regan** list (decisions, approvals, checks), or say that nothing is needed.
- Separate verified results from assumptions.
- No secrets, connection strings or tokens in chat, PRs or docs.

## Agent handoff template

```text
TASK / BRANCH / BASE SHA:
DRAFT PR:
CHANGED FILES:
VERIFIED REPO FACTS:
DECISIONS / RECOMMENDATIONS:
DEPENDENCIES / POTENTIAL CONFLICTS:
TESTS RUN / RESULTS:
MIGRATIONS / PROD ACTIONS: None (or approved detail)
KNOWN LIMITATIONS:
NEEDS REGAN:
NEXT ACTION / FILES TO READ:
```

## Refresh strategy

- `agent-context.md`: update when architecture or product facts change materially, not on every PR.
- `active-workstreams.md`: refreshed on request in a small docs-only PR (see that file).
- `agent-task-protocol.md`: change only on explicit process review by Regan.
- The live GitHub and production state always wins over snapshots. Do not blindly rewrite historical context from stale notes.
