import { preflight } from '@/core/http';
import { PDF_OPTIONS, pdfHandlers } from '@/app/api/_lib/finance-documents';
import { tenantFileRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** The stored PDF as an attachment (finance:documents_download). Audited. */
export const GET = tenantFileRoute(PDF_OPTIONS.download, pdfHandlers('INVOICE').download);
export const OPTIONS = preflight;
