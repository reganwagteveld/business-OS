import { ListLeavePolicyRevisionsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listLeavePolicyRevisions } from '@/modules/people';
import { leavePolicyIdOf } from '@/app/api/_lib/people';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Every version of the policy's rules, newest first (append-only, written by the database). */
export const GET = tenantRoute({ permission: 'people:read', response: ListLeavePolicyRevisionsResponse }, async ({ db, params }) => ({
  body: await listLeavePolicyRevisions(db, leavePolicyIdOf(params)),
}));

export const OPTIONS = preflight;
