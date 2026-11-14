import 'server-only';
// Shared by the finance services (docs/finance-data-model.md).
import { createHash } from 'node:crypto';
import type { AppTenantDb } from '@/core/db';
import { RuleViolationError } from '@/core/http/errors';

export type Kind = 'QUOTE' | 'INVOICE' | 'CREDIT_NOTE';
export type Status = 'DRAFT' | 'ISSUED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'VOID';

/** Every change bumps the version, so an edit based on an older version can be detected. */
export const BUMP = { version: { increment: 1 } };

export const dateOf = (v: string) => new Date(`${v}T00:00:00Z`);
export const dayOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
export const addDays = (day: string, days: number) => dayOf(new Date(dateOf(day).getTime() + days * 86_400_000))!;

/** Today's calendar date in the business's time zone (documents are dated in the business's zone). */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export async function businessProfile(db: AppTenantDb) {
  return db.business.findFirstOrThrow({ select: { name: true, legalName: true, countryCode: true, timeZone: true, currency: true } });
}

/** Field names whose value differs between a row and the update about to be written (sorted). */
export const changedFields = (before: Record<string, unknown>, data: Record<string, unknown>) =>
  Object.keys(data).filter((k) => {
    const a = before[k];
    const b = data[k];
    if (a instanceof Date || b instanceof Date) return (a as Date | null)?.getTime() !== (b as Date | null)?.getTime();
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) !== JSON.stringify(b); // Decimal, arrays, jsonb
    return a !== b;
  }).sort();

/**
 * Locks finance documents FOR NO KEY UPDATE in id order: the first step of every unit of work that
 * changes a document (ADR 0007 lock order: payments → documents → lines → series). NO KEY UPDATE, not
 * UPDATE, so concurrent FK checks (FOR KEY SHARE) on the same rows do not wait. Tagged $queryRaw on
 * the tenant client: same transaction, bos_app, forced RLS, plus an explicit business_id predicate.
 * Returns the ids it locked (rows of another business are invisible and so never locked).
 */
export async function lockDocuments(db: AppTenantDb, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM finance_documents
    WHERE id = ANY(${ids}::uuid[]) AND business_id = nullif(current_setting('app.business_id', true), '')::uuid
    ORDER BY id FOR NO KEY UPDATE`;
  return rows.map((r) => r.id);
}

/** Serialises requests that share an idempotency key in this business (transaction-scoped advisory lock). */
export async function lockIdempotencyKey(db: AppTenantDb, key: string) {
  await db.$queryRaw<{ locked: number }[]>`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(
      'finance.idempotency:' || current_setting('app.business_id', true) || ':' || ${key}::text, 0))) AS l`;
}

/** Canonical hash of a request body, so a repeated key with a different request is detected. */
export function requestHash(operation: string, input: unknown): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
    return v;
  };
  return createHash('sha256').update(JSON.stringify([operation, canonical(input ?? null)])).digest('hex');
}

const KEY = /^[\x21-\x7e]{1,200}$/;
/** The optional Idempotency-Key header of a create request: 1–200 visible ASCII characters. */
export function idempotencyKeyOf(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  if (key === null) return null;
  if (!KEY.test(key)) throw new RuleViolationError('invalid_idempotency_key', 'An Idempotency-Key is 1 to 200 visible ASCII characters.');
  return key;
}
