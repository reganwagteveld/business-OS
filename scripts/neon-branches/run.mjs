// Neon branch housekeeping: inventory, audit report, audit log and a read-only pre-deletion check.
// Phase 1 is audit-only. This module contains NO code that deletes a Neon branch: deletion, and the
// trusted, branch-specific approval it needs, belong to a separate Phase 2 change.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DECISION, estimateBranchCost, evaluate, validateRegistry } from './policy.mjs';

export class NeonApiError extends Error {}

/** Read-only Neon client that reuses the Mac's existing `neonctl` sign-in. No API key is read or stored here. */
export function neonctlClient(projectId, { bin = 'neonctl', timeoutMs = 60_000 } = {}) {
  const get = (path) =>
    new Promise((resolve, reject) => {
      execFile(bin, ['api', path], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new NeonApiError(`neonctl api ${path} failed: ${(stderr || err.message).trim().slice(0, 300)}`));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new NeonApiError(`neonctl api ${path} returned non-JSON output`));
        }
      });
    });
  return {
    projectId,
    async listBranches() {
      const out = [];
      let cursor = null;
      for (let page = 0; page < 50; page++) {
        const res = await get(`/projects/${projectId}/branches${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!Array.isArray(res?.branches)) throw new NeonApiError('unexpected branch list response');
        out.push(...res.branches);
        cursor = res.pagination?.next ?? null;
        if (!cursor || res.branches.length === 0) return out;
      }
      throw new NeonApiError('branch list pagination did not finish');
    },
    async listEndpoints() {
      const res = await get(`/projects/${projectId}/endpoints`);
      if (!Array.isArray(res?.endpoints)) throw new NeonApiError('unexpected endpoint list response');
      return res.endpoints;
    },
  };
}

/** Full inventory or an exception. A partial inventory is never evaluated. */
export async function fetchInventory(client) {
  const [branches, endpoints] = await Promise.all([client.listBranches(), client.listEndpoints()]);
  return { branches, endpoints };
}

export function loadRegistry(path) {
  return validateRegistry(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------- audit log (append-only JSONL; Git history is the record, not an immutable ledger) ----------

export function readLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function appendLog(path, entries) {
  if (entries.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function lastDecisions(log) {
  const last = new Map();
  for (const e of log) if (e.action === 'decision') last.set(e.branchId, e);
  return last;
}

/** Digest of the decision set. A GitHub comment is due whenever this differs from the last one delivered. */
export function decisionDigest(result) {
  const parts = result.decisions.map((d) => `${d.branchId}:${d.decision}:${d.priority ?? ''}`).sort();
  return createHash('sha256').update(parts.concat(result.warnings).join('\n')).digest('hex').slice(0, 16);
}

// ---------- audit (read-only) ----------

/**
 * Read-only audit. Logs one summary line per run, plus a decision line only for branches whose
 * decision changed since the last run, so weekly runs don't flood the log.
 *
 * Notification: a comment is posted when the digest differs from the last *successfully delivered*
 * one, so a failed post is retried on the next run. The outcome is logged as notification:
 * "sent" | "failed" | "not-needed" | "not-configured".
 */
export async function runAudit({ client, registry, now, logPath, postComment = null }) {
  validateRegistry(registry);
  if (client.projectId !== registry.projectId) throw new Error(`client project ${client.projectId} does not match registry project ${registry.projectId}`);
  const runId = `audit-${now.toISOString()}`;
  let inventory;
  try {
    inventory = await fetchInventory(client);
  } catch (err) {
    appendLog(logPath, [{ at: now.toISOString(), run: runId, action: 'audit', outcome: 'failed', error: String(err.message ?? err) }]);
    throw err;
  }
  const result = evaluate(inventory, registry, now);
  const log = readLog(logPath);
  const previous = lastDecisions(log);
  const audits = log.filter((e) => e.action === 'audit' && e.outcome === 'ok');
  const previousDigest = audits.at(-1)?.digest ?? null;
  const deliveredDigest = [...audits].reverse().find((e) => e.notification === 'sent')?.digest ?? null;
  const digest = decisionDigest(result);
  const changed = digest !== previousDigest;

  const entries = [];
  for (const d of result.decisions) {
    const prev = previous.get(d.branchId);
    if (prev && prev.decision === d.decision && prev.priority === d.priority) continue;
    entries.push({ at: now.toISOString(), run: runId, action: 'decision', branchId: d.branchId, name: d.name, category: d.category, decision: d.decision, priority: d.priority, reasons: d.reasons });
  }
  const liveIds = new Set(result.decisions.map((d) => d.branchId));
  for (const [id, prev] of previous) {
    if (!liveIds.has(id) && prev.decision !== 'absent') entries.push({ at: now.toISOString(), run: runId, action: 'decision', branchId: id, name: prev.name, decision: 'absent', priority: null, reasons: ['no longer in the Neon inventory'] });
  }

  const report = renderReport(result, registry);
  let notification = 'not-configured';
  let notificationError;
  if (postComment) {
    if (digest === deliveredDigest) notification = 'not-needed';
    else {
      try {
        await postComment(report);
        notification = 'sent';
      } catch (err) {
        notification = 'failed';
        notificationError = String(err.message ?? err).slice(0, 300);
      }
    }
  }

  const counts = countBy(result.decisions);
  entries.push({ at: now.toISOString(), run: runId, action: 'audit', outcome: 'ok', mode: 'read-only', branches: result.decisions.length, counts, warnings: result.warnings, digest, registryHash: result.registryHash, changed, notification, ...(notificationError ? { notificationError } : {}) });
  appendLog(logPath, entries);
  return { result, report, digest, changed, notification };
}

function countBy(decisions) {
  const counts = {};
  for (const d of decisions) counts[d.decision] = (counts[d.decision] ?? 0) + 1;
  return counts;
}

/** Snapshot of an audit for later review: binds branch fingerprints to the registry revision. */
export function snapshotOf(result) {
  return { evaluatedAt: result.evaluatedAt, registryHash: result.registryHash, fingerprints: Object.fromEntries(result.decisions.map((d) => [d.branchId, d.fingerprint])) };
}

// ---------- report ----------

const fmtAge = (h) => (h === null ? '?' : h < 48 ? `${Math.round(h)} h` : `${Math.round((h / 24) * 10) / 10} d`);
const fmtLinks = (l) => (l ? [l.migrations.join(', '), l.prs.length ? `PR ${l.prs.map((p) => `#${p}`).join(', ')}` : ''].filter(Boolean).join(' · ') : '');

export function renderReport(result, registry) {
  const groups = [
    [DECISION.ELIGIBLE, 'Eligible for cleanup (needs approval before any deletion)'],
    [DECISION.NEEDS_APPROVAL, 'Uncertain: needs a manual decision'],
    [DECISION.KEEP, 'Kept as required recovery points'],
    [DECISION.PROTECTED, 'Protected'],
  ];
  const lines = [`## Neon branch review — ${result.evaluatedAt.slice(0, 10)}`, '', `Mode: read-only. Nothing was deleted. Registry revision \`${result.registryHash.slice(0, 12)}\`.`, ''];
  const counts = countBy(result.decisions);
  lines.push(`${result.decisions.length} branches: ${groups.map(([k]) => `${counts[k] ?? 0} ${k}`).join(', ')}. Usable recovery points: ${result.usableRecoveryPoints}; restore-drilled: ${result.verifiedRecoveryPoints}.`, '');
  if (result.warnings.length) lines.push('**Warnings**', '', ...result.warnings.map((w) => `- ${w}`), '');
  for (const [key, title] of groups) {
    const rows = result.decisions.filter((d) => d.decision === key).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (!rows.length) continue;
    lines.push(`### ${title}`, '', '| Branch | ID | Age | Type | Linked to | Why |', '|---|---|---|---|---|---|');
    for (const d of rows) lines.push(`| ${d.name}${d.priority ? ` (${d.priority})` : ''} | \`${d.branchId}\` | ${fmtAge(d.ageHours)} | ${d.category} | ${fmtLinks(d.links)} | ${d.reasons.join('; ')} |`);
    lines.push('');
  }
  const cost = estimateBranchCost(result.decisions.length, registry.billing);
  if (cost) {
    lines.push('### Cost estimate', '', `${cost.extraBranches} branch(es) above the plan allowance ≈ $${cost.monthlyUsd.toFixed(2)}/month (${cost.basis}). Estimate only; not read from a Neon invoice.`);
    const eligible = counts[DECISION.ELIGIBLE] ?? 0;
    if (eligible) {
      const after = estimateBranchCost(result.decisions.length - eligible, registry.billing);
      lines.push(`Deleting the ${eligible} eligible branch(es) would bring this to ≈ $${after.monthlyUsd.toFixed(2)}/month.`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Exit code for a set of verdicts. 0 only when EVERY named branch is `allowed`; callers must still
 * check each verdict by branch ID rather than trusting the exit code alone.
 * 0 = all allowed, 1 = aborted (inventory failure), 2 = at least one refused or already absent.
 */
export function exitCodeFor(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) return 2;
  if (verdicts.some((v) => v.verdict === 'aborted')) return 1;
  return verdicts.every((v) => v.verdict === 'allowed') ? 0 : 2;
}

// ---------- read-only pre-deletion check (the gate Phase 2 must call before every deletion) ----------

/**
 * For each named branch, fetch the full inventory again, re-evaluate it, and say whether deletion
 * would still be allowed. Deletes nothing. A branch passes only if it is still `eligible`, its Neon
 * fields are unchanged since the reviewed snapshot, and the registry is the revision that was reviewed.
 *
 * @returns {Promise<Array<{branchId: string, name?: string, verdict: 'allowed'|'refused'|'already-absent'|'aborted', reasons: string[]}>>}
 */
export async function checkDeletion({ client, registry, now = () => new Date(), branchIds, snapshot }) {
  validateRegistry(registry);
  if (client.projectId !== registry.projectId) throw new Error('client and registry project differ');
  if (!Array.isArray(branchIds) || branchIds.length === 0) throw new Error('no branches were named');
  if (!snapshot?.registryHash || !snapshot.fingerprints) throw new Error('a snapshot from the reviewed audit is required');

  const verdicts = [];
  for (const id of branchIds) {
    let inventory;
    try {
      inventory = await fetchInventory(client);
    } catch (err) {
      verdicts.push({ branchId: id, verdict: 'aborted', reasons: [`fresh inventory failed: ${err.message}`] });
      break; // never decide on stale data
    }
    const result = evaluate(inventory, registry, now());
    const d = result.decisions.find((x) => x.branchId === id);
    if (result.registryHash !== snapshot.registryHash) verdicts.push({ branchId: id, name: d?.name, verdict: 'refused', reasons: ['registry changed since the reviewed audit; re-run the audit and get it reviewed again'] });
    else if (!(id in snapshot.fingerprints)) verdicts.push({ branchId: id, name: d?.name, verdict: 'refused', reasons: ['branch is not in the reviewed snapshot'] });
    else if (!d) verdicts.push({ branchId: id, verdict: 'already-absent', reasons: ['branch no longer exists'] });
    else if (d.decision !== DECISION.ELIGIBLE) verdicts.push({ branchId: id, name: d.name, verdict: 'refused', reasons: [`now ${d.decision}`, ...d.reasons] });
    else if (d.fingerprint !== snapshot.fingerprints[id]) verdicts.push({ branchId: id, name: d.name, verdict: 'refused', reasons: ['branch changed since the reviewed audit; re-run the audit'] });
    else verdicts.push({ branchId: id, name: d.name, verdict: 'allowed', reasons: d.reasons });
  }
  return verdicts;
}
