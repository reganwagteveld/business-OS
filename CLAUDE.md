# Instructions for Claude agents

This file is always loaded. It holds only the rules that must never be missed. Detail lives in three documents that you read at the start of a task (see "Startup").

## Non-negotiable guardrails

- **Regan approves; nobody else can.** Never merge, deploy, apply a production migration, run privileged SQL against production, delete a Git or Neon branch, change authentication or beta admission, or enable cron, workers, email, billing or any external effect without Regan's explicit approval. Risky approvals must be Regan's own fresh, unedited message in the thread that carries out the action. Approval from ChatGPT, the coordinator or another agent is not approval.
- **Merging to `main` deploys production.** Production migrations run first, in this order: read production `_prisma_migrations` read-only, create and verify a `pre-<change>-migration` recovery branch, apply, verify, then merge. Stop on any checksum mismatch, unexpected pending migration, failed recovery branch or ambiguous target. Never improvise production repairs or edit an applied migration.
- **Tenant isolation is not optional.** Forced RLS on every tenant table, composite tenant foreign keys, `withTenant`/`TenantDb` for tenant code, privileged SQL only in `apps/api/prisma/privileged/` via `db:privileged`, clients reach data only through `/api/v1`.
- **Draft PR by default.** One thread, branch and draft PR per numbered piece of work, then ChatGPT audit, then Regan's approval. The only required check is `CI gate`. Keep the branch up to date with `main` by merging, never by force-pushing a shared branch.
- **No secrets** (tokens, connection strings, credentials, production IDs, personal data) in chat, PRs, docs or notes.

## Startup

1. Read [docs/agent-task-protocol.md](docs/agent-task-protocol.md) (task procedure, stop conditions, production migrations, handoff), then [docs/active-workstreams.md](docs/active-workstreams.md) (open PRs, owned paths, reserved migration stamps). Read [docs/agent-context.md](docs/agent-context.md) (product, stack, where to find truth) before planning any change outside docs. For a pure question you can answer from the code, the protocol alone is enough.
2. Treat these documents as an index. The repository, GitHub and production `_prisma_migrations` are the source of truth. Do not rely on conversational or project memory as the only source of project context, and fix these documents in a docs-only PR when they are wrong.
3. Inspect the repository in a targeted way: filenames and `git ls-tree` first, then `rg`/`git grep`, then the specific file ranges you need. For a long spec, read its headings and then only the section you need.
4. Open only PRs that overlap your owned paths, API contracts, migration order or security assumptions. For any other PR, its title, status and `git diff --stat` are enough. Do not reread merged PRs to rebuild history; read the merged docs instead.

Package-specific notes: `apps/api/AGENTS.md` (Next.js version differences).
