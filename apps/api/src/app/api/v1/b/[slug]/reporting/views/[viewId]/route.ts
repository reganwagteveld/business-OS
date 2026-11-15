import { DeleteSavedViewResponse, SavedViewResponse, UpdateSavedViewRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { deleteView, getView, updateView } from '@/modules/reporting';
import { reportingActor, viewIdOf } from '@/app/api/_lib/reporting';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'reporting:read', response: SavedViewResponse }, async ({ db, actor, params }) => ({
  body: { view: await getView(db, reportingActor(actor), viewIdOf(params)) },
}));

/** Owner only (403 for someone else's shared view). 409 stale when `version` is not current. reporting:save. */
export const PATCH = tenantRoute({ permission: 'reporting:save', input: UpdateSavedViewRequest, response: SavedViewResponse }, async ({ db, actor, params, input }) => ({
  body: { view: await updateView(db, reportingActor(actor), viewIdOf(params), input) },
}));

/** The owner, or reporting:manage for a shared view. Removes the configuration only. reporting:save. */
export const DELETE = tenantRoute({ permission: 'reporting:save', response: DeleteSavedViewResponse }, async ({ db, actor, params }) => {
  await deleteView(db, reportingActor(actor), viewIdOf(params));
  return { body: { ok: true as const } };
});

export const OPTIONS = preflight;
