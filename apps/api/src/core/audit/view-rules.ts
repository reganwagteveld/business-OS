// What the audit viewer may show (docs/administration-audit-viewer.md §5). Default-deny: an action is
// described by the longest matching FAMILY rule (plus a few exact additions); metadata keys and the
// target are shown only as the rule allows. An action with no rule is still listed (time, actor, action
// string, a fixed label) with no metadata and, at most, its target type. Nothing here reads the database.
//
// Never allowed, whatever a module writes: tokens, hashes, emails, free text, names of customers or
// contacts, amounts, user ids of other people, provider payloads. Keys that hold ids (customerId, userId,
// from/to where they are user or record ids) are simply not listed.
import type { AuditGroup } from '@business-os/contracts';

/** show: type and id. type_only: the type, never the id. hidden: no target at all. */
export type TargetMode = 'show' | 'type_only' | 'hidden';

export interface ViewRule {
  /** The family prefix this rule describes (an action matches when it equals the prefix or starts with `prefix.`). */
  prefix: string;
  noun: string;
  group: AuditGroup;
  keys: readonly string[];
  target: TargetMode;
}

const family = (prefix: string, noun: string, group: AuditGroup, target: TargetMode, keys: readonly string[] = []): ViewRule => ({ prefix, noun, group, keys, target });

export const VIEW_RULES: readonly ViewRule[] = [
  family('business', 'Business', 'business', 'show', ['fields', 'countryCodeFrom', 'countryCodeTo', 'timeZoneFrom', 'timeZoneTo', 'localeFrom', 'localeTo', 'currencyFrom', 'currencyTo', 'fiscalYearStartMonthFrom', 'fiscalYearStartMonthTo']),
  family('membership', 'Member', 'team', 'show', ['role', 'from', 'to', 'via', 'mailboxesStopped', 'stopped', 'stepDown']),
  family('invitation', 'Invitation', 'team', 'type_only', ['role', 'reason']),
  family('customer', 'Customer', 'customers', 'show', ['fields']),
  family('contact', 'Contact', 'customers', 'show', ['fields']),
  family('activity', 'Note or activity', 'customers', 'type_only', ['activityType', 'fields', 'visibility']),
  family('sales.pipeline', 'Sales pipeline', 'sales', 'show', ['stages']),
  family('sales', 'Opportunity', 'sales', 'show', ['fields', 'currencyCode', 'hasAmount', 'hasReason']),
  family('projects', 'Project', 'projects', 'show', ['fields', 'status']),
  family('scheduling', 'Scheduling', 'scheduling', 'show', ['fields', 'enforced', 'blocksAvailability', 'overlaps', 'resourceType', 'status']),
  family('people', 'People record', 'people', 'type_only', ['fields', 'status', 'category', 'unit', 'entitlementMethod', 'statusFrom', 'statusTo', 'change', 'effectiveDate']),
  family('finance.system', 'Billing automation', 'finance', 'show', ['attempts', 'code', 'errorCode', 'state', 'previousState', 'reason', 'stage', 'offsetDays', 'periodIndex']),
  family('finance.document_pdf', 'Document PDF', 'finance', 'show', ['kind', 'versionNumber', 'pageCount', 'documentStatus', 'hasNote']),
  family('finance.statement_pdf', 'Customer statement PDF', 'finance', 'show', ['currencyCode']),
  family('finance', 'Finance record', 'finance', 'show', [
    'fields', 'kind', 'number', 'currencyCode', 'itemType', 'hasReason', 'direction', 'method', 'isDefault', 'wasDefault', 'scope', 'trigger',
    'frequency', 'intervalCount', 'lineCount', 'catalogLineCount', 'fromStatus', 'statusFrom', 'statusTo', 'taxTreatment', 'paidInFull',
    'reversedAllocations', 'skippedRuns', 'skippedPeriods', 'skippedReminders', 'cause', 'offsetDays',
  ]),
  family('reporting', 'Saved report', 'reporting', 'show', ['fields', 'visibility']),
  // Mailbox, history and erasure records. Mailbox, conversation and message ids are private references: never shown.
  family('communications.erasure', 'Erasure', 'communications', 'hidden', ['scope', 'reason', 'reviewRequired', 'deferred', 'messages', 'conversations', 'participants', 'activities', 'ordinaryRetentionDays', 'previousDays']),
  family('communications.legal_hold', 'Legal hold', 'communications', 'hidden', ['scope', 'reasonCode']),
  family('communications.retention', 'Mail retention', 'communications', 'type_only', ['ordinaryRetentionDays', 'previousDays']),
  family('communications.system', 'Mailbox system event', 'communications', 'type_only', ['provider']),
  family('communications', 'Mailbox', 'communications', 'type_only', [
    'provider', 'kind', 'reason', 'revocation', 'syncQueued', 'sharing', 'syncEnabled', 'access', 'previousAccess', 'cause', 'method', 'basis', 'fields',
  ]),
  family('conversation', 'Conversation', 'communications', 'hidden', ['channel']),
  family('message', 'Message', 'communications', 'hidden', ['direction', 'source']),
  family('messages', 'Messages', 'communications', 'hidden', ['created', 'duplicates']),
];

/**
 * Exact additions, merged into the family's keys. `from` and `to` are listed only for actions where they are
 * status or role codes, never where they are user or record ids (projects.*.assigned, people department changes).
 */
const EXTRA_KEYS: Readonly<Record<string, readonly string[]>> = {
  'projects.project.status_changed': ['from', 'to'],
  'projects.task.status_changed': ['from', 'to'],
  'projects.task.moved': ['from', 'to'],
  'scheduling.resource.status_changed': ['from', 'to'],
  'people.employee.status_changed': ['from', 'to'],
};

/** Target types that may be named. Anything else is reported as the fixed fallback "record". */
export const SAFE_TARGET_TYPES: ReadonlySet<string> = new Set([
  'business', 'membership', 'invitation', 'customer', 'contact', 'activity', 'opportunity', 'sales_pipeline', 'project', 'project_task',
  'scheduling_calendar', 'scheduling_event', 'scheduling_resource', 'people_employee', 'people_leave_policy', 'people_leave_type',
  'people_department', 'people_location', 'finance_document', 'finance_payment', 'finance_payment_allocation', 'finance_credit_application',
  'finance_expense', 'finance_expense_allocation', 'finance_catalog_item', 'finance_settings', 'finance_document_branding', 'finance_document_pdf',
  'finance_recurring_template', 'finance_recurring_run', 'finance_reminder', 'finance_reminder_policy', 'finance_reminder_hold', 'finance_tax_rate',
  'finance_number_series', 'finance_expense_category', 'reporting_saved_view', 'mail_connection', 'mail_business_domain', 'mail_business_address',
  'conversation', 'message', 'legal_hold', 'erasure',
]);

export const FALLBACK_TARGET_TYPE = 'record';
export const FALLBACK_LABEL = 'Recorded change';

export interface ResolvedRule {
  label: string;
  group: AuditGroup;
  keys: ReadonlySet<string>;
  target: TargetMode;
  /** True when no family matched (the action is listed with no metadata). */
  unknown: boolean;
}

const ACTION_SHAPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const words = (text: string) => text.replace(/[._]+/g, ' ').trim();
const sentence = (text: string) => (text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1));

export function matchFamily(action: string): ViewRule | undefined {
  let best: ViewRule | undefined;
  for (const rule of VIEW_RULES) {
    if (action === rule.prefix || action.startsWith(`${rule.prefix}.`)) {
      if (!best || rule.prefix.length > best.prefix.length) best = rule;
    }
  }
  return best;
}

/** The rule for an action. Total: any string, including one a future module invents, gets a safe answer. */
export function resolveRule(action: string): ResolvedRule {
  const rule = ACTION_SHAPE.test(action) ? matchFamily(action) : undefined;
  if (!rule) return { label: FALLBACK_LABEL, group: 'other', keys: new Set(), target: 'type_only', unknown: true };
  const rest = words(action.slice(rule.prefix.length));
  const label = sentence(rest ? `${rule.noun} ${rest}` : rule.noun).slice(0, 120);
  return { label, group: rule.group, keys: new Set([...rule.keys, ...(EXTRA_KEYS[action] ?? [])]), target: rule.target, unknown: false };
}

type Metadata = Record<string, string | number | boolean | string[]>;

const MAX_STRING = 200;
const MAX_ITEMS = 20;

/** Only allow-listed keys, only plain values (string, finite number, boolean, short string list), strings truncated. */
export function sanitizeMetadata(raw: unknown, keys: ReadonlySet<string>): Metadata {
  const out: Metadata = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const record = raw as Record<string, unknown>;
  for (const key of [...keys].sort()) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (typeof value === 'string') out[key] = value.slice(0, MAX_STRING);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = (value as string[]).slice(0, MAX_ITEMS).map((v) => v.slice(0, MAX_STRING));
  }
  return out;
}

/** The target as the viewer may show it. Null when the rule hides it or the row has none. */
export function viewTarget(rule: ResolvedRule, targetType: string | null, targetId: string | null): { type: string; id?: string } | null {
  if (rule.target === 'hidden' || (targetType === null && targetId === null)) return null;
  const type = targetType !== null && SAFE_TARGET_TYPES.has(targetType) && !rule.unknown ? targetType : FALLBACK_TARGET_TYPE;
  if (rule.target === 'show' && targetId !== null && !rule.unknown) return { type, id: targetId };
  return { type };
}

/** Dotted-boundary LIKE pattern for an action prefix, with LIKE metacharacters escaped (escape character is a backslash). */
export function prefixLikePattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}.%`;
}

export const MAX_WINDOW_MS = 92 * 24 * 60 * 60 * 1000;

/**
 * The window a request covers (docs §4). Always at most 92 days: neither bound means the last 92 days up to
 * now; only `to` means the 92 days before it; only `from` means up to 92 days after it, never past now.
 * Null when `from` lies in the future, so there is nothing to show.
 */
export function resolveWindow(query: { from?: string; to?: string }, now: Date): { from: Date; to: Date } | null {
  if (query.from !== undefined && query.to !== undefined) return { from: new Date(query.from), to: new Date(query.to) };
  if (query.to !== undefined) {
    const to = new Date(query.to);
    return { from: new Date(to.getTime() - MAX_WINDOW_MS), to };
  }
  if (query.from !== undefined) {
    const from = new Date(query.from);
    const to = new Date(Math.min(now.getTime(), from.getTime() + MAX_WINDOW_MS));
    return to.getTime() < from.getTime() ? null : { from, to };
  }
  return { from: new Date(now.getTime() - MAX_WINDOW_MS), to: now };
}
