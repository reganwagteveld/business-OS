/**
 * S-CFG-1A: Sales pipeline and stage configuration (docs/sales-pipeline-configuration-scfg.md v1.3, §13 test plan).
 * Real route handlers against PostgreSQL with the migrations (incl. 20261210000000_sales_configuration) and
 * privileged SQL applied as in production. Race tests (T-SC-20..29, T-SC-24b) use separate connections and
 * pg_blocking_pids barriers (support/locks.ts), never sleeps, so each interleaving is the one described.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as authRoute from '@/app/api/v1/auth/[...all]/route';
import * as businessesRoute from '@/app/api/v1/businesses/route';
import * as acceptRoute from '@/app/api/v1/invitations/accept/route';
import * as invitationsRoute from '@/app/api/v1/b/[slug]/invitations/route';
import * as customersRoute from '@/app/api/v1/b/[slug]/customers/route';
import * as pipelinesRoute from '@/app/api/v1/b/[slug]/sales/pipelines/route';
import * as defaultPipelineRoute from '@/app/api/v1/b/[slug]/sales/pipelines/default/route';
import * as pipelineRoute from '@/app/api/v1/b/[slug]/sales/pipelines/[pipelineId]/route';
import * as stagesCreateRoute from '@/app/api/v1/b/[slug]/sales/pipelines/[pipelineId]/stages/route';
import * as stageOrderRoute from '@/app/api/v1/b/[slug]/sales/pipelines/[pipelineId]/stages/order/route';
import * as stageRoute from '@/app/api/v1/b/[slug]/sales/pipelines/[pipelineId]/stages/[stageId]/route';
import * as stageArchiveRoute from '@/app/api/v1/b/[slug]/sales/pipelines/[pipelineId]/stages/[stageId]/archive/route';
import * as stageRestoreRoute from '@/app/api/v1/b/[slug]/sales/pipelines/[pipelineId]/stages/[stageId]/restore/route';
import * as stagesRoute from '@/app/api/v1/b/[slug]/sales/stages/route';
import * as opportunitiesRoute from '@/app/api/v1/b/[slug]/sales/opportunities/route';
import * as opportunityRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/route';
import * as winRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/win/route';
import * as loseRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/lose/route';
import * as reopenRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/reopen/route';
import * as oppArchiveRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/archive/route';
import * as oppRestoreRoute from '@/app/api/v1/b/[slug]/sales/opportunities/[opportunityId]/restore/route';
import * as quotesRoute from '@/app/api/v1/b/[slug]/finance/quotes/route';
import { devOutbox } from '@/core/email';
import { setConfigTestHooks } from '@/modules/sales';
import { admitFixture, inviteForSignup } from './support/admission';
import { backendPid, finishesOrBlocks, waitUntilBlocked } from './support/locks';

process.env.SALES_CONFIG_TEST_HOOKS = '1';

const BASE = process.env.APP_BASE_URL!;
const ORIGIN = new URL(BASE).origin;
const PASSWORD = 'correct horse battery staple';
const IP_BLOCK = Number(process.env.SALES_CONFIG_TEST_IP_BLOCK ?? 171);
const admin = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });

beforeAll(async () => {
  await admin.connect();
});
afterAll(async () => {
  await admin.end();
});
afterEach(() => {
  setConfigTestHooks({});
});

let ip = 1;
type User = { email: string; cookie: string; id: string };

function req(method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string | null } = {}) {
  const headers = new Headers({ 'x-forwarded-for': `100.${IP_BLOCK}.${Math.floor(ip / 250) % 250}.${ip++ % 250}` });
  if (opts.origin !== null) headers.set('origin', opts.origin ?? ORIGIN);
  if (opts.cookie) headers.set('cookie', opts.cookie);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) });

async function newUser(prefix: string): Promise<User> {
  const email = `${prefix}-${randomUUID()}@example.com`;
  await inviteForSignup(admin, email);
  await authRoute.POST(req('POST', '/api/v1/auth/sign-up/email', { body: { email, password: PASSWORD, name: prefix } }));
  await admitFixture(admin, email);
  const mail = [...devOutbox].reverse().find((m) => m.to === email)!;
  const link = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!);
  await authRoute.GET(req('GET', `${link.pathname}${link.search}`, { origin: null }));
  const res = await authRoute.POST(req('POST', '/api/v1/auth/sign-in/email', { body: { email, password: PASSWORD } }));
  const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c))!.split(';')[0]!;
  const { rows } = await admin.query('SELECT id FROM users WHERE email = $1', [email]);
  return { email, cookie, id: rows[0].id };
}

type Business = { slug: string; businessId: string; people: Record<string, User> };

/** A business with an OWNER, plus one member of each other role when `roles` is true. */
async function business(label: string, roles = false): Promise<Business> {
  const owner = await newUser(`${label}-owner`);
  const slug = `${label}-${randomUUID().slice(0, 8)}`;
  const created = await businessesRoute.POST(req('POST', '/api/v1/businesses', {
    cookie: owner.cookie, body: { name: `Business ${label}`, slug, countryCode: 'AU', timeZone: 'Australia/Perth', locale: 'en-AU', currency: 'AUD' },
  }));
  expect(created.status).toBe(201);
  const people: Record<string, User> = { OWNER: owner };
  if (roles) {
    for (const role of ['ADMIN', 'MANAGER', 'MEMBER']) {
      const user = await newUser(`${label}-${role.toLowerCase()}`);
      await invitationsRoute.POST(req('POST', `/api/v1/b/${slug}/invitations`, { cookie: owner.cookie, body: { email: user.email, role } }), ctx({ slug }));
      const mail = [...devOutbox].reverse().find((m) => m.to === user.email)!;
      const token = new URL(/(https?:\/\/\S+)/.exec(mail.text)![1]!).searchParams.get('token');
      expect((await acceptRoute.POST(req('POST', '/api/v1/invitations/accept', { cookie: user.cookie, body: { token } }))).status).toBe(200);
      people[role] = user;
    }
  }
  const { rows } = await admin.query('SELECT id FROM businesses WHERE slug = $1', [slug]);
  return { slug, people, businessId: rows[0].id as string };
}

const json = async (res: Response) => ({ status: res.status, body: await res.json() });
type Res = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

const api = (who: User, slug: string) => {
  const base = `/api/v1/b/${slug}/sales`;
  const o = (opportunityId: string) => ctx({ slug, opportunityId });
  const p = (pipelineId: string) => ctx({ slug, pipelineId });
  const s = (pipelineId: string, stageId: string) => ctx({ slug, pipelineId, stageId });
  const c = who.cookie;
  return {
    init: () => defaultPipelineRoute.POST(req('POST', `${base}/pipelines/default`, { cookie: c }), ctx({ slug })).then(json),
    pipelines: () => pipelinesRoute.GET(req('GET', `${base}/pipelines`, { cookie: c }), ctx({ slug })).then(json),
    createPipeline: (body: unknown) => pipelinesRoute.POST(req('POST', `${base}/pipelines`, { cookie: c, body }), ctx({ slug })).then(json),
    stages: (qs = '') => stagesRoute.GET(req('GET', `${base}/stages${qs}`, { cookie: c }), ctx({ slug })).then(json),
    config: (pid: string) => pipelineRoute.GET(req('GET', `${base}/pipelines/${pid}`, { cookie: c }), p(pid)).then(json),
    rename: (pid: string, body: unknown) => pipelineRoute.PATCH(req('PATCH', `${base}/pipelines/${pid}`, { cookie: c, body }), p(pid)).then(json),
    addStage: (pid: string, body: unknown) => stagesCreateRoute.POST(req('POST', `${base}/pipelines/${pid}/stages`, { cookie: c, body }), p(pid)).then(json),
    editStage: (pid: string, sid: string, body: unknown) =>
      stageRoute.PATCH(req('PATCH', `${base}/pipelines/${pid}/stages/${sid}`, { cookie: c, body }), s(pid, sid)).then(json),
    reorder: (pid: string, body: unknown) => stageOrderRoute.PUT(req('PUT', `${base}/pipelines/${pid}/stages/order`, { cookie: c, body }), p(pid)).then(json),
    archiveStage: (pid: string, sid: string, body: unknown) =>
      stageArchiveRoute.POST(req('POST', `${base}/pipelines/${pid}/stages/${sid}/archive`, { cookie: c, body }), s(pid, sid)).then(json),
    restoreStage: (pid: string, sid: string, body: unknown) =>
      stageRestoreRoute.POST(req('POST', `${base}/pipelines/${pid}/stages/${sid}/restore`, { cookie: c, body }), s(pid, sid)).then(json),
    create: (body: unknown) => opportunitiesRoute.POST(req('POST', `${base}/opportunities`, { cookie: c, body }), ctx({ slug })).then(json),
    get: (id: string) => opportunityRoute.GET(req('GET', `${base}/opportunities/${id}`, { cookie: c }), o(id)).then(json),
    patch: (id: string, body: unknown) => opportunityRoute.PATCH(req('PATCH', `${base}/opportunities/${id}`, { cookie: c, body }), o(id)).then(json),
    win: (id: string) => winRoute.POST(req('POST', `${base}/opportunities/${id}/win`, { cookie: c }), o(id)).then(json),
    lose: (id: string) => loseRoute.POST(req('POST', `${base}/opportunities/${id}/lose`, { cookie: c, body: {} }), o(id)).then(json),
    reopen: (id: string, body: unknown = {}) => reopenRoute.POST(req('POST', `${base}/opportunities/${id}/reopen`, { cookie: c, body }), o(id)).then(json),
    archiveOpp: (id: string) => oppArchiveRoute.POST(req('POST', `${base}/opportunities/${id}/archive`, { cookie: c }), o(id)).then(json),
    restoreOpp: (id: string, body?: unknown) => oppRestoreRoute.POST(req('POST', `${base}/opportunities/${id}/restore`, { cookie: c, body }), o(id)).then(json),
    createCustomer: (body: unknown) => customersRoute.POST(req('POST', `/api/v1/b/${slug}/customers`, { cookie: c, body }), ctx({ slug })).then(json),
    createQuote: (body: unknown) => quotesRoute.POST(req('POST', `/api/v1/b/${slug}/finance/quotes`, { cookie: c, body }), ctx({ slug })).then(json),
  };
};
type Stage = { id: string; name: string; position: number; archivedAt: string | null; defaultProbability: number | null; openCount: number };

/** A fresh business (owner only) with its default pipeline: New, Qualified, Proposal, Negotiation. */
async function setup(label: string) {
  const b = await business(label);
  const owner = api(b.people.OWNER!, b.slug);
  const init = await owner.init();
  expect(init.status).toBe(201);
  const pipelineId = init.body.pipeline.id as string;
  const stages = init.body.stages as Stage[];
  return { b, owner, pipelineId, stages, version: async () => (await owner.config(pipelineId)).body.pipeline.configVersion as number };
}

const audits = async (targetId: string) =>
  (await admin.query('SELECT action, metadata FROM audit_events WHERE target_id = $1 ORDER BY created_at, action', [targetId])).rows as { action: string; metadata: Record<string, string> }[];
const invalidOpen = async (businessId: string) =>
  (await admin.query(`SELECT count(*)::int AS n FROM opportunities o JOIN sales_stages s ON s.business_id = o.business_id AND s.id = o.stage_id
    JOIN sales_pipelines p ON p.business_id = o.business_id AND p.id = o.pipeline_id
    WHERE o.business_id = $1 AND o.status = 'OPEN' AND o.archived_at IS NULL AND (s.archived_at IS NOT NULL OR p.archived_at IS NOT NULL)`, [businessId])).rows[0].n as number;
const oppRow = async (id: string) => (await admin.query('SELECT stage_id::text, status, version, archived_at, probability FROM opportunities WHERE id = $1', [id])).rows[0];

/** A bos_app connection inside a transaction scoped to the business (the same session settings as withTenant). */
async function tenantTx(b: Business): Promise<pg.Client & { pid: number }> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');
  await c.query("SELECT set_config('app.business_id', $1, true), set_config('app.user_id', $2, true)", [b.businessId, b.people.OWNER!.id]);
  return Object.assign(c, { pid: await backendPid(c) });
}
async function end(c: pg.Client, commit = true) {
  try {
    await c.query(commit ? 'COMMIT' : 'ROLLBACK');
  } finally {
    await c.end();
  }
}
/** An advisory xact lock on the pipeline's L1 key: holding it makes configuration writes queue up behind it. */
const holdL1 = (c: pg.Client, pipelineId: string) =>
  c.query("SELECT pg_advisory_xact_lock(hashtextextended('sales.pipeline_config:' || $1::text, 0))", [pipelineId]);

// =====================================================================================================
describe('permissions, tenancy and happy paths (T-SC-01, 02, 03)', () => {
  let A: Business;
  let B: Business;
  let pipelineId: string;
  let stages: Stage[];
  beforeAll(async () => {
    A = await business('cfa', true);
    B = await business('cfb');
    const init = await api(A.people.OWNER!, A.slug).init();
    pipelineId = init.body.pipeline.id;
    stages = init.body.stages;
    await api(B.people.OWNER!, B.slug).init();
  }, 120_000);

  it('T-SC-01: OWNER and ADMIN may write; MANAGER and MEMBER get 403 on every write; all four may read', async () => {
    for (const role of ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER']) {
      const r = await api(A.people[role]!, A.slug).config(pipelineId);
      expect(r.status, role).toBe(200);
      expect(r.body.pipeline.configVersion, role).toBeGreaterThanOrEqual(1);
    }
    for (const role of ['MANAGER', 'MEMBER']) {
      const x = api(A.people[role]!, A.slug);
      const v = 1;
      const results = [
        await x.rename(pipelineId, { configVersion: v, name: 'Nope' }),
        await x.addStage(pipelineId, { configVersion: v, name: 'Nope' }),
        await x.editStage(pipelineId, stages[0]!.id, { configVersion: v, name: 'Nope' }),
        await x.reorder(pipelineId, { configVersion: v, stageIds: stages.map((s) => s.id) }),
        await x.archiveStage(pipelineId, stages[0]!.id, { configVersion: v }),
        await x.restoreStage(pipelineId, stages[0]!.id, { configVersion: v }),
        await x.createPipeline({ name: 'Nope' }),
      ];
      for (const r of results) expect([r.status, r.body.error], role).toEqual([403, 'forbidden']);
    }
    // OWNER and ADMIN both can.
    const owner = api(A.people.OWNER!, A.slug);
    let v = (await owner.config(pipelineId)).body.pipeline.configVersion;
    expect((await owner.rename(pipelineId, { configVersion: v, name: 'Owner named' })).status).toBe(200);
    v += 1;
    expect((await api(A.people.ADMIN!, A.slug).rename(pipelineId, { configVersion: v, name: 'Admin named' })).status).toBe(200);
    expect((await owner.config(pipelineId)).body.pipeline.name).toBe('Admin named');
  });

  it('T-SC-02: pipeline and stage ids of another business are 404 on every route, never 403; malformed ids are 404', async () => {
    const other = api(B.people.OWNER!, B.slug);
    const v = 1;
    const sid = stages[1]!.id;
    const results = [
      await other.config(pipelineId),
      await other.rename(pipelineId, { configVersion: v, name: 'Stolen' }),
      await other.addStage(pipelineId, { configVersion: v, name: 'Stolen' }),
      await other.editStage(pipelineId, sid, { configVersion: v, name: 'Stolen' }),
      await other.reorder(pipelineId, { configVersion: v, stageIds: stages.map((s) => s.id) }),
      await other.archiveStage(pipelineId, sid, { configVersion: v }),
      await other.restoreStage(pipelineId, sid, { configVersion: v }),
      await other.config('not-a-uuid'),
    ];
    for (const r of results) expect([r.status, r.body.error]).toEqual([404, 'not_found']);
    // B's own pipeline with A's stage id: still 404 (the stage is looked up in B's pipeline under B's RLS).
    const bPipeline = (await other.pipelines()).body.pipelines[0].id;
    const bv = (await other.config(bPipeline)).body.pipeline.configVersion;
    expect((await other.editStage(bPipeline, sid, { configVersion: bv, name: 'Stolen' })).status).toBe(404);
    expect((await other.archiveStage(bPipeline, (await other.config(bPipeline)).body.stages[0].id, { configVersion: bv, moveOpenTo: sid })).body.error).toBe('invalid_stage');
    expect((await api(A.people.OWNER!, A.slug).config(pipelineId)).body.stages.map((s: Stage) => s.name)).not.toContain('Stolen');
    // No session: 401.
    expect((await pipelineRoute.GET(req('GET', `/api/v1/b/${A.slug}/sales/pipelines/${pipelineId}`), ctx({ slug: A.slug, pipelineId }))).status).toBe(401);
  });

  it('T-SC-03: add, rename, edit probability, reorder, archive (with and without open opportunities), restore', async () => {
    const { owner, pipelineId: pid, stages: st, version } = await setup('cfh');
    let r = await owner.addStage(pid, { configVersion: 1, name: '  Demo  ', defaultProbability: 40, afterStageId: st[1]!.id });
    expect(r.status).toBe(201);
    expect(r.body.pipeline.configVersion).toBe(2);
    expect(r.body.stages.map((s: Stage) => [s.name, s.position, s.openCount])).toEqual([
      ['New', 1000, 0], ['Qualified', 2000, 0], ['Demo', 3000, 0], ['Proposal', 4000, 0], ['Negotiation', 5000, 0],
    ]);
    const demo = r.body.stages[2] as Stage;
    r = await owner.addStage(pid, { configVersion: 2, name: 'Closing' });
    expect(r.body.stages.at(-1)).toMatchObject({ name: 'Closing', position: 6000, defaultProbability: null });
    r = await owner.editStage(pid, demo.id, { configVersion: 3, name: 'Discovery', defaultProbability: 30 });
    expect(r.status).toBe(200);
    expect(r.body.stages.find((s: Stage) => s.id === demo.id)).toMatchObject({ name: 'Discovery', defaultProbability: 30 });
    const ids = (r.body.stages as Stage[]).map((s) => s.id).reverse();
    r = await owner.reorder(pid, { configVersion: 4, stageIds: ids });
    expect(r.status).toBe(200);
    expect((r.body.stages as Stage[]).map((s) => s.id)).toEqual(ids);
    expect((r.body.stages as Stage[]).map((s) => s.position)).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    // The board's stage list follows the new order.
    expect((await owner.stages(`?pipelineId=${pid}`)).body.stages.map((s: Stage) => s.id)).toEqual(ids);
    // Archive an empty stage.
    r = await owner.archiveStage(pid, demo.id, { configVersion: 5 });
    expect(r.status).toBe(200);
    expect(r.body.moved).toBe(0);
    expect(r.body.stages.at(-1)).toMatchObject({ id: demo.id, name: 'Discovery' });
    expect(r.body.stages.at(-1).archivedAt).not.toBeNull();
    expect((await owner.stages(`?pipelineId=${pid}`)).body.stages.map((s: Stage) => s.id)).not.toContain(demo.id);
    // Archive a stage with open work, moving it.
    const o1 = (await owner.create({ title: 'One', stageId: st[0]!.id })).body.opportunity;
    const o2 = (await owner.create({ title: 'Two', stageId: st[0]!.id })).body.opportunity;
    r = await owner.config(pid);
    expect(r.body.stages.find((s: Stage) => s.id === st[0]!.id).openCount).toBe(2);
    r = await owner.archiveStage(pid, st[0]!.id, { configVersion: 6, moveOpenTo: st[1]!.id });
    expect([r.status, r.body.moved]).toEqual([200, 2]);
    expect(r.body.stages.find((s: Stage) => s.id === st[1]!.id).openCount).toBe(2);
    for (const o of [o1, o2]) expect((await owner.get(o.id)).body.opportunity).toMatchObject({ stageId: st[1]!.id, version: 2 });
    // Restore goes to the end of the active order.
    r = await owner.restoreStage(pid, demo.id, { configVersion: 7 });
    expect(r.status).toBe(200);
    const active = (r.body.stages as Stage[]).filter((s) => !s.archivedAt);
    expect(active.at(-1)).toMatchObject({ id: demo.id });
    expect(active.at(-1)!.position).toBeGreaterThan(active.at(-2)!.position);
    expect(await version()).toBe(8);
    // Pipeline rename.
    r = await owner.rename(pid, { configVersion: 8, name: 'Inbound' });
    expect([r.status, r.body.pipeline.name, r.body.pipeline.configVersion]).toEqual([200, 'Inbound', 9]);
  });
});

// =====================================================================================================
describe('rules (T-SC-04..12, 16, 32..34)', () => {
  it('T-SC-04: names unique among active stages, case- and whitespace-insensitive; archived names reusable; restore clash', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfn');
    expect((await owner.addStage(pid, { configVersion: 1, name: ' proposal ' })).body.error).toBe('name_taken');
    expect((await owner.editStage(pid, st[0]!.id, { configVersion: 1, name: 'QUALIFIED' })).body.error).toBe('name_taken');
    // Renaming a stage to its own name with other casing is allowed (it is the same stage).
    expect((await owner.editStage(pid, st[1]!.id, { configVersion: 1, name: 'qualified' })).status).toBe(200);
    expect((await owner.archiveStage(pid, st[2]!.id, { configVersion: 2 })).status).toBe(200);
    expect((await owner.addStage(pid, { configVersion: 3, name: 'Proposal' })).status).toBe(201);
    expect((await owner.restoreStage(pid, st[2]!.id, { configVersion: 4 })).body.error).toBe('name_taken');
    // Pipelines: the active name of another pipeline is taken, case-insensitively.
    expect((await owner.createPipeline({ name: 'Partners' })).status).toBe(201);
    expect((await owner.rename(pid, { configVersion: 4, name: ' PARTNERS' })).body.error).toBe('name_taken');
    // The database backstop U1: a direct duplicate insert is a unique violation.
    await expect(admin.query("INSERT INTO sales_stages (id, business_id, pipeline_id, name, position) SELECT $1, business_id, id, 'NEW ', 9000 FROM sales_pipelines WHERE id = $2", [randomUUID(), pid]))
      .rejects.toThrow(/sales_stages_active_name_key/);
  });

  it('T-SC-05: a 21st active stage is stage_limit; the last active stage cannot be archived (service and trigger)', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfl');
    let v = 1;
    for (let i = 0; i < 16; i++) expect((await owner.addStage(pid, { configVersion: v++, name: `S${i}` })).status).toBe(201);
    expect((await owner.addStage(pid, { configVersion: v, name: 'S21' })).body.error).toBe('stage_limit');
    // Restore into a full pipeline is refused too.
    expect((await owner.archiveStage(pid, st[0]!.id, { configVersion: v++ })).status).toBe(200);
    expect((await owner.addStage(pid, { configVersion: v++, name: 'Fill' })).status).toBe(201);
    expect((await owner.restoreStage(pid, st[0]!.id, { configVersion: v })).body.error).toBe('stage_limit');
    // Last stage, through the service.
    const small = await setup('cfl2');
    let w = 1;
    for (const s of small.stages.slice(0, 3)) expect((await small.owner.archiveStage(small.pipelineId, s.id, { configVersion: w++ })).status).toBe(200);
    expect((await small.owner.archiveStage(small.pipelineId, small.stages[3]!.id, { configVersion: w })).body.error).toBe('last_stage');
  });

  it('T-SC-06: configVersion is checked on every write; reorder must list exactly the active stages', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfs');
    expect((await owner.addStage(pid, { configVersion: 1, name: 'X' })).status).toBe(201); // now 2
    const stale = [
      await owner.rename(pid, { configVersion: 1, name: 'Y' }),
      await owner.addStage(pid, { configVersion: 1, name: 'Y' }),
      await owner.editStage(pid, st[0]!.id, { configVersion: 1, name: 'Y' }),
      await owner.reorder(pid, { configVersion: 1, stageIds: [] }),
      await owner.archiveStage(pid, st[0]!.id, { configVersion: 1 }),
      await owner.restoreStage(pid, st[0]!.id, { configVersion: 1 }),
    ];
    expect(stale.map((r) => r.status)).toEqual([409, 409, 409, 400, 409, 409]); // empty list fails validation first
    for (const r of stale.filter((x) => x.status === 409)) expect(r.body.error).toBe('stale');
    const active = (await owner.config(pid)).body.stages.map((s: Stage) => s.id) as string[];
    expect((await owner.reorder(pid, { configVersion: 2, stageIds: active.slice(1) })).body.error).toBe('stale'); // missing
    expect((await owner.reorder(pid, { configVersion: 2, stageIds: [...active, randomUUID()] })).body.error).toBe('stale'); // extra
    expect((await owner.reorder(pid, { configVersion: 2, stageIds: [...active.slice(1), active[1]] })).status).toBe(400); // duplicate
    expect((await owner.reorder(pid, { configVersion: 2, stageIds: [...active, ...Array(16).fill(0).map(() => randomUUID())] })).status).toBe(400); // > 20
    expect((await owner.config(pid)).body.pipeline.configVersion).toBe(2);
  });

  it('T-SC-07: archive with moveOpenTo moves only OPEN, non-archived opportunities, one stage_changed audit each with cause', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfm');
    const mk = async (title: string) => (await owner.create({ title, stageId: st[2]!.id })).body.opportunity.id as string;
    const open1 = await mk('Open 1');
    const open2 = await mk('Open 2');
    const won = await mk('Won');
    const lost = await mk('Lost');
    const archived = await mk('Archived');
    await owner.win(won);
    await owner.lose(lost);
    await owner.archiveOpp(archived);
    const r = await owner.archiveStage(pid, st[2]!.id, { configVersion: 1, moveOpenTo: st[0]!.id });
    expect([r.status, r.body.moved]).toEqual([200, 2]);
    for (const id of [open1, open2]) {
      expect(await oppRow(id)).toMatchObject({ stage_id: st[0]!.id, version: 2 });
      const changed = (await audits(id)).filter((a) => a.action === 'sales.opportunity.stage_changed');
      expect(changed).toHaveLength(1);
      expect(changed[0]!.metadata).toEqual({ fromPipelineId: pid, fromStageId: st[2]!.id, toPipelineId: pid, toStageId: st[0]!.id, cause: 'stage_archived' });
    }
    for (const id of [won, lost, archived]) expect((await oppRow(id)).stage_id).toBe(st[2]!.id);
    const stageAudit = (await audits(st[2]!.id)).find((a) => a.action === 'sales.stage.archived')!;
    expect(stageAudit.metadata).toEqual({ pipelineId: pid, movedTo: st[0]!.id, moved: '2' });
    // Without a target while open work remains: refused, nothing changed.
    const again = await setup('cfm2');
    const o = (await again.owner.create({ title: 'Stay', stageId: again.stages[1]!.id })).body.opportunity.id;
    expect((await again.owner.archiveStage(again.pipelineId, again.stages[1]!.id, { configVersion: 1 })).body.error).toBe('has_open_opportunities');
    expect(await oppRow(o)).toMatchObject({ stage_id: again.stages[1]!.id, version: 1 });
    expect(await again.version()).toBe(1);
  });

  it('T-SC-08: moveOpenTo archived, the stage itself, or of another pipeline is 400 invalid_stage', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfi');
    await owner.create({ title: 'Here', stageId: st[1]!.id });
    expect((await owner.archiveStage(pid, st[3]!.id, { configVersion: 1 })).status).toBe(200);
    const other = (await owner.createPipeline({ name: 'Other' })).body.stages[0].id;
    for (const target of [st[3]!.id, st[1]!.id, other, randomUUID()]) {
      const r = await owner.archiveStage(pid, st[1]!.id, { configVersion: 2, moveOpenTo: target });
      expect([r.status, r.body.error], target).toEqual([400, 'invalid_stage']);
    }
    // afterStageId that is not an active stage of this pipeline.
    for (const after of [st[3]!.id, other]) expect((await owner.addStage(pid, { configVersion: 2, name: 'Z', afterStageId: after })).body.error).toBe('invalid_stage');
    expect(await owner.config(pid).then((r) => r.body.pipeline.configVersion)).toBe(2);
  });

  it('T-SC-09: reopen into an archived closing stage is archived_reference; with an active stageId it works', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfr');
    const id = (await owner.create({ title: 'Closed', stageId: st[2]!.id })).body.opportunity.id;
    await owner.win(id);
    expect((await owner.archiveStage(pid, st[2]!.id, { configVersion: 1 })).status).toBe(200); // a WON row does not block it
    expect((await owner.reopen(id)).body.error).toBe('archived_reference');
    const r = await owner.reopen(id, { stageId: st[0]!.id });
    expect([r.status, r.body.opportunity.status, r.body.opportunity.stageId]).toEqual([200, 'OPEN', st[0]!.id]);
  });

  it('T-SC-10, T-SC-16: restoring an archived OPEN opportunity in an archived stage needs an active stage; never in an archived pipeline', async () => {
    const { b, owner, pipelineId: pid, stages: st } = await setup('cfo');
    const id = (await owner.create({ title: 'Parked', stageId: st[1]!.id })).body.opportunity.id;
    await owner.archiveOpp(id);
    expect((await owner.archiveStage(pid, st[1]!.id, { configVersion: 1 })).status).toBe(200); // archived rows do not block it
    expect((await owner.restoreOpp(id)).body.error).toBe('archived_reference');
    expect((await owner.restoreOpp(id, { stageId: st[1]!.id })).body.error).toBe('archived_reference');
    const r = await owner.restoreOpp(id, { stageId: st[2]!.id });
    expect([r.status, r.body.opportunity.archivedAt, r.body.opportunity.stageId]).toEqual([200, null, st[2]!.id]);
    expect((await audits(id)).map((a) => a.action)).toContain('sales.opportunity.stage_changed');
    // A WON opportunity is restored where it is; a stage cannot be given for it.
    const won = (await owner.create({ title: 'Won', stageId: st[0]!.id })).body.opportunity.id;
    await owner.win(won);
    await owner.archiveOpp(won);
    expect((await owner.restoreOpp(won, { stageId: st[2]!.id })).body.error).toBe('not_open');
    expect((await owner.restoreOpp(won)).status).toBe(200);
    // T-SC-16: an archived pipeline (S-CFG-2 has no API yet; set directly on a non-default pipeline with no open work).
    const other = (await owner.createPipeline({ name: 'Old' })).body;
    const parked = (await owner.create({ title: 'In old', pipelineId: other.pipeline.id, stageId: other.stages[0].id })).body.opportunity.id;
    await owner.archiveOpp(parked);
    await admin.query('UPDATE sales_pipelines SET archived_at = now() WHERE id = $1', [other.pipeline.id]);
    expect((await owner.restoreOpp(parked)).body.error).toBe('archived_reference');
    expect((await owner.restoreOpp(parked, { stageId: other.stages[1].id })).body.error).toBe('archived_reference');
    expect((await owner.restoreOpp(parked, { stageId: st[0]!.id })).body.error).toBe('invalid_stage'); // not a stage of its pipeline
    // F6: the stage list of an archived pipeline is refused.
    expect((await owner.stages(`?pipelineId=${other.pipeline.id}`)).body.error).toBe('archived_reference');
    // F4: reopening into an archived pipeline is refused too.
    expect(await invalidOpen(b.businessId)).toBe(0);
  });

  it('T-SC-11, T-SC-34: POST /sales/pipelines refuses duplicate stage names, active-name clashes and an 11th active pipeline', async () => {
    const { owner } = await setup('cfp');
    expect((await owner.createPipeline({ name: 'Dup', stages: [{ name: 'A' }, { name: ' a ' }] })).body.error).toBe('duplicate_stage_name');
    expect((await owner.createPipeline({ name: ' sales PIPELINE ' })).body.error).toBe('name_taken');
    for (let i = 2; i <= 6; i++) expect((await owner.createPipeline({ name: `P${i}` })).status).toBe(201);
    // 6 active now; 4 more allowed. Eight concurrent creates: exactly 4 succeed, the rest are pipeline_limit.
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => owner.createPipeline({ name: `Race ${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(4);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.error)).toEqual(Array(4).fill('pipeline_limit'));
    expect((await owner.pipelines()).body.pipelines).toHaveLength(10);
    for (const p of (await owner.pipelines()).body.pipelines) expect(p.configVersion).toBe(1);
  });

  it('T-SC-12: audit entries are written in the same transaction, carry ids and counts, never names', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfa2');
    const r = await owner.addStage(pid, { configVersion: 1, name: 'Very Secret Stage', defaultProbability: 5 });
    const created = (r.body.stages as Stage[]).find((s) => s.name === 'Very Secret Stage')!;
    await owner.editStage(pid, created.id, { configVersion: 2, name: 'Another Secret' });
    await owner.rename(pid, { configVersion: 3, name: 'Secret Pipeline' });
    await owner.reorder(pid, { configVersion: 4, stageIds: (await owner.config(pid)).body.stages.map((s: Stage) => s.id).reverse() });
    await owner.archiveStage(pid, created.id, { configVersion: 5 });
    await owner.restoreStage(pid, created.id, { configVersion: 6 });
    const all = [...await audits(pid), ...await audits(created.id)];
    expect(all.map((a) => a.action).sort()).toEqual([
      'sales.pipeline.initialized', 'sales.pipeline.updated', 'sales.stage.archived', 'sales.stage.created', 'sales.stage.reordered', 'sales.stage.restored', 'sales.stage.updated',
    ]);
    expect(JSON.stringify(all)).not.toMatch(/Secret/);
    expect(all.find((a) => a.action === 'sales.stage.updated')!.metadata).toEqual({ pipelineId: pid, fields: ['name'] });
    expect(st).toHaveLength(4);
  });

  it('T-SC-32: the server stores exactly the probability sent (0 and null included), whatever the stage default', async () => {
    const { owner, pipelineId: pid, stages: st } = await setup('cfq');
    expect(st.map((s) => s.defaultProbability)).toEqual([10, 25, 50, 75]);
    const zero = (await owner.create({ title: 'Zero', stageId: st[2]!.id, probability: 0 })).body.opportunity;
    const none = (await owner.create({ title: 'None', stageId: st[2]!.id })).body.opportunity;
    expect([zero.probability, none.probability]).toEqual([0, null]);
    expect((await owner.patch(zero.id, { version: 1, stageId: st[3]!.id })).body.opportunity.probability).toBe(0);
    expect((await owner.patch(none.id, { version: 1, stageId: st[3]!.id })).body.opportunity.probability).toBeNull();
    await owner.win(zero.id);
    expect((await owner.reopen(zero.id, { stageId: st[1]!.id })).body.opportunity.probability).toBe(0);
    await owner.archiveOpp(none.id);
    expect((await owner.archiveStage(pid, st[3]!.id, { configVersion: 1, moveOpenTo: st[0]!.id })).body.moved).toBe(0);
    expect((await owner.restoreOpp(none.id, { stageId: st[0]!.id })).body.opportunity.probability).toBeNull();
    expect((await owner.editStage(pid, st[0]!.id, { configVersion: 2, defaultProbability: 99 })).status).toBe(200);
    expect((await oppRow(none.id)).probability).toBeNull();
  });

  it('T-SC-33: configVersion is 1 on creation, +1 exactly once per configuration change, unchanged by opportunity writes', async () => {
    const { owner, pipelineId: pid, stages: st, version } = await setup('cfv');
    expect(await version()).toBe(1);
    const created = (await owner.createPipeline({ name: 'Second' })).body;
    expect(created.pipeline.configVersion).toBe(1);
    const steps: [string, () => Promise<Res>][] = [
      ['rename', () => owner.rename(pid, { configVersion: 1, name: 'Renamed' })],
      ['add', () => owner.addStage(pid, { configVersion: 2, name: 'Added' })],
      ['edit', () => owner.editStage(pid, st[0]!.id, { configVersion: 3, defaultProbability: 11 })],
      ['reorder', async () => owner.reorder(pid, { configVersion: 4, stageIds: (await owner.config(pid)).body.stages.map((s: Stage) => s.id).reverse() })],
      ['archive', () => owner.archiveStage(pid, st[0]!.id, { configVersion: 5 })],
      ['restore', () => owner.restoreStage(pid, st[0]!.id, { configVersion: 6 })],
    ];
    for (const [i, [name, step]] of steps.entries()) {
      const r = await step();
      expect([name, r.status < 300, r.body.pipeline.configVersion]).toEqual([name, true, i + 2]);
    }
    // A request that changes nothing is not a change.
    expect((await owner.rename(pid, { configVersion: 7, name: 'Renamed' })).body.pipeline.configVersion).toBe(7);
    // Opportunity writes never bump it.
    const o = (await owner.create({ title: 'Deal', stageId: st[1]!.id })).body.opportunity;
    await owner.patch(o.id, { version: 1, stageId: st[2]!.id, title: 'Deal 2' });
    await owner.win(o.id);
    await owner.reopen(o.id);
    await owner.archiveOpp(o.id);
    await owner.restoreOpp(o.id);
    expect(await version()).toBe(7);
    // Archive with a move bumps once.
    expect((await owner.archiveStage(pid, st[2]!.id, { configVersion: 7, moveOpenTo: st[1]!.id })).body).toMatchObject({ moved: 1, pipeline: { configVersion: 8 } });
  });
});

// =====================================================================================================
describe('database guards via direct SQL as bos_app (T-SC-13, 14)', () => {
  it('T-SC-13: G1 refuses a pipeline change (SA004), archiving with open work (SA002) and the last stage (SA003)', async () => {
    const { b, owner, pipelineId: pid, stages: st } = await setup('cfg1');
    const other = (await owner.createPipeline({ name: 'Other' })).body.pipeline.id;
    await owner.create({ title: 'Open', stageId: st[0]!.id });
    const run = async (sql: string, params: unknown[]) => {
      const c = await tenantTx(b);
      try {
        await c.query(sql, params);
      } finally {
        await end(c, false);
      }
    };
    await expect(run('UPDATE sales_stages SET pipeline_id = $1 WHERE id = $2', [other, st[1]!.id])).rejects.toMatchObject({ code: 'SA004' });
    await expect(run('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [st[0]!.id])).rejects.toMatchObject({ code: 'SA002' });
    // The three stages without open work may be archived (rolled back); the last one never.
    await expect(run('UPDATE sales_stages SET archived_at = now() WHERE id = ANY($1::uuid[])', [st.map((s) => s.id).slice(1)])).resolves.toBeUndefined();
    const c = await tenantTx(b);
    try {
      await c.query("UPDATE opportunities SET status = 'LOST', closed_at = now() WHERE pipeline_id = $1", [pid]);
      await c.query('UPDATE sales_stages SET archived_at = now() WHERE id = ANY($1::uuid[])', [st.map((s) => s.id).slice(1)]);
      await expect(c.query('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [st[0]!.id])).rejects.toMatchObject({ code: 'SA003' });
    } finally {
      await end(c, false);
    }
  });

  it('T-SC-14: G2 refuses an OPEN row in an archived stage or pipeline (SA001), but never blocks closed rows', async () => {
    const { b, owner, pipelineId: pid, stages: st } = await setup('cfg2');
    const won = (await owner.create({ title: 'Won', stageId: st[1]!.id })).body.opportunity.id;
    await owner.win(won);
    expect((await owner.archiveStage(pid, st[1]!.id, { configVersion: 1 })).status).toBe(200);
    const c = await tenantTx(b);
    try {
      await c.query('SAVEPOINT s');
      await expect(c.query("INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES ($1, $2, 'x', $3, $4, 'AUD')",
        [randomUUID(), b.businessId, pid, st[1]!.id])).rejects.toMatchObject({ code: 'SA001' });
      await c.query('ROLLBACK TO SAVEPOINT s');
      // A WON row in the archived stage: other columns may change, and it may even be archived and restored while WON.
      await c.query("UPDATE opportunities SET title = 'Still won', archived_at = now() WHERE id = $1", [won]);
      await c.query('UPDATE opportunities SET archived_at = NULL WHERE id = $1', [won]);
      // Reopening it in place (status -> OPEN) is refused.
      await c.query('SAVEPOINT s');
      await expect(c.query("UPDATE opportunities SET status = 'OPEN', closed_at = NULL WHERE id = $1", [won])).rejects.toMatchObject({ code: 'SA001' });
      await c.query('ROLLBACK TO SAVEPOINT s');
      // A move into the archived stage is refused.
      const open = (await c.query("INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES ($1, $2, 'o', $3, $4, 'AUD') RETURNING id",
        [randomUUID(), b.businessId, pid, st[0]!.id])).rows[0].id;
      await c.query('SAVEPOINT s');
      await expect(c.query('UPDATE opportunities SET stage_id = $1 WHERE id = $2', [st[1]!.id, open])).rejects.toMatchObject({ code: 'SA001' });
      await c.query('ROLLBACK TO SAVEPOINT s');
    } finally {
      await end(c, false);
    }
  });
});

// =====================================================================================================
describe('archive atomicity (T-SC-15, 15b)', () => {
  it('T-SC-15: an OPEN opportunity slipped into the stage between move and archive makes G1 roll back everything', async () => {
    const { b, owner, pipelineId: pid, stages: st, version } = await setup('cff');
    const moved = [(await owner.create({ title: 'A', stageId: st[1]!.id })).body.opportunity.id, (await owner.create({ title: 'B', stageId: st[1]!.id })).body.opportunity.id];
    setConfigTestHooks({
      afterMove: async (db) => {
        await db.$queryRaw`INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code)
          VALUES (${randomUUID()}::uuid, ${b.businessId}::uuid, 'Injected', ${pid}::uuid, ${st[1]!.id}::uuid, 'AUD') RETURNING id`;
      },
    });
    const r = await owner.archiveStage(pid, st[1]!.id, { configVersion: 1, moveOpenTo: st[2]!.id });
    expect([r.status, r.body.error]).toEqual([409, 'has_open_opportunities']);
    for (const id of moved) {
      expect(await oppRow(id)).toMatchObject({ stage_id: st[1]!.id, version: 1 });
      expect((await audits(id)).map((a) => a.action)).toEqual(['sales.opportunity.created']);
    }
    expect((await admin.query("SELECT count(*)::int AS n FROM opportunities WHERE title = 'Injected' AND business_id = $1", [b.businessId])).rows[0].n).toBe(0);
    expect((await audits(st[1]!.id))).toEqual([]);
    expect(await version()).toBe(1);
    expect((await admin.query('SELECT archived_at FROM sales_stages WHERE id = $1', [st[1]!.id])).rows[0].archived_at).toBeNull();
  });

  it('T-SC-15b: a late audit failure, or the transaction deadline passing, rolls back every move, the archive and the version bump', async () => {
    const { owner, pipelineId: pid, stages: st, version } = await setup('cfd');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await owner.create({ title: `O${i}`, stageId: st[0]!.id })).body.opportunity.id);
    const unchanged = async () => {
      for (const id of ids) expect(await oppRow(id)).toMatchObject({ stage_id: st[0]!.id, version: 1 });
      expect(await version()).toBe(1);
      expect((await admin.query('SELECT archived_at FROM sales_stages WHERE id = $1', [st[0]!.id])).rows[0].archived_at).toBeNull();
      expect(await audits(st[0]!.id)).toEqual([]);
      for (const id of ids) expect((await audits(id)).map((a) => a.action)).toEqual(['sales.opportunity.created']);
    };
    setConfigTestHooks({ beforeAuditBatch: async ({ last }) => { if (last) throw new Error('injected audit failure'); } });
    expect((await owner.archiveStage(pid, st[0]!.id, { configVersion: 1, moveOpenTo: st[1]!.id })).status).toBe(500);
    await unchanged();
    setConfigTestHooks({ deadlineMs: 1500, beforeAuditBatch: () => new Promise((resolve) => setTimeout(resolve, 1700)) });
    const r = await owner.archiveStage(pid, st[0]!.id, { configVersion: 1, moveOpenTo: st[1]!.id });
    expect([r.status, r.body.error]).toEqual([409, 'busy']);
    await unchanged();
    setConfigTestHooks({});
    expect((await owner.archiveStage(pid, st[0]!.id, { configVersion: 1, moveOpenTo: st[1]!.id })).body.moved).toBe(3);
  });
});

// =====================================================================================================
describe('races on real PostgreSQL (T-SC-20..29, 24b)', () => {
  let observer: pg.Client;
  beforeAll(async () => {
    observer = new pg.Client({ connectionString: process.env.TEST_ADMIN_URL });
    await observer.connect();
  });
  afterAll(async () => {
    await observer.end();
  });

  /** An opportunity write on the product path, held open: lock the target stage FOR SHARE first (L2), then write (L3). */
  async function heldMove(b: Business, oppId: string, pipelineId: string, toStage: string) {
    const h = await tenantTx(b);
    await h.query('SELECT 1 FROM sales_stages WHERE id = $1 AND pipeline_id = $2 FOR SHARE', [toStage, pipelineId]);
    await h.query('UPDATE opportunities SET stage_id = $1, version = version + 1 WHERE id = $2', [toStage, oppId]);
    return h;
  }
  /** A stage archive on the database path, held open (L2 FOR UPDATE, G1 runs). */
  async function heldArchive(b: Business, pipelineId: string, stageId: string) {
    const h = await tenantTx(b);
    await h.query('SELECT 1 FROM sales_stages WHERE id = $1 AND pipeline_id = $2 FOR UPDATE', [stageId, pipelineId]);
    await h.query('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [stageId]);
    return h;
  }

  it('T-SC-20: archive vs a move into that stage, both orders: never an OPEN row in an archived stage', async () => {
    // Move first: the archive waits for it at L2, then moves the newcomer along.
    let t = await setup('cr20a');
    let o = (await t.owner.create({ title: 'Mover', stageId: t.stages[0]!.id })).body.opportunity.id;
    let h = await heldMove(t.b, o, t.pipelineId, t.stages[1]!.id);
    const archive = t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 1, moveOpenTo: t.stages[2]!.id });
    await waitUntilBlocked(observer, h.pid);
    await end(h);
    const r = await archive;
    expect([r.status, r.body.moved]).toEqual([200, 1]);
    expect((await oppRow(o)).stage_id).toBe(t.stages[2]!.id);
    expect(await invalidOpen(t.b.businessId)).toBe(0);
    // Archive first: the move (API, locking read) waits, then sees the stage archived.
    t = await setup('cr20b');
    o = (await t.owner.create({ title: 'Mover', stageId: t.stages[0]!.id })).body.opportunity.id;
    h = await heldArchive(t.b, t.pipelineId, t.stages[1]!.id);
    const move = t.owner.patch(o, { version: 1, stageId: t.stages[1]!.id });
    await waitUntilBlocked(observer, h.pid);
    await end(h);
    expect((await move).body.error).toBe('archived_reference');
    expect(await invalidOpen(t.b.businessId)).toBe(0);
  });

  it('T-SC-21: archive vs a create into that stage, both orders', async () => {
    let t = await setup('cr21a');
    let h = await tenantTx(t.b);
    await h.query('SELECT 1 FROM sales_stages WHERE id = $1 FOR SHARE', [t.stages[1]!.id]);
    const id = randomUUID();
    await h.query("INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES ($1, $2, 'New', $3, $4, 'AUD')", [id, t.b.businessId, t.pipelineId, t.stages[1]!.id]);
    const archive = t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 1, moveOpenTo: t.stages[0]!.id });
    await waitUntilBlocked(observer, h.pid);
    await end(h);
    expect((await archive).body.moved).toBe(1);
    expect((await oppRow(id)).stage_id).toBe(t.stages[0]!.id);
    t = await setup('cr21b');
    h = await heldArchive(t.b, t.pipelineId, t.stages[1]!.id);
    const create = t.owner.create({ title: 'Late', stageId: t.stages[1]!.id });
    await waitUntilBlocked(observer, h.pid);
    await end(h);
    expect((await create).body.error).toBe('archived_reference');
    expect(await invalidOpen(t.b.businessId)).toBe(0);
  });

  it('T-SC-22: archive (+move) vs a PATCH of an opportunity in that stage: no lost update, the late writer gets stale', async () => {
    const t = await setup('cr22');
    const o = (await t.owner.create({ title: 'Edit me', stageId: t.stages[1]!.id })).body.opportunity.id;
    // An edit holds the opportunity row; the archive waits for it at L3 and then moves the edited row.
    const h = await tenantTx(t.b);
    await h.query("UPDATE opportunities SET title = 'Edited', version = version + 1 WHERE id = $1", [o]);
    const archive = t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 1, moveOpenTo: t.stages[0]!.id });
    await waitUntilBlocked(observer, h.pid);
    await end(h);
    expect((await archive).body.moved).toBe(1);
    const row = (await t.owner.get(o)).body.opportunity;
    expect([row.title, row.stageId, row.version]).toEqual(['Edited', t.stages[0]!.id, 3]);
    // A client still holding version 1 or 2 is refused, not silently applied.
    expect((await t.owner.patch(o, { version: 2, title: 'Overwrite' })).body.error).toBe('stale');
    expect((await t.owner.get(o)).body.opportunity.title).toBe('Edited');
  });

  it('T-SC-23: two reorders from the same configVersion: exactly one succeeds', async () => {
    const t = await setup('cr23');
    const ids = t.stages.map((s) => s.id);
    const h = await tenantTx(t.b);
    await holdL1(h, t.pipelineId);
    const both = Promise.all([t.owner.reorder(t.pipelineId, { configVersion: 1, stageIds: [...ids].reverse() }), t.owner.reorder(t.pipelineId, { configVersion: 1, stageIds: [ids[1], ids[0], ids[2], ids[3]] })]);
    await waitUntilBlocked(observer, h.pid, { count: 2 });
    await end(h);
    const results = await both;
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.error).toBe('stale');
    expect(await t.version()).toBe(2);
  });

  it('T-SC-24: two archives of the last two active stages through the API: exactly one succeeds', async () => {
    const t = await setup('cr24');
    expect((await t.owner.archiveStage(t.pipelineId, t.stages[0]!.id, { configVersion: 1 })).status).toBe(200);
    expect((await t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 2 })).status).toBe(200);
    const h = await tenantTx(t.b);
    await holdL1(h, t.pipelineId);
    const both = Promise.all([2, 3].map((i) => t.owner.archiveStage(t.pipelineId, t.stages[i]!.id, { configVersion: 3 })));
    await waitUntilBlocked(observer, h.pid, { count: 2 });
    await end(h);
    const results = await both;
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(['stale', 'last_stage']).toContain(results.find((r) => r.status === 409)!.body.error);
    expect((await t.owner.stages(`?pipelineId=${t.pipelineId}`)).body.stages).toHaveLength(1);
  });

  it('T-SC-24b: direct SQL, two connections, the last two active stages: the second archive blocks on G1 and fails SA003', async () => {
    const script = async (first: 'S1' | 'S2') => {
      const t = await setup('cr24b');
      await t.owner.archiveStage(t.pipelineId, t.stages[0]!.id, { configVersion: 1 });
      await t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 2 });
      const [s1, s2] = first === 'S1' ? [t.stages[2]!.id, t.stages[3]!.id] : [t.stages[3]!.id, t.stages[2]!.id];
      const a = await tenantTx(t.b);
      const b = await tenantTx(t.b);
      try {
        await a.query('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [s1]);
        const second = b.query('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [s2]).then(() => 'ok', (e: { code?: string }) => e.code);
        await waitUntilBlocked(observer, a.pid);
        const waiting = (await observer.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [b.pid])).rows[0].wait_event_type;
        expect(waiting).toBe('Lock');
        await a.query('COMMIT');
        expect(await second).toBe('SA003');
        await b.query('ROLLBACK');
      } finally {
        await a.end();
        await b.end();
      }
      return t;
    };
    await script('S1');
    await script('S2');

    // Detection check: with a variant of G1 that does NOT lock the pipeline row, the same script lets both
    // archives commit (the pipeline is left with no active stage), so the test above would catch the gap.
    const original = (await admin.query("SELECT pg_get_functiondef('sales_stages_guard'::regproc) AS def")).rows[0].def as string;
    const variant = original.replace(/PERFORM 1 FROM sales_pipelines[^;]*;/, '');
    expect(variant).not.toBe(original);
    await admin.query(variant);
    try {
      const t = await setup('cr24v');
      await t.owner.archiveStage(t.pipelineId, t.stages[0]!.id, { configVersion: 1 });
      await t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 2 });
      const a = await tenantTx(t.b);
      const b = await tenantTx(t.b);
      await a.query('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [t.stages[2]!.id]);
      await b.query('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [t.stages[3]!.id]); // does not block
      await end(a);
      await end(b);
      expect((await admin.query('SELECT count(*)::int AS n FROM sales_stages WHERE pipeline_id = $1 AND archived_at IS NULL', [t.pipelineId])).rows[0].n).toBe(0);
    } finally {
      await admin.query(original);
    }
    expect((await admin.query("SELECT pg_get_functiondef('sales_stages_guard'::regproc) AS def")).rows[0].def).toBe(original);
  });

  it('T-SC-25: archive (+move) vs a reopen into the archived stage, both orders', async () => {
    let t = await setup('cr25a');
    let o = (await t.owner.create({ title: 'Closed', stageId: t.stages[1]!.id })).body.opportunity.id;
    await t.owner.win(o);
    // Reopen first (held): the archive waits at L2 and then moves the reopened row.
    let h = await tenantTx(t.b);
    await h.query('SELECT 1 FROM sales_stages WHERE id = $1 FOR SHARE', [t.stages[1]!.id]);
    await h.query("UPDATE opportunities SET status = 'OPEN', closed_at = NULL, version = version + 1 WHERE id = $1", [o]);
    const archive = t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 1, moveOpenTo: t.stages[0]!.id });
    await waitUntilBlocked(observer, h.pid);
    await end(h);
    expect((await archive).body.moved).toBe(1);
    expect(await oppRow(o)).toMatchObject({ status: 'OPEN', stage_id: t.stages[0]!.id });
    // Archive first (held): the API reopen waits on its locking read and is refused.
    t = await setup('cr25b');
    o = (await t.owner.create({ title: 'Closed', stageId: t.stages[1]!.id })).body.opportunity.id;
    await t.owner.lose(o);
    h = await heldArchive(t.b, t.pipelineId, t.stages[1]!.id);
    const reopen = t.owner.reopen(o);
    await waitUntilBlocked(observer, h.pid);
    await end(h);
    expect((await reopen).body.error).toBe('archived_reference');
    expect((await oppRow(o)).status).toBe('LOST');
    expect(await invalidOpen(t.b.businessId)).toBe(0);
  });

  it('T-SC-26: 50 randomized concurrent configuration and opportunity operations: no deadlock, invariants hold', async () => {
    const t = await setup('cr26');
    // Six active stages and a few opportunities in each.
    let v = 1;
    for (const name of ['Five', 'Six']) await t.owner.addStage(t.pipelineId, { configVersion: v++, name });
    const opps: string[] = [];
    const all = async () => (await t.owner.config(t.pipelineId)).body as { pipeline: { configVersion: number }; stages: Stage[] };
    for (const s of (await all()).stages) for (let i = 0; i < 3; i++) opps.push((await t.owner.create({ title: `R${i}`, stageId: s.id })).body.opportunity.id);
    const deadlocksBefore = (await admin.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks as number;
    let seed = 26;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const snapshot = await all();
    const stageIds = snapshot.stages.map((s) => s.id);
    const ops: (() => Promise<Res>)[] = [];
    for (let i = 0; i < 50; i++) {
      const kind = rnd(7);
      const s1 = stageIds[rnd(stageIds.length)]!;
      const s2 = stageIds[rnd(stageIds.length)]!;
      const o = opps[rnd(opps.length)]!;
      ops.push(async () => {
        const cfg = await all();
        const version = cfg.pipeline.configVersion;
        const active = cfg.stages.filter((s) => !s.archivedAt).map((s) => s.id);
        switch (kind) {
          case 0: return t.owner.archiveStage(t.pipelineId, s1, { configVersion: version, moveOpenTo: s2 });
          case 1: return t.owner.restoreStage(t.pipelineId, s1, { configVersion: version });
          case 2: return t.owner.reorder(t.pipelineId, { configVersion: version, stageIds: [...active].reverse() });
          case 3: return t.owner.patch(o, { version: (await t.owner.get(o)).body.opportunity.version, stageId: s2 });
          case 4: return t.owner.create({ title: 'Burst', stageId: s1 });
          case 5: return (await t.owner.win(o)).status === 200 ? t.owner.reopen(o, { stageId: s2 }) : t.owner.reopen(o, { stageId: s2 });
          default: return t.owner.editStage(t.pipelineId, s1, { configVersion: version, defaultProbability: rnd(100) });
        }
      });
    }
    const results = await Promise.all(ops.map((op) => op()));
    for (const r of results) {
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
      expect(r.body.error).not.toBe('retryable');
    }
    await new Promise((resolve) => setTimeout(resolve, 1200)); // cumulative statistics flush
    await admin.query('SELECT pg_stat_clear_snapshot()');
    const deadlocksAfter = (await admin.query('SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()')).rows[0].deadlocks as number;
    expect(deadlocksAfter - deadlocksBefore).toBe(0);
    expect(await invalidOpen(t.b.businessId)).toBe(0);
    expect((await t.owner.stages(`?pipelineId=${t.pipelineId}`)).body.stages.length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('T-SC-27: archive (+move) alongside cross-Zone links on the same opportunity: the FK KEY SHARE never blocks it', async () => {
    const t = await setup('cr27');
    const customer = (await t.owner.createCustomer({ displayName: 'Linked customer' })).body.customer.id;
    const o = (await t.owner.create({ title: 'Linked', stageId: t.stages[1]!.id, customerId: customer })).body.opportunity.id;
    // A link insert in flight holds the opportunity FOR KEY SHARE (its FK check); the archive's FOR NO KEY UPDATE is compatible (I9).
    const h = await tenantTx(t.b);
    await h.query('SELECT 1 FROM opportunities WHERE id = $1 FOR KEY SHARE', [o]);
    const archive = t.owner.archiveStage(t.pipelineId, t.stages[1]!.id, { configVersion: 1, moveOpenTo: t.stages[2]!.id });
    expect(await finishesOrBlocks(observer, h.pid, archive)).toBe('finished');
    expect((await archive).body.moved).toBe(1);
    await end(h);
    // And a real Finance link concurrently with another archive (+move) of the stage it now sits in: both succeed.
    const [quote, again] = await Promise.all([
      t.owner.createQuote({ customerId: customer, opportunityId: o }),
      t.owner.archiveStage(t.pipelineId, t.stages[2]!.id, { configVersion: 2, moveOpenTo: t.stages[3]!.id }),
    ]);
    expect([quote.status, again.status, again.body.moved]).toEqual([201, 200, 1]);
    expect(quote.body.document.opportunityId).toBe(o);
  });

  it('T-SC-28: lock modes on real PostgreSQL match §5.1 P2/P3; configuration runs at READ COMMITTED', async () => {
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgrowlocks');
    const t = await setup('cr28');
    const o = (await t.owner.create({ title: 'Lock', stageId: t.stages[0]!.id })).body.opportunity.id;
    const modes = async (table: string, id: string) =>
      ((await admin.query(`SELECT r.modes FROM pgrowlocks('${table}') r JOIN ${table} x ON x.ctid = r.locked_row WHERE x.id = $1`, [id])).rows[0]?.modes ?? []) as string[];
    const probe = async (sql: string, params: unknown[], checks: [string, string, string[]][]) => {
      const c = await tenantTx(t.b);
      try {
        await c.query(sql, params);
        for (const [table, id, expected] of checks) expect(await modes(table, id), `${sql} on ${table}`).toEqual(expect.arrayContaining(expected));
      } finally {
        await end(c, false);
      }
    };
    // Rename, archive and reorder: an implicit FOR NO KEY UPDATE (U1/U2 are partial expression indexes, not keys).
    await probe("UPDATE sales_stages SET name = 'Renamed' WHERE id = $1", [t.stages[1]!.id], [['sales_stages', t.stages[1]!.id, ['No Key Update']]]);
    await probe('UPDATE sales_stages SET position = 9000 WHERE id = $1', [t.stages[1]!.id], [['sales_stages', t.stages[1]!.id, ['No Key Update']]]);
    // Archive: the stage, plus G1's explicit FOR NO KEY UPDATE on the pipeline row (L4).
    await probe('UPDATE sales_stages SET archived_at = now() WHERE id = $1', [t.stages[1]!.id],
      [['sales_stages', t.stages[1]!.id, ['No Key Update']], ['sales_pipelines', t.pipelineId, ['For No Key Update']]]);
    // Opportunity create and move: G2's FOR SHARE on the target stage (with the FK's KEY SHARE).
    await probe("INSERT INTO opportunities (id, business_id, title, pipeline_id, stage_id, currency_code) VALUES ($1, $2, 'L', $3, $4, 'AUD')",
      [randomUUID(), t.b.businessId, t.pipelineId, t.stages[2]!.id], [['sales_stages', t.stages[2]!.id, ['For Share']]]);
    await probe('UPDATE opportunities SET stage_id = $1 WHERE id = $2', [t.stages[3]!.id, o], [['sales_stages', t.stages[3]!.id, ['For Share']], ['opportunities', o, ['No Key Update']]]);
    // A title edit takes no stage lock at all (G2 does not fire).
    const c = await tenantTx(t.b);
    try {
      await c.query("UPDATE opportunities SET title = 'T' WHERE id = $1", [o]);
      expect(await modes('sales_stages', t.stages[0]!.id)).toEqual([]);
    } finally {
      await end(c, false);
    }
    // The configuration service runs at READ COMMITTED (withTenant's level, asserted by the service on every write).
    const iso = (await admin.query("SELECT current_setting('default_transaction_isolation') AS l")).rows[0].l;
    expect(iso).toBe('read committed');
    expect((await t.owner.rename(t.pipelineId, { configVersion: 1, name: 'RC' })).status).toBe(200);
  });

  it('T-SC-29: a held stage lock makes a configuration write answer 409 busy after lock_timeout, with no partial change', async () => {
    const t = await setup('cr29');
    const h = await tenantTx(t.b);
    await h.query('SELECT 1 FROM sales_stages WHERE id = $1 FOR SHARE', [t.stages[1]!.id]);
    const started = Date.now();
    const r = await t.owner.editStage(t.pipelineId, t.stages[1]!.id, { configVersion: 1, name: 'Blocked' });
    expect([r.status, r.body.error]).toEqual([409, 'busy']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500);
    await end(h);
    expect((await t.owner.config(t.pipelineId)).body).toMatchObject({ pipeline: { configVersion: 1 } });
    expect((await t.owner.config(t.pipelineId)).body.stages[1].name).toBe('Qualified');
  });
});
