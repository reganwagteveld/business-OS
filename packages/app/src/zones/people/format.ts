import type { Employee, EmploymentStatus, EmploymentType } from '@business-os/contracts';
import type { BadgeTone } from '@business-os/ui';

export { formatDate, formatWhen } from '../sales/format';

export const STATUS_LABEL: Record<EmploymentStatus, string> = { PENDING: 'Pending start', ACTIVE: 'Active', ON_LEAVE: 'On leave', TERMINATED: 'Terminated' };
export const STATUS_TONE: Record<EmploymentStatus, BadgeTone> = { PENDING: 'info', ACTIVE: 'success', ON_LEAVE: 'warning', TERMINATED: 'neutral' };

export const TYPE_LABEL: Record<EmploymentType, string> = {
  FULL_TIME: 'Full time', PART_TIME: 'Part time', CASUAL: 'Casual', CONTRACTOR: 'Contractor', TEMPORARY: 'Temporary', OTHER: 'Other',
};
export const EMPLOYMENT_TYPES = Object.entries(TYPE_LABEL).map(([value, label]) => ({ value: value as EmploymentType, label }));

/**
 * The lifecycle P1 defines (docs/people-data-model.md §3), for presentation only: which actions to offer.
 * The server and a database trigger enforce the same rules, so a stale or forged request is still refused.
 */
export const TRANSITIONS: Record<EmploymentStatus, readonly { to: EmploymentStatus; label: string }[]> = {
  PENDING: [{ to: 'ACTIVE', label: 'Activate' }, { to: 'TERMINATED', label: 'Withdraw offer' }],
  ACTIVE: [{ to: 'ON_LEAVE', label: 'Mark on leave' }, { to: 'TERMINATED', label: 'Terminate' }],
  ON_LEAVE: [{ to: 'ACTIVE', label: 'Return from leave' }, { to: 'TERMINATED', label: 'Terminate' }],
  TERMINATED: [{ to: 'ACTIVE', label: 'Rehire as active' }, { to: 'PENDING', label: 'Rehire as pending' }],
};

/** Server reasons for a refused status change, in words a person can act on. */
export const STATUS_ERRORS: Record<string, string> = {
  invalid_transition: 'That change is not allowed from the current status. Reload and check the status.',
  has_direct_reports: 'This person still has direct reports. Reassign them before terminating.',
  stale: 'Someone else changed this employee. Reload to see the latest, then try again.',
  terminated: 'This employee has been terminated.',
};

export const fullName = (e: Pick<Employee, 'displayName'>) => e.displayName;

/** A real calendar date check, the same rule as the contract (YYYY-MM-DD that round-trips). */
export const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
