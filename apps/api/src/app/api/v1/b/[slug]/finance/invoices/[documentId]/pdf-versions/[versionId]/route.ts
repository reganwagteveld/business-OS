import { preflight } from '@/core/http';
import { pdfVersionRoutes } from '@/app/api/_lib/finance-documents';

export const dynamic = 'force-dynamic';

/** One version's metadata, including its stable file reference (finance:read). */
export const GET = pdfVersionRoutes('INVOICE').get;
export const OPTIONS = preflight;
