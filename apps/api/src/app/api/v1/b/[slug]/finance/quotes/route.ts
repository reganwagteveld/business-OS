import { CreateQuoteRequest, FinanceDocumentResponse, ListFinanceDocumentsResponse, ListQuotesQuery } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { authorizeFinanceLinks, createQuote, idempotencyKeyOf, listDocuments } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** WF-1 §6.6: the opportunityId filter also needs sales:read (a Finance key never reaches into Sales). */
export const GET = tenantRoute({ permission: 'finance:read', query: ListQuotesQuery, response: ListFinanceDocumentsResponse }, async ({ db, actor, query }) => {
  if (query.opportunityId !== undefined) authorizeFinanceLinks(actor, { opportunityId: query.opportunityId });
  return { body: await listDocuments(db, 'QUOTE', query) };
});

/** 201 with the new draft; 200 with the first draft when an Idempotency-Key is repeated with the same request. */
export const POST = tenantRoute({ permission: 'finance:write', input: CreateQuoteRequest, response: FinanceDocumentResponse }, async ({ db, actor, input, request }) => {
  authorizeFinanceLinks(actor, input); // D-WF1-11
  const { status, document } = await createQuote(db, actor.userId, input, idempotencyKeyOf(request));
  return { status, body: { document } };
});

export const OPTIONS = preflight;
