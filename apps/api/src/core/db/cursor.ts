// Opaque keyset-pagination cursors (data-model §6: lists use keyset pagination, not OFFSET).
// The cursor only says where the previous page ended; it carries no authority, and the query it
// feeds still runs inside the tenant unit of work.

export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Returns null for anything malformed, so a tampered cursor just restarts from the first page. */
export function decodeCursor<K extends string>(cursor: string | undefined, keys: readonly K[]): Record<K, string> | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!value || typeof value !== 'object') return null;
    for (const key of keys) if (typeof value[key] !== 'string' || (value[key] as string).length > 300) return null;
    return Object.fromEntries(keys.map((k) => [k, value[k] as string])) as Record<K, string>;
  } catch {
    return null;
  }
}
