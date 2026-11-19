import 'server-only';
// People P3-C1 (docs/people-leave-p3c-ledger-architecture.md §C, §D, §H.1, §J.4, §L): the leave ledger core.
//
// Internal only. No route reaches this file in C1 and nothing calls it outside tests: there is no accrual
// engine (C2), no P3-B integration (C3) and no endpoint (C4/C5). It provides:
//   * postDerived: the one posting primitive for the derived transaction kinds the C1 stage gate accepts
//     (ACCRUAL, YEAR_OPEN, CONSUME, FREEZE, CARRY_PROPAGATION), with explicit hours from the caller;
//   * bucketTotals: balance and reserved sums per leave year, as of a date (sums of entries, D-P3C-10);
//   * takeSeal / transactionsBetweenSeals: the commit-aware seal primitive (§F.1a);
//   * verifyLedger: the read-only verifier checks V-01..V-07 (§J.4).
//
// The database is the authority: actor, business date, recorded time and xid, account version and
// sensitivity are set by the guards; kind/basis, signs, pairs, closing, lapse and lock rules are enforced
// there (migration 20261211000000_people_leave_ledger). This code only orders the statements correctly.
// Amounts of ACCRUAL and GRANT are trusted application input (D-P3C-32 option A): the engine that computes
// them is C2, and verifier V-08 (C2) is the blocking release gate that detects a wrong amount.
//
// No days↔hours assumption lives here (revised D-P3C-23): the hours are always explicit, and the database
// refuses any posting under a DAYS policy until the per-policy conversion basis exists.
import { createHash } from 'node:crypto';
import type { AppTenantDb } from '@/core/db';
import { joinSql, sql } from '@/core/db';

export const DERIVED_KINDS = ['ACCRUAL', 'YEAR_OPEN', 'CONSUME', 'FREEZE', 'CARRY_PROPAGATION'] as const;
export type DerivedKind = (typeof DERIVED_KINDS)[number];

const SOURCE_KIND: Record<DerivedKind, string> = {
  ACCRUAL: 'POLICY_ACCRUAL', YEAR_OPEN: 'YEAR_BOUNDARY', CONSUME: 'LEAVE_REQUEST', FREEZE: 'EMPLOYMENT', CARRY_PROPAGATION: 'TRANSACTION',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Signed hours with at most 4 decimals inside numeric(12,4); exact decimal strings, never floats. */
const HOURS = /^-?\d{1,8}(\.\d{1,4})?$/;

export type EntryKind =
  | 'GRANT' | 'ACCRUAL' | 'CARRY_OUT' | 'CARRY_IN' | 'EXPIRY' | 'CONSUMPTION' | 'RESERVATION' | 'RESERVATION_RELEASE' | 'REVERSAL'
  | 'ADJUSTMENT' | 'PAYOUT' | 'OPENING_BALANCE' | 'IMPORT' | 'WRITE_OFF';

export interface EntryInput {
  /** Caller-chosen id, so the two halves of a carry pair can cite each other in one statement. */
  id: string;
  bucketId: string;
  book: 'BALANCE' | 'RESERVED';
  kind: EntryKind;
  /** Exact decimal string, e.g. "12.6667" or "-5". */
  hours: string;
  appliesOn: string;
  leaveDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  policyId: string;
  policyVersion: number;
  reversesEntryId?: string | null;
  reservationEntryId?: string | null;
  pairEntryId?: string | null;
  releaseReason?: 'CONSUMED' | 'CANCELLED' | 'FROZEN' | null;
  expiryReason?: 'CARRY_CAP' | 'MAX_BALANCE' | 'MANUAL' | 'POLICY_EXPIRY' | null;
  /** May raise the computed sensitivity, never lower it (§C.6a). */
  sensitive?: boolean;
}

export type BucketChange =
  | { create: { id: string; servicePeriod: number; yearStart: string; yearEnd: string; state: 'FUTURE' | 'OPEN' } }
  | { bucketId: string; to: 'OPEN' | 'CLOSED' | 'FROZEN' };

export interface DerivedPosting {
  employeeId: string;
  leaveTypeId: string;
  kind: DerivedKind;
  /** The derived key (§D.3), e.g. `ac:{accountId}:{servicePeriod}:{periodStart}`. Checked by the database. */
  idempotencyKey: string | ((accountId: string) => string);
  relatedTransactionId?: string | null;
  sensitive?: boolean;
  /** Applied in order, after the transaction row and before the entries. */
  bucketChanges?: BucketChange[];
  entries: EntryInput[];
}

export type PostResult = { status: 'posted' | 'duplicate'; transactionId: string; accountId: string };

export class LedgerInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerInputError';
  }
}

/** A derived key that was already posted with a different kind, account or payload (never a silent duplicate). */
export class LedgerIdempotencyConflict extends LedgerInputError {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerIdempotencyConflict';
  }
}

function hours4(h: string): string {
  const neg = h.startsWith('-');
  const [int, frac = ''] = (neg ? h.slice(1) : h).split('.');
  return `${neg ? '-' : ''}${String(int).replace(/^0+(?=\d)/, '')}.${frac.padEnd(4, '0')}`;
}

const lower = (id: string | null | undefined) => (id == null ? null : id.toLowerCase());

/**
 * sha256 of the posting's canonical meaning, stored as the transaction's `request_hash` (required for derived
 * kinds by the database). Covers kind, employee, type, related transaction, the requested sensitivity, every
 * bucket change in order and every entry. Caller-chosen entry ids are replaced by meaning: an entry is its
 * fields, and a carry pair is the pair of its two halves' meanings, so the same pairing with new ids hashes the
 * same while a different pairing does not. Ids of persisted rows (years, cited entries, policies) stay as ids.
 */
export function payloadDigest(posting: DerivedPosting): string {
  const base = (e: EntryInput) => JSON.stringify([lower(e.bucketId), e.book, e.kind, hours4(e.hours), e.appliesOn, e.leaveDate ?? null,
    e.periodStart ?? null, e.periodEnd ?? null, lower(e.policyId), e.policyVersion, lower(e.reversesEntryId), lower(e.reservationEntryId),
    e.releaseReason ?? null, e.expiryReason ?? null, e.sensitive === true]);
  const byId = new Map(posting.entries.map((e) => [e.id.toLowerCase(), e]));
  const entries = posting.entries.map((e) => {
    if (e.pairEntryId == null) return [base(e), null];
    const partner = byId.get(e.pairEntryId.toLowerCase());
    return [base(e), partner ? base(partner) : `outside:${e.pairEntryId.toLowerCase()}`];
  }).map((x) => JSON.stringify(x)).sort();
  const changes = (posting.bucketChanges ?? []).map((c) => ('create' in c
    ? ['create', lower(c.create.id), c.create.servicePeriod, c.create.yearStart, c.create.yearEnd, c.create.state]
    : ['move', lower(c.bucketId), c.to]));
  const canonical = JSON.stringify({ v: 1, kind: posting.kind, employee: lower(posting.employeeId), type: lower(posting.leaveTypeId),
    related: lower(posting.relatedTransactionId), sensitive: posting.sensitive === true, changes, entries });
  return createHash('sha256').update(canonical).digest('hex');
}

function check(posting: DerivedPosting) {
  const fail = (m: string) => { throw new LedgerInputError(m); };
  if (!DERIVED_KINDS.includes(posting.kind)) fail(`not a derived kind: ${String(posting.kind)}`);
  if (!UUID.test(posting.employeeId) || !UUID.test(posting.leaveTypeId)) fail('employee and leave type are uuids');
  for (const e of posting.entries) {
    if (!UUID.test(e.id) || !UUID.test(e.bucketId) || !UUID.test(e.policyId)) fail('entry ids are uuids');
    if (!HOURS.test(e.hours) || Number(e.hours) === 0) fail(`hours must be a non-zero decimal with at most 4 places: ${e.hours}`);
    for (const d of [e.appliesOn, e.leaveDate, e.periodStart, e.periodEnd]) if (d != null && !DAY.test(d)) fail(`not a date: ${d}`);
    if (!Number.isInteger(e.policyVersion) || e.policyVersion < 1) fail('policy version is a positive integer');
  }
  for (const c of posting.bucketChanges ?? []) {
    if ('create' in c) {
      if (!UUID.test(c.create.id) || !DAY.test(c.create.yearStart) || !DAY.test(c.create.yearEnd)) fail('bucket id and dates');
    } else if (!UUID.test(c.bucketId)) fail('bucket id');
  }
}

/** The account of (employee, leave type), created lazily (§C.3). Returns its id. */
async function ensureAccount(db: AppTenantDb, employeeId: string, leaveTypeId: string): Promise<string> {
  // Two statements on purpose: under READ COMMITTED a concurrent creator makes the INSERT wait and then do
  // nothing, and only a new statement (new snapshot) sees the row it committed.
  await db.$queryRaw`
    INSERT INTO people_leave_accounts (id, business_id, employee_id, leave_type_id)
    VALUES (gen_random_uuid(), nullif(current_setting('app.business_id', true), '')::uuid, ${employeeId}::uuid, ${leaveTypeId}::uuid)
    ON CONFLICT (business_id, employee_id, leave_type_id) DO NOTHING
    RETURNING id`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM people_leave_accounts WHERE employee_id = ${employeeId}::uuid AND leave_type_id = ${leaveTypeId}::uuid`;
  const id = rows[0]?.id;
  if (!id) throw new LedgerInputError('leave account not visible');
  return id;
}

/**
 * Posts one derived ledger transaction inside the caller's unit of work, all or nothing (§D.2, §I.4):
 * lock the account (FOR UPDATE), return the existing transaction if the key was already posted, else bump
 * the account version, insert the transaction, apply bucket changes, insert every entry in one statement.
 * The deferred invariants run at the caller's COMMIT. Concurrent posters of one account queue on its row.
 */
export async function postDerived(db: AppTenantDb, posting: DerivedPosting): Promise<PostResult> {
  check(posting);
  const accountId = await ensureAccount(db, posting.employeeId, posting.leaveTypeId);
  await db.$queryRaw`SELECT id FROM people_leave_accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
  const key = typeof posting.idempotencyKey === 'function' ? posting.idempotencyKey(accountId) : posting.idempotencyKey;
  const digest = payloadDigest(posting);
  const existing = await db.$queryRaw<{ id: string; kind: string; account_id: string; request_hash: string | null }[]>`
    SELECT id::text, kind, account_id::text, request_hash FROM people_leave_transactions WHERE idempotency_key = ${key}`;
  if (existing[0]) {
    if (existing[0].kind !== posting.kind || existing[0].account_id !== accountId) throw new LedgerIdempotencyConflict('idempotency key belongs to another posting');
    // A retry is a duplicate only if it says exactly the same thing (same canonical payload digest). Anything
    // else under a posted key is a caller bug and must not be silently swallowed; a row without a digest cannot
    // be proven equal, so it fails closed too.
    if (existing[0].request_hash !== digest) throw new LedgerIdempotencyConflict('idempotency key already posted with a different payload');
    return { status: 'duplicate', transactionId: existing[0].id, accountId };
  }
  await db.$queryRaw`UPDATE people_leave_accounts SET version = version + 1 WHERE id = ${accountId}::uuid RETURNING version`;
  const tx = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO people_leave_transactions
      (id, business_id, account_id, employee_id, leave_type_id, kind, idempotency_key, request_hash, source_kind, related_transaction_id,
       actor_user_id, actor_basis, posted_on, account_version, sensitive)
    VALUES (gen_random_uuid(), nullif(current_setting('app.business_id', true), '')::uuid, ${accountId}::uuid, ${posting.employeeId}::uuid,
            ${posting.leaveTypeId}::uuid, ${posting.kind}, ${key}, ${digest}, ${SOURCE_KIND[posting.kind]}, ${posting.relatedTransactionId ?? null}::uuid,
            '00000000-0000-0000-0000-000000000000'::uuid, 'DERIVED', CURRENT_DATE, 0, ${posting.sensitive ?? false})
    RETURNING id::text`;
  const transactionId = tx[0]!.id;
  for (const change of posting.bucketChanges ?? []) {
    if ('create' in change) {
      const b = change.create;
      await db.$queryRaw`
        INSERT INTO people_leave_buckets (id, business_id, account_id, employee_id, leave_type_id, service_period, year_start, year_end, state)
        VALUES (${b.id}::uuid, nullif(current_setting('app.business_id', true), '')::uuid, ${accountId}::uuid, ${posting.employeeId}::uuid,
                ${posting.leaveTypeId}::uuid, ${b.servicePeriod}::int, ${b.yearStart}::date, ${b.yearEnd}::date, ${b.state})`;
    } else {
      const moved = await db.$queryRaw<{ id: string }[]>`
        UPDATE people_leave_buckets SET state = ${change.to}, version = version + 1
         WHERE id = ${change.bucketId}::uuid AND account_id = ${accountId}::uuid RETURNING id::text`;
      if (moved.length !== 1) throw new LedgerInputError('leave year not found on this account');
    }
  }
  if (posting.entries.length > 0) {
    const rows = posting.entries.map((e) => sql`(
      ${e.id}::uuid, nullif(current_setting('app.business_id', true), '')::uuid, ${transactionId}::uuid, ${accountId}::uuid, ${e.bucketId}::uuid,
      ${posting.employeeId}::uuid, ${posting.leaveTypeId}::uuid, ${e.book}, ${e.kind}, ${e.hours}::numeric, ${e.appliesOn}::date,
      ${e.leaveDate ?? null}::date, ${e.periodStart ?? null}::date, ${e.periodEnd ?? null}::date, ${e.policyId}::uuid, ${e.policyVersion}::int,
      ${e.reversesEntryId ?? null}::uuid, ${e.reservationEntryId ?? null}::uuid, ${e.pairEntryId ?? null}::uuid,
      ${e.releaseReason ?? null}, ${e.expiryReason ?? null}, ${e.sensitive ?? false})`);
    await db.$queryRaw`
      INSERT INTO people_leave_entries
        (id, business_id, transaction_id, account_id, bucket_id, employee_id, leave_type_id, book, kind, hours, applies_on, leave_date,
         period_start, period_end, policy_id, policy_version, reverses_entry_id, reservation_entry_id, pair_entry_id, release_reason,
         expiry_reason, sensitive)
      VALUES ${joinSql(rows)}
      RETURNING id`;
  }
  return { status: 'posted', transactionId, accountId };
}

export interface BucketTotal {
  bucketId: string;
  servicePeriod: number;
  yearStart: string;
  yearEnd: string;
  state: string;
  /** Σ BALANCE entries with applies_on ≤ asOf (§F.2 B). */
  balance: string;
  /** Σ RESERVED entries with applies_on ≤ asOf (§F.2 Rv). */
  reserved: string;
  /** balance − reserved (§F.2 Av). */
  available: string;
}

/** Posted balance per leave year of one account, as of a business date (default: the business's today). */
export async function bucketTotals(db: AppTenantDb, employeeId: string, leaveTypeId: string, asOf?: string): Promise<BucketTotal[]> {
  if (asOf !== undefined && !DAY.test(asOf)) throw new LedgerInputError('asOf is a date');
  const rows = await db.$queryRaw<{ id: string; service_period: number; year_start: string; year_end: string; state: string; balance: string; reserved: string; available: string }[]>`
    SELECT b.id::text, b.service_period, b.year_start::text, b.year_end::text, b.state,
           coalesce(sum(e.hours) FILTER (WHERE e.book = 'BALANCE'), 0.0000::numeric(12,4))::text AS balance,
           coalesce(sum(e.hours) FILTER (WHERE e.book = 'RESERVED'), 0.0000::numeric(12,4))::text AS reserved,
           (coalesce(sum(e.hours) FILTER (WHERE e.book = 'BALANCE'), 0.0000::numeric(12,4)) - coalesce(sum(e.hours) FILTER (WHERE e.book = 'RESERVED'), 0.0000::numeric(12,4)))::text AS available
      FROM people_leave_buckets b
      LEFT JOIN people_leave_entries e
        ON e.business_id = b.business_id AND e.bucket_id = b.id
       AND e.applies_on <= coalesce(${asOf ?? null}::date, people_leave_business_today())
     WHERE b.employee_id = ${employeeId}::uuid AND b.leave_type_id = ${leaveTypeId}::uuid
     GROUP BY b.id
     ORDER BY b.service_period, b.year_start`;
  return rows.map((r) => ({
    bucketId: r.id, servicePeriod: r.service_period, yearStart: r.year_start, yearEnd: r.year_end, state: r.state,
    balance: r.balance, reserved: r.reserved, available: r.available,
  }));
}

/**
 * Seal primitive (§F.1a, T-C63): a stored pg_snapshot taken inside the caller's read transaction. A ledger
 * transaction is "in" a seal when its recorded_xid is visible to that snapshot, which is commit-aware: a
 * transaction in flight when the seal is taken is absent from it and present in the next one, never twice.
 */
export async function takeSeal(db: AppTenantDb): Promise<string> {
  const rows = await db.$queryRaw<{ snapshot: string }[]>`SELECT pg_current_snapshot()::text AS snapshot`;
  return rows[0]!.snapshot;
}

const SNAPSHOT = /^\d+:\d+:(\d+(,\d+)*)?$/;

/** Ledger transactions included in `next` and not in `previous` (null = from the beginning). */
export async function transactionsBetweenSeals(db: AppTenantDb, previous: string | null, next: string): Promise<string[]> {
  if (!SNAPSHOT.test(next) || (previous !== null && !SNAPSHOT.test(previous))) throw new LedgerInputError('not a snapshot');
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id::text FROM people_leave_transactions
     WHERE pg_visible_in_snapshot(recorded_xid, ${next}::pg_snapshot)
       AND (${previous}::pg_snapshot IS NULL OR NOT pg_visible_in_snapshot(recorded_xid, ${previous}::pg_snapshot))
     ORDER BY id`;
  return rows.map((r) => r.id);
}

export type VerifierCheck = 'V-01' | 'V-02' | 'V-03' | 'V-04' | 'V-05' | 'V-06' | 'V-07';
export interface VerifierFinding { check: VerifierCheck; id: string }

/**
 * Read-only consistency checks V-01..V-07 (§J.4) over every ledger row the caller can read. The database
 * already prevents each of these at write time; the verifier detects rows that got past it (a disabled
 * trigger, a restore, a manual repair). V-08 (engine replay) arrives with the C2 engine; V-09/V-10 with C3.
 */
export async function verifyLedger(db: AppTenantDb): Promise<VerifierFinding[]> {
  const rows = await db.$queryRaw<{ check: VerifierCheck; id: string }[]>`
    -- V-01: reserved never negative per year; one release and one consumption per reservation; a
    -- consumption always has its release for consumption.
    SELECT 'V-01' AS check, e.bucket_id::text AS id FROM people_leave_entries e
     WHERE e.book = 'RESERVED' GROUP BY e.bucket_id HAVING sum(e.hours) < 0
    UNION ALL
    SELECT 'V-01', r.id::text FROM people_leave_entries r
     WHERE r.kind = 'RESERVATION'
       AND ((SELECT count(*) FROM people_leave_entries s WHERE s.reservation_entry_id = r.id AND s.kind = 'RESERVATION_RELEASE') > 1
         OR (SELECT count(*) FROM people_leave_entries s WHERE s.reservation_entry_id = r.id AND s.kind = 'CONSUMPTION') > 1
         OR (EXISTS (SELECT 1 FROM people_leave_entries s WHERE s.reservation_entry_id = r.id AND s.kind = 'CONSUMPTION')
             AND NOT EXISTS (SELECT 1 FROM people_leave_entries s WHERE s.reservation_entry_id = r.id AND s.release_reason = 'CONSUMED')))
    UNION ALL
    -- V-02: a closed year sums to zero in both books.
    SELECT 'V-02', b.id::text FROM people_leave_buckets b
      LEFT JOIN people_leave_entries e ON e.bucket_id = b.id
     WHERE b.state = 'CLOSED' GROUP BY b.id
    HAVING coalesce(sum(e.hours) FILTER (WHERE e.book = 'BALANCE'), 0) <> 0 OR coalesce(sum(e.hours) FILTER (WHERE e.book = 'RESERVED'), 0) <> 0
    UNION ALL
    -- V-03: at most one OPEN year per account and service period; years do not overlap.
    SELECT 'V-03', b.id::text FROM people_leave_buckets b
     WHERE EXISTS (SELECT 1 FROM people_leave_buckets o WHERE o.account_id = b.account_id AND o.service_period = b.service_period AND o.id <> b.id
                     AND ((o.state = 'OPEN' AND b.state = 'OPEN') OR daterange(o.year_start, o.year_end) && daterange(b.year_start, b.year_end)))
    UNION ALL
    -- V-04: reversals mirror their originals.
    SELECT 'V-04', r.id::text FROM people_leave_entries r JOIN people_leave_entries o ON o.id = r.reverses_entry_id
     WHERE r.hours <> -o.hours OR r.bucket_id <> o.bucket_id OR r.book <> o.book OR r.leave_date IS DISTINCT FROM o.leave_date
    UNION ALL
    -- V-05: dated reservation entries lie inside their year.
    SELECT 'V-05', e.id::text FROM people_leave_entries e JOIN people_leave_buckets b ON b.id = e.bucket_id
     WHERE e.leave_date IS NOT NULL AND NOT (e.leave_date >= b.year_start AND e.leave_date < b.year_end)
    UNION ALL
    -- V-06: account version − 1 = number of its transactions.
    SELECT 'V-06', a.id::text FROM people_leave_accounts a
     WHERE a.version - 1 <> (SELECT count(*) FROM people_leave_transactions t WHERE t.account_id = a.id)
    UNION ALL
    -- V-07: every transaction has an entry (a FREEZE may change year states only); manual kinds carry a reason.
    SELECT 'V-07', t.id::text FROM people_leave_transactions t
     WHERE (t.kind <> 'FREEZE' AND NOT EXISTS (SELECT 1 FROM people_leave_entries e WHERE e.transaction_id = t.id))
        OR (t.kind IN ('OPENING_BALANCE', 'IMPORT', 'ADJUSTMENT', 'CORRECTION', 'EXPIRY', 'PAYOUT', 'REVERSE_CONSUMPTION') AND t.reason_code IS NULL)
    ORDER BY 1, 2`;
  return rows.map((r) => ({ check: r.check, id: r.id }));
}
