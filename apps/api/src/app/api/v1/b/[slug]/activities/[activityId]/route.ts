import { ActivityResponse, UpdateNoteRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getActivity, updateNote } from '@/modules/activity';
import { activityIdOf, activityViewer } from '../../../../../_lib/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** One timeline entry; a restricted note the caller may not see is a 404, like a missing one. */
export const GET = tenantRoute({ permission: 'activity:read', response: ActivityResponse }, async ({ db, actor, params }) => ({
  body: { activity: await getActivity(db, activityViewer(actor), activityIdOf(params)) },
}));

/** The author edits a note's subject or text. */
export const PATCH = tenantRoute({ permission: 'activity:write', input: UpdateNoteRequest, response: ActivityResponse }, async ({ db, actor, params, input }) => ({
  body: { activity: await updateNote(db, activityViewer(actor), activityIdOf(params), input) },
}));

export const OPTIONS = preflight;
