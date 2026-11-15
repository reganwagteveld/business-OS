import 'server-only';
// Errors a service may throw on purpose. The route wrappers turn each into one generic, stable
// response, so no service builds HTTP responses and no detail leaks (architecture §7.3).

/** The record does not exist in this business (or is not visible to it): always 404. */
export class RecordNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('not_found');
    this.name = 'RecordNotFoundError';
  }
}

export type StateConflictCode =
  | 'archived' | 'not_archived' | 'archived_reference' | 'not_open' | 'not_closed' | 'stale' | 'project_archived' | 'order_changed'
  // Finance (docs/finance-data-model.md §5): a document or setting is not in a state that allows the change.
  | 'invalid_state' | 'immutable' | 'invoice_not_open' | 'invoice_credited' | 'invoice_has_payments' | 'credit_exceeds_invoice'
  | 'series_in_use' | 'number_conflict' | 'idempotency_conflict' | 'quote_not_convertible' | 'totals_mismatch'
  // Finance F2: payments, allocations and credit applications.
  | 'payment_not_open' | 'credit_note_not_open' | 'over_allocation' | 'over_settlement' | 'over_application' | 'already_allocated'
  | 'already_applied' | 'already_reversed' | 'has_credit_applications'
  // Finance F3: expenses, categories, and payments made.
  | 'duplicate_name' | 'has_payments' | 'expense_not_open' | 'over_payment'
  // People (docs/people-data-model.md §4).
  | 'invalid_transition' | 'has_direct_reports' | 'manager_cycle' | 'in_use' | 'duplicate_employee_number' | 'user_already_linked' | 'terminated'
  | 'start_date_locked'
  // Scheduling S1: the default calendar cannot be archived; cancelled events are read-only.
  | 'default_calendar' | 'not_scheduled';

/** The request is well-formed but not allowed in the record's current state (e.g. editing an archived customer): 409. */
export class StateConflictError extends Error {
  readonly status = 409;
  constructor(readonly code: StateConflictCode) {
    super(code);
    this.name = 'StateConflictError';
  }
}

/** A business rule the contract schema cannot express was broken: 400 with a safe, human message. */
export class RuleViolationError extends Error {
  readonly status = 400;
  constructor(readonly code: string, readonly detail: string) {
    super(code);
    this.name = 'RuleViolationError';
  }
}

/**
 * The SQLSTATE of a database error, unwrapped from Prisma's driver-adapter error shapes (model
 * operations and raw queries report it in different places). Undefined for anything else.
 */
export function sqlState(error: unknown): string | undefined {
  const e = error as {
    code?: unknown; cause?: { originalCode?: unknown; code?: unknown };
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } };
  } | null;
  const candidates = [e?.meta?.driverAdapterError?.cause?.originalCode, e?.cause?.originalCode, e?.meta?.code, e?.cause?.code, e?.code];
  return candidates.find((c): c is string => typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c));
}

/** True for a unique violation on the named index or constraint (from Prisma's error metadata or message). */
export function isUniqueViolation(error: unknown, name: string): boolean {
  if (sqlState(error) !== '23505' && (error as { code?: string } | null)?.code !== 'P2002') return false;
  const text = `${error instanceof Error ? error.message : ''} ${JSON.stringify((error as { meta?: unknown } | null)?.meta ?? {})}`;
  return text.includes(name);
}
