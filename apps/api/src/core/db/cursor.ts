// Opaque keyset-pagination cursors (data-model §6: lists use keyset pagination, not OFFSET).
// The cursor only says where the previous page ended; it carries no authority, and the query it
// feeds still runs inside the tenant unit of work.
import { RuleViolationError } from '@/core/http/errors';

/** A cursor that was not issued by this list (tampered, truncated, or from another list): 400 invalid_cursor. */
export function invalidCursor(): never {
  throw new RuleViolationError('invalid_cursor', 'This page position is not valid. Start again from the first page.');
}

/** `list` names the list the cursor belongs to, so a cursor from one list is refused by another. */
export function encodeCursor(list: string, value: Record<string, string>): string {
  return Buffer.from(JSON.stringify({ k: list, ...value }), 'utf8').toString('base64url');
}

/**
 * Null when there is no cursor (first page). Anything malformed is rejected with invalid_cursor rather
 * than silently restarting from the first page, which a client would show as duplicated rows.
 */
export function decodeCursor<K extends string>(cursor: string | undefined, list: string, keys: readonly K[]): Record<K, string> | null {
  if (cursor === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return invalidCursor();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidCursor();
  const record = value as Record<string, unknown>;
  if (record.k !== list || Object.keys(record).length !== keys.length + 1) return invalidCursor();
  for (const key of keys) {
    const v = record[key];
    if (typeof v !== 'string' || v.length === 0 || v.length > 300) return invalidCursor();
  }
  return Object.fromEntries(keys.map((k) => [k, record[k] as string])) as Record<K, string>;
}
