import { describe, expect, it } from 'vitest';
import { CreateReminderPolicyRequest, daysPastDue, dueReminderStage, REMINDER_MAX_LATENESS_DAYS, reminderStageDate, reminderStageState } from '../src/index.ts';

// Finance F6-3 stage rules (docs/finance-billing-f6.md §10.3), shared by the API worker and the clients.
const STAGES = [{ offsetDays: -3, label: 'Due soon' }, { offsetDays: 0, label: 'Due today' }, { offsetDays: 7, label: 'Overdue' }, { offsetDays: 30, label: 'Final' }];
const DUE = '2027-03-31';

describe('reminder stage rules', () => {
  it('dates stages from the due date across month and year ends', () => {
    expect(reminderStageDate(DUE, -3)).toBe('2027-03-28');
    expect(reminderStageDate(DUE, 30)).toBe('2027-04-30');
    expect(reminderStageDate('2027-12-31', 1)).toBe('2028-01-01');
    expect(reminderStageDate('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysPastDue(DUE, '2027-04-07')).toBe(7);
    expect(daysPastDue(DUE, '2027-03-28')).toBe(-3);
  });

  it('only the latest stage whose date has come may be sent; earlier ones are superseded', () => {
    expect(dueReminderStage(STAGES, DUE, '2027-03-27')).toBeNull();
    expect(dueReminderStage(STAGES, DUE, '2027-03-28')?.offsetDays).toBe(-3);
    expect(dueReminderStage(STAGES, DUE, '2027-03-30')?.offsetDays).toBe(-3);
    expect(dueReminderStage(STAGES, DUE, DUE)?.offsetDays).toBe(0);
    expect(reminderStageState(STAGES, DUE, DUE, -3)).toBe('superseded');
    expect(dueReminderStage(STAGES, DUE, '2027-04-07')?.offsetDays).toBe(7);
    expect(reminderStageState(STAGES, DUE, '2027-04-07', 0)).toBe('superseded');
    expect(reminderStageState(STAGES, DUE, '2027-04-07', 30)).toBe('not_yet');
  });

  it('pre-due and due-day reminders go stale once the invoice is overdue', () => {
    expect(dueReminderStage(STAGES, DUE, '2027-04-01')).toBeNull();
    expect(reminderStageState(STAGES, DUE, '2027-04-01', 0)).toBe('stale');
    expect(reminderStageState([{ offsetDays: -3, label: 'Due soon' }], DUE, '2027-04-01', -3)).toBe('stale');
  });

  it(`a stage more than ${REMINDER_MAX_LATENESS_DAYS} days past its date expires: no catch-up floods`, () => {
    expect(dueReminderStage(STAGES, DUE, '2027-04-21')?.offsetDays).toBe(7); // 14 days after its date
    expect(dueReminderStage(STAGES, DUE, '2027-04-22')).toBeNull(); // 15 days: expired, and +30 not yet
    expect(reminderStageState(STAGES, DUE, '2027-04-22', 7)).toBe('expired');
    expect(dueReminderStage(STAGES, DUE, '2027-04-30')?.offsetDays).toBe(30);
    expect(dueReminderStage(STAGES, DUE, '2027-05-15')).toBeNull();
  });

  it('policy requests need ordered stages within range', () => {
    const ok = CreateReminderPolicyRequest.safeParse({ name: 'Std', stages: STAGES });
    expect(ok.success).toBe(true);
    expect(CreateReminderPolicyRequest.safeParse({ name: 'Std', stages: [STAGES[2], STAGES[0]] }).success).toBe(false);
    expect(CreateReminderPolicyRequest.safeParse({ name: 'Std', stages: [{ offsetDays: -61, label: 'x' }] }).success).toBe(false);
    expect(CreateReminderPolicyRequest.safeParse({ name: 'Std', stages: [{ offsetDays: 1, label: ' ' }] }).success).toBe(false);
  });
});
