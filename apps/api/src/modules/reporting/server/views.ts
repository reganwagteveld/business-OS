import 'server-only';
// Saved views (docs/reporting-r1.md §6): stored report CONFIGURATIONS, never results. A view grants
// nothing: running it re-checks reporting:read, every metric's source keys and the business in the URL,
// as the person running it. PRIVATE views are visible to their owner only; BUSINESS views to anyone in
// the business who holds reporting:read and can read every source the view uses (otherwise the view is
// left out of lists and answers 404, so its title and filters reveal nothing). Only the owner edits.
// The database backs each rule with restrictive RLS policies (migration 20261124000000_reporting).
import { randomUUID } from 'node:crypto';
import { SavedViewConfig, SAVED_VIEW_CONFIG_VERSION, type SavedView, type SavedViewListItem } from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
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

/** Rows read per round trip, and at most per request, while filling one page of views this actor may see. */
const LIST_BATCH = 200;
const LIST_SCAN_LIMIT = 1000;
const EXACT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Views this actor may see, most recently updated first, keyset-paginated on (updated_at, id) with the
 * timestamp kept to the microsecond. Nothing is silently left out: rows the actor may not see (another
 * person's shared view over a source they cannot read) are skipped while the page is filled, and when a
 * request has scanned LIST_SCAN_LIMIT rows it returns what it found with a cursor to continue, so every
 * view is reached by following `nextCursor` until it is null.
 */
export async function listViews(db: AppTenantDb, actor: ReportingActor, query: { scope: 'all' | 'mine' | 'shared'; cursor?: string; limit: number }) {
  const list = `reporting:views:${query.scope}`;
  let after = decodeCursor(query.cursor, list, ['t', 'i'] as const);
  if (after && (!EXACT.test(after.t) || !UUID.test(after.i))) invalidCursor();
  const mine = query.scope !== 'shared';
  const shared = query.scope !== 'mine';
  const out: SavedViewListItem[] = [];
  let scanned = 0;
  let last: { t: string; i: string } | null = null;
  let exhausted = false;
  while (out.length < query.limit && scanned < LIST_SCAN_LIMIT) {
    const keys = await db.$queryRaw<{ id: string; at: string }[]>`
      SELECT v.id::text, to_char(v.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
        FROM reporting_saved_views v
       WHERE v.business_id = nullif(current_setting('app.business_id', true), '')::uuid
         AND ((${mine}::boolean AND v.owner_user_id = ${actor.userId}::uuid)
           OR (${shared}::boolean AND v.visibility = 'BUSINESS' AND (${query.scope === 'shared'}::boolean OR v.owner_user_id <> ${actor.userId}::uuid)))
         AND (${after?.t ?? null}::timestamptz IS NULL OR (v.updated_at, v.id) < (${after?.t ?? null}::timestamptz, ${after?.i ?? null}::uuid))
       ORDER BY v.updated_at DESC, v.id DESC
       LIMIT ${LIST_BATCH}`;
    if (keys.length === 0) {
      exhausted = true;
      break;
    }
    const rows = new Map(((await db.reportingSavedView.findMany({ where: { id: { in: keys.map((k) => k.id) } }, select })) as Row[]).map((r) => [r.id, r]));
    for (const key of keys) {
      scanned++;
      last = { t: key.at, i: key.id };
      const row = rows.get(key.id);
      if (row) {
        const config = readConfig(row);
        if (row.ownerUserId === actor.userId || visibleToOthers(actor, row, config)) {
          out.push({
            id: row.id, title: row.title, description: row.description, reportType: 'metrics', configVersion: row.configVersion,
            visibility: row.visibility as SavedView['visibility'], ownerUserId: row.ownerUserId, isOwner: row.ownerUserId === actor.userId, version: row.version,
            createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
            metrics: config?.metrics ?? [],
            issues: config ? issuesOf(actor, config) : [UNREADABLE],
          });
        }
      }
      if (out.length >= query.limit) break;
    }
    if (keys.length < LIST_BATCH && last?.i === keys[keys.length - 1]!.id) exhausted = true;
    if (exhausted) break;
    after = last;
  }
  return { views: out, nextCursor: !exhausted && last ? encodeCursor(list, last) : null };
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
