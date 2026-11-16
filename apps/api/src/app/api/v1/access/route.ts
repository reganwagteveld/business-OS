import { PlatformAccessResponse } from '@business-os/contracts';
import { betaSessionCanCreateBusiness } from '@/core/db';
import { preflight } from '@/core/http';
import { publicRoute } from '../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * The signed-in, admitted user's platform-level capabilities (private beta). Read from the database on
 * every request; the client uses it only to show or hide "create a business". The server still enforces
 * the rule on POST /businesses and in app_private.create_business.
 */
export const GET = publicRoute({ response: PlatformAccessResponse }, async ({ sessionToken }) => ({
  body: { canCreateBusiness: await betaSessionCanCreateBusiness(sessionToken) },
}));

export const OPTIONS = preflight;
