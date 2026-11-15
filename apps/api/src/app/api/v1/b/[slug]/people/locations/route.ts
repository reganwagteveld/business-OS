import { CreateLocationRequest, LocationResponse, ListLocationsResponse, ListOrgUnitsQuery } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createOrgUnit, listOrgUnits, toLocation } from '@/modules/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'people:read', query: ListOrgUnitsQuery, response: ListLocationsResponse }, async ({ db, query }) => {
  const { rows, nextCursor } = await listOrgUnits(db, 'location', query);
  return { body: { locations: rows.map(toLocation), nextCursor } };
});

export const POST = tenantRoute({ permission: 'people:configure', input: CreateLocationRequest, response: LocationResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { location: toLocation(await createOrgUnit(db, 'location', actor.userId, input)) },
}));

export const OPTIONS = preflight;
