import { z } from 'zod';
import { CalendarDate } from './sales.ts';

// Finance F6-3 (docs/finance-billing-f6.md §10): payment reminder policies, customer assignments,
// holds (suppression and exclusion), reminder scheduling and history. Every path is under
// /api/v1/b/:slug/finance.
//
// Nothing here sends mail. A reminder that passes its pre-dispatch check stops at READY ("ready to
// send") until Communications C2-C provides an outbox; once handed over it is QUEUED and C2-C owns
// delivery. The strongest outbound state is ACCEPTED ("sent from your mailbox"); no state means
// "delivered" (D-F6-8, D-C2-13).
//
// The stage rules below are shared by the API and the clients, so a schedule shown in the app and
// the worker agree on every date. Pure functions on calendar dates (YYYY-MM-DD).

const Uuid = z.string().uuid();
const Amount = z.string();
const Limit = z.coerce.number().int().min(1).max(100).default(50);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();
const Version = z.number().int().min(1);

/** A stage is skipped, never sent, once it is more than this many days past its date (no catch-up floods). */
export const REMINDER_MAX_LATENESS_DAYS = 14;
/** Stage offsets are days relative to the due date: negative = before, 0 = on the due date. */
export const REMINDER_OFFSET_MIN = -60;
export const REMINDER_OFFSET_MAX = 365;
export const REMINDER_MAX_STAGES = 8;

export const ReminderPolicyStatus = z.enum(['ACTIVE', 'ARCHIVED']);
export const ReminderStatus = z.enum(['PENDING', 'RUNNING', 'READY', 'QUEUED', 'SKIPPED', 'FAILED']);
export type ReminderStatus = z.infer<typeof ReminderStatus>;
/** C2's outbound register (D-C2-13). Never "DELIVERED": the providers do not confirm delivery. */
export const ReminderOutboundState = z.enum(['QUEUED', 'SENDING', 'SUBMITTED', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'BOUNCED']);
export type ReminderOutboundState = z.infer<typeof ReminderOutboundState>;
export const ReminderHoldReason = z.enum(['DISPUTE', 'PAYMENT_PLAN', 'CUSTOMER_REQUEST', 'OTHER']);
export const ReminderHoldScope = z.enum(['CUSTOMER', 'INVOICE']);

/**
 * Why a reminder was not (or is not yet) handed over. Stable codes, shown in words by the clients.
 * An outbox refusal (C2-C, for example no sending mailbox) is reported with its own code beside these.
 */
export const REMINDER_REASONS = [
  'not_issued', 'settled', 'no_due_date', 'due_date_changed', 'customer_archived', 'on_hold', 'no_policy', 'policy_changed', 'stage_removed',
  'superseded', 'stale', 'expired', 'not_yet', 'no_recipient', 'dismissed', 'lease_expired', 'internal_error',
] as const;
export type ReminderReason = (typeof REMINDER_REASONS)[number];

// ---- stage rules ---------------------------------------------------------------------------------

export type ReminderStage = { offsetDays: number; label: string };

const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The date a stage comes due for an invoice due on `dueDate`. */
export const reminderStageDate = (dueDate: string, offsetDays: number) => addDays(dueDate, offsetDays);

/** Days past the due date on `day` (negative before it). */
export const daysPastDue = (dueDate: string, day: string) => daysBetween(dueDate, day);

/**
 * Where one stage of an invoice stands on `today`:
 * - `not_yet`: its date has not come;
 * - `superseded`: a later stage has also come due, so only that one may be sent (one reminder per
 *   invoice at a time; a worker that was down never sends a burst);
 * - `stale`: a reminder before or on the due date ("due soon", "due today") once the invoice is overdue;
 * - `expired`: more than REMINDER_MAX_LATENESS_DAYS past its date (turning on a policy never mails
 *   every old invoice);
 * - `due`: the one stage that may be sent today.
 * `stages` must be sorted by offset (the contracts and the database both require strictly increasing offsets).
 */
export function reminderStageState(
  stages: readonly ReminderStage[], dueDate: string, today: string, offsetDays: number,
): 'due' | 'not_yet' | 'superseded' | 'stale' | 'expired' {
  const date = reminderStageDate(dueDate, offsetDays);
  if (date > today) return 'not_yet';
  if (stages.some((s) => s.offsetDays > offsetDays && reminderStageDate(dueDate, s.offsetDays) <= today)) return 'superseded';
  if (offsetDays <= 0 && today > dueDate) return 'stale';
  if (daysBetween(date, today) > REMINDER_MAX_LATENESS_DAYS) return 'expired';
  return 'due';
}

/** The stage that may be sent today for an invoice due on `dueDate`, or null. */
export function dueReminderStage(stages: readonly ReminderStage[], dueDate: string, today: string): ReminderStage | null {
  return stages.find((s) => reminderStageState(stages, dueDate, today, s.offsetDays) === 'due') ?? null;
}

// ---- requests -------------------------------------------------------------------------------------

export const ReminderStageInput = z
  .object({
    offsetDays: z.number().int().min(REMINDER_OFFSET_MIN).max(REMINDER_OFFSET_MAX),
    label: z.string().trim().min(1, 'Name this stage').max(80),
  })
  .strict();
const Stages = z
  .array(ReminderStageInput)
  .min(1, 'A policy needs at least one stage')
  .max(REMINDER_MAX_STAGES, `A policy has at most ${REMINDER_MAX_STAGES} stages`)
  .refine((s) => s.every((v, i) => i === 0 || v.offsetDays > s[i - 1]!.offsetDays), 'Stages must be in order, each later than the one before');

export const CreateReminderPolicyRequest = z
  .object({
    name: z.string().trim().min(1, 'Name this policy').max(200),
    stages: Stages,
    /** Becomes the business's default policy (the previous default stops being the default). */
    isDefault: z.boolean().optional(),
  })
  .strict();

/** Changes apply to stages not yet reached; reminders already handed over never change. */
export const UpdateReminderPolicyRequest = z
  .object({ version: Version, name: z.string().trim().min(1).max(200).optional(), stages: Stages.optional(), isDefault: z.boolean().optional() })
  .strict();
export const ArchiveReminderPolicyRequest = z.object({ version: Version }).strict();
export const ListReminderPoliciesQuery = z.object({ status: z.enum(['active', 'archived', 'all']).default('active') }).strict();

/** Null policy = the business default. `version` is required once the customer has a setting. */
export const UpdateCustomerReminderSettingsRequest = z.object({ policyId: Uuid.nullable(), version: Version.optional() }).strict();

export const CreateReminderHoldRequest = z
  .object({
    customerId: Uuid,
    /** Omitted or null: every invoice of the customer (with no end date, an exclusion). */
    invoiceId: Uuid.nullable().optional(),
    reason: ReminderHoldReason,
    note: z.string().trim().max(1000).transform((v) => (v === '' ? null : v)).nullable().optional(),
    /** Last day of the hold (inclusive), in the business's zone. Omitted or null: until released. */
    untilDate: CalendarDate.nullable().optional(),
  })
  .strict();
export const ReleaseReminderHoldRequest = z.object({}).strict();
export const ListReminderHoldsQuery = z
  .object({
    state: z.enum(['in_effect', 'ended', 'all']).default('in_effect'),
    customerId: Uuid.optional(),
    invoiceId: Uuid.optional(),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();

export const ListRemindersQuery = z
  .object({
    status: z.enum(['pending', 'running', 'ready', 'queued', 'skipped', 'failed', 'all']).default('all'),
    customerId: Uuid.optional(),
    invoiceId: Uuid.optional(),
    cursor: Cursor,
    limit: Limit,
  })
  .strict();
export const DismissReminderRequest = z.object({}).strict();

// ---- responses ------------------------------------------------------------------------------------

const Stage = z.object({ offsetDays: z.number().int(), label: z.string() }).strict();

export const ReminderPolicy = z
  .object({
    id: Uuid,
    name: z.string(),
    status: ReminderPolicyStatus,
    isDefault: z.boolean(),
    stages: z.array(Stage),
    /** Customers assigned to this policy explicitly (not counting those on the default). */
    assignedCustomers: z.number().int(),
    version: z.number().int(),
    archivedAt: z.string().nullable(),
    createdById: Uuid.nullable(),
    updatedById: Uuid.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type ReminderPolicy = z.infer<typeof ReminderPolicy>;
export const ReminderPolicyResponse = z.object({ policy: ReminderPolicy }).strict();
export const ListReminderPoliciesResponse = z.object({ policies: z.array(ReminderPolicy) }).strict();

export const ReminderHold = z
  .object({
    id: Uuid,
    scope: ReminderHoldScope,
    customerId: Uuid,
    invoiceId: Uuid.nullable(),
    invoiceNumber: z.string().nullable(),
    reason: ReminderHoldReason,
    note: z.string().nullable(),
    untilDate: CalendarDate.nullable(),
    /** Not released and, with an end date, on or before it today in the business's zone. */
    inEffect: z.boolean(),
    releasedAt: z.string().nullable(),
    releasedById: Uuid.nullable(),
    createdById: Uuid,
    createdAt: z.string(),
  })
  .strict();
export type ReminderHold = z.infer<typeof ReminderHold>;
export const ReminderHoldResponse = z.object({ hold: ReminderHold }).strict();
export const ListReminderHoldsResponse = z.object({ holds: z.array(ReminderHold), nextCursor: z.string().nullable() }).strict();

export const CustomerReminderSettings = z
  .object({
    customerId: Uuid,
    /** The customer's own policy, or null for the business default. */
    policyId: Uuid.nullable(),
    /** The policy that applies now (the assignment if active, else the default), or null: no reminders. */
    effectivePolicyId: Uuid.nullable(),
    /** Null until the customer has a setting of its own. */
    version: z.number().int().nullable(),
    holdsInEffect: z.array(ReminderHold),
  })
  .strict();
export const CustomerReminderSettingsResponse = z.object({ settings: CustomerReminderSettings }).strict();

export const Reminder = z
  .object({
    id: Uuid,
    invoiceId: Uuid,
    invoiceNumber: z.string().nullable(),
    customerId: Uuid,
    policyId: Uuid,
    offsetDays: z.number().int(),
    stageLabel: z.string(),
    dueDate: CalendarDate,
    scheduledOn: CalendarDate,
    status: ReminderStatus,
    /** Why it was skipped or failed, or why the outbox has not taken it yet (READY). */
    outcomeCode: z.string().nullable(),
    currencyCode: z.string(),
    /** The invoice's outstanding amount at the last pre-dispatch check (never a projection). */
    checkedOutstanding: Amount.nullable(),
    checkedAt: z.string().nullable(),
    /** C2-C's outbound message and its last reported state, once handed over. */
    outboundId: Uuid.nullable(),
    outboundState: ReminderOutboundState.nullable(),
    readyAt: z.string().nullable(),
    queuedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    dismissedById: Uuid.nullable(),
    createdAt: z.string(),
  })
  .strict();
export type Reminder = z.infer<typeof Reminder>;
export const ReminderResponse = z.object({ reminder: Reminder }).strict();
export const ListRemindersResponse = z.object({ reminders: z.array(Reminder), nextCursor: z.string().nullable() }).strict();

/** One invoice's reminder position today: what would happen next, stage by stage, and what already did. */
export const InvoiceReminderSchedule = z
  .object({
    invoiceId: Uuid,
    asOf: CalendarDate,
    /** Whether a reminder could be sent for it today, and if not, why (one of REMINDER_REASONS). */
    eligible: z.boolean(),
    reason: z.string().nullable(),
    currencyCode: z.string(),
    outstanding: Amount,
    dueDate: CalendarDate.nullable(),
    policyId: Uuid.nullable(),
    stages: z.array(
      z
        .object({
          offsetDays: z.number().int(),
          label: z.string(),
          scheduledOn: CalendarDate.nullable(),
          /** Today, by the stage rules (not_yet, due, superseded, stale, expired), or null without a due date. */
          state: z.enum(['due', 'not_yet', 'superseded', 'stale', 'expired']).nullable(),
          reminderId: Uuid.nullable(),
        })
        .strict(),
    ),
    /** Every reminder of this invoice, newest first (including stages since removed from the policy). */
    reminders: z.array(Reminder),
  })
  .strict();
export const InvoiceReminderScheduleResponse = z.object({ schedule: InvoiceReminderSchedule }).strict();
