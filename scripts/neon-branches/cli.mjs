#!/usr/bin/env node
// Usage (from the repo root, on a machine where `neonctl` is signed in):
//   node scripts/neon-branches/cli.mjs audit [--report out.md] [--snapshot out.json] [--github-issue N]
//   node scripts/neon-branches/cli.mjs delete --snapshot out.json --ids br-a,br-b --approval "<link>" [--execute]
// `audit` is read-only. `delete` refuses unless ops/neon/recovery-points.json has cleanupEnabled: true,
// and without --execute it is a dry run.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadRegistry, neonctlClient, runAudit, runDeletion } from './run.mjs';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    registry: { type: 'string', default: 'ops/neon/recovery-points.json' },
    log: { type: 'string', default: 'ops/neon/audit-log.jsonl' },
    lock: { type: 'string', default: 'ops/neon/.housekeeping.lock' },
    report: { type: 'string' },
    snapshot: { type: 'string' },
    'github-issue': { type: 'string' },
    ids: { type: 'string' },
    approval: { type: 'string' },
    execute: { type: 'boolean', default: false },
  },
});

const registry = loadRegistry(values.registry);
const client = neonctlClient(registry.projectId);
const command = positionals[0] ?? 'audit';

if (command === 'audit') {
  const issue = values['github-issue'];
  const postComment = issue
    ? async (body) => execFileSync('gh', ['issue', 'comment', issue, '--body-file', '-'], { input: body, stdio: ['pipe', 'inherit', 'inherit'] })
    : null;
  const { result, report, changed } = await runAudit({ client, registry, now: new Date(), logPath: values.log, postComment });
  if (values.report) writeFileSync(values.report, report + '\n');
  if (values.snapshot) {
    const snapshot = { evaluatedAt: result.evaluatedAt, fingerprints: Object.fromEntries(result.decisions.map((d) => [d.branchId, d.fingerprint])) };
    writeFileSync(values.snapshot, JSON.stringify(snapshot, null, 2) + '\n');
  }
  process.stdout.write(report + '\n');
  process.stdout.write(`\n(decision set ${changed ? 'changed' : 'unchanged'} since the last audit)\n`);
} else if (command === 'delete') {
  if (!values.snapshot) throw new Error('--snapshot from the reviewed audit is required');
  const snap = JSON.parse(readFileSync(values.snapshot, 'utf8'));
  const outcomes = await runDeletion({
    client,
    registry,
    logPath: values.log,
    lockPath: values.lock,
    branchIds: (values.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    approval: values.approval,
    snapshot: new Map(Object.entries(snap.fingerprints ?? {})),
    execute: values.execute,
  });
  for (const o of outcomes) process.stdout.write(`${o.branchId} ${o.name ?? ''}: ${o.outcome} (${o.reasons.join('; ')})\n`);
  if (outcomes.some((o) => o.outcome === 'failed' || o.outcome === 'aborted')) process.exitCode = 1;
} else {
  throw new Error(`unknown command ${command}`);
}
