import { preflight } from '@/core/http';
import { PDF_OPTIONS, pdfHandlers } from '@/app/api/_lib/finance-documents';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';
const h = pdfHandlers('INVOICE');

/** The document's stored PDF versions, newest first, and whether it can have any (finance:read). */
export const GET = tenantRoute(PDF_OPTIONS.list, h.list);
/** Creates the original (idempotent) or a new version with a reason (finance:documents_generate). */
export const POST = tenantRoute(PDF_OPTIONS.create, h.create);
export const OPTIONS = preflight;
