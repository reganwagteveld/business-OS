import { ArchiveReminderPolicyRequest, ReminderPolicyResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { archiveReminderPolicy } from '@/modules/finance';
import { policyIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Final. Refused while customers are assigned to the policy (409 in_use). finance:billing. */
export const POST = tenantRoute({ permission: 'finance:billing', input: ArchiveReminderPolicyRequest, response: ReminderPolicyResponse }, async ({ db, actor, params, input }) => ({
  body: { policy: await archiveReminderPolicy(db, actor.userId, policyIdOf(params), input) },
}));

export const OPTIONS = preflight;
