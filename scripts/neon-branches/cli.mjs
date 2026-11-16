#!/usr/bin/env node
// Usage (from the repo root, on a machine where `neonctl` and `gh` are signed in):
//   node scripts/neon-branches/cli.mjs audit [--report out.md] [--snapshot out.json] [--github-issue N]
//   node scripts/neon-branches/cli.mjs check --snapshot out.json --ids br-a,br-b
// Both commands are read-only. `check` runs the fresh eligibility gate that Phase 2 deletion will use;
// nothing in this tool deletes a branch.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkDeletion, loadRegistry, neonctlClient, runAudit, snapshotOf } from './run.mjs';

const GITHUB_REPO = 'reganwagteveld/business-OS';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    registry: { type: 'string', default: 'ops/neon/recovery-points.json' },
    log: { type: 'string', default: 'ops/neon/audit-log.jsonl' },
    report: { type: 'string' },
    snapshot: { type: 'string' },
    'github-issue': { type: 'string' },
    ids: { type: 'string' },
  },
});

const registry = loadRegistry(values.registry);
const client = neonctlClient(registry.projectId);
const command = positionals[0] ?? 'audit';

if (command === 'audit') {
  const issue = values['github-issue'];
  if (issue && !/^\d+$/.test(issue)) throw new Error('--github-issue must be an issue number');
  const postComment = issue
    ? async (body) => execFileSync('gh', ['issue', 'comment', issue, '--repo', GITHUB_REPO, '--body-file', '-'], { input: body, stdio: ['pipe', 'inherit', 'pipe'] })
    : null;
  const { result, report, changed, notification } = await runAudit({ client, registry, now: new Date(), logPath: values.log, postComment });
  if (values.report) writeFileSync(values.report, report + '\n');
  if (values.snapshot) writeFileSync(values.snapshot, JSON.stringify(snapshotOf(result), null, 2) + '\n');
  process.stdout.write(report + '\n');
  process.stdout.write(`\n(decision set ${changed ? 'changed' : 'unchanged'} since the last audit; GitHub comment: ${notification})\n`);
  if (notification === 'failed') process.exitCode = 1; // retried automatically on the next run
} else if (command === 'check') {
  if (!values.snapshot) throw new Error('--snapshot from the reviewed audit is required');
  const verdicts = await checkDeletion({
    client,
    registry,
    branchIds: (values.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    snapshot: JSON.parse(readFileSync(values.snapshot, 'utf8')),
  });
  for (const v of verdicts) process.stdout.write(`${v.branchId} ${v.name ?? ''}: ${v.verdict} (${v.reasons.join('; ')})\n`);
  if (verdicts.some((v) => v.verdict === 'aborted')) process.exitCode = 1;
} else {
  throw new Error(`unknown command ${command}`);
}
