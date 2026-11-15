import { preflight } from '@/core/http';
import { PDF_OPTIONS, pdfHandlers } from '@/app/api/_lib/finance-documents';
import { tenantFileRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** A watermarked preview of a draft, rendered on demand and never stored (finance:documents_preview). */
export const GET = tenantFileRoute(PDF_OPTIONS.draft, pdfHandlers('INVOICE').draft);
export const OPTIONS = preflight;
