import 'server-only';
// Invitation email (D-A2-5: platform email through core/email, never Communications). Sent only after
// the unit of work committed. A failed send never undoes the invitation: the caller reports
// `delivery: "failed"` and the person can resend (docs/administration-a2.md §6.2). The token is in the
// body only: never logged, audited or put in an error.
import { getEnv } from '@/core/config/env';
import { sendEmail } from '@/core/email';

export async function sendInvitationEmail(to: string, businessName: string | null, token: string): Promise<'sent' | 'failed'> {
  try {
    await sendEmail({
      to,
      subject: `You're invited to ${businessName ?? 'a business'} on Business OS`,
      text: `Accept the invitation: ${getEnv().APP_BASE_URL}/invite?token=${token}\n\nThe link expires in 7 days and works only for this email address.`,
    });
    return 'sent';
  } catch (error) {
    console.error('[invitations] email delivery failed', error instanceof Error ? error.name : typeof error);
    return 'failed';
  }
}
