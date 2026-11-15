import { ActivityResponse, CreateActivityRequest, ListActivitiesQuery, ListActivitiesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createActivity, listActivities } from '@/modules/activity';
import { activityViewer } from '../../../../_lib/communications';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * The unified timeline, newest first: the whole business, one customer (including its contacts'
 * activity) or one contact; optionally only some types or one visibility. Restricted notes and
 * message entries appear only for those allowed to see them.
 */
export const GET = tenantRoute({ permission: 'activity:read', query: ListActivitiesQuery, response: ListActivitiesResponse }, async ({ db, actor, query }) => ({
  body: await listActivities(db, activityViewer(actor), query),
}));

export const POST = tenantRoute({ permission: 'activity:write', input: CreateActivityRequest, response: ActivityResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { activity: await createActivity(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
