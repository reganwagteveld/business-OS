import { CreateEventRequest, ListEventsQuery, ListEventsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createEvent, listEvents, viewerOf } from '@/modules/scheduling';
import { EventWriteResponse, writeResult } from '@/app/api/_lib/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'scheduling:read', query: ListEventsQuery, response: ListEventsResponse }, async ({ db, actor, query }) => ({
  body: await listEvents(db, viewerOf(actor), query),
}));

export const POST = tenantRoute({ permission: 'scheduling:create', input: CreateEventRequest, response: EventWriteResponse }, async ({ db, actor, input }) =>
  writeResult(await createEvent(db, viewerOf(actor), actor.userId, input), 201));

export const OPTIONS = preflight;
