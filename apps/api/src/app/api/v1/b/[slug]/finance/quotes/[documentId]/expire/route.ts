import { FinanceDocumentResponse, QuoteTransitionRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { transitionQuote } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'finance:issue', input: QuoteTransitionRequest, response: FinanceDocumentResponse }, async ({ db, actor, params, input }) => ({
  body: { document: await transitionQuote(db, actor.userId, documentIdOf(params), 'EXPIRED', input) },
}));

export const OPTIONS = preflight;
