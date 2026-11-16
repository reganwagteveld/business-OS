import { InvitationResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { NotFoundError, resendInvitation, sendInvitationEmail } from '@/modules/tenancy';
import { isUuid, tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Resend = revoke and reissue (D-A2-6): the old link stops working, a new invitation (new token, new
 * 7-day expiry) replaces it. At most once per 60 seconds (429). `delivery` reports the email outcome.
 */
export const POST = tenantRoute(
  { permission: 'members:invite', response: InvitationResponse, retryOnConflict: true },
  async ({ db, actor, params }) => {
    if (!isUuid(params.invitationId)) throw new NotFoundError();
    const { invitation, token } = await resendInvitation(db, actor, params.invitationId);
    const business = await db.business.findFirst({ select: { name: true } });
    const body: { invitation: typeof invitation; delivery: 'sent' | 'failed' } = { invitation, delivery: 'failed' };
    return {
      status: 201,
      body,
      afterCommit: async () => { body.delivery = await sendInvitationEmail(invitation.email, business?.name ?? null, token); },
    };
  },
);

export const OPTIONS = preflight;
