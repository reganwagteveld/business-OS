import { CustomerReminderSettingsResponse, UpdateCustomerReminderSettingsRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getCustomerReminderSettings, updateCustomerReminderSettings } from '@/modules/finance';
import { customerIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** F6-3: the customer's reminder policy and the holds in effect for it. finance:read. */
export const GET = tenantRoute({ permission: 'finance:read', response: CustomerReminderSettingsResponse }, async ({ db, params }) => ({
  body: { settings: await getCustomerReminderSettings(db, customerIdOf(params)) },
}));

/** Assigns a policy (null = the business default). finance:billing. */
export const PUT = tenantRoute({ permission: 'finance:billing', input: UpdateCustomerReminderSettingsRequest, response: CustomerReminderSettingsResponse }, async ({ db, actor, params, input }) => ({
  body: { settings: await updateCustomerReminderSettings(db, actor.userId, customerIdOf(params), input) },
}));

export const OPTIONS = preflight;
