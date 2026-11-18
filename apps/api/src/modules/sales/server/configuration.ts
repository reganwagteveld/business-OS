import 'server-only';
// S-CFG-1A: pipeline and stage configuration (docs/sales-pipeline-configuration-scfg.md v1.3 §4–§6, §11, §12).
// Runs inside a tenant unit of work (READ COMMITTED, forced RLS, business filter injected).
//
// Lock hierarchy (§5.2), always in this order and never back up a level:
//   L1  advisory lock on the pipeline (every configuration write);
//   L2  the stage rows it changes, plus the move target, in ONE statement ordered by id, FOR UPDATE;
//   L3  the opportunities it moves, locked in id order before the UPDATE (archive only);
//   L4  the pipeline row: G1's FOR NO KEY UPDATE during a stage archive, then the config_version bump.
// Opportunity writes take their target stage FOR SHARE (L2) before the opportunity row (L3), so the two
// sides cannot wait for each other in a cycle. The invariants themselves rest on triggers G1/G2 and the
// partial unique indexes U1/U2 (migration 20261210000000_sales_configuration), not on this ordering.
import { randomUUID } from 'node:crypto';
import { MAX_ACTIVE_STAGES, type ConfiguredStage } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, StateConflictError, sqlState } from '@/core/http/errors';
import { nameKey, pipelineSelect, POSITION_STEP, stageSelect, toPipeline, toStage, type PipelineRow, type StageRow } from './pipelines';

/** Per statement (§5.2). */
const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT_MS = 30_000;
/**
 * Transaction deadline (§11): statement_timeout bounds each statement, not their sum, so the service also
 * checks a deadline between statements and gives each statement only the time that is left. Kept below the
 * route's unit-of-work timeout (CONFIG_ROUTE_TIMEOUT_MS) so the deadline, not Prisma, ends a slow archive.
 */
const DEADLINE_MS = 25_000;
/** The unit-of-work timeout configuration routes pass to tenantRoute. */
export const CONFIG_ROUTE_TIMEOUT_MS = 30_000;
/** Audit rows for moved opportunities are written in batches of this size. */
const AUDIT_BATCH = 500;

/**
 * Test-only fault injection (T-SC-15, T-SC-15b). Active only when NODE_ENV is 'test' (the test runner;
 * never set on Vercel) AND SALES_CONFIG_TEST_HOOKS is '1'. Production code paths never read it otherwise.
 */
export type ConfigTestHooks = {
  /** Between the bulk move (§5.3 step 6) and setting archived_at (step 7), in the same transaction. */
  afterMove?: (db: AppTenantDb, ctx: { pipelineId: string; stageId: string }) => Promise<void>;
  /** Before each batch of per-opportunity audit rows; `last` marks the final batch. */
  beforeAuditBatch?: (batch: { index: number; last: boolean }) => Promise<void>;
  /** Overrides DEADLINE_MS. */
  deadlineMs?: number;
};
let testHooks: ConfigTestHooks = {};
const hooksEnabled = () => process.env.NODE_ENV === 'test' && process.env.SALES_CONFIG_TEST_HOOKS === '1';
export function setConfigTestHooks(hooks: ConfigTestHooks): void {
  if (!hooksEnabled()) throw new Error('sales configuration test hooks are disabled');
  testHooks = hooks;
}
const hooks = (): ConfigTestHooks => (hooksEnabled() ? testHooks : {});

/** A lock or statement timeout, or a deadlock: the unit of work rolled back whole. */
const BUSY_STATES = new Set(['55P03', '57014', '40P01']);

class Deadline {
  private readonly endsAt: number;
  constructor(ms: number) {
    this.endsAt = Date.now() + ms;
  }
  /** Before each statement: refuse when the deadline passed, and cap the next statement at the time left. */
  async next(db: AppTenantDb): Promise<void> {
    const left = this.endsAt - Date.now();
    if (left <= 0) throw new StateConflictError('busy');
    const ms = Math.max(1, Math.min(STATEMENT_TIMEOUT_MS, left));
    await db.$queryRaw`SELECT set_config('statement_timeout', ${`${ms}ms`}, true)`;
  }
}

/**
 * One configuration write. Sets the per-statement limits, asserts READ COMMITTED (§5.1; at a stricter level
 * the locking reads would fail with 40001, which is safe but not what the design reasons about), takes L1 for
 * the pipeline and maps a lock or statement timeout or a deadlock to 409 busy. Every error leaves the
 * transaction to roll back whole.
 */
async function configWrite<R>(db: AppTenantDb, pipelineId: string, work: (deadline: Deadline) => Promise<R>): Promise<R> {
  try {
    const rows = await db.$queryRaw<{ isolation: string }[]>`
      SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true),
             set_config('statement_timeout', ${`${STATEMENT_TIMEOUT_MS}ms`}, true),
             set_config('idle_in_transaction_session_timeout', ${`${CONFIG_ROUTE_TIMEOUT_MS + 5_000}ms`}, true),
             current_setting('transaction_isolation') AS isolation`;
    if (rows[0]?.isolation !== 'read committed') throw new Error('sales configuration requires READ COMMITTED');
    const deadline = new Deadline(hooks().deadlineMs ?? DEADLINE_MS);
    await deadline.next(db);
    // L1. One statement, before any row lock.
    await db.$queryRaw<{ locked: number }[]>`
      SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended('sales.pipeline_config:' || ${pipelineId}::text, 0))) AS l`;
    return await work(deadline);
  } catch (error) {
    const state = sqlState(error);
    if (state && BUSY_STATES.has(state)) throw new StateConflictError('busy');
    throw error;
  }
}

/** §5.3 step 3: the pipeline, refused when archived or when its configuration changed since the client read it. */
async function pipelineForWrite(db: AppTenantDb, pipelineId: string, configVersion: number): Promise<PipelineRow> {
  const pipeline = (await db.salesPipeline.findFirst({ where: { id: pipelineId }, select: pipelineSelect })) as PipelineRow | null;
  if (!pipeline) throw new RecordNotFoundError();
  if (pipeline.archivedAt) throw new StateConflictError('archived');
  if (pipeline.configVersion !== configVersion) throw new StateConflictError('stale');
  return pipeline;
}

/** L2: the given stages of this pipeline, one statement, id order, FOR UPDATE. Unknown ids are simply absent. */
async function lockStages(db: AppTenantDb, pipelineId: string, ids: string[]): Promise<Map<string, StageRow>> {
  const sorted = [...new Set(ids.map((i) => i.toLowerCase()))].sort();
  if (sorted.length === 0) return new Map();
  const rows = await db.$queryRaw<StageRow[]>`
    SELECT id::text, pipeline_id::text AS "pipelineId", name, position, default_probability AS "defaultProbability", archived_at AS "archivedAt"
    FROM sales_stages
    WHERE pipeline_id = ${pipelineId}::uuid AND id = ANY(${sorted}::uuid[])
      AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ORDER BY id FOR UPDATE`;
  return new Map(rows.map((r) => [r.id, r]));
}

/** L2 for reorder and add: every active stage of the pipeline, one statement, id order, FOR UPDATE. */
async function lockActiveStages(db: AppTenantDb, pipelineId: string): Promise<StageRow[]> {
  const rows = await db.$queryRaw<StageRow[]>`
    SELECT id::text, pipeline_id::text AS "pipelineId", name, position, default_probability AS "defaultProbability", archived_at AS "archivedAt"
    FROM sales_stages
    WHERE pipeline_id = ${pipelineId}::uuid AND archived_at IS NULL
      AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ORDER BY id FOR UPDATE`;
  return rows.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/** Active stages other than `exceptId` whose name matches (U1 is the backstop for a race the service lost). */
async function nameTaken(db: AppTenantDb, pipelineId: string, name: string, exceptId?: string): Promise<boolean> {
  const active = (await db.salesStage.findMany({ where: { pipelineId, archivedAt: null }, select: { id: true, name: true } })) as { id: string; name: string }[];
  return active.some((s) => s.id !== exceptId && nameKey(s.name) === nameKey(name));
}

/** L4: the config_version bump, exactly once per committed configuration change (§6.1). */
async function bump(db: AppTenantDb, actorUserId: string, pipelineId: string, configVersion: number): Promise<void> {
  const result = await db.salesPipeline.updateMany({
    where: { id: pipelineId, configVersion },
    data: { configVersion: { increment: 1 }, updatedById: actorUserId } as never,
  });
  // Unreachable under L1 (every writer of config_version holds it); kept as a fail-closed check.
  if (result.count !== 1) throw new StateConflictError('stale');
}

/** The pipeline with all its stages (active in board order, then archived) and each stage's open count. */
export async function getPipelineConfig(db: AppTenantDb, pipelineId: string): Promise<{ pipeline: ReturnType<typeof toPipeline>; stages: ConfiguredStage[] }> {
  const pipeline = (await db.salesPipeline.findFirst({ where: { id: pipelineId }, select: pipelineSelect })) as PipelineRow | null;
  if (!pipeline) throw new RecordNotFoundError();
  const stages = (await db.salesStage.findMany({ where: { pipelineId }, select: stageSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] })) as StageRow[];
  const counts = (await db.opportunity.groupBy({
    by: ['stageId'], where: { pipelineId, status: 'OPEN', archivedAt: null }, _count: { _all: true },
  } as never)) as unknown as { stageId: string; _count: { _all: number } }[];
  const open = new Map(counts.map((c) => [c.stageId, c._count._all]));
  const ordered = [...stages.filter((s) => !s.archivedAt), ...stages.filter((s) => s.archivedAt)];
  return { pipeline: toPipeline(pipeline), stages: ordered.map((s) => ({ ...toStage(s), openCount: open.get(s.id) ?? 0 })) };
}

export async function updatePipeline(db: AppTenantDb, actorUserId: string, pipelineId: string, input: { configVersion: number; name: string }) {
  return configWrite(db, pipelineId, async () => {
    const pipeline = await pipelineForWrite(db, pipelineId, input.configVersion);
    const fields: string[] = [];
    if (input.name !== pipeline.name) {
      const others = (await db.salesPipeline.findMany({ where: { archivedAt: null }, select: { id: true, name: true } })) as { id: string; name: string }[];
      if (others.some((p) => p.id !== pipelineId && nameKey(p.name) === nameKey(input.name))) throw new StateConflictError('name_taken');
      await db.salesPipeline.updateMany({ where: { id: pipelineId }, data: { name: input.name, updatedById: actorUserId } as never });
      fields.push('name');
    }
    if (fields.length === 0) return getPipelineConfig(db, pipelineId); // nothing changed: no version bump
    await bump(db, actorUserId, pipelineId, input.configVersion);
    await recordAudit(db, actorUserId, 'sales.pipeline.updated', { type: 'sales_pipeline', id: pipelineId }, { fields });
    return getPipelineConfig(db, pipelineId);
  });
}

export async function createStage(
  db: AppTenantDb, actorUserId: string, pipelineId: string,
  input: { configVersion: number; name: string; defaultProbability?: number | null; afterStageId?: string },
) {
  return configWrite(db, pipelineId, async () => {
    await pipelineForWrite(db, pipelineId, input.configVersion);
    const active = await lockActiveStages(db, pipelineId);
    let index = active.length; // at the end
    if (input.afterStageId) {
      const at = active.findIndex((s) => s.id === input.afterStageId!.toLowerCase());
      if (at < 0) throw new RuleViolationError('invalid_stage', 'Choose an active stage of this pipeline.');
      index = at + 1;
    }
    if (active.length >= MAX_ACTIVE_STAGES) throw new StateConflictError('stage_limit');
    if (active.some((s) => nameKey(s.name) === nameKey(input.name))) throw new StateConflictError('name_taken');
    const id = randomUUID();
    let position: number;
    if (index === active.length) {
      position = (active[active.length - 1]?.position ?? 0) + POSITION_STEP;
    } else {
      // Insert in the middle: rewrite the active positions as 1000, 2000, … (at most 20 rows, all locked above).
      position = (index + 1) * POSITION_STEP;
      for (const [i, s] of active.entries()) {
        const next = (i < index ? i + 1 : i + 2) * POSITION_STEP;
        if (s.position !== next) await db.salesStage.updateMany({ where: { id: s.id }, data: { position: next } as never });
      }
    }
    await db.salesStage.createMany({
      data: [{ id, pipelineId, name: input.name, position, defaultProbability: input.defaultProbability ?? null }] as never,
    });
    await bump(db, actorUserId, pipelineId, input.configVersion);
    await recordAudit(db, actorUserId, 'sales.stage.created', { type: 'sales_stage', id }, { pipelineId, position: String(position) });
    return getPipelineConfig(db, pipelineId);
  });
}

export async function updateStage(
  db: AppTenantDb, actorUserId: string, pipelineId: string, stageId: string,
  input: { configVersion: number; name?: string; defaultProbability?: number | null },
) {
  return configWrite(db, pipelineId, async () => {
    await pipelineForWrite(db, pipelineId, input.configVersion);
    const stage = (await lockStages(db, pipelineId, [stageId])).get(stageId.toLowerCase());
    if (!stage) throw new RecordNotFoundError();
    if (stage.archivedAt) throw new StateConflictError('archived');
    const data: Record<string, unknown> = {};
    if (input.name !== undefined && input.name !== stage.name) {
      if (await nameTaken(db, pipelineId, input.name, stage.id)) throw new StateConflictError('name_taken');
      data.name = input.name;
    }
    if (input.defaultProbability !== undefined && input.defaultProbability !== stage.defaultProbability) data.defaultProbability = input.defaultProbability;
    const fields = Object.keys(data).sort();
    if (fields.length === 0) return getPipelineConfig(db, pipelineId);
    await db.salesStage.updateMany({ where: { id: stage.id }, data: data as never });
    await bump(db, actorUserId, pipelineId, input.configVersion);
    await recordAudit(db, actorUserId, 'sales.stage.updated', { type: 'sales_stage', id: stage.id }, { pipelineId, fields });
    return getPipelineConfig(db, pipelineId);
  });
}

/** §4.2: the request lists every active stage exactly once; anything else is 409 stale. Positions become 1000, 2000, … */
export async function reorderStages(db: AppTenantDb, actorUserId: string, pipelineId: string, input: { configVersion: number; stageIds: string[] }) {
  return configWrite(db, pipelineId, async () => {
    await pipelineForWrite(db, pipelineId, input.configVersion);
    const active = await lockActiveStages(db, pipelineId);
    const wanted = input.stageIds.map((i) => i.toLowerCase());
    const current = new Set(active.map((s) => s.id));
    if (wanted.length !== current.size || wanted.some((id) => !current.has(id))) throw new StateConflictError('stale');
    const byId = new Map(active.map((s) => [s.id, s]));
    for (const [i, id] of wanted.entries()) {
      const position = (i + 1) * POSITION_STEP;
      if (byId.get(id)!.position !== position) await db.salesStage.updateMany({ where: { id }, data: { position } as never });
    }
    await bump(db, actorUserId, pipelineId, input.configVersion);
    await recordAudit(db, actorUserId, 'sales.stage.reordered', { type: 'sales_pipeline', id: pipelineId }, { stages: String(wanted.length) });
    return getPipelineConfig(db, pipelineId);
  });
}

/**
 * §5.3 stage archive (C1). With open, non-archived opportunities in the stage, a target (`moveOpenTo`, an
 * active stage of the same pipeline) is required and they are moved in the same transaction (D-SCFG-2).
 * Won, lost and archived opportunities keep the stage. Any failure, including G1 at step 7, a late audit
 * failure or the deadline, rolls back every move, the archive and the version bump.
 */
export async function archiveStage(
  db: AppTenantDb, actorUserId: string, pipelineId: string, stageId: string, input: { configVersion: number; moveOpenTo?: string },
) {
  return configWrite(db, pipelineId, async (deadline) => {
    // Steps 1–3.
    await pipelineForWrite(db, pipelineId, input.configVersion);
    const archivedId = stageId.toLowerCase();
    const targetId = input.moveOpenTo?.toLowerCase();
    // Step 4: L2, the archived stage and the target together, one statement, id order, FOR UPDATE.
    await deadline.next(db);
    const locked = await lockStages(db, pipelineId, targetId ? [archivedId, targetId] : [archivedId]);
    const stage = locked.get(archivedId);
    if (!stage) throw new RecordNotFoundError();
    if (stage.archivedAt) throw new StateConflictError('archived');
    if (targetId !== undefined) {
      const target = locked.get(targetId);
      // Missing (another pipeline or business), archived, or the stage itself.
      if (!target || target.archivedAt || targetId === archivedId) throw new RuleViolationError('invalid_stage', 'Choose another active stage of this pipeline.');
    }
    const otherActive = await db.salesStage.count({ where: { pipelineId, archivedAt: null, id: { not: archivedId } } });
    if (otherActive === 0) throw new StateConflictError('last_stage');
    // Step 5.
    await deadline.next(db);
    const openCount = await db.opportunity.count({ where: { pipelineId, stageId: archivedId, status: 'OPEN', archivedAt: null } });
    if (openCount > 0 && targetId === undefined) throw new StateConflictError('has_open_opportunities');
    // Step 6: L3, then the move. G2 fires per row and re-takes the target lock (already held).
    let movedIds: string[] = [];
    if (targetId !== undefined && openCount > 0) {
      await deadline.next(db);
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT id::text FROM opportunities
        WHERE stage_id = ${archivedId}::uuid AND pipeline_id = ${pipelineId}::uuid AND status = 'OPEN' AND archived_at IS NULL
          AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
        ORDER BY id FOR NO KEY UPDATE`;
      await deadline.next(db);
      movedIds = await db.$queryRaw<{ id: string }[]>`
        UPDATE opportunities SET stage_id = ${targetId}::uuid, version = version + 1, updated_by_id = ${actorUserId}::uuid, updated_at = now()
        WHERE id = ANY(${rows.map((r) => r.id)}::uuid[]) AND stage_id = ${archivedId}::uuid AND status = 'OPEN' AND archived_at IS NULL
          AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
        RETURNING id::text`.then((r) => r.map((x) => x.id).sort());
    }
    await hooks().afterMove?.(db, { pipelineId, stageId: archivedId });
    // Step 7: G1 locks the pipeline row (L4) and re-counts with a fresh snapshot (SA003, SA002).
    await deadline.next(db);
    await db.salesStage.updateMany({ where: { id: archivedId }, data: { archivedAt: new Date() } as never });
    // Step 8.
    await deadline.next(db);
    await bump(db, actorUserId, pipelineId, input.configVersion);
    // Step 9, plus one stage_changed entry per moved opportunity (ids only, never names).
    for (let i = 0; i < movedIds.length; i += AUDIT_BATCH) {
      await hooks().beforeAuditBatch?.({ index: i / AUDIT_BATCH, last: i + AUDIT_BATCH >= movedIds.length });
      await deadline.next(db);
      await db.auditEvent.createMany({
        data: movedIds.slice(i, i + AUDIT_BATCH).map((id) => ({
          id: randomUUID(), actorUserId, action: 'sales.opportunity.stage_changed', targetType: 'opportunity', targetId: id,
          metadata: { fromPipelineId: pipelineId, fromStageId: archivedId, toPipelineId: pipelineId, toStageId: targetId!, cause: 'stage_archived' },
        })) as never,
      });
    }
    await deadline.next(db);
    await recordAudit(db, actorUserId, 'sales.stage.archived', { type: 'sales_stage', id: archivedId }, {
      pipelineId, movedTo: movedIds.length > 0 ? targetId! : null, moved: String(movedIds.length),
    });
    await deadline.next(db);
    return { ...(await getPipelineConfig(db, pipelineId)), moved: movedIds.length };
  });
}

/** Restore goes to the end of the active order; refused on a name clash or a full pipeline (§4.2). */
export async function restoreStage(db: AppTenantDb, actorUserId: string, pipelineId: string, stageId: string, input: { configVersion: number }) {
  return configWrite(db, pipelineId, async () => {
    await pipelineForWrite(db, pipelineId, input.configVersion);
    const stage = (await lockStages(db, pipelineId, [stageId])).get(stageId.toLowerCase());
    if (!stage) throw new RecordNotFoundError();
    if (!stage.archivedAt) throw new StateConflictError('not_archived');
    const active = (await db.salesStage.findMany({ where: { pipelineId, archivedAt: null }, select: { name: true, position: true } })) as { name: string; position: number }[];
    if (active.length >= MAX_ACTIVE_STAGES) throw new StateConflictError('stage_limit');
    if (active.some((s) => nameKey(s.name) === nameKey(stage.name))) throw new StateConflictError('name_taken');
    const position = Math.max(0, ...active.map((s) => s.position)) + POSITION_STEP;
    await db.salesStage.updateMany({ where: { id: stage.id }, data: { archivedAt: null, position } as never });
    await bump(db, actorUserId, pipelineId, input.configVersion);
    await recordAudit(db, actorUserId, 'sales.stage.restored', { type: 'sales_stage', id: stage.id }, { pipelineId });
    return getPipelineConfig(db, pipelineId);
  });
}
