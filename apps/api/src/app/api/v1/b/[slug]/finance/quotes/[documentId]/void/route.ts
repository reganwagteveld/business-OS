import { FinanceDocumentResponse, VoidDocumentRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { voidDocument } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const POST = tenantRoute({ permission: 'finance:issue', input: VoidDocumentRequest, response: FinanceDocumentResponse }, async ({ db, actor, params, input }) => ({
  body: { document: await voidDocument(db, actor.userId, 'QUOTE', documentIdOf(params), input) },
}));

export const OPTIONS = preflight;
