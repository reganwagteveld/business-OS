import { ConvertQuoteRequest, FinanceDocumentResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { convertQuote, idempotencyKeyOf } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Creates a draft invoice from the quote (201). Never issues it and never changes the quote. */
export const POST = tenantRoute({ permission: 'finance:write', input: ConvertQuoteRequest, response: FinanceDocumentResponse }, async ({ db, actor, params, input, request }) => {
  const { status, document } = await convertQuote(db, actor.userId, documentIdOf(params), input, idempotencyKeyOf(request));
  return { status, body: { document } };
});

export const OPTIONS = preflight;
