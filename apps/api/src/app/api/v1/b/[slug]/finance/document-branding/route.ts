import { DocumentBrandingResponse, UpdateDocumentBrandingRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { getBranding, updateBranding } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** How this business's quotes and invoices look (finance:read). */
export const GET = tenantRoute({ permission: 'finance:read', response: DocumentBrandingResponse }, async ({ db }) => ({ body: { branding: await getBranding(db) } }));

/** Saves branding; affects only versions generated afterwards (finance:documents_branding). */
export const PATCH = tenantRoute({ permission: 'finance:documents_branding', input: UpdateDocumentBrandingRequest, response: DocumentBrandingResponse }, async ({ db, actor, input }) => ({
  body: { branding: await updateBranding(db, actor.userId, input) },
}));

export const OPTIONS = preflight;
