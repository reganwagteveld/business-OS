import { FinanceDocumentResponse, UpdateInvoiceRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getDocument, updateDraft } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: FinanceDocumentResponse }, async ({ db, params }) => ({
  body: { document: await getDocument(db, 'INVOICE', documentIdOf(params)) },
}));

/** Drafts only (409 immutable once issued). `lines`, when given, replaces the whole list. */
export const PATCH = tenantRoute({ permission: 'finance:write', input: UpdateInvoiceRequest, response: FinanceDocumentResponse }, async ({ db, actor, params, input }) => ({
  body: { document: await updateDraft(db, actor.userId, 'INVOICE', documentIdOf(params), input) },
}));

export const OPTIONS = preflight;
