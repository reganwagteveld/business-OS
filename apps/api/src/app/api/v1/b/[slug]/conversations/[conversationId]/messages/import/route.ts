import { ImportMessagesRequest, ImportMessagesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { importMessages } from '@/modules/communications';
import { conversationIdOf, requireCustomerRead } from '../../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Imports up to 100 historical messages, idempotently by external id (all or nothing). */
export const POST = tenantRoute({ permission: 'communications:record', input: ImportMessagesRequest, response: ImportMessagesResponse }, async ({ db, actor, params, input }) => {
  requireCustomerRead(actor);
  return { body: await importMessages(db, actor.userId, conversationIdOf(params), input.messages) };
});

export const OPTIONS = preflight;
