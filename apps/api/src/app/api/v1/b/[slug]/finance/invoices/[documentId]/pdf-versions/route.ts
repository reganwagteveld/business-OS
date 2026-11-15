import { preflight } from '@/core/http';
import { pdfVersionRoutes } from '@/app/api/_lib/finance-documents';

export const dynamic = 'force-dynamic';
const routes = pdfVersionRoutes('INVOICE');

/** The document's stored PDF versions, newest first (finance:read). */
export const GET = routes.list;
/** Creates the original (idempotent) or a new version with a reason (finance:documents_generate). */
export const POST = routes.create;
export const OPTIONS = preflight;
