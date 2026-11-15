import { ConversationResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getConversation } from '@/modules/communications';
import { conversationIdOf, requireCustomerRead } from '../../../../../_lib/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'communications:read', response: ConversationResponse }, async ({ db, actor, params }) => {
  requireCustomerRead(actor);
  return { body: { conversation: await getConversation(db, conversationIdOf(params)) } };
});

export const OPTIONS = preflight;
