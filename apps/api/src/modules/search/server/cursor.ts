// Keyset cursors for "Show more" in one type (docs/global-search-gs1.md §7.2; GS2 §5.7). Opaque to the
// client and bound to the business, type, normalised query and archived toggle they were issued for,
// with an HMAC so a changed position or binding is refused (400 invalid_cursor) rather than reused.
// A cursor carries no authority: the page still runs with the caller's own permissions and tenant.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SearchType } from '@business-os/contracts';
import { getEnv } from '@/core/config/env';
import { invalidCursor } from '@/core/db/cursor';
import type { SearchPosition } from '@/core/search';

export interface CursorBinding {
  businessId: string;
  type: SearchType;
  q: string;
  includeArchived: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(binding: CursorBinding, body: string): Buffer {
  return createHmac('sha256', getEnv().AUTH_SECRET)
    .update(JSON.stringify(['search-cursor-v1', binding.businessId, binding.type, binding.q, binding.includeArchived, body]))
    .digest();
}

export function encodeSearchCursor(binding: CursorBinding, position: SearchPosition): string {
  const body = JSON.stringify([position.tier, position.demote, position.sortKey, position.id]);
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${mac(binding, body).subarray(0, 16).toString('base64url')}`;
}

export function decodeSearchCursor(binding: CursorBinding, cursor: string): SearchPosition {
  const [encoded, signature, ...rest] = cursor.split('.');
  if (!encoded || !signature || rest.length > 0) return invalidCursor();
  const body = Buffer.from(encoded, 'base64url').toString('utf8');
  const expected = mac(binding, body).subarray(0, 16);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return invalidCursor();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return invalidCursor();
  }
  if (!Array.isArray(value) || value.length !== 4) return invalidCursor();
  const [tier, demote, sortKey, id] = value as unknown[];
  if (!Number.isInteger(tier) || !Number.isInteger(demote) || typeof sortKey !== 'string' || typeof id !== 'string' || !UUID.test(id)) return invalidCursor();
  return { tier: tier as number, demote: demote as number, sortKey, id };
}
