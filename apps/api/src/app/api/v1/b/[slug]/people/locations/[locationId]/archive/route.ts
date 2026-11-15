import { LocationResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { archiveOrgUnit, toLocation } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'people:configure', response: LocationResponse }, async ({ db, actor, params }) => {
  if (!isUuid(params.locationId)) throw new RecordNotFoundError();
  return { body: { location: toLocation(await archiveOrgUnit(db, 'location', actor.userId, params.locationId)) } };
});

export const OPTIONS = preflight;
