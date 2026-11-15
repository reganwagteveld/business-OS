import { preflight } from '@/core/http';
import { PDF_OPTIONS, pdfHandlers } from '@/app/api/_lib/finance-documents';
import { tenantFileRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** The stored PDF, inline (finance:documents_preview). */
export const GET = tenantFileRoute(PDF_OPTIONS.preview, pdfHandlers('QUOTE').preview);
export const OPTIONS = preflight;
