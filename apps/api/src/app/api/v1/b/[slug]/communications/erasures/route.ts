import { ErasureResponse, ListErasuresQuery, ListErasuresResponse, RequestErasureRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listErasures, requestErasure } from '@/modules/communications';
import { sessionTokenOf } from '../../../../../_lib/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/** Erasure requests and retention purges, newest first (ids and counts only; never content). */
export const GET = tenantRoute(
  { permission: 'communications:manage_connections', query: ListErasuresQuery, response: ListErasuresResponse },
  async ({ db, query }) => ({ body: await listErasures(db, query) }),
);

/**
 * Requests erasure of a contact's communications, a conversation or a message (docs/communications-e1.md §5).
 * Needs a single-use authorisation for this operation and target. 202: recorded and started (a small request
 * is usually already COMPLETED); 200: an open request for the same target already exists.
 */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: RequestErasureRequest, response: ErasureResponse, sessionToken: true, timeoutMs: 15_000 },
  async ({ db, input, sessionToken }) => {
    const { erasure, created } = await requestErasure(db, sessionTokenOf(sessionToken), input);
    return { status: created ? 202 : 200, body: { erasure } };
  },
);

export const OPTIONS = preflight;
