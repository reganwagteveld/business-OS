import { FinanceDocumentResponse, IssueDocumentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { issueWithOriginal } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * Issues the invoice and, in the same transaction, creates and keeps its original PDF (F5-D2). If the PDF
 * cannot be made or stored, nothing is issued. Rendering needs more than the default 5 s budget.
 */
export const POST = tenantRoute(
  { permission: 'finance:issue', input: IssueDocumentRequest, response: FinanceDocumentResponse, timeoutMs: 15_000 },
  async ({ db, actor, params, input }) => ({ body: { document: (await issueWithOriginal(db, actor.userId, 'INVOICE', documentIdOf(params), input)).document } }),
);

export const OPTIONS = preflight;
