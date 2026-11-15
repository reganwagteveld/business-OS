import { ListMailProvidersResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listProviders } from '@/modules/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Which mail providers this deployment can connect (an OAuth client is configured). */
export const GET = tenantRoute({ permission: 'communications:connect', response: ListMailProvidersResponse }, async () => ({
  body: { providers: listProviders() },
}));

export const OPTIONS = preflight;
