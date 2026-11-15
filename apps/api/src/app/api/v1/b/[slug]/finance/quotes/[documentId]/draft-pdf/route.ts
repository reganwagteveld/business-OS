import { preflight } from '@/core/http';
import { pdfVersionRoutes } from '@/app/api/_lib/finance-documents';

export const dynamic = 'force-dynamic';

/** A draft rendered on demand, watermarked DRAFT and never stored (finance:documents_preview). */
export const GET = pdfVersionRoutes('QUOTE').draft;
export const OPTIONS = preflight;
