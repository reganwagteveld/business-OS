import { CreateInvitationRequest, InvitationResponse, InvitationsResponse } from '@business-os/contracts';
import { getEnv } from '@/core/config/env';
import { sendEmail } from '@/core/email';
import { preflight } from '@/core/http';
import { createInvitation, listInvitations } from '@/modules/tenancy';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'members:invite', response: InvitationsResponse }, async ({ db }) => ({
  body: { invitations: await listInvitations(db) },
}));

/** Invites by email. The link carries a one-time token; only its hash is stored. */
export const POST = tenantRoute({ permission: 'members:invite', input: CreateInvitationRequest, response: InvitationResponse }, async ({ db, actor, input }) => {
  const { invitation, token } = await createInvitation(db, actor, input.email, input.role);
  const business = await db.business.findFirst({ select: { name: true } });
  return {
    status: 201,
    body: { invitation },
    afterCommit: () =>
      sendEmail({
        to: invitation.email,
        subject: `You're invited to ${business?.name ?? 'a business'} on Business OS`,
        text: `Accept the invitation: ${getEnv().APP_BASE_URL}/invite?token=${token}\n\nThe link expires in 7 days and works only for this email address.`,
      }),
  };
});

export const OPTIONS = preflight;
