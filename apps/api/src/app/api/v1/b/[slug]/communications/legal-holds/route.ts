import { LegalHoldResponse, ListLegalHoldsQuery, ListLegalHoldsResponse, PlaceLegalHoldRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listLegalHolds, placeLegalHold } from '@/modules/communications';
import { tenantRoute } from '../../../../../_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute(
  { permission: 'communications:manage_connections', query: ListLegalHoldsQuery, response: ListLegalHoldsResponse },
  async ({ db, query }) => ({ body: { holds: await listLegalHolds(db, query.includeReleased === 'true') } }),
);

/**
 * Places a legal hold (docs/communications-e1.md §6). Placing only protects data, so it needs no single-use
 * authorisation; releasing does. Idempotent: 201 new, 200 an active hold on the same target already exists.
 */
export const POST = tenantRoute(
  { permission: 'communications:manage_connections', input: PlaceLegalHoldRequest, response: LegalHoldResponse },
  async ({ db, actor, input }) => {
    const { hold, created } = await placeLegalHold(db, actor.userId, input);
    return { status: created ? 201 : 200, body: { hold } };
  },
);

export const OPTIONS = preflight;
