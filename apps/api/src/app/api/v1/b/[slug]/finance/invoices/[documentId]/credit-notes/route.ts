import { CreateCreditNoteRequest, FinanceDocumentResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { createCreditNote, idempotencyKeyOf } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Creates a draft credit note for an issued invoice (201). It does not settle the invoice (F2). */
export const POST = tenantRoute({ permission: 'finance:write', input: CreateCreditNoteRequest, response: FinanceDocumentResponse }, async ({ db, actor, params, input, request }) => {
  const { status, document } = await createCreditNote(db, actor.userId, documentIdOf(params), input, idempotencyKeyOf(request));
  return { status, body: { document } };
});

export const OPTIONS = preflight;
