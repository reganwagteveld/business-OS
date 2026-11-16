import 'server-only';
// People P3-A (docs/people-leave-p3.md §4): leave types and leave policies. Runs inside one tenant unit
// of work per request: the change and its audit entry (and, for policies, the revision the database
// appends), nothing else.
//
// Every change is conditional on the version the caller read (`UPDATE … WHERE id = ? AND version = ?`),
// so two administrators editing the same policy can never both win; the loser gets 409 stale. The
// database holds every rule again (migration 20261201000000_people_leave_policies): the shapes and rule
// combinations, active-name uniqueness, the fixed leave type and unit, archived rows being read-only,
// the version advancing by one, archive-while-in-use, and RLS.
//
// No rule here comes from a country's law. A policy's numbers are whatever the business enters.
import { createHash, randomUUID } from 'node:crypto';
import {
  leavePolicyProblems,
  type AccrualFrequency, type CarryoverMode, type EntitlementMethod, type LeaveCategory, type LeaveConfigStatus, type LeaveGranularity,
  type LeavePolicy as PolicyDto, type LeavePolicyRules, type LeaveType as TypeDto, type LeaveUnit, type LeaveYearStart,
} from '@business-os/contracts';
import { recordAudit } from '@/core/audit';
import { Decimal, type AppTenantDb } from '@/core/db';
import { decodeCursor, encodeCursor, invalidCursor } from '@/core/db/cursor';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { UUID } from './shared';

const iso = (d: Date | null) => d?.toISOString() ?? null;
const amount = (d: Decimal | null) => (d === null ? null : d.toFixed());
type StatusFilter = 'current' | 'active' | 'inactive' | 'archived' | 'all';

function statusWhere(status: StatusFilter): Record<string, unknown>[] {
  if (status === 'current') return [{ archivedAt: null }];
  if (status === 'active') return [{ archivedAt: null, status: 'ACTIVE' }];
  if (status === 'inactive') return [{ archivedAt: null, status: 'INACTIVE' }];
  if (status === 'archived') return [{ archivedAt: { not: null } }];
  return [];
}

/** A digest of the filters, so a cursor issued for one filter set is refused by another (as in F7-A). */
const filterKey = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('base64url');

// ---- leave types --------------------------------------------------------------------------------

type TypeRow = {
  id: string; name: string; description: string | null; category: LeaveCategory; paid: boolean; sensitive: boolean; status: LeaveConfigStatus;
  archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
};
const typeSelect = {
  id: true, name: true, description: true, category: true, paid: true, sensitive: true, status: true, archivedAt: true, version: true,
  createdAt: true, updatedAt: true,
} as const;
const typeDto = (r: TypeRow): TypeDto => ({ ...r, archivedAt: iso(r.archivedAt), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });

/** A leave type of this business. Another business's id answers exactly like a missing one (404). */
async function loadType(db: AppTenantDb, id: string): Promise<TypeRow> {
  const row = (await db.peopleLeaveType.findFirst({ where: { id }, select: typeSelect })) as TypeRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}
export const getLeaveType = async (db: AppTenantDb, id: string) => typeDto(await loadType(db, id));

/** Current (not archived) names are unique per business ignoring case and surrounding spaces. */
async function checkTypeName(db: AppTenantDb, name: string, exceptId?: string) {
  const clash = await db.peopleLeaveType.findFirst({
    where: { name: { equals: name.trim(), mode: 'insensitive' }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true },
  });
  if (clash) throw new StateConflictError('duplicate_name');
}

export interface LeaveTypeQuery { q?: string; status: StatusFilter; category?: LeaveCategory; cursor?: string; limit: number }

export async function listLeaveTypes(db: AppTenantDb, query: LeaveTypeQuery) {
  const where = statusWhere(query.status);
  if (query.category) where.push({ category: query.category });
  if (query.q) where.push({ name: { contains: query.q, mode: 'insensitive' } });
  const list = 'people:leave-types';
  const filters = filterKey([query.q || null, query.status, query.category ?? null]);
  const after = decodeCursor(query.cursor, list, ['n', 'i', 'f'] as const);
  if (after) {
    if (!UUID.test(after.i) || after.f !== filters) invalidCursor();
    where.push({ OR: [{ name: { gt: after.n } }, { name: after.n, id: { gt: after.i } }] });
  }
  const rows = (await db.peopleLeaveType.findMany({
    where: { AND: where }, select: typeSelect, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  })) as TypeRow[];
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { leaveTypes: page.map(typeDto), nextCursor: rows.length > query.limit && last ? encodeCursor(list, { n: last.name, i: last.id, f: filters }) : null };
}

export interface LeaveTypeInput { name: string; description?: string | null; category: LeaveCategory; paid: boolean; sensitive?: boolean }

export async function createLeaveType(db: AppTenantDb, actorUserId: string, input: LeaveTypeInput) {
  await checkTypeName(db, input.name);
  const id = randomUUID();
  // Sick and similar categories default to sensitive; the business can change it.
  const sensitive = input.sensitive ?? ['SICK', 'PERSONAL', 'CARER', 'COMPASSIONATE', 'PARENTAL'].includes(input.category);
  await db.peopleLeaveType.create({
    data: {
      id, name: input.name, description: input.description ?? null, category: input.category, paid: input.paid, sensitive,
      createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  // References only: never names or descriptions (docs/people-leave-p3.md §4.6).
  await recordAudit(db, actorUserId, 'people.leave_type.created', { type: 'people_leave_type', id }, { category: input.category });
  return getLeaveType(db, id);
}

export interface LeaveTypePatch { version: number; name?: string; description?: string | null; category?: LeaveCategory; paid?: boolean; sensitive?: boolean; status?: LeaveConfigStatus }

export async function updateLeaveType(db: AppTenantDb, actorUserId: string, id: string, input: LeaveTypePatch) {
  const before = await loadType(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const data: Record<string, unknown> = {};
  for (const key of ['name', 'description', 'category', 'paid', 'sensitive', 'status'] as const) {
    if (input[key] !== undefined && input[key] !== before[key]) data[key] = input[key];
  }
  if (Object.keys(data).length === 0) return typeDto(before);
  if (typeof data.name === 'string' && data.name.trim().toLowerCase() !== before.name.trim().toLowerCase()) await checkTypeName(db, data.name, id);
  const result = await db.peopleLeaveType.updateMany({
    where: { id, version: input.version, archivedAt: null }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'people.leave_type.updated', { type: 'people_leave_type', id }, {
    fields: Object.keys(data).sort(), ...(data.status !== undefined ? { statusFrom: before.status, statusTo: data.status as string } : {}),
  });
  return getLeaveType(db, id);
}

export async function archiveLeaveType(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await loadType(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (before.archivedAt) throw new StateConflictError('archived');
  // Lock first (conflicts with the FOR SHARE a policy insert or restore takes on its type), then check.
  await db.$queryRaw`SELECT id FROM people_leave_types WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
  if ((await db.peopleLeavePolicy.count({ where: { leaveTypeId: id, archivedAt: null } })) > 0) throw new StateConflictError('in_use');
  const result = await db.peopleLeaveType.updateMany({
    where: { id, version: input.version, archivedAt: null }, data: { archivedAt: new Date(), version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'people.leave_type.archived', { type: 'people_leave_type', id }, { category: before.category });
  return getLeaveType(db, id);
}

export async function restoreLeaveType(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await loadType(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (!before.archivedAt) throw new StateConflictError('not_archived');
  await checkTypeName(db, before.name, id);
  const result = await db.peopleLeaveType.updateMany({
    where: { id, version: input.version, archivedAt: { not: null } }, data: { archivedAt: null, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'people.leave_type.restored', { type: 'people_leave_type', id }, { category: before.category });
  return getLeaveType(db, id);
}

// ---- leave policies -----------------------------------------------------------------------------

type PolicyRow = {
  id: string; leaveTypeId: string; name: string; description: string | null; countryCode: string | null; unit: LeaveUnit; granularity: LeaveGranularity;
  entitlementMethod: EntitlementMethod; entitlementAmount: Decimal | null; accrualFrequency: AccrualFrequency | null; yearStart: LeaveYearStart | null;
  yearStartMonth: number | null; yearStartDay: number | null; carryover: CarryoverMode; carryoverCap: Decimal | null; maxBalance: Decimal | null;
  negativeBalanceLimit: Decimal; requiresApproval: boolean; minimumNoticeDays: number | null; allowBackdated: boolean; waitingPeriodDays: number | null;
  status: LeaveConfigStatus; archivedAt: Date | null; version: number; createdAt: Date; updatedAt: Date;
  leaveType: { id: string; name: string; category: LeaveCategory; archivedAt: Date | null };
};
const policySelect = {
  id: true, leaveTypeId: true, name: true, description: true, countryCode: true, unit: true, granularity: true, entitlementMethod: true,
  entitlementAmount: true, accrualFrequency: true, yearStart: true, yearStartMonth: true, yearStartDay: true, carryover: true, carryoverCap: true,
  maxBalance: true, negativeBalanceLimit: true, requiresApproval: true, minimumNoticeDays: true, allowBackdated: true, waitingPeriodDays: true,
  status: true, archivedAt: true, version: true, createdAt: true, updatedAt: true,
  leaveType: { select: { id: true, name: true, category: true, archivedAt: true } },
} as const;

const policyDto = (r: PolicyRow, currentAssignments: number): PolicyDto => ({
  id: r.id, leaveType: { id: r.leaveType.id, name: r.leaveType.name, category: r.leaveType.category, archived: r.leaveType.archivedAt !== null },
  name: r.name, description: r.description, countryCode: r.countryCode, unit: r.unit, granularity: r.granularity,
  entitlementMethod: r.entitlementMethod, entitlementAmount: amount(r.entitlementAmount), accrualFrequency: r.accrualFrequency,
  yearStart: r.yearStart, yearStartMonth: r.yearStartMonth, yearStartDay: r.yearStartDay, carryover: r.carryover, carryoverCap: amount(r.carryoverCap),
  maxBalance: amount(r.maxBalance), negativeBalanceLimit: r.negativeBalanceLimit.toFixed(), requiresApproval: r.requiresApproval,
  minimumNoticeDays: r.minimumNoticeDays, allowBackdated: r.allowBackdated, waitingPeriodDays: r.waitingPeriodDays,
  status: r.status, archivedAt: iso(r.archivedAt), currentAssignments, version: r.version, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});

async function currentCounts(db: AppTenantDb, policyIds: string[]): Promise<Map<string, number>> {
  if (policyIds.length === 0) return new Map();
  const groups = await db.peopleLeavePolicyAssignment.groupBy({ by: ['policyId'], where: { policyId: { in: policyIds }, endsOn: null }, _count: { _all: true } });
  return new Map(groups.map((g) => [g.policyId, g._count._all]));
}

async function loadPolicy(db: AppTenantDb, id: string): Promise<PolicyRow> {
  const row = (await db.peopleLeavePolicy.findFirst({ where: { id }, select: policySelect })) as PolicyRow | null;
  if (!row) throw new RecordNotFoundError();
  return row;
}
export async function getLeavePolicy(db: AppTenantDb, id: string) {
  const row = await loadPolicy(db, id);
  return policyDto(row, (await currentCounts(db, [id])).get(id) ?? 0);
}

async function checkPolicyName(db: AppTenantDb, name: string, exceptId?: string) {
  const clash = await db.peopleLeavePolicy.findFirst({
    where: { name: { equals: name.trim(), mode: 'insensitive' }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true },
  });
  if (clash) throw new StateConflictError('duplicate_name');
}

export interface LeavePolicyQuery { q?: string; leaveTypeId?: string; status: StatusFilter; cursor?: string; limit: number }

export async function listLeavePolicies(db: AppTenantDb, query: LeavePolicyQuery) {
  const where = statusWhere(query.status);
  if (query.leaveTypeId) where.push({ leaveTypeId: query.leaveTypeId });
  if (query.q) where.push({ name: { contains: query.q, mode: 'insensitive' } });
  const list = 'people:leave-policies';
  const filters = filterKey([query.q || null, query.status, query.leaveTypeId?.toLowerCase() ?? null]);
  const after = decodeCursor(query.cursor, list, ['n', 'i', 'f'] as const);
  if (after) {
    if (!UUID.test(after.i) || after.f !== filters) invalidCursor();
    where.push({ OR: [{ name: { gt: after.n } }, { name: after.n, id: { gt: after.i } }] });
  }
  const rows = (await db.peopleLeavePolicy.findMany({
    where: { AND: where }, select: policySelect, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: query.limit + 1,
  })) as PolicyRow[];
  const page = rows.slice(0, query.limit);
  const counts = await currentCounts(db, page.map((r) => r.id));
  const last = page[page.length - 1];
  return {
    policies: page.map((r) => policyDto(r, counts.get(r.id) ?? 0)),
    nextCursor: rows.length > query.limit && last ? encodeCursor(list, { n: last.name, i: last.id, f: filters }) : null,
  };
}

/** The rule fields as a client sends them (all optional on update). */
export interface LeavePolicyRuleInput {
  granularity?: LeaveGranularity; entitlementMethod?: EntitlementMethod; entitlementAmount?: string | null; accrualFrequency?: AccrualFrequency | null;
  yearStart?: LeaveYearStart | null; yearStartMonth?: number | null; yearStartDay?: number | null; carryover?: CarryoverMode; carryoverCap?: string | null;
  maxBalance?: string | null; negativeBalanceLimit?: string; requiresApproval?: boolean; minimumNoticeDays?: number | null; allowBackdated?: boolean;
  waitingPeriodDays?: number | null;
}

/**
 * The full rule set after applying `input` to `base`. Fields that only make sense for another setting are
 * cleared when the client did not send them (switching to "no balance" clears the amount, leave year,
 * carry-over and limits; leaving a custom year clears its month and day; and so on). A value the client
 * did send is kept, so a contradictory request is refused rather than silently corrected.
 */
function mergeRules(base: LeavePolicyRules, input: LeavePolicyRuleInput): LeavePolicyRules {
  const pick = <K extends keyof LeavePolicyRules>(k: K): LeavePolicyRules[K] => (input[k as keyof LeavePolicyRuleInput] !== undefined ? (input[k as keyof LeavePolicyRuleInput] as LeavePolicyRules[K]) : base[k]);
  const sent = (k: keyof LeavePolicyRuleInput) => input[k] !== undefined;
  const r: LeavePolicyRules = {
    unit: base.unit, granularity: pick('granularity'), entitlementMethod: pick('entitlementMethod'), entitlementAmount: pick('entitlementAmount'),
    accrualFrequency: pick('accrualFrequency'), yearStart: pick('yearStart'), yearStartMonth: pick('yearStartMonth'), yearStartDay: pick('yearStartDay'),
    carryover: pick('carryover'), carryoverCap: pick('carryoverCap'), maxBalance: pick('maxBalance'), negativeBalanceLimit: pick('negativeBalanceLimit'),
  };
  if (r.entitlementMethod === 'NONE') {
    if (!sent('entitlementAmount')) r.entitlementAmount = null;
    if (!sent('yearStart')) r.yearStart = null;
    if (!sent('carryover')) r.carryover = 'NONE';
    if (!sent('maxBalance')) r.maxBalance = null;
    if (!sent('negativeBalanceLimit')) r.negativeBalanceLimit = '0';
  }
  if (r.entitlementMethod !== 'ACCRUAL' && !sent('accrualFrequency')) r.accrualFrequency = null;
  if (r.yearStart !== 'CUSTOM') {
    if (!sent('yearStartMonth')) r.yearStartMonth = null;
    if (!sent('yearStartDay')) r.yearStartDay = null;
  }
  if (r.carryover !== 'CAPPED' && !sent('carryoverCap')) r.carryoverCap = null;
  return r;
}

function checkRules(rules: LeavePolicyRules) {
  const problems = leavePolicyProblems(rules);
  if (problems.length > 0) throw new RuleViolationError('invalid_policy', problems.join(' '));
}

const dec = (v: string | null) => (v === null ? null : new Decimal(v));

export interface LeavePolicyInput extends LeavePolicyRuleInput {
  leaveTypeId: string; name: string; description?: string | null; countryCode?: string | null; unit: LeaveUnit;
  granularity: LeaveGranularity; entitlementMethod: EntitlementMethod;
}

export async function createLeavePolicy(db: AppTenantDb, actorUserId: string, input: LeavePolicyInput) {
  const type = await db.peopleLeaveType.findFirst({ where: { id: input.leaveTypeId }, select: { archivedAt: true } });
  if (!type) throw new RuleViolationError('invalid_leave_type', 'Choose a leave type of this business.');
  if (type.archivedAt) throw new StateConflictError('archived_reference');
  const rules = mergeRules({
    unit: input.unit, granularity: input.granularity, entitlementMethod: input.entitlementMethod, entitlementAmount: null, accrualFrequency: null,
    yearStart: null, yearStartMonth: null, yearStartDay: null, carryover: 'NONE', carryoverCap: null, maxBalance: null, negativeBalanceLimit: '0',
  }, input);
  checkRules(rules);
  await checkPolicyName(db, input.name);
  const id = randomUUID();
  await db.peopleLeavePolicy.create({
    data: {
      id, leaveTypeId: input.leaveTypeId, name: input.name, description: input.description ?? null, countryCode: input.countryCode ?? null,
      unit: rules.unit, granularity: rules.granularity, entitlementMethod: rules.entitlementMethod, entitlementAmount: dec(rules.entitlementAmount),
      accrualFrequency: rules.accrualFrequency, yearStart: rules.yearStart, yearStartMonth: rules.yearStartMonth, yearStartDay: rules.yearStartDay,
      carryover: rules.carryover, carryoverCap: dec(rules.carryoverCap), maxBalance: dec(rules.maxBalance), negativeBalanceLimit: new Decimal(rules.negativeBalanceLimit),
      requiresApproval: input.requiresApproval ?? true, minimumNoticeDays: input.minimumNoticeDays ?? null, allowBackdated: input.allowBackdated ?? false,
      waitingPeriodDays: input.waitingPeriodDays ?? null, createdById: actorUserId, updatedById: actorUserId,
    } as never,
  });
  await recordAudit(db, actorUserId, 'people.leave_policy.created', { type: 'people_leave_policy', id }, {
    leaveTypeId: input.leaveTypeId, unit: rules.unit, entitlementMethod: rules.entitlementMethod,
  });
  return getLeavePolicy(db, id);
}

export interface LeavePolicyPatch extends LeavePolicyRuleInput {
  version: number; name?: string; description?: string | null; countryCode?: string | null; status?: LeaveConfigStatus;
}

const rulesOf = (r: PolicyRow): LeavePolicyRules => ({
  unit: r.unit, granularity: r.granularity, entitlementMethod: r.entitlementMethod, entitlementAmount: amount(r.entitlementAmount),
  accrualFrequency: r.accrualFrequency, yearStart: r.yearStart, yearStartMonth: r.yearStartMonth, yearStartDay: r.yearStartDay, carryover: r.carryover,
  carryoverCap: amount(r.carryoverCap), maxBalance: amount(r.maxBalance), negativeBalanceLimit: r.negativeBalanceLimit.toFixed(),
});
const sameAmount = (a: string | null, b: string | null) => (a === null || b === null ? a === b : new Decimal(a).eq(b));
const AMOUNTS = new Set(['entitlementAmount', 'carryoverCap', 'maxBalance', 'negativeBalanceLimit']);

export async function updateLeavePolicy(db: AppTenantDb, actorUserId: string, id: string, input: LeavePolicyPatch) {
  const before = await loadPolicy(db, id);
  if (before.archivedAt) throw new StateConflictError('archived');
  if (before.version !== input.version) throw new StateConflictError('stale');
  const was = rulesOf(before);
  const rules = mergeRules(was, input);
  const data: Record<string, unknown> = {};
  for (const key of Object.keys(rules) as (keyof LeavePolicyRules)[]) {
    if (key === 'unit') continue;
    const a = was[key];
    const b = rules[key];
    const changed = AMOUNTS.has(key) ? !sameAmount(a as string | null, b as string | null) : a !== b;
    if (changed) data[key] = AMOUNTS.has(key) ? dec(b as string | null) : b;
  }
  for (const key of ['name', 'description', 'countryCode', 'requiresApproval', 'minimumNoticeDays', 'allowBackdated', 'waitingPeriodDays', 'status'] as const) {
    if (input[key] !== undefined && input[key] !== before[key]) data[key] = input[key];
  }
  if (Object.keys(data).length === 0) return getLeavePolicy(db, id);
  checkRules(rules);
  if (typeof data.name === 'string' && data.name.trim().toLowerCase() !== before.name.trim().toLowerCase()) await checkPolicyName(db, data.name, id);
  const result = await db.peopleLeavePolicy.updateMany({
    where: { id, version: input.version, archivedAt: null }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'people.leave_policy.updated', { type: 'people_leave_policy', id }, {
    leaveTypeId: before.leaveTypeId, fields: Object.keys(data).sort(),
    ...(data.status !== undefined ? { statusFrom: before.status, statusTo: data.status as string } : {}),
  });
  return getLeavePolicy(db, id);
}

export async function archiveLeavePolicy(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await loadPolicy(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (before.archivedAt) throw new StateConflictError('archived');
  // Lock first (conflicts with the FOR SHARE every new assignment takes), then count current assignments.
  await db.$queryRaw`SELECT id FROM people_leave_policies WHERE id = ${id}::uuid AND business_id = nullif(current_setting('app.business_id', true), '')::uuid FOR UPDATE`;
  if ((await db.peopleLeavePolicyAssignment.count({ where: { policyId: id, endsOn: null } })) > 0) throw new StateConflictError('in_use');
  const result = await db.peopleLeavePolicy.updateMany({
    where: { id, version: input.version, archivedAt: null }, data: { archivedAt: new Date(), version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'people.leave_policy.archived', { type: 'people_leave_policy', id }, { leaveTypeId: before.leaveTypeId });
  return getLeavePolicy(db, id);
}

export async function restoreLeavePolicy(db: AppTenantDb, actorUserId: string, id: string, input: { version: number }) {
  const before = await loadPolicy(db, id);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (!before.archivedAt) throw new StateConflictError('not_archived');
  if (before.leaveType.archivedAt) throw new StateConflictError('archived_reference');
  await checkPolicyName(db, before.name, id);
  const result = await db.peopleLeavePolicy.updateMany({
    where: { id, version: input.version, archivedAt: { not: null } }, data: { archivedAt: null, version: { increment: 1 }, updatedById: actorUserId } as never,
  });
  if (result.count === 0) throw new StateConflictError('stale');
  await recordAudit(db, actorUserId, 'people.leave_policy.restored', { type: 'people_leave_policy', id }, { leaveTypeId: before.leaveTypeId });
  return getLeavePolicy(db, id);
}

/** Every version of a policy's rules, newest first (written by the database; append-only). */
export async function listLeavePolicyRevisions(db: AppTenantDb, policyId: string) {
  await loadPolicy(db, policyId);
  const rows = await db.peopleLeavePolicyRevision.findMany({
    where: { policyId }, select: { version: true, rules: true, recordedById: true, recordedAt: true }, orderBy: { version: 'desc' },
  });
  return {
    revisions: rows.map((r) => ({
      version: r.version, rules: r.rules as Record<string, unknown>, recordedById: r.recordedById, recordedAt: r.recordedAt.toISOString(),
    })),
  };
}
