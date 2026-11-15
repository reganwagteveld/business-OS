import 'server-only';
// Path parameters and the conflict response of the scheduling routes. A malformed id answers exactly
// like a missing one (404).
import { EventResponse, SchedulingConflictResponse } from '@business-os/contracts';
import { z } from 'zod';
import { RecordNotFoundError } from '@/core/http/errors';
import type { WriteResult } from '@/modules/scheduling';
import { isUuid, type Result } from './routes';

const idOf = (name: string) => (params: Record<string, string>): string => {
  if (!isUuid(params[name])) throw new RecordNotFoundError();
  return params[name];
};
export const calendarIdOf = idOf('calendarId');
export const eventIdOf = idOf('eventId');

/** A write answers with the event, or 409 scheduling_conflict listing what it overlaps (nothing was written). */
export const EventWriteResponse = z.union([EventResponse, SchedulingConflictResponse]);
export function writeResult(result: WriteResult, status = 200): Result<z.infer<typeof EventWriteResponse>> {
  if (result.kind === 'conflict') return { status: 409, body: { error: 'scheduling_conflict', conflicts: result.conflicts } };
  return { status, body: { event: result.event, conflicts: result.conflicts } };
}
