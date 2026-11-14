import { DiscardDraftRequest, FinanceDocumentResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { discardDraft } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Drafts only: discarding is part of drafting (finance:write); voiding issued documents needs finance:issue. */
export const POST = tenantRoute({ permission: 'finance:write', input: DiscardDraftRequest, response: FinanceDocumentResponse }, async ({ db, actor, params, input }) => ({
  body: { document: await discardDraft(db, actor.userId, 'QUOTE', documentIdOf(params), input) },
}));

export const OPTIONS = preflight;
