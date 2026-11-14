import { FinanceDocumentResponse, IssueDocumentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { issueDocument } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'finance:issue', input: IssueDocumentRequest, response: FinanceDocumentResponse }, async ({ db, actor, params, input }) => ({
  body: { document: await issueDocument(db, actor.userId, 'QUOTE', documentIdOf(params), input) },
}));

export const OPTIONS = preflight;
