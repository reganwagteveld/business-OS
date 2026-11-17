/**
 * CIQ-A3: the merge queue's read-only verdict detector (scripts/merge-queue/verdict-status.sh).
 * Runs its offline self-test, which feeds synthetic comments to the parser: only an unedited
 * chatgpt-codex-connector comment whose first line is exactly "APPROVED — EXECUTE: MERGE" and that
 * names exactly one reviewed head SHA counts. Nothing here contacts GitHub.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

it('accepts only provenance-checked, exact merge verdicts (fail closed)', () => {
  const run = spawnSync('bash', [join(ROOT, 'scripts/merge-queue/verdict-status.test.sh')], { encoding: 'utf8' });
  expect(run.stderr).toBe('');
  expect(run.status).toBe(0);
  expect(run.stdout).toMatch(/ok {3}plain verdict/);
});
