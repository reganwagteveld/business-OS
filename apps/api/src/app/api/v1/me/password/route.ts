import { ChangePasswordRequest, ChangePasswordResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { changePassword } from '@/modules/identity';
import { publicRoute } from '../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Change your password (contract: endpoints.changePassword, Settings A3-A). Needs the current password; ends
 * every other session of the account. Rate-limited per account. Admission required (settings-a3 §15.2).
 */
export const POST = publicRoute({ input: ChangePasswordRequest, response: ChangePasswordResponse }, async ({ user, sessionToken, input }) => ({
  body: await changePassword({ userId: user.id, sessionToken, currentPassword: input.currentPassword, newPassword: input.newPassword }),
}));

export const OPTIONS = preflight;
