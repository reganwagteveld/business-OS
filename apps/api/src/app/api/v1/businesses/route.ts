import { CreateBusinessRequest, CreateBusinessResponse, ListBusinessesResponse } from '@business-os/contracts';
import { betaSessionCanCreateBusiness, createBusiness, myMemberships, TrustedPathError } from '@/core/db';
import { preflight } from '@/core/http';
import { validateNewBusiness } from '@/modules/tenancy';
import { publicRoute } from '../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The signed-in user's businesses (switcher). Resolved in the database from the session token. */
export const GET = publicRoute({ response: ListBusinessesResponse }, async ({ sessionToken }) => ({
  body: { businesses: (await myMemberships(sessionToken)).map((m) => ({ slug: m.slug, name: m.name, role: m.role })) },
}));

/**
 * Creates a business with the caller as its OWNER. The data region is set by the server. Requires the
 * explicit platform business-creation grant (private beta); admission or any membership role alone is
 * not enough. app_private.create_business enforces the same rule independently.
 */
export const POST = publicRoute({ input: CreateBusinessRequest, response: CreateBusinessResponse }, async ({ sessionToken, input }) => {
  if (!await betaSessionCanCreateBusiness(sessionToken)) throw new TrustedPathError('business_creation_not_permitted');
  if (validateNewBusiness(input)) throw new TrustedPathError('invalid');
  const business = await createBusiness(sessionToken, input);
  return { status: 201, body: { business: { slug: business.slug } } };
});

export const OPTIONS = preflight;
