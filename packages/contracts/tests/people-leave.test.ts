import { describe, expect, it } from 'vitest';
import { CreateLeavePolicyRequest, LEAVE_TYPE_STARTERS, leavePolicyProblems, type LeavePolicyRules } from '../src/index.ts';

// People P3-A (docs/people-leave-p3.md): the rule combinations the API and the database both enforce.
const none: LeavePolicyRules = {
  unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'NONE', entitlementAmount: null, accrualFrequency: null, yearStart: null,
  yearStartMonth: null, yearStartDay: null, carryover: 'NONE', carryoverCap: null, maxBalance: null, negativeBalanceLimit: '0',
};
const grant: LeavePolicyRules = { ...none, entitlementMethod: 'GRANT', entitlementAmount: '20', yearStart: 'CALENDAR' };

describe('leavePolicyProblems', () => {
  it('accepts consistent policies', () => {
    expect(leavePolicyProblems(none)).toEqual([]);
    expect(leavePolicyProblems(grant)).toEqual([]);
    expect(leavePolicyProblems({ ...grant, entitlementMethod: 'ACCRUAL', accrualFrequency: 'MONTHLY', yearStart: 'CUSTOM', yearStartMonth: 7, yearStartDay: 1 })).toEqual([]);
    expect(leavePolicyProblems({ ...grant, unit: 'HOURS', granularity: 'QUARTER_HOUR', carryover: 'CAPPED', carryoverCap: '0', maxBalance: '40' })).toEqual([]);
  });

  it('explains each inconsistency', () => {
    for (const rules of [
      { ...none, granularity: 'HOUR' as const }, { ...none, unit: 'HOURS' as const }, { ...none, entitlementAmount: '1' }, { ...none, negativeBalanceLimit: '1' },
      { ...grant, entitlementAmount: null }, { ...grant, entitlementAmount: '0' }, { ...grant, yearStart: null }, { ...grant, accrualFrequency: 'WEEKLY' as const },
      { ...grant, entitlementMethod: 'ACCRUAL' as const }, { ...grant, yearStart: 'CUSTOM' as const, yearStartMonth: 2, yearStartDay: 29 },
      { ...grant, yearStart: 'CUSTOM' as const, yearStartMonth: 9, yearStartDay: 31 }, { ...grant, yearStartMonth: 1, yearStartDay: 1 },
      { ...grant, carryover: 'CAPPED' as const }, { ...grant, carryoverCap: '2' }, { ...grant, maxBalance: '0' },
    ]) {
      expect(leavePolicyProblems(rules).length, JSON.stringify(rules)).toBeGreaterThan(0);
    }
  });

  it('starter types carry no entitlement numbers, and the create contract is strict', () => {
    for (const starter of LEAVE_TYPE_STARTERS) expect(Object.keys(starter).sort()).toEqual(['category', 'name', 'paid', 'sensitive']);
    const base = { leaveTypeId: '6f1c2b0e-3a52-4b8e-9b7a-1d2e3f405162', name: 'Annual', unit: 'DAYS', granularity: 'FULL_DAY', entitlementMethod: 'NONE' };
    expect(CreateLeavePolicyRequest.safeParse(base).success).toBe(true);
    expect(CreateLeavePolicyRequest.safeParse({ ...base, countryCode: 'au' }).data?.countryCode).toBe('AU');
    expect(CreateLeavePolicyRequest.safeParse({ ...base, statutoryMinimum: 20 }).success).toBe(false);
    expect(CreateLeavePolicyRequest.safeParse({ ...base, entitlementAmount: '1.23456' }).success).toBe(false);
  });
});
