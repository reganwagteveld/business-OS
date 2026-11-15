import { CreateSavedViewRequest, ListSavedViewsQuery, ListSavedViewsResponse, SavedViewResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createView, listViews } from '@/modules/reporting';
import { reportingActor } from '@/app/api/_lib/reporting';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Your own views and the shared views whose every source you can read. reporting:read. */
export const GET = tenantRoute({ permission: 'reporting:read', query: ListSavedViewsQuery, response: ListSavedViewsResponse }, async ({ db, actor, query }) => ({
  body: { views: await listViews(db, reportingActor(actor), query.scope) },
}));

/** Saves a configuration (never results). Private by default; sharing needs reporting:share. reporting:save. */
export const POST = tenantRoute({ permission: 'reporting:save', input: CreateSavedViewRequest, response: SavedViewResponse }, async ({ db, actor, input }) => ({
  status: 201,
  body: { view: await createView(db, reportingActor(actor), input) },
}));

export const OPTIONS = preflight;
