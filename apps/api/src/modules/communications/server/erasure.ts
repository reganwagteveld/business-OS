import 'server-only';
// Communications E1 (docs/communications-e1.md): retention eligibility, legal holds and erasure. The
// application never removes content itself: it has no UPDATE or DELETE right on message history. Every
// destructive step is a call to a bos_maint function in app_private (prisma/privileged/004), which verifies
// its own authority in the database:
//   * high-risk operations (erasure requests, hold release, applying a reduction early) need the caller's
//     raw session token (a live OWNER/ADMIN membership, OWNER for the reduction) AND a single-use code the
//     same person obtained for exactly that operation and target within the last 5 minutes;
//   * the worker's steps can only continue a request created that way, or erase copies the database itself
//     computes as past their retention and not held.
// This module is the only caller of those functions (boundary rule erasure-functions-only-in-erasure-service).
import type {
  Erasure as ErasureDto, LegalHold as LegalHoldDto, PrivilegedOperation, RetentionEligibilityResponse,
} from '@business-os/contracts';
import { randomUUID } from 'node:crypto';
import type { AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { recordAudit } from '@/core/audit';
import { RecordNotFoundError, RuleViolationError, sqlState, StateConflictError } from '@/core/http/errors';
import { ForbiddenError } from '@/modules/access';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maps the privileged functions' refusals to the API's generic errors; anything else propagates. */
function mapPrivileged(error: unknown): never {
  const state = sqlState(error);
  if (state === '42501') throw new ForbiddenError();
  if (state === 'P0002') throw new RecordNotFoundError();
  if (state === '22023') throw new RuleViolationError('invalid_input', 'The request is not valid for this operation.');
  throw error;
}

// ---- single-use authorisations (D-E1-4) ------------------------------------------------------------------

export async function authorizeOperation(
  db: AppTenantDb, sessionToken: string, operation: PrivilegedOperation, targetId: string | null,
): Promise<{ operation: PrivilegedOperation; targetId: string | null; code: string; expiresAt: string }> {
  try {
    const rows = await db.$queryRaw<{ code: string; expires_at: Date }[]>`
      SELECT code, expires_at FROM app_private.communications_authorize(${sessionToken}, ${operation}, ${targetId}::uuid)`;
    return { operation, targetId, code: rows[0]!.code, expiresAt: rows[0]!.expires_at.toISOString() };
  } catch (error) {
    return mapPrivileged(error);
  }
}

// ---- erasure requests --------------------------------------------------------------------------------------

type ErasureRow = {
  id: string; kind: string; targetType: string | null; contactId: string | null; conversationId: string | null; messageId: string | null;
  reasonCode: string; status: string; deferredReason: string | null; requestedById: string | null; requestedAt: Date; nextAttemptAt: Date;
  attempts: number; lastErrorCode: string | null; completedAt: Date | null; messagesErased: number; participantsErased: number;
  activitiesErased: number; conversationsErased: number; reviewRequired: number; deferredCount: number;
};
const erasureSelect = {
  id: true, kind: true, targetType: true, contactId: true, conversationId: true, messageId: true, reasonCode: true, status: true, deferredReason: true,
  requestedById: true, requestedAt: true, nextAttemptAt: true, attempts: true, lastErrorCode: true, completedAt: true, messagesErased: true,
  participantsErased: true, activitiesErased: true, conversationsErased: true, reviewRequired: true, deferredCount: true,
} as const;

function toErasure(r: ErasureRow): ErasureDto {
  return {
    id: r.id, kind: r.kind as ErasureDto['kind'], targetType: r.targetType as ErasureDto['targetType'],
    targetId: r.contactId ?? r.conversationId ?? r.messageId, reasonCode: r.reasonCode as ErasureDto['reasonCode'], status: r.status as ErasureDto['status'],
    deferredReason: r.deferredReason as ErasureDto['deferredReason'], requestedById: r.requestedById, requestedAt: r.requestedAt.toISOString(),
    nextAttemptAt: r.status === 'COMPLETED' ? null : r.nextAttemptAt.toISOString(), attempts: r.attempts, lastErrorCode: r.lastErrorCode,
    completedAt: r.completedAt?.toISOString() ?? null,
    counts: {
      messages: r.messagesErased, participants: r.participantsErased, activities: r.activitiesErased, conversations: r.conversationsErased,
      reviewRequired: r.reviewRequired, deferred: r.deferredCount,
    },
  };
}

async function erasureRow(db: AppTenantDb, id: string): Promise<ErasureRow> {
  const row = (await db.communicationsErasure.findFirst({ where: { id }, select: erasureSelect })) as ErasureRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}

/**
 * Records an erasure request (idempotent per open target) and runs its first bounded step in the same unit
 * of work, so a small request is usually complete when this returns. Anything left is finished by the worker.
 */
export async function requestErasure(
  db: AppTenantDb,
  sessionToken: string,
  input: { targetType: 'CONTACT' | 'CONVERSATION' | 'MESSAGE'; targetId: string; reason: string; authorization: string },
): Promise<{ erasure: ErasureDto; created: boolean }> {
  let id: string;
  let created: boolean;
  try {
    const rows = await db.$queryRaw<{ erasure_id: string; created: boolean }[]>`
      SELECT erasure_id::text, created FROM app_private.communications_request_erasure(
        ${sessionToken}, ${input.authorization}, ${input.targetType}, ${input.targetId}::uuid, ${input.reason})`;
    id = rows[0]!.erasure_id;
    created = rows[0]!.created;
  } catch (error) {
    return mapPrivileged(error);
  }
  if (created) await stepErasure(db, id, FIRST_STEP_BATCH);
  return { erasure: toErasure(await erasureRow(db, id)), created };
}
/** Small, so the request's own unit of work stays well inside its time limit. */
const FIRST_STEP_BATCH = 50;

export async function getErasure(db: AppTenantDb, id: string): Promise<{ erasure: ErasureDto; reviewItems: { entityType: 'MESSAGE' | 'CONVERSATION'; entityId: string }[] }> {
  const erasure = toErasure(await erasureRow(db, id));
  const items = (await db.communicationsErasureItem.findMany({
    where: { erasureId: id, action: 'REVIEW_REQUIRED' }, select: { entityType: true, entityId: true }, orderBy: [{ entityType: 'asc' }, { entityId: 'asc' }], take: 500,
  })) as { entityType: 'MESSAGE' | 'CONVERSATION'; entityId: string }[];
  return { erasure, reviewItems: items };
}

/** Newest first (requested_at, id); keyset paging. */
export async function listErasures(
  db: AppTenantDb, query: { status?: string; kind?: string; cursor?: string; limit: number },
): Promise<{ erasures: ErasureDto[]; nextCursor: string | null }> {
  // The cursor is bound to the filters it was issued under (audit E1-02): replaying it with another status or
  // kind would silently skip rows, so a mismatch is refused (400 invalid_cursor). The page size may change.
  const filters = `${query.status ?? '*'}|${query.kind ?? '*'}`;
  const after = decodeCursor(query.cursor, 'erasures', ['t', 'i', 'f'] as const);
  if (after && after.f !== filters) invalidCursor();
  const and: Record<string, unknown>[] = [];
  if (query.status) and.push({ status: query.status });
  if (query.kind) and.push({ kind: query.kind });
  if (after) {
    const t = new Date(after.t);
    if (Number.isNaN(t.getTime()) || !UUID.test(after.i)) invalidCursor();
    and.push({ OR: [{ requestedAt: { lt: t } }, { requestedAt: t, id: { lt: after.i } }] });
  }
  const rows = (await db.communicationsErasure.findMany({
    where: { AND: and }, select: erasureSelect, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: query.limit + 1,
  })) as ErasureRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    erasures: page.map(toErasure),
    nextCursor: rows.length > query.limit && last ? encodeCursor('erasures', { t: last.requestedAt.toISOString(), i: last.id, f: filters }) : null,
  };
}

// ---- worker steps (no user; docs/communications-e1.md §7) -----------------------------------------------

export type StepOutcome = 'progress' | 'deferred' | 'completed' | 'busy';

/** One bounded, atomic step of a request. */
export async function stepErasure(db: AppTenantDb, id: string, batch: number): Promise<{ outcome: StepOutcome; processed: number }> {
  const rows = await db.$queryRaw<{ outcome: StepOutcome; processed: number }[]>`
    SELECT outcome, processed FROM app_private.communications_erasure_step(${id}::uuid, ${batch}::int)`;
  return { outcome: rows[0]!.outcome, processed: Number(rows[0]!.processed) };
}

/** Requests whose next attempt is due, oldest first. */
export async function dueErasureIds(db: AppTenantDb, limit: number): Promise<string[]> {
  const rows = (await db.communicationsErasure.findMany({
    where: { kind: 'REQUEST', status: { in: ['PENDING', 'DEFERRED'] }, nextAttemptAt: { lte: new Date() } },
    select: { id: true }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }], take: limit,
  })) as { id: string }[];
  return rows.map((r) => r.id);
}

/** Records a failed step (which rolled back whole) for retry with backoff. */
export async function recordErasureFailure(db: AppTenantDb, id: string, code: string): Promise<void> {
  await db.$queryRaw`SELECT 1 AS ok FROM app_private.communications_erasure_failed(${id}::uuid, ${code})`;
}

/** One retention purge batch; null when nothing was due. */
export async function purgeExpired(db: AppTenantDb, batch: number): Promise<{ erasureId: string; messages: number } | null> {
  const rows = await db.$queryRaw<{ erasure_id: string; messages: number }[]>`
    SELECT erasure_id::text, messages FROM app_private.communications_retention_purge(${batch}::int)`;
  return rows[0] ? { erasureId: rows[0].erasure_id, messages: Number(rows[0].messages) } : null;
}

export async function erasureHousekeeping(db: AppTenantDb, limit: number): Promise<number> {
  const rows = await db.$queryRaw<{ n: number }[]>`SELECT app_private.communications_erasure_housekeeping(${limit}::int) AS n`;
  return Number(rows[0]?.n ?? 0);
}

/** Which of these provider message ids were erased here (unexpired keyed markers, D-E1-2)? */
export async function erasedExternalIds(db: AppTenantDb, source: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<{ ids: string[] }[]>`
    SELECT app_private.communications_erased_matches('MESSAGE', ${source}, ${ids}::text[]) AS ids`;
  return new Set(rows[0]?.ids ?? []);
}

// ---- legal holds ---------------------------------------------------------------------------------------

type HoldRow = {
  id: string; scope: string; contactId: string | null; connectionId: string | null; reasonCode: string; placedById: string; placedAt: Date;
  releasedAt: Date | null; releasedById: string | null;
};
const holdSelect = {
  id: true, scope: true, contactId: true, connectionId: true, reasonCode: true, placedById: true, placedAt: true, releasedAt: true, releasedById: true,
} as const;
const toHold = (r: HoldRow): LegalHoldDto => ({
  id: r.id, scope: r.scope as LegalHoldDto['scope'], contactId: r.contactId, connectionId: r.connectionId, reasonCode: r.reasonCode as LegalHoldDto['reasonCode'],
  placedById: r.placedById, placedAt: r.placedAt.toISOString(), releasedAt: r.releasedAt?.toISOString() ?? null, releasedById: r.releasedById,
});

export async function listLegalHolds(db: AppTenantDb, includeReleased: boolean): Promise<LegalHoldDto[]> {
  const rows = (await db.communicationsLegalHold.findMany({
    where: includeReleased ? {} : { releasedAt: null }, select: holdSelect, orderBy: [{ placedAt: 'desc' }, { id: 'desc' }], take: 200,
  })) as HoldRow[];
  return rows.map(toHold);
}

/**
 * Places a hold (manage_connections). Idempotent: an active hold on the same target is returned. Placing waits
 * for any erasure step in progress in the business (hold lock, §9), so once this commits nothing it covers is
 * erased.
 */
export async function placeLegalHold(
  db: AppTenantDb, userId: string, input: { scope: 'BUSINESS' | 'CONTACT' | 'CONNECTION'; contactId?: string; connectionId?: string; reasonCode: string },
): Promise<{ hold: LegalHoldDto; created: boolean }> {
  if (input.contactId && !(await db.contact.findFirst({ where: { id: input.contactId }, select: { id: true } }))) throw new RecordNotFoundError();
  if (input.connectionId && !(await db.mailConnection.findFirst({ where: { id: input.connectionId }, select: { id: true } }))) throw new RecordNotFoundError();
  const where = { scope: input.scope, contactId: input.contactId ?? null, connectionId: input.connectionId ?? null, releasedAt: null };
  const existing = (await db.communicationsLegalHold.findFirst({ where, select: holdSelect })) as HoldRow | null;
  if (existing) return { hold: toHold(existing), created: false };
  const id = randomUUID();
  try {
    await db.communicationsLegalHold.create({
      data: { id, scope: input.scope, contactId: input.contactId ?? null, connectionId: input.connectionId ?? null, reasonCode: input.reasonCode, placedById: userId } as never,
    });
  } catch (error) {
    if (sqlState(error) === '23505') throw new StateConflictError('stale');
    throw error;
  }
  await recordAudit(db, userId, 'communications.legal_hold.placed', { type: 'legal_hold', id }, { scope: input.scope, reasonCode: input.reasonCode });
  return { hold: toHold((await db.communicationsLegalHold.findFirst({ where: { id }, select: holdSelect })) as HoldRow), created: true };
}

export async function releaseLegalHold(db: AppTenantDb, sessionToken: string, holdId: string, authorization: string): Promise<LegalHoldDto> {
  try {
    await db.$queryRaw`SELECT app_private.communications_release_legal_hold(${sessionToken}, ${authorization}, ${holdId}::uuid)`;
  } catch (error) {
    return mapPrivileged(error);
  }
  return toHold((await db.communicationsLegalHold.findFirst({ where: { id: holdId }, select: holdSelect })) as HoldRow);
}

// ---- retention -----------------------------------------------------------------------------------------

export async function applyRetentionReduction(db: AppTenantDb, sessionToken: string, authorization: string, reason: string): Promise<boolean> {
  try {
    const rows = await db.$queryRaw<{ applied: boolean }[]>`
      SELECT app_private.communications_apply_retention_reduction(${sessionToken}, ${authorization}, ${reason}) AS applied`;
    return rows[0]!.applied;
  } catch (error) {
    return mapPrivileged(error);
  }
}

/**
 * Counts per category, computed with the same database function the purge uses (mail_retention_due_at), so
 * what this reports as due is exactly what the next purge would erase. Unshared personal copies are not
 * counted here: their volume is not shown to administrators (docs/communications-e1.md §6).
 */
export async function retentionEligibility(db: AppTenantDb): Promise<RetentionEligibilityResponse['eligibility']> {
  const settings = (await db.mailRetentionSetting.findFirst({
    select: { ordinaryRetentionDays: true, previousRetentionDays: true, shorteningEffectiveAt: true },
  })) as { ordinaryRetentionDays: number; previousRetentionDays: number | null; shorteningEffectiveAt: Date | null } | null;
  const rows = await db.$queryRaw<{ category: string; live: bigint; due: bigint; held: bigint; next_due: Date | null; in_force: number | null; now: Date }[]>`
    WITH s AS (
      SELECT mail_effective_ordinary_days(r.ordinary_retention_days, r.previous_retention_days, r.shortening_effective_at) AS days
        FROM mail_retention_settings r
    ), c AS (
      SELECT m.id, m.retention_category AS category,
             mail_retention_due_at(m.retention_category, m.occurred_at, m.recorded_at, (SELECT days FROM s)) AS due_at,
             communications_message_held(m.business_id, m.id) AS held
        FROM messages m
       WHERE m.erased_at IS NULL AND m.retention_category IN ('ORDINARY', 'RETAINED_RECORD', 'STAGED_INTAKE')
    )
    SELECT k.category,
           count(c.id) AS live,
           count(c.id) FILTER (WHERE c.due_at <= now() AND NOT c.held) AS due,
           count(c.id) FILTER (WHERE c.held) AS held,
           min(c.due_at) FILTER (WHERE c.due_at > now() AND NOT c.held) AS next_due,
           (SELECT days FROM s) AS in_force, now() AS now
      FROM (VALUES ('ORDINARY'), ('RETAINED_RECORD'), ('STAGED_INTAKE')) AS k(category)
      LEFT JOIN c ON c.category = k.category
     GROUP BY k.category ORDER BY k.category`;
  const unclassified = await db.message.count({ where: { erasedAt: null, retentionCategory: null } });
  const inForce = rows[0]?.in_force ?? null;
  return {
    ordinaryRetentionDaysInForce: inForce,
    pendingReduction: settings?.previousRetentionDays != null && settings.shorteningEffectiveAt
      ? { previousDays: settings.previousRetentionDays, effectiveAt: settings.shorteningEffectiveAt.toISOString() } : null,
    unclassifiedLive: unclassified,
    categories: rows.map((r) => ({
      category: r.category as 'ORDINARY' | 'RETAINED_RECORD' | 'STAGED_INTAKE',
      live: Number(r.live), due: Number(r.due), held: Number(r.held), nextDueAt: r.next_due?.toISOString() ?? null,
      automaticExpiry: r.category === 'STAGED_INTAKE' || (r.category === 'ORDINARY' && inForce !== null),
    })),
    evaluatedAt: (rows[0]?.now ?? new Date()).toISOString(),
  };
}
