import { ListMessagesQuery, ListMessagesResponse, MessageResponse, RecordMessageRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listMessages, recordMessage } from '@/modules/communications';
import { conversationIdOf, requireCustomerRead } from '../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The conversation's messages, oldest first. */
export const GET = tenantRoute({ permission: 'communications:read', query: ListMessagesQuery, response: ListMessagesResponse }, async ({ db, actor, params, query }) => {
  requireCustomerRead(actor);
  return { body: await listMessages(db, conversationIdOf(params), query) };
});

/** Records one message that was exchanged outside Business OS. Nothing is sent. */
export const POST = tenantRoute({ permission: 'communications:record', input: RecordMessageRequest, response: MessageResponse }, async ({ db, actor, params, input }) => {
  requireCustomerRead(actor);
  return { status: 201, body: { message: await recordMessage(db, actor.userId, conversationIdOf(params), input) } };
});

export const OPTIONS = preflight;
