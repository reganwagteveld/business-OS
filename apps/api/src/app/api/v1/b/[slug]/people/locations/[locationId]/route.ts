import { LocationResponse, UpdateLocationRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { toLocation, updateOrgUnit } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const PATCH = tenantRoute({ permission: 'people:configure', input: UpdateLocationRequest, response: LocationResponse }, async ({ db, actor, params, input }) => {
  if (!isUuid(params.locationId)) throw new RecordNotFoundError();
  return { body: { location: toLocation(await updateOrgUnit(db, 'location', actor.userId, params.locationId, input)) } };
});

export const OPTIONS = preflight;
