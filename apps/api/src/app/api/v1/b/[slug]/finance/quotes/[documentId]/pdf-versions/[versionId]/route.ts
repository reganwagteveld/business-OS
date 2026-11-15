import { preflight } from '@/core/http';
import { PDF_OPTIONS, pdfHandlers } from '@/app/api/_lib/finance-documents';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** One stored PDF version's metadata and stable reference (finance:read). */
export const GET = tenantRoute(PDF_OPTIONS.get, pdfHandlers('QUOTE').get);
export const OPTIONS = preflight;
