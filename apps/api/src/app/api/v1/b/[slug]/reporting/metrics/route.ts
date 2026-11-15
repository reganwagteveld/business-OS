import { ReportingCatalogResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { catalog } from '@/modules/reporting';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** The metric registry (definitions and the caller's access to each). Never any data. reporting:read. */
export const GET = tenantRoute({ permission: 'reporting:read', response: ReportingCatalogResponse }, async ({ db, actor }) => ({
  body: await catalog(db, actor),
}));

export const OPTIONS = preflight;
