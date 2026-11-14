import { ActivityResponse, CreateActivityRequest, ListActivitiesQuery, ListActivitiesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createActivity, listActivities } from '@/modules/activity';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Timeline, newest first; filter by one customer (includes its contacts' activity) or one contact. */
export const GET = tenantRoute({ permission: 'activity:read', query: ListActivitiesQuery, response: ListActivitiesResponse }, async ({ db, query }) => ({
  body: await listActivities(db, query),
}));

export const POST = tenantRoute({ permission: 'activity:write', input: CreateActivityRequest, response: ActivityResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { activity: await createActivity(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
