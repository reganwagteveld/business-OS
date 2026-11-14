import 'server-only';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Status = 'active' | 'archived' | 'all';

export function statusFilter(status: Status): Record<string, unknown> {
  return status === 'active' ? { archivedAt: null } : status === 'archived' ? { archivedAt: { not: null } } : {};
}

/** Case-insensitive "contains" across the given text columns (ILIKE; wildcards in the input are escaped by Prisma). */
export function searchFilter(q: string | undefined, fields: string[]): Record<string, unknown> {
  const term = q?.trim();
  if (!term) return {};
  return { OR: fields.map((f) => ({ [f]: { contains: term, mode: 'insensitive' } })) };
}

/** Keyset position after (displayName, id) for name-ordered lists. */
export function afterName(list: 'customers' | 'contacts', cursor: string | undefined): Record<string, unknown> {
  const after = decodeCursor(cursor, list, ['n', 'i'] as const);
  if (!after) return {};
  if (!UUID.test(after.i)) invalidCursor();
  return { OR: [{ displayName: { gt: after.n } }, { displayName: after.n, id: { gt: after.i } }] };
}

export function page<T extends { displayName: string; id: string }>(list: 'customers' | 'contacts', rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(list, { n: last.displayName, i: last.id }) : null };
}

/** Field names that changed, for activity/audit metadata (values are not logged: they may be personal data). */
export function changedFields(before: Record<string, unknown>, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => patch[k] !== undefined && before[k] !== patch[k]).sort();
}
