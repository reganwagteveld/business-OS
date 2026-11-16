// Communications E1 (docs/communications-e1.md §8): retention eligibility, legal holds, erasure requests and
// the single-use authorisations that high-risk operations need. Responses carry ids, codes, dates and counts
// only: never message content, addresses, provider identifiers or authorisation secrets other than the one
// code returned to the person who asked for it.
import { z } from 'zod';

const Uuid = z.string().uuid();
const Iso = z.string().datetime();
const Cursor = z.string().min(1).max(512).optional();
const Limit = z.coerce.number().int().min(1).max(100).default(25);
/** A single-use authorisation code (64 hex characters), valid 5 minutes, for one operation on one target. */
const AuthorizationCode = z.string().regex(/^[0-9a-f]{64}$/);

export const PrivilegedOperation = z.enum(['ERASE_CONTACT', 'ERASE_CONVERSATION', 'ERASE_MESSAGE', 'RELEASE_LEGAL_HOLD', 'APPLY_RETENTION_REDUCTION']);
export type PrivilegedOperation = z.infer<typeof PrivilegedOperation>;
/** targetId: required for every operation except APPLY_RETENTION_REDUCTION (which has none). */
export const CreatePrivilegedAuthorizationRequest = z
  .object({ operation: PrivilegedOperation, targetId: Uuid.nullable() })
  .strict()
  .refine((v) => (v.operation === 'APPLY_RETENTION_REDUCTION') === (v.targetId === null), 'targetId is required for this operation (and only for it)');
export const PrivilegedAuthorizationResponse = z
  .object({ authorization: z.object({ operation: PrivilegedOperation, targetId: Uuid.nullable(), code: AuthorizationCode, expiresAt: Iso }).strict() })
  .strict();

// ---- retention eligibility ----------------------------------------------------------------------------
export const RetentionCategory = z.enum(['ORDINARY', 'RETAINED_RECORD', 'STAGED_INTAKE']);
export const RetentionCategorySummary = z
  .object({
    category: RetentionCategory,
    /** Stored, unerased copies in this category. */
    live: z.number().int().min(0),
    /** Past their expiry and not held: the next purge would erase them. */
    due: z.number().int().min(0),
    /** Past or before expiry but under a legal hold. */
    held: z.number().int().min(0),
    /** Null when the category has no automatic expiry (no period set, or no decided duration). */
    nextDueAt: Iso.nullable(),
    automaticExpiry: z.boolean(),
  })
  .strict();
export const RetentionEligibilityResponse = z
  .object({
    eligibility: z
      .object({
        ordinaryRetentionDaysInForce: z.number().int().nullable(),
        pendingReduction: z.object({ previousDays: z.number().int(), effectiveAt: Iso }).strict().nullable(),
        /** Manual and imported C1 history (no category): never automatically eligible (D-E1-1). */
        unclassifiedLive: z.number().int().min(0),
        categories: z.array(RetentionCategorySummary),
        evaluatedAt: Iso,
      })
      .strict(),
  })
  .strict();
export type RetentionEligibilityResponse = z.infer<typeof RetentionEligibilityResponse>;
export const ApplyRetentionReductionRequest = z
  .object({ authorization: AuthorizationCode, reason: z.enum(['LEGAL_OBLIGATION', 'DATA_MINIMISATION', 'OTHER']) })
  .strict();
export const ApplyRetentionReductionResponse = z.object({ applied: z.boolean() }).strict();

// ---- legal holds ----------------------------------------------------------------------------------------
export const LegalHoldScope = z.enum(['BUSINESS', 'CONTACT', 'CONNECTION']);
export const LegalHoldReason = z.enum(['LITIGATION', 'REGULATORY', 'INVESTIGATION', 'OTHER']);
export const LegalHold = z
  .object({
    id: Uuid, scope: LegalHoldScope, contactId: Uuid.nullable(), connectionId: Uuid.nullable(), reasonCode: LegalHoldReason,
    placedById: Uuid, placedAt: Iso, releasedAt: Iso.nullable(), releasedById: Uuid.nullable(),
  })
  .strict();
export type LegalHold = z.infer<typeof LegalHold>;
export const PlaceLegalHoldRequest = z
  .object({ scope: LegalHoldScope, contactId: Uuid.optional(), connectionId: Uuid.optional(), reasonCode: LegalHoldReason })
  .strict()
  .refine(
    (v) => (v.scope === 'BUSINESS' && !v.contactId && !v.connectionId) || (v.scope === 'CONTACT' && !!v.contactId && !v.connectionId)
      || (v.scope === 'CONNECTION' && !!v.connectionId && !v.contactId),
    'Name exactly the target the scope needs',
  );
export const ListLegalHoldsQuery = z.object({ includeReleased: z.enum(['true', 'false']).optional() }).strict();
export const LegalHoldResponse = z.object({ hold: LegalHold }).strict();
export const ListLegalHoldsResponse = z.object({ holds: z.array(LegalHold) }).strict();
export const ReleaseLegalHoldRequest = z.object({ authorization: AuthorizationCode }).strict();

// ---- erasure requests -----------------------------------------------------------------------------------
export const ErasureTargetType = z.enum(['CONTACT', 'CONVERSATION', 'MESSAGE']);
export const ErasureReason = z.enum(['DATA_SUBJECT_REQUEST', 'BUSINESS_REQUEST', 'LEGAL_OBLIGATION']);
export const Erasure = z
  .object({
    id: Uuid,
    kind: z.enum(['REQUEST', 'RETENTION']),
    targetType: ErasureTargetType.nullable(),
    targetId: Uuid.nullable(),
    reasonCode: z.enum(['DATA_SUBJECT_REQUEST', 'BUSINESS_REQUEST', 'LEGAL_OBLIGATION', 'RETENTION_EXPIRED']),
    status: z.enum(['PENDING', 'DEFERRED', 'COMPLETED']),
    deferredReason: z.enum(['LEGAL_HOLD', 'RETAINED_RECORD']).nullable(),
    requestedById: Uuid.nullable(),
    requestedAt: Iso,
    nextAttemptAt: Iso.nullable(),
    attempts: z.number().int().min(0),
    lastErrorCode: z.string().nullable(),
    completedAt: Iso.nullable(),
    counts: z
      .object({
        messages: z.number().int().min(0), participants: z.number().int().min(0), activities: z.number().int().min(0),
        conversations: z.number().int().min(0), reviewRequired: z.number().int().min(0), deferred: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type Erasure = z.infer<typeof Erasure>;
export const RequestErasureRequest = z
  .object({ targetType: ErasureTargetType, targetId: Uuid, reason: ErasureReason, authorization: AuthorizationCode })
  .strict();
export const ErasureResponse = z.object({ erasure: Erasure }).strict();
/** Detail: what still needs a person (quoted text in kept messages, shared conversations), as ids only. */
export const ErasureDetailResponse = z
  .object({
    erasure: Erasure,
    reviewItems: z.array(z.object({ entityType: z.enum(['MESSAGE', 'CONVERSATION']), entityId: Uuid }).strict()),
  })
  .strict();
export const ListErasuresQuery = z
  .object({ status: z.enum(['PENDING', 'DEFERRED', 'COMPLETED']).optional(), kind: z.enum(['REQUEST', 'RETENTION']).optional(), cursor: Cursor, limit: Limit })
  .strict();
export const ListErasuresResponse = z.object({ erasures: z.array(Erasure), nextCursor: z.string().nullable() }).strict();
