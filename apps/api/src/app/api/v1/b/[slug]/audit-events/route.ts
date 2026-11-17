import { ListAuditEventsQuery, ListAuditEventsResponse } from '@business-os/contracts';
import { listAuditEvents } from '@/core/audit';
import { preflight } from '@/core/http';
import { tenantRoute } from '../../../../_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * The business's recorded changes, newest first, at most 92 days per request (follow nextCursor). audit:read
 * (OWNER and ADMIN). Metadata and targets are shown only as the view rules allow (docs/administration-audit-viewer.md).
 */
export const GET = tenantRoute({ permission: 'audit:read', query: ListAuditEventsQuery, response: ListAuditEventsResponse }, async ({ db, query }) => ({
  body: await listAuditEvents(db, query),
}));

export const OPTIONS = preflight;
