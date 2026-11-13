import { MembersResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listMembers } from '@/modules/tenancy';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'members:read', response: MembersResponse }, async ({ db }) => ({
  body: { members: await listMembers(db) },
}));

export const OPTIONS = preflight;
