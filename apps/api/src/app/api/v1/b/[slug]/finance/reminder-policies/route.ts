import { CreateReminderPolicyRequest, ListReminderPoliciesQuery, ListReminderPoliciesResponse, ReminderPolicyResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createReminderPolicy, listReminderPolicies } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-3: payment reminder policies. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListReminderPoliciesQuery, response: ListReminderPoliciesResponse }, async ({ db, query }) => ({
  body: await listReminderPolicies(db, query),
}));

/** Creates a policy (optionally the default). Nothing is sent until C2-C (D-F6-8). finance:billing. */
export const POST = tenantRoute({ permission: 'finance:billing', input: CreateReminderPolicyRequest, response: ReminderPolicyResponse }, async ({ db, actor, input }) => ({
  status: 201, body: { policy: await createReminderPolicy(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
