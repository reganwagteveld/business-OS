import { AcceptInvitationRequest, AcceptInvitationResponse } from '@business-os/contracts';
import { acceptInvitation } from '@/core/db';
import { preflight } from '@/core/http';
import { publicRoute } from '../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Accepts an invitation for the signed-in user; their verified email must match. Generic failure. */
export const POST = publicRoute({ input: AcceptInvitationRequest, response: AcceptInvitationResponse }, async ({ sessionToken, input }) => {
  const accepted = await acceptInvitation(sessionToken, input.token);
  return { body: { business: { slug: accepted.slug, role: accepted.role } } };
});

export const OPTIONS = preflight;
