import { DocumentBrandingResponse, UploadBrandingLogoRequest } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { currentLogo, uploadLogo } from '@/modules/finance';
import { tenantFileRoute, tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** The current logo image, for the settings preview (finance:read). 404 when there is none. */
export const GET = tenantFileRoute({ permission: 'finance:read' }, async ({ db }) => {
  const logo = await currentLogo(db);
  return { bytes: logo.bytes, contentType: logo.contentType as 'image/png' | 'image/jpeg', sha256: logo.sha256 };
});

/** Uploads a PNG or JPEG logo and makes it the business's logo (finance:documents_branding). */
export const POST = tenantRoute(
  { permission: 'finance:documents_branding', input: UploadBrandingLogoRequest, response: DocumentBrandingResponse, timeoutMs: 15_000 },
  async ({ db, actor, input }) => ({ status: 201, body: { branding: await uploadLogo(db, actor.userId, input) } }),
);

export const OPTIONS = preflight;
