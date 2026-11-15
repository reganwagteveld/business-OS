import 'server-only';
// Saved views (docs/reporting-r1.md §6): stored report CONFIGURATIONS, never results. A view grants
// nothing: running it re-checks reporting:read, every metric's source keys and the business in the URL,
// as the person running it. PRIVATE views are visible to their owner only; BUSINESS views to anyone in
// the business who holds reporting:read and can read every source the view uses (otherwise the view is
// left out of lists and answers 404, so its title and filters reveal nothing). Only the owner edits.
// The database backs each rule with restrictive RLS policies (migration 20261122000000_reporting).
import { randomUUID } from 'node:crypto';
import { SavedViewConfig, SAVED_VIEW_CONFIG_VERSION, type SavedView, type SavedViewListItem } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { can, ForbiddenError, type Principal } from '@/modules/access';
import { checkAccess, checkShape, resolveMetric, runQuery } from './engine';
import { checkRange, resolveDate } from './periods';
import { metricById } from './registry';

export interface ReportingActor extends Principal {
  readonly userId: string;
}

/** Most views one person may keep in one business: bounds every list without paging in R1. */
export const MAX_VIEWS_PER_OWNER = 100;
const UNREADABLE = 'This report was saved in a format this version cannot read. Delete it and save it again.';

type Row = {
  id: string; ownerUserId: string; title: string; description: string | null; reportType: string; config: unknown; configVersion: number;
  visibility: string; version: number; createdAt: Date; updatedAt: Date;
};
const select = {
  id: true, ownerUserId: true, title: true, description: true, reportType: true, config: true, configVersion: true, visibility: true, version: true,
  createdAt: true, updatedAt: true,
} as const;

/** Reads a stored config with the current contract; older formats would be migrated here. Null when unreadable. */
function readConfig(row: Pick<Row, 'config' | 'configVersion'>): SavedViewConfig | null {
  if (row.configVersion !== SAVED_VIEW_CONFIG_VERSION) return null;
  const parsed = SavedViewConfig.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

/** Problems a config has against the CURRENT registry and the actor's access (empty when it runs as saved). */
function issuesOf(actor: Principal, config: SavedViewConfig): string[] {
  const issues: string[] = [];
  for (const ref of config.metrics) {
    try {
      const def = resolveMetric(ref);
      checkShape(def, config);
      checkAccess(actor, def, config.groupBy);
    } catch (error) {
      if (error instanceof RuleViolationError) issues.push(error.detail);
      else if (error instanceof ForbiddenError) issues.push(`You do not have access to the data ${metricById(ref.id)?.name ?? ref.id} uses.`);
      else throw error;
    }
  }
  return issues;
}

/** Whether a non-owner may see this view at all: shared, readable config, and access to every source it names. */
function visibleToOthers(actor: Principal, row: Row, config: SavedViewConfig | null): boolean {
  if (row.visibility !== 'BUSINESS' || !config) return false;
  return config.metrics.every((ref) => {
    const def = metricById(ref.id);
    return !def || def.requires.every((k) => can(actor, k));
  }) && (!config.groupBy || config.metrics.every((ref) => (metricById(ref.id)?.dimensionRequires[config.groupBy!] ?? []).every((k) => can(actor, k))));
}

function dto(actor: ReportingActor, row: Row, config: SavedViewConfig): SavedView {
  return {
    id: row.id, title: row.title, description: row.description, reportType: 'metrics', config, configVersion: row.configVersion,
    visibility: row.visibility as SavedView['visibility'], ownerUserId: row.ownerUserId, isOwner: row.ownerUserId === actor.userId, version: row.version,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/** A view this actor may open, or 404 (also for another person's private view, which RLS hides anyway). */
async function load(db: AppTenantDb, actor: ReportingActor, id: string): Promise<{ row: Row; config: SavedViewConfig | null }> {
  const row = (await db.reportingSavedView.findFirst({
    where: { id, OR: [{ ownerUserId: actor.userId }, { visibility: 'BUSINESS' }] }, select,
  })) as Row | null;
  if (!row) throw new RecordNotFoundError();
  const config = readConfig(row);
  if (row.ownerUserId !== actor.userId && !visibleToOthers(actor, row, config)) throw new RecordNotFoundError();
  return { row, config };
}

/** Everything a new or edited config must satisfy: the registry, the limits, and the actor's own access. */
function validateForSave(actor: ReportingActor, config: SavedViewConfig): void {
  for (const ref of config.metrics) {
    const def = resolveMetric(ref);
    checkShape(def, config);
    // A view cannot be saved over data its owner cannot read (so sharing never extends anyone's reach).
    checkAccess(actor, def, config.groupBy);
  }
  if (config.date.kind === 'fixed') checkRange(resolveDate(config.date, config.date.to), config.granularity);
}

export async function listViews(db: AppTenantDb, actor: ReportingActor, scope: 'all' | 'mine' | 'shared'): Promise<SavedViewListItem[]> {
  const where = scope === 'mine' ? { ownerUserId: actor.userId }
    : scope === 'shared' ? { visibility: 'BUSINESS' }
    : { OR: [{ ownerUserId: actor.userId }, { visibility: 'BUSINESS' }] };
  const rows = (await db.reportingSavedView.findMany({ where, select, orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }], take: 500 })) as Row[];
  const out: SavedViewListItem[] = [];
  for (const row of rows) {
    const config = readConfig(row);
    if (row.ownerUserId !== actor.userId && !visibleToOthers(actor, row, config)) continue;
    out.push({
      id: row.id, title: row.title, description: row.description, reportType: 'metrics', configVersion: row.configVersion,
      visibility: row.visibility as SavedView['visibility'], ownerUserId: row.ownerUserId, isOwner: row.ownerUserId === actor.userId, version: row.version,
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
      metrics: config?.metrics ?? [],
      issues: config ? issuesOf(actor, config) : [UNREADABLE],
    });
  }
  return out;
}

export async function getView(db: AppTenantDb, actor: ReportingActor, id: string): Promise<SavedView> {
  const { row, config } = await load(db, actor, id);
  if (!config) throw new StateConflictError('view_config_invalid');
  return dto(actor, row, config);
}

export async function createView(db: AppTenantDb, actor: ReportingActor, input: {
  title: string; description?: string | null; visibility: 'PRIVATE' | 'BUSINESS'; config: SavedViewConfig;
}): Promise<SavedView> {
  if (input.visibility === 'BUSINESS' && !can(actor, 'reporting:share')) throw new ForbiddenError();
  validateForSave(actor, input.config);
  const owned = await db.reportingSavedView.count({ where: { ownerUserId: actor.userId } });
  if (owned >= MAX_VIEWS_PER_OWNER) throw new StateConflictError('too_many_views');
  const id = randomUUID();
  const row = (await db.reportingSavedView.create({
    data: {
      id, ownerUserId: actor.userId, updatedById: actor.userId, title: input.title, description: input.description ?? null, reportType: 'metrics',
      config: input.config, configVersion: SAVED_VIEW_CONFIG_VERSION, visibility: input.visibility,
    } as never,
    select,
  })) as Row;
  await recordAudit(db, actor.userId, 'reporting.view.created', { type: 'reporting_saved_view', id }, { visibility: input.visibility, metrics: input.config.metrics.map((m) => m.id) });
  return dto(actor, row, input.config);
}

export async function updateView(db: AppTenantDb, actor: ReportingActor, id: string, patch: {
  version: number; title?: string; description?: string | null; visibility?: 'PRIVATE' | 'BUSINESS'; config?: SavedViewConfig;
}): Promise<SavedView> {
  const { row, config } = await load(db, actor, id);
  // Shared views are read-only for everyone but their owner; say so rather than pretend it is missing.
  if (row.ownerUserId !== actor.userId) throw new ForbiddenError();
  if (patch.visibility === 'BUSINESS' && row.visibility !== 'BUSINESS' && !can(actor, 'reporting:share')) throw new ForbiddenError();
  const next = patch.config ?? config;
  if (!next) throw new RuleViolationError('view_config_invalid', UNREADABLE);
  if (patch.config) validateForSave(actor, patch.config);
  const data: Record<string, unknown> = { updatedById: actor.userId, version: { increment: 1 } };
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.description !== undefined) data.description = patch.description;
  if (patch.visibility !== undefined) data.visibility = patch.visibility;
  if (patch.config !== undefined) Object.assign(data, { config: patch.config, configVersion: SAVED_VIEW_CONFIG_VERSION });
  const result = await db.reportingSavedView.updateMany({ where: { id, ownerUserId: actor.userId, version: patch.version }, data: data as never });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actor.userId, 'reporting.view.updated', { type: 'reporting_saved_view', id }, {
    fields: Object.keys(data).filter((k) => !['updatedById', 'version', 'configVersion'].includes(k)).sort(),
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
  });
  const fresh = (await db.reportingSavedView.findFirstOrThrow({ where: { id }, select })) as Row;
  return dto(actor, fresh, next);
}

export async function deleteView(db: AppTenantDb, actor: ReportingActor, id: string): Promise<void> {
  const { row } = await load(db, actor, id);
  const mine = row.ownerUserId === actor.userId;
  // The route requires reporting:save. Removing someone else's shared view (for example after they left)
  // also needs reporting:manage; another person's private view is never reachable (404 above, and RLS).
  if (!mine && !(row.visibility === 'BUSINESS' && can(actor, 'reporting:manage'))) throw new ForbiddenError();
  const result = await db.reportingSavedView.deleteMany({ where: { id } });
  if (result.count === 0) throw new RecordNotFoundError();
  await recordAudit(db, actor.userId, 'reporting.view.deleted', { type: 'reporting_saved_view', id }, { ownerUserId: row.ownerUserId, visibility: row.visibility });
}

/** Runs a saved view's stored config as the caller, against the current registry, metric by metric. */
export async function runView(db: AppTenantDb, actor: ReportingActor, id: string) {
  const { row, config } = await load(db, actor, id);
  if (!config) throw new RuleViolationError('view_config_invalid', UNREADABLE);
  const result = await runQuery(db, actor, config, 'lenient');
  return { view: dto(actor, row, config), result };
}
