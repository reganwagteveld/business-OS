import { FinanceSettingsResponse, UpdateFinanceSettingsRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getSettings, updateSettings } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: FinanceSettingsResponse }, async ({ db }) => ({
  body: { settings: await getSettings(db) },
}));

export const PATCH = tenantRoute({ permission: 'finance:manage', input: UpdateFinanceSettingsRequest, response: FinanceSettingsResponse }, async ({ db, actor, input }) => ({
  body: { settings: await updateSettings(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
