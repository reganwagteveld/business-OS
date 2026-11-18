import { ListCreditNotesQuery, ListFinanceDocumentsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { authorizeFinanceLinks, listDocuments } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Credit notes are created from their invoice: POST …/finance/invoices/:documentId/credit-notes. */
/** WF-1 §6.6: the opportunityId filter also needs sales:read (a Finance key never reaches into Sales). */
export const GET = tenantRoute({ permission: 'finance:read', query: ListCreditNotesQuery, response: ListFinanceDocumentsResponse }, async ({ db, actor, query }) => {
  if (query.opportunityId !== undefined) authorizeFinanceLinks(actor, { opportunityId: query.opportunityId });
  return { body: await listDocuments(db, 'CREDIT_NOTE', query) };
});

export const OPTIONS = preflight;
