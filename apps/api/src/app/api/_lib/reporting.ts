import 'server-only';
// Path parameters and the caller of the reporting routes. A malformed id answers exactly like a missing one (404).
import { RecordNotFoundError } from '@/core/http/errors';
import type { ReportingActor } from '@/modules/reporting';
import type { Actor } from '@/modules/tenancy';
import { isUuid } from './routes';

export function viewIdOf(params: Record<string, string>): string {
  if (!isUuid(params.viewId)) throw new RecordNotFoundError();
  return params.viewId;
}

/** The verified membership as the reporting module sees it: role-derived permission keys and the session user. */
export const reportingActor = (actor: Actor): ReportingActor => actor;
