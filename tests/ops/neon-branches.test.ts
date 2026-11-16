/**
 * Neon branch housekeeping: retention policy and deletion safeguards.
 * Every test uses an in-memory fake Neon client. No test can reach a real Neon project:
 * the fake's project ID is not a real one and the real neonctl client is never constructed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluate, fingerprint, type NeonBranch, type Registry } from '../../scripts/neon-branches/policy.mjs';
import { readLog, runAudit, runDeletion, type NeonClient } from '../../scripts/neon-branches/run.mjs';

const PROJECT = 'test-project-not-real';
const NOW = new Date('2026-11-29T08:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const prod: NeonBranch = { id: 'br-prod', name: 'production', default: true, primary: true, current_state: 'ready', created_at: hoursAgo(24 * 30), updated_at: hoursAgo(1) };
const rec = (id: string, ageH: number): NeonBranch => ({ id, name: `pre-${id}`, parent_id: 'br-prod', parent_lsn: `0/${id.length}`, current_state: 'ready', created_at: hoursAgo(ageH), updated_at: hoursAgo(ageH) });

type EntryOpts = { restore?: boolean; migration?: string; deployment?: string; incident?: { status: string; summary: string }; hold?: string };
const entry = (b: NeonBranch, o: EntryOpts = {}) => ({
  branchId: b.id,
  name: b.name,
  kind: 'recovery',
  migrations: [`m_${b.id}`],
  prs: [1],
  migration: { status: o.migration ?? 'verified' },
  deployment: { status: o.deployment ?? 'verified' },
  restoreCheck: { status: o.restore === false ? 'not-run' : 'verified' },
  ...(o.incident ? { incident: o.incident } : {}),
  ...(o.hold ? { hold: o.hold } : {}),
});

function registryFor(pairs: Array<[NeonBranch, EntryOpts?]>, extra: Partial<Registry> = {}): Registry {
  return {
    projectId: PROJECT,
    cleanupEnabled: true,
    billing: { includedBranches: 10, extraBranchMonthUsd: 1.5 },
    incidents: [],
    branches: [{ branchId: 'br-prod', name: 'production', kind: 'production' }, ...pairs.map(([b, o]) => entry(b, o))],
    ...extra,
  };
}

/** Fake Neon client over a mutable branch list. Hooks let tests simulate concurrent changes and failures. */
function fakeNeon(branches: NeonBranch[], opts: { endpoints?: { id: string; branch_id: string }[] } = {}) {
  const state = { branches: [...branches], endpoints: opts.endpoints ?? [{ id: 'ep-prod', branch_id: 'br-prod' }], deleted: [] as string[], listCalls: 0 };
  const hooks: { beforeList?: (n: number) => void; failList?: (n: number) => boolean; failDelete?: (id: string) => boolean } = {};
  const client: NeonClient = {
    projectId: PROJECT,
    async listBranches() {
      state.listCalls++;
      hooks.beforeList?.(state.listCalls);
      if (hooks.failList?.(state.listCalls)) throw new Error('503 Service Unavailable');
      return structuredClone(state.branches);
    },
    async listEndpoints() {
      return structuredClone(state.endpoints);
    },
    async deleteBranch(id: string) {
      if (hooks.failDelete?.(id)) throw new Error('500 internal error');
      if (state.branches.some((b) => b.parent_id === id)) throw new Error('branch has children');
      state.branches = state.branches.filter((b) => b.id !== id);
      state.deleted.push(id);
      return {};
    },
  };
  return { client, state, hooks };
}

const decisionOf = (r: ReturnType<typeof evaluate>, id: string) => r.decisions.find((d) => d.branchId === id)!;

let dir: string;
let logPath: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neon-branches-'));
  logPath = join(dir, 'audit-log.jsonl');
  lockPath = join(dir, '.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('retention policy', () => {
  it('never makes the production branch deletable, even when old and unregistered', () => {
    const r = evaluate({ branches: [prod], endpoints: [] }, { projectId: PROJECT, branches: [] }, NOW);
    expect(decisionOf(r, 'br-prod').decision).toBe('protected');
    expect(decisionOf(r, 'br-prod').reasons[0]).toMatch(/production/);
  });

  it('protects any branch that is the Neon default even if it is not named production', () => {
    const odd = { ...rec('x', 500), default: true };
    const r = evaluate({ branches: [prod, odd], endpoints: [] }, registryFor([[odd]]), NOW);
    expect(decisionOf(r, 'x').decision).toBe('protected');
  });

  it('protects branches younger than 48 hours, including at 47.9 h', () => {
    const [a, b, c, young] = [rec('a', 300), rec('b', 290), rec('c', 280), rec('young', 47.9)];
    const r = evaluate({ branches: [prod, a, b, c, young], endpoints: [] }, registryFor([[a], [b], [c], [young]]), NOW);
    // young is one of the two newest, so it is kept; check the youth reason is recorded too
    expect(decisionOf(r, 'young').reasons.join(' ')).toMatch(/younger than 48 hours/);
    expect(['protected', 'keep']).toContain(decisionOf(r, 'young').decision);
  });

  it('protects a young branch that is not one of the retained recovery points', () => {
    // young is not usable (its migration is unverified), so only the 48-hour and verification rules apply
    const [n1, n2, young] = [rec('n1', 49), rec('n2', 49.5), rec('young', 10)];
    const r = evaluate({ branches: [prod, n1, n2, young], endpoints: [] }, registryFor([[n1], [n2], [young, { migration: 'pending' }]]), NOW);
    expect(decisionOf(r, 'young').decision).toBe('protected');
    expect(decisionOf(r, 'young').reasons[0]).toMatch(/younger than 48 hours/);
  });

  it('keeps the two newest restore-verified recovery points and marks older ones eligible by age band', () => {
    const [old, mid, n1, n2] = [rec('old', 24 * 9), rec('mid', 24 * 4), rec('n1', 60), rec('n2', 55)];
    const r = evaluate({ branches: [prod, old, mid, n1, n2], endpoints: [] }, registryFor([[old], [mid], [n1], [n2]]), NOW);
    expect(decisionOf(r, 'n2').decision).toBe('keep');
    expect(decisionOf(r, 'n1').decision).toBe('keep');
    expect(decisionOf(r, 'mid')).toMatchObject({ decision: 'eligible', priority: 'review' });
    expect(decisionOf(r, 'old')).toMatchObject({ decision: 'eligible', priority: 'cleanup' });
    expect(r.warnings).toEqual([]);
  });

  it('skips unverified newer points when choosing the verified two, and keeps the newest usable point', () => {
    const [v1, v2, u1] = [rec('v1', 200), rec('v2', 190), rec('u1', 60)];
    const r = evaluate({ branches: [prod, v1, v2, u1], endpoints: [] }, registryFor([[v1], [v2], [u1, { restore: false }]]), NOW);
    expect(decisionOf(r, 'v1').decision).toBe('keep');
    expect(decisionOf(r, 'v2').decision).toBe('keep');
    expect(decisionOf(r, 'u1').decision).toBe('keep'); // last known usable recovery point
  });

  it('tops up with unverified points and warns when fewer than two are restore-verified', () => {
    const [a, b, c] = [rec('a', 300), rec('b', 200), rec('c', 100)];
    const r = evaluate({ branches: [prod, a, b, c], endpoints: [] }, registryFor([[a, { restore: false }], [b, { restore: false }], [c, { restore: false }]]), NOW);
    expect(decisionOf(r, 'c').decision).toBe('keep');
    expect(decisionOf(r, 'b').decision).toBe('keep');
    expect(decisionOf(r, 'a').decision).toBe('eligible');
    expect(r.warnings.join(' ')).toMatch(/Only 0 recovery point/);
  });

  it('never makes the only recovery point eligible', () => {
    const only = rec('only', 24 * 30);
    const r = evaluate({ branches: [prod, only], endpoints: [] }, registryFor([[only, { restore: false }]]), NOW);
    expect(decisionOf(r, 'only').decision).toBe('keep');
  });

  it('protects branches tied to an open incident (registry-wide or on the entry) and releases them once resolved', () => {
    const [a, b, n1, n2] = [rec('a', 300), rec('b', 290), rec('n1', 100), rec('n2', 90)];
    const reg = registryFor([[a], [b, { incident: { status: 'open', summary: 'bad deploy' } }], [n1], [n2]], {
      incidents: [{ id: 'INC-1', status: 'open', summary: 'rollback pending', branchIds: ['a'] }],
    });
    const r = evaluate({ branches: [prod, a, b, n1, n2], endpoints: [] }, reg, NOW);
    expect(decisionOf(r, 'a')).toMatchObject({ decision: 'protected' });
    expect(decisionOf(r, 'a').reasons.join(' ')).toMatch(/INC-1/);
    expect(decisionOf(r, 'b').decision).toBe('protected');
    reg.incidents[0].status = 'resolved';
    expect(decisionOf(evaluate({ branches: [prod, a, b, n1, n2], endpoints: [] }, reg, NOW), 'a').decision).toBe('eligible');
  });

  it('a wildcard incident freezes every branch', () => {
    const [a, n1, n2] = [rec('a', 300), rec('n1', 100), rec('n2', 90)];
    const reg = registryFor([[a], [n1], [n2]], { incidents: [{ id: 'INC-2', status: 'open', branchIds: ['*'] }] });
    const r = evaluate({ branches: [prod, a, n1, n2], endpoints: [] }, reg, NOW);
    expect(r.decisions.filter((d) => d.decision === 'eligible')).toEqual([]);
  });

  it('protects failed migrations, unverified deployments and manual holds', () => {
    const [f, d, h, n1, n2] = [rec('f', 300), rec('d', 300), rec('h', 300), rec('n1', 100), rec('n2', 90)];
    const r = evaluate(
      { branches: [prod, f, d, h, n1, n2], endpoints: [] },
      registryFor([[f, { migration: 'failed' }], [d, { deployment: 'pending' }], [h, { hold: 'keep for audit' }], [n1], [n2]]),
      NOW,
    );
    expect(decisionOf(r, 'f').decision).toBe('protected');
    expect(decisionOf(r, 'd').reasons.join(' ')).toMatch(/deployment not verified/);
    expect(decisionOf(r, 'd').decision).toBe('protected');
    expect(decisionOf(r, 'h').decision).toBe('protected');
  });

  it('sends unknown, development, testing and unregistered pre-* branches to manual approval, however old', () => {
    const branches = [prod, rec('n1', 100), rec('n2', 90), { ...rec('u', 900), name: 'mystery' }, { ...rec('d', 900), name: 'dev/regan' }, { ...rec('t', 900), name: 'ci-run-42' }, { ...rec('p', 900), name: 'pre-orphan' }];
    const r = evaluate({ branches, endpoints: [] }, registryFor([[branches[1]!], [branches[2]!]]), NOW);
    for (const id of ['u', 'd', 't', 'p']) expect(decisionOf(r, id).decision).toBe('needs-approval');
    expect(decisionOf(r, 'd').category).toBe('development');
    expect(decisionOf(r, 't').category).toBe('testing');
  });

  it('treats a branch whose registry ID does not match (recreated under the same name) as unknown', () => {
    const real = rec('a', 300);
    const reg = registryFor([[rec('n1', 100)], [rec('n2', 90)]]);
    reg.branches.push({ ...entry(real), branchId: 'br-old-id' });
    const r = evaluate({ branches: [prod, real, rec('n1', 100), rec('n2', 90)], endpoints: [] }, reg, NOW);
    expect(decisionOf(r, 'a')).toMatchObject({ decision: 'needs-approval', category: 'unknown' });
  });

  it('never proposes a branch with a compute endpoint, children, a non-ready state or the Neon protected flag', () => {
    const [ep, parent, child, busy, flagged, n1, n2] = [rec('ep', 300), rec('parent', 300), { ...rec('child', 300), parent_id: 'parent' }, { ...rec('busy', 300), current_state: 'init' }, { ...rec('flagged', 300), protected: true }, rec('n1', 100), rec('n2', 90)];
    const r = evaluate(
      { branches: [prod, ep, parent, child, busy, flagged, n1, n2], endpoints: [{ id: 'ep-1', branch_id: 'ep' }] },
      registryFor([[ep], [parent], [child], [busy], [flagged], [n1], [n2]]),
      NOW,
    );
    expect(decisionOf(r, 'ep').decision).toBe('needs-approval');
    expect(decisionOf(r, 'parent').decision).toBe('protected');
    expect(decisionOf(r, 'busy').decision).toBe('protected');
    expect(decisionOf(r, 'flagged').decision).toBe('protected');
    expect(decisionOf(r, 'child').decision).toBe('eligible');
  });

  it('rejects an inventory with duplicate branch IDs instead of guessing', () => {
    expect(() => evaluate({ branches: [prod, prod], endpoints: [] }, registryFor([]), NOW)).toThrow(/duplicate/);
  });
});

describe('audit run (read-only)', () => {
  it('never calls delete, and logs decisions only when they change across repeated runs', async () => {
    const [old, n1, n2] = [rec('old', 300), rec('n1', 100), rec('n2', 90)];
    const { client, state } = fakeNeon([prod, old, n1, n2]);
    const reg = registryFor([[old], [n1], [n2]]);
    const posted: string[] = [];
    const postComment = async (body: string) => posted.push(body);

    const first = await runAudit({ client, registry: reg, now: NOW, logPath, postComment });
    const afterFirst = readLog(logPath);
    const second = await runAudit({ client, registry: reg, now: new Date(NOW.getTime() + 60_000), logPath, postComment });
    const afterSecond = readLog(logPath);

    expect(state.deleted).toEqual([]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(afterFirst.filter((e) => e.action === 'decision')).toHaveLength(4);
    expect(afterSecond.filter((e) => e.action === 'decision')).toHaveLength(4); // nothing new
    expect(afterSecond.filter((e) => e.action === 'audit')).toHaveLength(2);
    expect(posted).toHaveLength(1); // GitHub comment only when something changed
    expect(first.report).toMatch(/Nothing was deleted/);
    expect(first.report).toMatch(/pre-old/);
  });

  it('records a vanished branch as absent', async () => {
    const [old, n1, n2] = [rec('old', 300), rec('n1', 100), rec('n2', 90)];
    const { client, state } = fakeNeon([prod, old, n1, n2]);
    const reg = registryFor([[old], [n1], [n2]]);
    await runAudit({ client, registry: reg, now: NOW, logPath });
    state.branches = state.branches.filter((b) => b.id !== 'old');
    await runAudit({ client, registry: reg, now: NOW, logPath });
    expect(readLog(logPath).filter((e) => e.branchId === 'old').map((e) => e.decision)).toEqual(['eligible', 'absent']);
  });

  it('fails closed on an API error: no decisions are recorded and the error surfaces', async () => {
    const { client, hooks } = fakeNeon([prod, rec('a', 300)]);
    hooks.failList = () => true;
    await expect(runAudit({ client, registry: registryFor([]), now: NOW, logPath })).rejects.toThrow(/503/);
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: 'audit', outcome: 'failed' });
  });

  it('refuses to audit a different project than the registry names', async () => {
    const { client } = fakeNeon([prod]);
    await expect(runAudit({ client, registry: { ...registryFor([]), projectId: 'other' }, now: NOW, logPath })).rejects.toThrow(/does not match/);
  });
});

describe('guarded deletion', () => {
  const setup = (registryExtra: Partial<Registry> = {}) => {
    const [old, mid, n1, n2] = [rec('old', 24 * 9), rec('mid', 24 * 4), rec('n1', 60), rec('n2', 55)];
    const neon = fakeNeon([prod, old, mid, n1, n2]);
    const reg = registryFor([[old], [mid], [n1], [n2]], registryExtra);
    const snap = new Map(evaluate({ branches: neon.state.branches, endpoints: [] }, reg, NOW).decisions.map((d) => [d.branchId, d.fingerprint]));
    const base = { client: neon.client, registry: reg, now: () => NOW, logPath, lockPath, approval: 'thread message cmsg_test', snapshot: snap };
    return { ...neon, reg, snap, base };
  };

  it('is disabled until the registry enables Phase 2', async () => {
    const { base, state } = setup({ cleanupEnabled: false });
    await expect(runDeletion({ ...base, branchIds: ['old'], execute: true })).rejects.toThrow(/not enabled/);
    expect(state.deleted).toEqual([]);
  });

  it('requires an approval reference and a reviewed snapshot for every branch', async () => {
    const { base } = setup();
    await expect(runDeletion({ ...base, approval: ' ', branchIds: ['old'] })).rejects.toThrow(/approval/);
    await expect(runDeletion({ ...base, snapshot: new Map(), branchIds: ['old'] })).rejects.toThrow(/fingerprint/);
  });

  it('dry run by default: reports what would happen and deletes nothing', async () => {
    const { base, state } = setup();
    const out = await runDeletion({ ...base, branchIds: ['old', 'mid'] });
    expect(out.map((o) => o.outcome)).toEqual(['would-delete', 'would-delete']);
    expect(state.deleted).toEqual([]);
  });

  it('deletes eligible branches with a fresh inventory check before each one', async () => {
    const { base, state } = setup();
    const out = await runDeletion({ ...base, branchIds: ['old', 'mid'], execute: true });
    expect(out.map((o) => o.outcome)).toEqual(['deleted', 'deleted']);
    expect(state.deleted).toEqual(['old', 'mid']);
    expect(state.listCalls).toBe(2);
    expect(readLog(logPath).filter((e) => e.action === 'delete').map((e) => e.outcome)).toEqual(['deleted', 'deleted']);
  });

  it('refuses production and retained recovery points even if named', async () => {
    const { base, state, snap } = setup();
    snap.set('br-prod', fingerprint(prod));
    const out = await runDeletion({ ...base, snapshot: snap, branchIds: ['br-prod', 'n1', 'n2'], execute: true });
    expect(out.map((o) => o.outcome)).toEqual(['refused', 'refused', 'refused']);
    expect(state.deleted).toEqual([]);
  });

  it('refuses a branch that became protected after the audit (new incident registered)', async () => {
    const { base, state, reg } = setup();
    reg.incidents.push({ id: 'INC-9', status: 'open', branchIds: ['old'] });
    const out = await runDeletion({ ...base, branchIds: ['old'], execute: true });
    expect(out[0]).toMatchObject({ outcome: 'refused' });
    expect(out[0]!.reasons!.join(' ')).toMatch(/now protected/);
    expect(state.deleted).toEqual([]);
  });

  it('refuses when the two newest points disappear mid-run, so an old point becomes a required one', async () => {
    const { base, state, hooks } = setup();
    // Someone deletes the two newest recovery points between our deletions.
    hooks.beforeList = (n) => {
      if (n === 2) state.branches = state.branches.filter((b) => b.id !== 'n1' && b.id !== 'n2');
    };
    const out = await runDeletion({ ...base, branchIds: ['old', 'mid'], execute: true });
    expect(out.map((o) => o.outcome)).toEqual(['deleted', 'refused']);
    expect(out[1]!.reasons![0]).toBe('now keep');
    expect(state.deleted).toEqual(['old']);
  });

  it('refuses a branch that changed since the reviewed audit (concurrent change)', async () => {
    const { base, state } = setup();
    state.branches = state.branches.map((b) => (b.id === 'old' ? { ...b, updated_at: NOW.toISOString() } : b));
    const out = await runDeletion({ ...base, branchIds: ['old'], execute: true });
    expect(out[0]!.outcome).toBe('refused');
    expect(out[0]!.reasons![0]).toMatch(/changed since the reviewed audit/);
    expect(state.deleted).toEqual([]);
  });

  it('treats an already-deleted branch as done on a repeated run', async () => {
    const { base, state } = setup();
    await runDeletion({ ...base, branchIds: ['old'], execute: true });
    const again = await runDeletion({ ...base, branchIds: ['old'], execute: true });
    expect(again[0]!.outcome).toBe('already-absent');
    expect(state.deleted).toEqual(['old']);
  });

  it('stops at the first inventory failure and never deletes on stale data', async () => {
    const { base, state, hooks } = setup();
    hooks.failList = (n) => n === 2;
    const out = await runDeletion({ ...base, branchIds: ['old', 'mid'], execute: true });
    expect(out.map((o) => o.outcome)).toEqual(['deleted', 'aborted']);
    expect(state.deleted).toEqual(['old']);
  });

  it('stops after a failed delete call and logs it', async () => {
    const { base, state, hooks } = setup();
    hooks.failDelete = (id) => id === 'old';
    const out = await runDeletion({ ...base, branchIds: ['old', 'mid'], execute: true });
    expect(out.map((o) => o.outcome)).toEqual(['failed']);
    expect(state.deleted).toEqual([]);
    expect(readLog(logPath).at(-1)).toMatchObject({ outcome: 'failed', branchId: 'old' });
  });

  it('refuses to start while another run holds the lock, and releases it afterwards', async () => {
    const { base, state } = setup();
    writeFileSync(lockPath, '123');
    await expect(runDeletion({ ...base, branchIds: ['old'], execute: true })).rejects.toThrow(/another housekeeping run/);
    expect(state.deleted).toEqual([]);
    rmSync(lockPath);
    await runDeletion({ ...base, branchIds: ['old'], execute: true });
    await expect(runDeletion({ ...base, branchIds: ['mid'], execute: true })).resolves.toHaveLength(1);
  });
});
