import 'server-only';
// The integration boundary between Finance reminders (F6-3) and Communications C2-C outbound sending
// (docs/finance-billing-f6.md §10.5, D-F6-8). Finance decides WHETHER and WHAT to remind; C2-C decides
// HOW it leaves the business's mailbox and reports what the provider said. Nothing in Finance talks to
// a mail provider, and nothing here sends.
//
// The contract, in three calls:
//   1. enqueue (C2-C implements, Finance calls): inside Finance's pre-dispatch transaction, with the
//      invoice row locked and its balance just re-checked, C2-C records an outbound message QUEUED and
//      returns its id. It must do no network I/O and must be idempotent on `idempotencyKey` (a retry of
//      the same reminder returns the same outbound id). Finance marks the reminder QUEUED in the same
//      transaction, so a reminder is handed over exactly once or not at all.
//   2. confirmReminderBeforeSend (Finance implements, C2-C calls): immediately before C2-C contacts the
//      provider, in the transaction that moves its outbound message out of QUEUED, Finance locks the
//      invoice and re-checks everything again (still issued, still unpaid, no hold, same policy and
//      stage). If anything changed the reminder is SKIPPED and C2-C must cancel its message. The send
//      itself happens only after that transaction commits.
//   3. recordReminderOutboundState (Finance implements, C2-C calls): C2-C reports each later state of
//      the outbound message. The states are C2's register; the database refuses UNKNOWN → FAILED and has
//      no "delivered" state, so nothing in Finance can claim more than "accepted by the provider".
//
// Until C2-C exists, `configuredReminderOutbox()` returns null and every eligible reminder stops at READY.
import type { ReminderOutboundState, ReminderReason } from '@business-os/contracts';
import type { AppTenantDb } from '@/core/db';

/** Who the reminder is addressed to. Resolved at each check; Finance never stores the address on the reminder. */
export interface ReminderRecipient {
  source: 'invoice_contact' | 'primary_contact' | 'customer';
  contactId: string | null;
  address: string;
}

/**
 * What C2-C needs to compose and send one reminder. Amounts are exact decimal strings in the invoice's
 * currency scale, taken from the locked invoice at the moment of the check. Composition (wording,
 * language, attachments) belongs to C2-C and is not decided here.
 */
export interface ReminderDispatchRequest {
  reminderId: string;
  /** Deterministic per reminder and impossible for a client to send (contains a space). */
  idempotencyKey: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  recipient: ReminderRecipient;
  currencyCode: string;
  total: string;
  outstanding: string;
  dueDate: string;
  /** Days past the due date on the business's today (negative before it). */
  daysPastDue: number;
  offsetDays: number;
  stageLabel: string;
  policyId: string;
}

export type EnqueueResult = { status: 'queued'; outboundId: string } | { status: 'refused'; code: string };

export interface ReminderOutbox {
  /**
   * Records an outbound message in C2-C's outbox in the caller's transaction (`db`) and returns its id.
   * No network I/O. Idempotent on request.idempotencyKey. `refused` (with a stable lowercase code, for
   * example no_sending_mailbox) leaves the reminder READY and it is checked again later.
   */
  enqueue(db: AppTenantDb, request: ReminderDispatchRequest): Promise<EnqueueResult>;
}

export type BeforeSendResult = { send: true; request: ReminderDispatchRequest } | { send: false; reason: ReminderReason | 'not_queued' };

/**
 * The outbox in use. C2-C replaces this with its implementation (behind its own owner approval and
 * Gates A to C). Until then: none, and reminders stop at READY ("ready to send").
 */
export function configuredReminderOutbox(): ReminderOutbox | null {
  return null;
}

export type { ReminderOutboundState };
