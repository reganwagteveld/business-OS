import { ConversationResponse, CreateConversationRequest, ListConversationsQuery, ListConversationsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createConversation, listConversations } from '@/modules/communications';
import { requireCustomerRead } from '../../../../_lib/communications';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Conversations of the business, one customer or one contact, newest first. */
export const GET = tenantRoute({ permission: 'communications:read', query: ListConversationsQuery, response: ListConversationsResponse }, async ({ db, actor, query }) => {
  requireCustomerRead(actor);
  return { body: await listConversations(db, query) };
});

/** Opens a conversation record for history exchanged outside Business OS. */
export const POST = tenantRoute({ permission: 'communications:record', input: CreateConversationRequest, response: ConversationResponse }, async ({ db, actor, input }) => {
  requireCustomerRead(actor);
  return { status: 201, body: { conversation: await createConversation(db, actor.userId, input) } };
});

export const OPTIONS = preflight;
