import 'server-only';
// Read side of the audit log (A-AUD-1, docs/administration-audit-viewer.md). One tenant read through the
// caller's own unit of work: RLS (audit_tenant_read) limits it to this business, the route requires
// audit:read, and everything returned passes through the view rules (default-deny metadata and targets).
// Nothing here writes, and the viewer never selects ip_address or user_agent.
import type { AuditEventView, ListAuditEventsQuery, ListAuditEventsResponse } from '@business-os/contracts';
import { emptySql, sql, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RuleViolationError } from '@/core/http/errors';
import { MAX_WINDOW_MS, prefixLikePattern, resolveRule, resolveWindow, sanitizeMetadata, viewTarget } from './view-rules';

const LIST = 'audit-events';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MICRO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

type Row = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: unknown;
};

const filterKey = (q: ListAuditEventsQuery) => `${q.actionPrefix ?? ''}|${q.actorUserId ?? ''}|${q.actorKind ?? ''}`;

/** The window a cursor was issued for, which a follow-up request can only repeat or leave out. */
function windowFor(query: ListAuditEventsQuery, cursor: Record<'t' | 'i' | 'f' | 'a' | 'b', string> | null, now: Date) {
  if (cursor) {
    if (cursor.f !== filterKey(query) || !MICRO_INSTANT.test(cursor.t) || !UUID.test(cursor.i)) return invalidCursor();
    const from = new Date(cursor.a);
    const to = new Date(cursor.b);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return invalidCursor();
    // A cursor is data the client holds, so it is held to the rules of a first-page request: ordered bounds, at
    // most 92 days, and a position inside them. Anything else is refused, never widened.
    const at = Date.parse(cursor.t);
    if (to.getTime() < from.getTime() || to.getTime() - from.getTime() > MAX_WINDOW_MS || at < from.getTime() || at > to.getTime() + 1) return invalidCursor();
    if ((query.from !== undefined && Date.parse(query.from) !== from.getTime()) || (query.to !== undefined && Date.parse(query.to) !== to.getTime())) return invalidCursor();
    return { from, to };
  }
  const window = resolveWindow(query, now);
  if (!window) throw new RuleViolationError('invalid_window', 'The start of the period is in the future.');
  return window;
}

export async function listAuditEvents(db: AppTenantDb, query: ListAuditEventsQuery, now: Date = new Date()): Promise<ListAuditEventsResponse> {
  const cursor = decodeCursor(query.cursor, LIST, ['t', 'i', 'f', 'a', 'b'] as const);
  const window = windowFor(query, cursor, now);
  const bounds = { from: window.from.toISOString(), to: window.to.toISOString() };

  // A filter by a person who is not a current member is the same empty page as an unused id (D-AUD-9).
  if (query.actorUserId !== undefined) {
    const member = await db.membership.findFirst({ where: { userId: query.actorUserId }, select: { id: true } });
    if (!member) return { events: [], nextCursor: null, window: bounds };
  }

  const where = [
    sql`business_id = nullif(current_setting('app.business_id', true), '')::uuid`,
    sql`created_at >= ${bounds.from}::timestamptz`,
    sql`created_at <= ${bounds.to}::timestamptz`,
    query.actionPrefix !== undefined ? sql`(action = ${query.actionPrefix} OR action LIKE ${prefixLikePattern(query.actionPrefix)} ESCAPE '\\')` : emptySql,
    query.actorUserId !== undefined ? sql`actor_user_id = ${query.actorUserId}::uuid` : emptySql,
    query.actorKind === 'system' ? sql`actor_user_id IS NULL` : emptySql,
    cursor ? sql`(created_at, id) < (${cursor.t}::timestamptz, ${cursor.i}::uuid)` : emptySql,
  ].filter((fragment) => fragment !== emptySql);
  const condition = where.reduce((all, part, index) => (index === 0 ? part : sql`${all} AND ${part}`));

  const rows = await db.$queryRaw<Row[]>(sql`
    SELECT id::text AS id,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           actor_user_id::text AS actor_user_id, action, target_type, target_id::text AS target_id, metadata
      FROM audit_events
     WHERE ${condition}
     ORDER BY created_at DESC, id DESC
     LIMIT ${query.limit + 1}`);

  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  const nextCursor = rows.length > query.limit && last
    ? encodeCursor(LIST, { t: last.created_at, i: last.id, f: filterKey(query), a: bounds.from, b: bounds.to })
    : null;

  // Names of current members only (actors, and the member a membership event is about). Anyone else is
  // a former member: no id, no name.
  const actorIds = [...new Set(items.flatMap((row) => (row.actor_user_id ? [row.actor_user_id] : [])))];
  const memberTargetIds = [...new Set(items.flatMap((row) => (row.target_type === 'membership' && row.target_id && resolveRule(row.action).target === 'show' ? [row.target_id] : [])))];
  const actors = actorIds.length > 0 ? await db.membership.findMany({ where: { userId: { in: actorIds } }, select: { userId: true, user: { select: { name: true } } } }) : [];
  const targets = memberTargetIds.length > 0 ? await db.membership.findMany({ where: { id: { in: memberTargetIds } }, select: { id: true, user: { select: { name: true } } } }) : [];
  const actorNames = new Map(actors.map((m) => [m.userId as string, (m.user as { name: string }).name]));
  const targetNames = new Map(targets.map((m) => [m.id as string, (m.user as { name: string }).name]));

  const events: AuditEventView[] = items.map((row) => {
    const rule = resolveRule(row.action);
    const target = viewTarget(rule, row.target_type, row.target_id);
    const name = target?.id ? targetNames.get(target.id) : undefined;
    const actorName = row.actor_user_id ? actorNames.get(row.actor_user_id) : undefined;
    return {
      id: row.id,
      createdAt: row.created_at,
      action: row.action.slice(0, 80),
      label: rule.label,
      group: rule.group,
      actor: row.actor_user_id === null
        ? { kind: 'system' }
        : actorName !== undefined ? { kind: 'member', userId: row.actor_user_id, name: actorName.slice(0, 200) } : { kind: 'former_member' },
      target: target ? { ...target, ...(name !== undefined ? { name: name.slice(0, 200) } : {}) } : null,
      metadata: rule.unknown ? {} : sanitizeMetadata(row.metadata, rule.keys),
    };
  });
  return { events, nextCursor, window: bounds };
}
