# Instructions for Claude agents

At the start of every task, read these three documents. They are imported below, so Claude Code loads them automatically:

- @docs/agent-task-protocol.md — how to run a task, approvals, stop conditions, production migrations
- @docs/agent-context.md — product, stack, security invariants, where to find truth
- @docs/active-workstreams.md — open PRs, owned paths, reserved migration stamps

Then:

1. Treat these documents as an index. The repository, GitHub and the production `_prisma_migrations` table are the source of truth. Do not rely on conversational or project memory as the only source of project context, and correct these documents in a docs-only PR when they are wrong.
2. Inspect the repository in a targeted way: filenames and `git ls-tree` first, then `rg`/`git grep`, then the specific file ranges you need. Read the relevant section of a long spec, not the whole file.
3. Only open PRs that overlap your owned paths, API contracts, migration order or security assumptions. For any other PR, its title, status and `git diff --stat` are enough. Do not reread merged PRs to rebuild history; read the merged docs instead.
4. Never merge, deploy, apply production migrations, run privileged SQL against production, or enable cron, workers, email or billing without Regan's explicit approval as defined in the protocol.

Package-specific notes: `apps/api/AGENTS.md` (Next.js version differences).
