import { CreateInvitationRequest, InvitationResponse, InvitationsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createInvitation, listInvitations, sendInvitationEmail } from '@/modules/tenancy';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'members:invite', response: InvitationsResponse }, async ({ db }) => ({
  body: { invitations: await listInvitations(db) },
}));

/**
 * Invites by email. The link carries a one-time token; only its hash is stored. The email is sent
 * after commit; `delivery` reports the outcome (the invitation exists either way).
 */
export const POST = tenantRoute(
  { permission: 'members:invite', input: CreateInvitationRequest, response: InvitationResponse, retryOnConflict: true },
  async ({ db, actor, input }) => {
    const { invitation, token } = await createInvitation(db, actor, input.email, input.role);
    const business = await db.business.findFirst({ select: { name: true } });
    const body: { invitation: typeof invitation; delivery: 'sent' | 'failed' } = { invitation, delivery: 'failed' };
    return {
      status: 201,
      body,
      // The response body is validated after this runs, so it carries the real outcome.
      afterCommit: async () => { body.delivery = await sendInvitationEmail(invitation.email, business?.name ?? null, token); },
    };
  },
);

export const OPTIONS = preflight;
