// Neon branch housekeeping: inventory, audit report, audit log and guarded deletion.
// Phase 1 is audit-only. Deletion refuses to run unless the registry sets cleanupEnabled: true
// (a reviewed commit = Regan's approval of Phase 2) AND the caller passes an approval reference.
import { execFile } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DECISION, estimateBranchCost, evaluate } from './policy.mjs';

export class NeonApiError extends Error {}

/** Neon client that reuses the Mac's existing `neonctl` sign-in. No API key is read or stored here. */
export function neonctlClient(projectId, { bin = 'neonctl', timeoutMs = 60_000 } = {}) {
  const call = (path, extra = []) =>
    new Promise((resolve, reject) => {
      execFile(bin, ['api', path, ...extra], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
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
        const res = await call(`/projects/${projectId}/branches${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!Array.isArray(res?.branches)) throw new NeonApiError('unexpected branch list response');
        out.push(...res.branches);
        cursor = res.pagination?.next ?? null;
        if (!cursor || res.branches.length === 0) return out;
      }
      throw new NeonApiError('branch list pagination did not finish');
    },
    async listEndpoints() {
      const res = await call(`/projects/${projectId}/endpoints`);
      if (!Array.isArray(res?.endpoints)) throw new NeonApiError('unexpected endpoint list response');
      return res.endpoints;
    },
    async deleteBranch(branchId) {
      return call(`/projects/${projectId}/branches/${branchId}`, ['-X', 'DELETE']);
    },
  };
}

/** Full inventory or an exception. A partial inventory is never evaluated. */
export async function fetchInventory(client) {
  const [branches, endpoints] = await Promise.all([client.listBranches(), client.listEndpoints()]);
  return { branches, endpoints };
}

export function loadRegistry(path) {
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  if (!registry.projectId) throw new Error('registry has no projectId');
  return registry;
}

// ---------- audit log (append-only JSONL) ----------

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

/** Digest of the decision set: a new GitHub comment is posted only when this changes. */
export function decisionDigest(result) {
  const parts = result.decisions.map((d) => `${d.branchId}:${d.decision}:${d.priority ?? ''}`).sort();
  return createHash('sha256').update(parts.concat(result.warnings).join('\n')).digest('hex').slice(0, 16);
}

// ---------- audit (read-only) ----------

/**
 * Read-only audit. Logs one summary line per run, plus a decision line only for branches whose
 * decision changed since the last run, so weekly runs don't flood the log.
 */
export async function runAudit({ client, registry, now, logPath, postComment = null }) {
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
  const previousDigest = [...log].reverse().find((e) => e.action === 'audit' && e.outcome === 'ok')?.digest ?? null;
  const digest = decisionDigest(result);

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
  const changed = digest !== previousDigest;
  const counts = countBy(result.decisions);
  entries.push({ at: now.toISOString(), run: runId, action: 'audit', outcome: 'ok', mode: 'read-only', branches: result.decisions.length, counts, warnings: result.warnings, digest, changed });
  appendLog(logPath, entries);

  const report = renderReport(result, registry);
  if (postComment && changed) await postComment(report);
  return { result, report, digest, changed };
}

function countBy(decisions) {
  const counts = {};
  for (const d of decisions) counts[d.decision] = (counts[d.decision] ?? 0) + 1;
  return counts;
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
  const lines = [`## Neon branch review — ${result.evaluatedAt.slice(0, 10)}`, '', `Mode: read-only. Nothing was deleted.`, ''];
  const counts = countBy(result.decisions);
  lines.push(`${result.decisions.length} branches: ${groups.map(([k]) => `${counts[k] ?? 0} ${k}`).join(', ')}. Usable recovery points: ${result.usableRecoveryPoints}; restore-verified: ${result.verifiedRecoveryPoints}.`, '');
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

// ---------- guarded deletion (Phase 2, not enabled) ----------

function acquireLock(lockPath) {
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
  } catch {
    throw new Error(`another housekeeping run holds ${lockPath}; remove it only if no run is active`);
  }
  return () => rmSync(lockPath, { force: true });
}

/**
 * Delete approved branches one at a time. Before EACH deletion the full inventory is fetched again and
 * re-evaluated; the branch must still be eligible and unchanged since the audit snapshot.
 *
 * @param {object} opts
 * @param {string[]} opts.branchIds      branches Regan approved
 * @param {string} opts.approval         where the approval was given (message link or id)
 * @param {Map<string,string>} opts.snapshot  branchId -> fingerprint from the audit Regan reviewed
 * @param {boolean} opts.execute         false = dry run (default)
 */
export async function runDeletion({ client, registry, now = () => new Date(), logPath, lockPath, branchIds, approval, snapshot, execute = false }) {
  if (registry.cleanupEnabled !== true) throw new Error('cleanup is not enabled in the registry (Phase 2 needs an approved change setting cleanupEnabled: true)');
  if (!approval || !String(approval).trim()) throw new Error('an approval reference is required');
  if (!Array.isArray(branchIds) || branchIds.length === 0) throw new Error('no branches were named');
  if (!(snapshot instanceof Map) || branchIds.some((id) => !snapshot.has(id))) throw new Error('every branch needs a fingerprint from the reviewed audit');
  if (client.projectId !== registry.projectId) throw new Error('client and registry project differ');

  const release = acquireLock(lockPath);
  const outcomes = [];
  const runId = `delete-${now().toISOString()}`;
  try {
    for (const id of branchIds) {
      const at = now();
      const base = { at: at.toISOString(), run: runId, action: 'delete', branchId: id, approval, dryRun: !execute };
      let inventory;
      try {
        inventory = await fetchInventory(client);
      } catch (err) {
        const entry = { ...base, outcome: 'aborted', reasons: [`fresh inventory failed: ${err.message}`] };
        appendLog(logPath, [entry]);
        outcomes.push(entry);
        break; // never continue on stale data
      }
      const result = evaluate(inventory, registry, at);
      const d = result.decisions.find((x) => x.branchId === id);
      let entry;
      if (!d) entry = { ...base, outcome: 'already-absent', reasons: ['branch no longer exists'] };
      else if (d.decision !== DECISION.ELIGIBLE) entry = { ...base, name: d.name, outcome: 'refused', reasons: [`now ${d.decision}`, ...d.reasons] };
      else if (d.fingerprint !== snapshot.get(id)) entry = { ...base, name: d.name, outcome: 'refused', reasons: ['branch changed since the reviewed audit; re-run the audit'] };
      else if (!execute) entry = { ...base, name: d.name, outcome: 'would-delete', reasons: d.reasons };
      else {
        try {
          await client.deleteBranch(id);
          entry = { ...base, name: d.name, outcome: 'deleted', reasons: d.reasons };
        } catch (err) {
          entry = { ...base, name: d.name, outcome: 'failed', reasons: [String(err.message ?? err)] };
          appendLog(logPath, [entry]);
          outcomes.push(entry);
          break;
        }
      }
      appendLog(logPath, [entry]);
      outcomes.push(entry);
    }
  } finally {
    release();
  }
  return outcomes;
}
