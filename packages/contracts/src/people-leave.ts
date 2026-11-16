import { z } from 'zod';
import { CalendarDate } from './sales.ts';
import { EmploymentStatus } from './people.ts';

// People P3-A: leave configuration (docs/people-leave-p3.md). Leave types, leave policies (the rules for
// one type, as they apply to the employees assigned to it), the policy revision history and the
// effective-dated assignment of a policy to an employee. Every path is under /api/v1/b/:slug/people.
//
// Nothing here encodes a country's law. Categories are neutral labels; every entitlement number is
// entered by the business; a policy's country code is a label for multi-country businesses and nothing
// is derived from it. There are no requests, approvals or balances yet (P3-B, P3-C), and no pay fields.

const Uuid = z.string().uuid();
const Count = z.number().int().min(1);
const Version = z.number().int().min(1);
const Limit = z.coerce.number().int().min(1).max(100).default(25);
const Cursor = z.string().max(500).regex(/^[A-Za-z0-9_-]+$/).optional();
const optionalText = (max: number) =>
  z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();
const Name = z.string().trim().min(1, 'A name is required').max(120);

export const LeaveCategory = z.enum(['ANNUAL', 'SICK', 'PERSONAL', 'CARER', 'UNPAID', 'COMPASSIONATE', 'PARENTAL', 'STUDY', 'OTHER']);
export type LeaveCategory = z.infer<typeof LeaveCategory>;
export const LeaveConfigStatus = z.enum(['ACTIVE', 'INACTIVE']);
export type LeaveConfigStatus = z.infer<typeof LeaveConfigStatus>;
export const LeaveUnit = z.enum(['DAYS', 'HOURS']);
export type LeaveUnit = z.infer<typeof LeaveUnit>;
/** FULL_DAY and HALF_DAY go with DAYS; HOUR, HALF_HOUR and QUARTER_HOUR with HOURS. */
export const LeaveGranularity = z.enum(['FULL_DAY', 'HALF_DAY', 'HOUR', 'HALF_HOUR', 'QUARTER_HOUR']);
export type LeaveGranularity = z.infer<typeof LeaveGranularity>;
/** NONE: no balance is kept (unpaid or compassionate leave, for example). GRANT: an amount each leave year. ACCRUAL: the annual amount accrues per period. */
export const EntitlementMethod = z.enum(['NONE', 'GRANT', 'ACCRUAL']);
export type EntitlementMethod = z.infer<typeof EntitlementMethod>;
export const AccrualFrequency = z.enum(['WEEKLY', 'FORTNIGHTLY', 'MONTHLY']);
export type AccrualFrequency = z.infer<typeof AccrualFrequency>;
/** When a leave year starts: 1 January, each employee's start-date anniversary, or a fixed day (a financial year). */
export const LeaveYearStart = z.enum(['CALENDAR', 'ANNIVERSARY', 'CUSTOM']);
export type LeaveYearStart = z.infer<typeof LeaveYearStart>;
export const CarryoverMode = z.enum(['NONE', 'UNLIMITED', 'CAPPED']);
export type CarryoverMode = z.infer<typeof CarryoverMode>;

/** A non-negative amount of days or hours with up to four decimals, as a string (never a float). */
export const LeaveAmount = z.string().trim().regex(/^\d{1,5}(\.\d{1,4})?$/, 'Use a number such as 20 or 7.5 (up to 4 decimals)');

// ---- leave types --------------------------------------------------------------------------------

export const LeaveType = z
  .object({
    id: Uuid, name: z.string(), description: z.string().nullable(), category: LeaveCategory, paid: z.boolean(), sensitive: z.boolean(),
    status: LeaveConfigStatus, archivedAt: z.string().datetime().nullable(), version: Count,
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .strict();
export type LeaveType = z.infer<typeof LeaveType>;

const leaveTypeFields = { name: Name, description: optionalText(2000), category: LeaveCategory, paid: z.boolean(), sensitive: z.boolean().optional() };
export const CreateLeaveTypeRequest = z.object(leaveTypeFields).strict();
export const UpdateLeaveTypeRequest = z
  .object({ ...leaveTypeFields, sensitive: z.boolean(), status: LeaveConfigStatus }).partial().extend({ version: Version }).strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
export const LeaveConfigLifecycleRequest = z.object({ version: Version }).strict();
export const LeaveTypeResponse = z.object({ leaveType: LeaveType }).strict();

/** current (default) = not archived; active and inactive are current types with that status. */
export const ListLeaveTypesQuery = z
  .object({
    q: z.string().trim().max(100).optional(), status: z.enum(['current', 'active', 'inactive', 'archived', 'all']).default('current'),
    category: LeaveCategory.optional(), cursor: Cursor, limit: Limit,
  })
  .strict();
export const ListLeaveTypesResponse = z.object({ leaveTypes: z.array(LeaveType), nextCursor: z.string().nullable() }).strict();

/**
 * A starting point a client may offer ("add the usual types"): names, categories and flags only. No
 * entitlement numbers, because those differ by country, contract and business. Each is created through
 * the ordinary create endpoint and can be renamed, changed or archived like any other type.
 */
export const LEAVE_TYPE_STARTERS: readonly { name: string; category: LeaveCategory; paid: boolean; sensitive: boolean }[] = [
  { name: 'Annual leave', category: 'ANNUAL', paid: true, sensitive: false },
  { name: 'Sick leave', category: 'SICK', paid: true, sensitive: true },
  { name: 'Personal leave', category: 'PERSONAL', paid: true, sensitive: true },
  { name: 'Unpaid leave', category: 'UNPAID', paid: false, sensitive: false },
  { name: 'Compassionate leave', category: 'COMPASSIONATE', paid: true, sensitive: true },
  { name: 'Parental leave', category: 'PARENTAL', paid: false, sensitive: true },
];

// ---- leave policies -----------------------------------------------------------------------------

const TypeRef = z.object({ id: Uuid, name: z.string(), category: LeaveCategory, archived: z.boolean() }).strict();

export const LeavePolicy = z
  .object({
    id: Uuid, leaveType: TypeRef, name: z.string(), description: z.string().nullable(), countryCode: z.string().nullable(),
    unit: LeaveUnit, granularity: LeaveGranularity,
    entitlementMethod: EntitlementMethod, entitlementAmount: z.string().nullable(), accrualFrequency: AccrualFrequency.nullable(),
    yearStart: LeaveYearStart.nullable(), yearStartMonth: z.number().int().nullable(), yearStartDay: z.number().int().nullable(),
    carryover: CarryoverMode, carryoverCap: z.string().nullable(), maxBalance: z.string().nullable(), negativeBalanceLimit: z.string(),
    requiresApproval: z.boolean(), minimumNoticeDays: z.number().int().nullable(), allowBackdated: z.boolean(), waitingPeriodDays: z.number().int().nullable(),
    status: LeaveConfigStatus, archivedAt: z.string().datetime().nullable(), currentAssignments: z.number().int().min(0), version: Count,
    createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  })
  .strict();
export type LeavePolicy = z.infer<typeof LeavePolicy>;

/** The rule fields of a policy (shape only; the combinations are checked by leavePolicyProblems). */
const ruleFields = {
  granularity: LeaveGranularity,
  entitlementMethod: EntitlementMethod,
  entitlementAmount: LeaveAmount.nullable().optional(),
  accrualFrequency: AccrualFrequency.nullable().optional(),
  yearStart: LeaveYearStart.nullable().optional(),
  yearStartMonth: z.number().int().min(1).max(12).nullable().optional(),
  yearStartDay: z.number().int().min(1).max(31).nullable().optional(),
  carryover: CarryoverMode.optional(),
  carryoverCap: LeaveAmount.nullable().optional(),
  maxBalance: LeaveAmount.nullable().optional(),
  negativeBalanceLimit: LeaveAmount.optional(),
  requiresApproval: z.boolean().optional(),
  minimumNoticeDays: z.number().int().min(0).max(365).nullable().optional(),
  allowBackdated: z.boolean().optional(),
  waitingPeriodDays: z.number().int().min(0).max(3650).nullable().optional(),
};
const CountryCode = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter country code such as US');

export const CreateLeavePolicyRequest = z
  .object({
    leaveTypeId: Uuid, name: Name, description: optionalText(2000), countryCode: CountryCode.nullable().optional(), unit: LeaveUnit, ...ruleFields,
  })
  .strict();
/** The leave type and the unit are fixed once created (create another policy to change them). */
export const UpdateLeavePolicyRequest = z
  .object({ name: Name, description: optionalText(2000), countryCode: CountryCode.nullable(), ...ruleFields, status: LeaveConfigStatus })
  .partial().extend({ version: Version }).strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to update');
export const LeavePolicyResponse = z.object({ policy: LeavePolicy }).strict();

export const ListLeavePoliciesQuery = z
  .object({
    q: z.string().trim().max(100).optional(), leaveTypeId: Uuid.optional(), status: z.enum(['current', 'active', 'inactive', 'archived', 'all']).default('current'),
    cursor: Cursor, limit: Limit,
  })
  .strict();
export const ListLeavePoliciesResponse = z.object({ policies: z.array(LeavePolicy), nextCursor: z.string().nullable() }).strict();

/** The rules a policy held at one version, written by the database on every change (append-only). */
export const LeavePolicyRevision = z
  .object({ version: Count, rules: z.record(z.string(), z.unknown()), recordedById: Uuid.nullable(), recordedAt: z.string().datetime() })
  .strict();
export const ListLeavePolicyRevisionsResponse = z.object({ revisions: z.array(LeavePolicyRevision) }).strict();

/** The full set of rule values, as stored, that leavePolicyProblems checks. */
export interface LeavePolicyRules {
  unit: LeaveUnit; granularity: LeaveGranularity; entitlementMethod: EntitlementMethod; entitlementAmount: string | null;
  accrualFrequency: AccrualFrequency | null; yearStart: LeaveYearStart | null; yearStartMonth: number | null; yearStartDay: number | null;
  carryover: CarryoverMode; carryoverCap: string | null; maxBalance: string | null; negativeBalanceLimit: string;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const positive = (v: string | null) => v !== null && Number(v) > 0;

/**
 * Plain-language problems with a combination of rules, or [] when it is consistent. Used by the API
 * before writing (the database CHECKs are the backstop) and available to clients for inline hints.
 */
export function leavePolicyProblems(r: LeavePolicyRules): string[] {
  const out: string[] = [];
  const days = r.unit === 'DAYS';
  if (days !== (r.granularity === 'FULL_DAY' || r.granularity === 'HALF_DAY')) {
    out.push(days ? 'Day-based leave is taken in full or half days.' : 'Hour-based leave is taken in hours, half hours or quarter hours.');
  }
  if (r.entitlementMethod === 'NONE') {
    if (r.entitlementAmount !== null) out.push('Leave without a balance has no entitlement amount.');
    if (r.accrualFrequency !== null) out.push('Leave without a balance does not accrue.');
    if (r.yearStart !== null || r.yearStartMonth !== null || r.yearStartDay !== null) out.push('Leave without a balance has no leave year.');
    if (r.carryover !== 'NONE' || r.carryoverCap !== null) out.push('Leave without a balance has nothing to carry over.');
    if (r.maxBalance !== null) out.push('Leave without a balance has no maximum balance.');
    if (Number(r.negativeBalanceLimit) !== 0) out.push('Leave without a balance cannot go negative.');
    return out;
  }
  if (!positive(r.entitlementAmount)) out.push('Enter the entitlement per leave year (more than 0).');
  if ((r.entitlementMethod === 'ACCRUAL') !== (r.accrualFrequency !== null)) {
    out.push(r.entitlementMethod === 'ACCRUAL' ? 'Choose how often leave accrues.' : 'Only accruing leave has an accrual frequency.');
  }
  if (r.yearStart === null) out.push('Choose when the leave year starts.');
  if ((r.yearStart === 'CUSTOM') !== (r.yearStartMonth !== null && r.yearStartDay !== null)
      || (r.yearStartMonth === null) !== (r.yearStartDay === null)) {
    out.push(r.yearStart === 'CUSTOM' ? 'Choose the month and day the leave year starts.' : 'Only a custom leave year has a start month and day.');
  } else if (r.yearStartMonth !== null && r.yearStartDay !== null && r.yearStartDay > DAYS_IN_MONTH[r.yearStartMonth - 1]!) {
    out.push('Choose a start day that exists every year (not 29 February).');
  }
  if ((r.carryover === 'CAPPED') !== (r.carryoverCap !== null)) {
    out.push(r.carryover === 'CAPPED' ? 'Enter the most that can carry over.' : 'Only capped carry-over has a cap.');
  }
  if (r.maxBalance !== null && !positive(r.maxBalance)) out.push('A maximum balance must be more than 0.');
  return out;
}

// ---- policy assignments -------------------------------------------------------------------------

const EmployeeRef = z.object({ id: Uuid, name: z.string(), status: EmploymentStatus }).strict();
const PolicyRef = z.object({ id: Uuid, name: z.string(), archived: z.boolean() }).strict();

/** Which policy governs an employee's leave of one type, over [startsOn, endsOn). */
export const LeavePolicyAssignment = z
  .object({
    id: Uuid, employee: EmployeeRef, leaveType: TypeRef, policy: PolicyRef, startsOn: z.string(), endsOn: z.string().nullable(),
    createdAt: z.string().datetime(), endedAt: z.string().datetime().nullable(),
  })
  .strict();
export type LeavePolicyAssignment = z.infer<typeof LeavePolicyAssignment>;

/**
 * Assign a policy to up to 100 employees at once, all or nothing, from the effective date (default
 * today in the business's time zone; never in the future). An employee who already has this policy is
 * left unchanged; one with another policy of the same leave type has it closed on that date.
 */
export const AssignLeavePolicyRequest = z
  .object({
    employeeIds: z.array(Uuid).min(1).max(100).refine((ids) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length, 'Each employee once'),
    effectiveDate: CalendarDate.optional(),
  })
  .strict();
export const AssignLeavePolicyResponse = z
  .object({ assigned: z.number().int().min(0), unchanged: z.number().int().min(0), assignments: z.array(LeavePolicyAssignment) })
  .strict();

/** Stop applying any policy of this leave type to the employee from the effective date. */
export const EndLeavePolicyAssignmentRequest = z.object({ leaveTypeId: Uuid, effectiveDate: CalendarDate.optional() }).strict();

/** Current and past assignments of one employee, current first, then newest first. */
export const EmployeeLeavePoliciesResponse = z.object({ assignments: z.array(LeavePolicyAssignment) }).strict();

/** The employees a policy currently applies to (or every assignment it ever had, with all=true). */
export const ListPolicyAssignmentsQuery = z
  .object({ include: z.enum(['current', 'all']).default('current'), cursor: Cursor, limit: Limit })
  .strict();
export const ListPolicyAssignmentsResponse = z
  .object({ assignments: z.array(LeavePolicyAssignment), nextCursor: z.string().nullable() })
  .strict();
