import { preflight } from '@/core/http';
import { pdfVersionRoutes } from '@/app/api/_lib/finance-documents';

export const dynamic = 'force-dynamic';

/** The stored PDF, inline (finance:documents_preview). Not audited. */
export const GET = pdfVersionRoutes('QUOTE').preview;
export const OPTIONS = preflight;
