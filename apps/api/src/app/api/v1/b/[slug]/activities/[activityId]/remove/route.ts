import { ActivityResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { removeActivity } from '@/modules/activity';
import { activityIdOf, activityViewer } from '../../../../../../_lib/communications';
import { tenantRoute } from '../../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** The author removes their own note, call, meeting, email or interaction. System and message entries cannot be removed. */
export const POST = tenantRoute({ permission: 'activity:write', response: ActivityResponse }, async ({ db, actor, params }) => ({
  body: { activity: await removeActivity(db, activityViewer(actor), activityIdOf(params)) },
}));

export const OPTIONS = preflight;
