// Neon recovery-branch retention policy. Pure functions: no I/O, no clock, no Neon calls.
import { createHash } from 'node:crypto';
// The rules are minimum safeguards. "eligible" means "may be proposed for deletion",
// never "delete automatically": every deletion still needs Regan's approval and a fresh check.

export const DEFAULT_POLICY = Object.freeze({
  protectHours: 48, // younger branches are always protected
  priorityDays: 7, // older eligible branches are flagged for cleanup first
  minRecoveryPoints: 2, // recovery points that are always kept
});

export const CATEGORY = Object.freeze({
  PRODUCTION: 'production',
  RECOVERY: 'recovery',
  DEVELOPMENT: 'development',
  TESTING: 'testing',
  UNKNOWN: 'unknown',
});

export const DECISION = Object.freeze({
  PROTECTED: 'protected', // a rule forbids deletion
  KEEP: 'keep', // retained as one of the required recovery points
  ELIGIBLE: 'eligible', // may be proposed for deletion (approval still required)
  NEEDS_APPROVAL: 'needs-approval', // unknown or ambiguous: a person must decide
});

const HOUR_MS = 3_600_000;

/** Stable fingerprint of the branch fields that matter for a deletion decision. */
export function fingerprint(branch) {
  return [
    branch.id,
    branch.name,
    branch.parent_id ?? '',
    branch.parent_lsn ?? '',
    branch.created_at ?? '',
    branch.current_state ?? '',
    branch.updated_at ?? '',
    branch.default ? 'default' : '',
    branch.protected ? 'protected' : '',
  ].join('|');
}

const KINDS = new Set(Object.values(CATEGORY));
const STATUSES = new Set(['verified', 'pending', 'failed', 'not-run', 'missing']);

/** Reject registries that could make a decision ambiguous. Returns the registry for chaining. */
export function validateRegistry(registry) {
  const problems = [];
  if (!registry || typeof registry !== 'object') throw new Error('registry is not an object');
  if (typeof registry.projectId !== 'string' || !registry.projectId) problems.push('projectId missing');
  if (!Array.isArray(registry.branches)) problems.push('branches must be an array');
  const ids = new Set();
  const names = new Set();
  for (const [i, e] of (registry.branches ?? []).entries()) {
    const at = `branches[${i}]`;
    if (typeof e?.branchId !== 'string' || !e.branchId) problems.push(`${at}: branchId missing`);
    else if (ids.has(e.branchId)) problems.push(`${at}: duplicate branchId ${e.branchId}`);
    if (typeof e?.name !== 'string' || !e.name) problems.push(`${at}: name missing`);
    else if (names.has(e.name)) problems.push(`${at}: duplicate name ${e.name}`);
    ids.add(e?.branchId);
    names.add(e?.name);
    if (!KINDS.has(e?.kind)) problems.push(`${at}: unknown kind ${e?.kind}`);
    if (e?.kind === CATEGORY.RECOVERY) {
      for (const k of ['migration', 'deployment', 'restoreDrill']) {
        if (e[k] !== undefined && !STATUSES.has(e[k]?.status)) problems.push(`${at}: ${k}.status "${e[k]?.status}" is not one of ${[...STATUSES].join(', ')}`);
      }
      if (e.restoreCheck !== undefined) problems.push(`${at}: restoreCheck is no longer used; record a restoreDrill`);
    }
  }
  for (const [i, inc] of (registry.incidents ?? []).entries()) {
    if (!inc?.id || !Array.isArray(inc.branchIds)) problems.push(`incidents[${i}]: id and branchIds are required`);
  }
  if (problems.length) throw new Error(`invalid recovery-point registry:\n- ${problems.join('\n- ')}`);
  return registry;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Hash of every registry field that can change a decision. Any edit means the snapshot must be re-reviewed. */
export function registryHash(registry) {
  const relevant = { ...registry };
  delete relevant.billing; // billing only affects the cost note
  return createHash('sha256').update(canonical(relevant)).digest('hex').slice(0, 32);
}

/**
 * A recovery point counts as independently verified only after an evidenced restore drill:
 * restored to a temporary compute, and application data checked, not just reachable.
 */
export function restoreDrillVerified(entry) {
  const d = entry?.restoreDrill;
  return d?.status === 'verified' && d.dataIntegrityChecked === true && typeof d.evidence === 'string' && d.evidence.trim().length > 0 && typeof d.at === 'string';
}

function registryEntry(branch, registry) {
  const entries = registry.branches ?? [];
  const byId = entries.find((e) => e.branchId === branch.id);
  if (byId) {
    if (byId.name !== branch.name) return { entry: byId, mismatch: `registry name "${byId.name}" differs from Neon name` };
    return { entry: byId };
  }
  const byName = entries.find((e) => e.name === branch.name);
  if (byName) return { entry: null, mismatch: `registry lists "${branch.name}" with a different branch ID (${byName.branchId}); it may have been recreated` };
  return { entry: null };
}

/** Category from Neon flags, then the registry, then the name. Name alone never makes a branch deletable. */
export function classify(branch, registry) {
  if (branch.default || branch.primary || branch.name === 'production') return { category: CATEGORY.PRODUCTION, source: 'neon' };
  const { entry, mismatch } = registryEntry(branch, registry);
  if (mismatch) return { category: CATEGORY.UNKNOWN, source: 'registry-mismatch', note: mismatch };
  if (entry) return { category: entry.kind ?? CATEGORY.UNKNOWN, source: 'registry', entry };
  const n = branch.name.toLowerCase();
  if (/^pre-/.test(n)) return { category: CATEGORY.RECOVERY, source: 'name' };
  if (/(^|[-_/])(test|tests|ci|spike|tmp|scratch)([-_/]|$)/.test(n)) return { category: CATEGORY.TESTING, source: 'name' };
  if (/^(dev|preview|feat|feature|vercel-dev)([-_/]|$)/.test(n)) return { category: CATEGORY.DEVELOPMENT, source: 'name' };
  return { category: CATEGORY.UNKNOWN, source: 'none' };
}

function openIncidentFor(branch, entry, registry) {
  const incidents = (registry.incidents ?? []).filter((i) => i.status !== 'resolved');
  const hit = incidents.find((i) => (i.branchIds ?? []).includes(branch.id) || (i.branchIds ?? []).includes('*'));
  if (hit) return `open incident ${hit.id}: ${hit.summary ?? 'no summary'}`;
  if (entry?.incident && entry.incident.status !== 'resolved') return `open incident on this recovery point: ${entry.incident.summary ?? entry.incident.id ?? 'no summary'}`;
  return null;
}

function verificationGaps(entry) {
  const gaps = [];
  if (entry.migration?.status !== 'verified') gaps.push(`production migration not verified (status: ${entry.migration?.status ?? 'missing'})`);
  if (entry.deployment?.status !== 'verified') gaps.push(`production deployment not verified (status: ${entry.deployment?.status ?? 'missing'})`);
  if (entry.hold) gaps.push(`manual hold: ${entry.hold}`);
  return gaps;
}

/**
 * Evaluate the whole inventory. Decisions depend on other branches (children, the recovery minimum),
 * so always evaluate the full, fresh inventory rather than a single branch.
 *
 * @param {{branches: object[], endpoints: object[]}} inventory  Neon API objects
 * @param {object} registry  ops/neon/recovery-points.json
 * @param {Date} now
 */
export function evaluate(inventory, registry, now, policy = DEFAULT_POLICY) {
  validateRegistry(registry);
  const branches = inventory.branches ?? [];
  const endpoints = inventory.endpoints ?? [];
  const warnings = [];
  const nowMs = now.getTime();

  const ids = new Set();
  for (const b of branches) {
    if (ids.has(b.id)) throw new Error(`duplicate branch id in inventory: ${b.id}`);
    ids.add(b.id);
  }

  const rows = branches.map((b) => {
    const c = classify(b, registry);
    const createdMs = Date.parse(b.created_at);
    const ageHours = Number.isFinite(createdMs) ? (nowMs - createdMs) / HOUR_MS : null;
    return { branch: b, ...c, ageHours };
  });

  // Recovery points that could actually be used to restore: registered, ready, migration verified.
  const usable = rows
    .filter((r) => r.category === CATEGORY.RECOVERY && r.source === 'registry' && r.branch.current_state === 'ready' && r.entry?.migration?.status === 'verified')
    .sort((a, b) => Date.parse(b.branch.created_at) - Date.parse(a.branch.created_at));
  const verified = usable.filter((r) => restoreDrillVerified(r.entry));

  // Keep the newest independently verified points; top up with the newest usable ones if there are too few.
  const retained = new Map();
  for (const r of verified.slice(0, policy.minRecoveryPoints)) retained.set(r.branch.id, 'one of the two most recent restore-drilled recovery points');
  for (const r of usable) {
    if (retained.size >= policy.minRecoveryPoints) break;
    if (!retained.has(r.branch.id)) retained.set(r.branch.id, 'kept to hold the two-recovery-point minimum (no restore drill yet)');
  }
  if (usable[0]) retained.set(usable[0].branch.id, retained.get(usable[0].branch.id) ?? 'last known usable recovery point');
  if (verified.length < policy.minRecoveryPoints) {
    warnings.push(`Only ${verified.length} recovery point(s) have an evidenced restore drill; the minimum is ${policy.minRecoveryPoints}. Unverified points are being kept instead.`);
  }
  if (usable.length === 0) warnings.push('No usable recovery point found. Nothing can be deleted until one exists.');

  const decisions = rows.map((r) => {
    const b = r.branch;
    const reasons = [];
    let decision = null;
    const set = (d, reason) => {
      if (!decision) decision = d;
      reasons.push(reason);
    };

    if (r.category === CATEGORY.PRODUCTION) set(DECISION.PROTECTED, 'production branch: never deleted');
    if (b.protected) set(DECISION.PROTECTED, 'marked protected in Neon');
    if (branches.some((o) => o.parent_id === b.id)) set(DECISION.PROTECTED, 'has child branches');
    if (b.current_state !== 'ready') set(DECISION.PROTECTED, `branch state is "${b.current_state}", not ready`);
    if (r.ageHours === null) set(DECISION.NEEDS_APPROVAL, 'creation time missing or unreadable');
    else if (r.ageHours < policy.protectHours) set(DECISION.PROTECTED, `younger than ${policy.protectHours} hours`);
    if (endpoints.some((e) => e.branch_id === b.id)) set(DECISION.NEEDS_APPROVAL, 'has a compute endpoint attached (may be in use)');
    const incident = openIncidentFor(b, r.entry, registry);
    if (incident) set(DECISION.PROTECTED, incident);

    if (r.category === CATEGORY.RECOVERY) {
      if (r.source !== 'registry') set(DECISION.NEEDS_APPROVAL, 'recovery-style name but not in the recovery-point registry');
      else for (const gap of verificationGaps(r.entry)) set(DECISION.PROTECTED, gap);
      if (retained.has(b.id)) set(DECISION.KEEP, retained.get(b.id));
    } else if (r.category !== CATEGORY.PRODUCTION) {
      set(DECISION.NEEDS_APPROVAL, r.note ?? `${r.category} branch: ownership and purpose need a person's decision`);
    }

    // A retained recovery point is reported as KEEP even when another rule also protects it.
    if (retained.has(b.id) && decision === DECISION.PROTECTED) decision = DECISION.KEEP;

    let priority = null;
    if (!decision) {
      decision = DECISION.ELIGIBLE;
      priority = r.ageHours >= policy.priorityDays * 24 ? 'cleanup' : 'review';
      reasons.push(priority === 'cleanup' ? `older than ${policy.priorityDays} days and no longer required` : `between ${policy.protectHours} hours and ${policy.priorityDays} days old: review`);
    }

    return {
      branchId: b.id,
      name: b.name,
      category: r.category,
      decision,
      priority,
      reasons,
      ageHours: r.ageHours === null ? null : Math.round(r.ageHours * 10) / 10,
      createdAt: b.created_at,
      parentId: b.parent_id ?? null,
      logicalSizeBytes: b.logical_size ?? null,
      links: r.entry ? { migrations: r.entry.migrations ?? [], prs: r.entry.prs ?? [], appliedAt: r.entry.appliedAt ?? null } : null,
      fingerprint: fingerprint(b),
    };
  });

  return { evaluatedAt: now.toISOString(), registryHash: registryHash(registry), decisions, warnings, verifiedRecoveryPoints: verified.length, usableRecoveryPoints: usable.length };
}

/** Rough monthly cost of branches above the plan allowance. Only as good as the billing figures in the registry. */
export function estimateBranchCost(branchCount, billing) {
  if (!billing || typeof billing.includedBranches !== 'number' || typeof billing.extraBranchMonthUsd !== 'number') return null;
  const extra = Math.max(0, branchCount - billing.includedBranches);
  return { extraBranches: extra, monthlyUsd: Math.round(extra * billing.extraBranchMonthUsd * 100) / 100, basis: billing.source ?? 'registry billing figures' };
}
