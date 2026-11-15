import { EventResponse, UpdateEventRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getEvent, updateEvent, viewerOf } from '@/modules/scheduling';
import { eventIdOf, EventWriteResponse, writeResult } from '@/app/api/_lib/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'scheduling:read', response: EventResponse }, async ({ db, actor, params }) => ({
  body: await getEvent(db, viewerOf(actor), eventIdOf(params)),
}));

export const PATCH = tenantRoute({ permission: 'scheduling:update', input: UpdateEventRequest, response: EventWriteResponse }, async ({ db, actor, params, input }) =>
  writeResult(await updateEvent(db, viewerOf(actor), actor.userId, eventIdOf(params), input)));

export const OPTIONS = preflight;
