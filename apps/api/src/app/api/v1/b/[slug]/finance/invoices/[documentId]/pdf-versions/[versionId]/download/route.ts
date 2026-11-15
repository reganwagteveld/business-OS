import { preflight } from '@/core/http';
import { pdfVersionRoutes } from '@/app/api/_lib/finance-documents';

export const dynamic = 'force-dynamic';

/** The stored PDF as a file download (finance:documents_download). Audited. */
export const GET = pdfVersionRoutes('INVOICE').download;
export const OPTIONS = preflight;
