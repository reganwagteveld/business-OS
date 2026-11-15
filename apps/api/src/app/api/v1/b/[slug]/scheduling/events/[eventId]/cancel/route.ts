import { EventResponse, EventTransitionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { cancelEvent, viewerOf } from '@/modules/scheduling';
import { eventIdOf } from '@/app/api/_lib/scheduling';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'scheduling:cancel', input: EventTransitionRequest, response: EventResponse }, async ({ db, actor, params, input }) => ({
  body: await cancelEvent(db, viewerOf(actor), actor.userId, eventIdOf(params), input.version),
}));

export const OPTIONS = preflight;
