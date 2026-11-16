import 'server-only';
// Path parameters of the People leave routes (P3-A). A malformed id answers exactly like a missing one (404).
import { RecordNotFoundError } from '@/core/http/errors';
import { isUuid } from './routes';

const idOf = (name: string) => (params: Record<string, string>): string => {
  if (!isUuid(params[name])) throw new RecordNotFoundError();
  return params[name];
};
export const employeeIdOf = idOf('employeeId');
export const leaveTypeIdOf = idOf('leaveTypeId');
export const leavePolicyIdOf = idOf('policyId');
