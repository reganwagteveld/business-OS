import 'server-only';
// Pipelines and stages (docs/sales-data-model.md §2). Runs inside a tenant unit of work: the scoped
// client adds the business id, RLS enforces it again, and composite foreign keys keep every stage
// inside its pipeline and business.
import { randomUUID } from 'node:crypto';
import type { Pipeline as PipelineDto, Stage as StageDto } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { RecordNotFoundError, StateConflictError } from '@/core/http/errors';

/** Spaced positions, so a later drag-and-drop reorder can move one stage without renumbering the rest. */
export const POSITION_STEP = 1000;

/** The standard stages of a new pipeline. Won and Lost are outcomes, not stages. */
export const DEFAULT_STAGES: ReadonlyArray<{ name: string; defaultProbability: number }> = [
  { name: 'New', defaultProbability: 10 },
  { name: 'Qualified', defaultProbability: 25 },
  { name: 'Proposal', defaultProbability: 50 },
  { name: 'Negotiation', defaultProbability: 75 },
];

type PipelineRow = { id: string; name: string; defaultSlot: string | null; position: number; createdAt: Date; updatedAt: Date; archivedAt: Date | null };
type StageRow = { id: string; pipelineId: string; name: string; position: number; defaultProbability: number | null; archivedAt: Date | null };
const pipelineSelect = { id: true, name: true, defaultSlot: true, position: true, createdAt: true, updatedAt: true, archivedAt: true } as const;
export const stageSelect = { id: true, pipelineId: true, name: true, position: true, defaultProbability: true, archivedAt: true } as const;

export const toPipeline = (r: PipelineRow): PipelineDto => ({
  id: r.id, name: r.name, isDefault: r.defaultSlot !== null, position: r.position,
  createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null,
});
export const toStage = (r: StageRow): StageDto => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null });

function stageRows(pipelineId: string, stages: ReadonlyArray<{ name: string; defaultProbability?: number | null }>) {
  return stages.map((s, i) => ({ id: randomUUID(), pipelineId, name: s.name, position: (i + 1) * POSITION_STEP, defaultProbability: s.defaultProbability ?? null }));
}

/**
 * The business's default pipeline, created with the standard stages on first use. Safe under
 * concurrency: the insert is ON CONFLICT DO NOTHING on (business_id, default_slot), so when two first
 * requests race, the second waits for the first to commit, inserts nothing, and reads the winner's
 * pipeline. Only the request that created it adds the stages and the audit entry.
 */
export async function ensureDefaultPipeline(db: AppTenantDb, actorUserId: string): Promise<PipelineRow> {
  const existing = (await db.salesPipeline.findFirst({ where: { defaultSlot: 'default' }, select: pipelineSelect })) as PipelineRow | null;
  if (existing) return existing;
  const id = randomUUID();
  const created = await db.salesPipeline.createMany({
    data: [{ id, name: 'Sales pipeline', defaultSlot: 'default', position: 0, createdById: actorUserId, updatedById: actorUserId }] as never,
    skipDuplicates: true,
  });
  if (created.count === 1) {
    await db.salesStage.createMany({ data: stageRows(id, DEFAULT_STAGES) as never });
    await recordAudit(db, actorUserId, 'sales.pipeline.initialized', { type: 'sales_pipeline', id }, { stages: String(DEFAULT_STAGES.length) });
  }
  return (await db.salesPipeline.findFirstOrThrow({ where: { defaultSlot: 'default' }, select: pipelineSelect })) as PipelineRow;
}

export async function listPipelines(db: AppTenantDb, actorUserId: string) {
  await ensureDefaultPipeline(db, actorUserId);
  const rows = (await db.salesPipeline.findMany({ where: { archivedAt: null }, select: pipelineSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] })) as PipelineRow[];
  return { pipelines: rows.map(toPipeline) };
}

export async function createPipeline(db: AppTenantDb, actorUserId: string, input: { name: string; stages?: { name: string; defaultProbability?: number | null }[] }) {
  await ensureDefaultPipeline(db, actorUserId);
  const last = await db.salesPipeline.findFirst({ select: { position: true }, orderBy: [{ position: 'desc' }] });
  const id = randomUUID();
  const row = (await db.salesPipeline.create({
    data: { id, name: input.name, position: (last?.position ?? 0) + POSITION_STEP, createdById: actorUserId, updatedById: actorUserId } as never,
    select: pipelineSelect,
  })) as PipelineRow;
  const stages = stageRows(id, input.stages ?? DEFAULT_STAGES);
  await db.salesStage.createMany({ data: stages as never });
  await recordAudit(db, actorUserId, 'sales.pipeline.created', { type: 'sales_pipeline', id }, { stages: String(stages.length) });
  return { pipeline: toPipeline(row), stages: stages.map((s) => toStage({ ...s, archivedAt: null })) };
}

/** An active pipeline of this business (the default when none is named). */
export async function activePipeline(db: AppTenantDb, actorUserId: string, pipelineId?: string): Promise<PipelineRow> {
  if (!pipelineId) return ensureDefaultPipeline(db, actorUserId);
  const row = (await db.salesPipeline.findFirst({ where: { id: pipelineId }, select: pipelineSelect })) as PipelineRow | null;
  if (!row) throw new RecordNotFoundError();
  if (row.archivedAt) throw new StateConflictError('archived_reference');
  return row;
}

export async function activeStages(db: AppTenantDb, pipelineId: string): Promise<StageRow[]> {
  return (await db.salesStage.findMany({ where: { pipelineId, archivedAt: null }, select: stageSelect, orderBy: [{ position: 'asc' }, { id: 'asc' }] })) as StageRow[];
}

export async function listStages(db: AppTenantDb, actorUserId: string, query: { pipelineId?: string }) {
  const pipeline = await activePipeline(db, actorUserId, query.pipelineId);
  return { pipeline: toPipeline(pipeline), stages: (await activeStages(db, pipeline.id)).map(toStage) };
}
