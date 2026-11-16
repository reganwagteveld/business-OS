import { MembersResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listMembers } from '@/modules/tenancy';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Every member sees names, roles and status; emails only for holders of members:invite (D-A2-11). */
export const GET = tenantRoute({ permission: 'members:read', response: MembersResponse }, async ({ db, actor }) => ({
  body: { members: await listMembers(db, actor) },
}));

export const OPTIONS = preflight;
