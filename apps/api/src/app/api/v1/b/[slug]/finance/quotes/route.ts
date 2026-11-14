import { CreateQuoteRequest, FinanceDocumentResponse, ListFinanceDocumentsResponse, ListQuotesQuery } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createQuote, idempotencyKeyOf, listDocuments } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', query: ListQuotesQuery, response: ListFinanceDocumentsResponse }, async ({ db, query }) => ({
  body: await listDocuments(db, 'QUOTE', query),
}));

/** 201 with the new draft; 200 with the first draft when an Idempotency-Key is repeated with the same request. */
export const POST = tenantRoute({ permission: 'finance:write', input: CreateQuoteRequest, response: FinanceDocumentResponse }, async ({ db, actor, input, request }) => {
  const { status, document } = await createQuote(db, actor.userId, input, idempotencyKeyOf(request));
  return { status, body: { document } };
});

export const OPTIONS = preflight;
