import { PersonalDetailsResponse, UpdatePersonalDetailsRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RecordNotFoundError } from '@/core/http/errors';
import { getPersonalDetails, updatePersonalDetails, viewerOf } from '@/modules/people';
import { isUuid, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

const idOf = (params: Record<string, string>) => {
  if (!isUuid(params.employeeId)) throw new RecordNotFoundError();
  return params.employeeId;
};

// Personal details need people:read_sensitive to read; writing also needs people:manage. The service
// checks read_sensitive again, so neither key alone reaches these fields.
export const GET = tenantRoute({ permission: 'people:read_sensitive', response: PersonalDetailsResponse }, async ({ db, actor, params }) => ({
  body: { personalDetails: await getPersonalDetails(db, viewerOf(actor), idOf(params)) },
}));

export const PATCH = tenantRoute(
  { permission: 'people:manage', input: UpdatePersonalDetailsRequest, response: PersonalDetailsResponse },
  async ({ db, actor, params, input }) => ({ body: { personalDetails: await updatePersonalDetails(db, viewerOf(actor), actor.userId, idOf(params), input) } }),
);

export const OPTIONS = preflight;
