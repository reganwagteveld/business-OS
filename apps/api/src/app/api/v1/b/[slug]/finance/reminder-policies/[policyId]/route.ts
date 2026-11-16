import { ReminderPolicyResponse, UpdateReminderPolicyRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getReminderPolicy, updateReminderPolicy } from '@/modules/finance';
import { policyIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: ReminderPolicyResponse }, async ({ db, params }) => ({
  body: { policy: await getReminderPolicy(db, policyIdOf(params)) },
}));

/** Changes apply to stages not yet reached. Optimistic concurrency on `version`. finance:billing. */
export const PATCH = tenantRoute({ permission: 'finance:billing', input: UpdateReminderPolicyRequest, response: ReminderPolicyResponse }, async ({ db, actor, params, input }) => ({
  body: { policy: await updateReminderPolicy(db, actor.userId, policyIdOf(params), input) },
}));

export const OPTIONS = preflight;
