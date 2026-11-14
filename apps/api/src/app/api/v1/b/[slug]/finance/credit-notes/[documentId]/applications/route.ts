import { ApplyCreditRequest, CreditNoteCreditResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { applyCreditNote, getCreditNoteCredit } from '@/modules/finance';
import { documentIdOf } from '@/app/api/_lib/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'finance:read', response: CreditNoteCreditResponse }, async ({ db, params }) => ({
  body: { credit: await getCreditNoteCredit(db, documentIdOf(params)) },
}));

/** Applies an issued credit note to issued invoices of the same customer and currency (settlement: finance:payments). */
export const POST = tenantRoute({ permission: 'finance:payments', input: ApplyCreditRequest, response: CreditNoteCreditResponse }, async ({ db, actor, params, input }) => ({
  body: { credit: await applyCreditNote(db, actor.userId, documentIdOf(params), input.applications) },
}));

export const OPTIONS = preflight;
