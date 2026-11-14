import { ListCreditNotesQuery, ListFinanceDocumentsResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { listDocuments } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Credit notes are created from their invoice: POST …/finance/invoices/:documentId/credit-notes. */
export const GET = tenantRoute({ permission: 'finance:read', query: ListCreditNotesQuery, response: ListFinanceDocumentsResponse }, async ({ db, query }) => ({
  body: await listDocuments(db, 'CREDIT_NOTE', query),
}));

export const OPTIONS = preflight;
