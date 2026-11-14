import { ProjectSummaryResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { projectSummary } from '@/modules/projects';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

export const GET = tenantRoute({ permission: 'projects:read', response: ProjectSummaryResponse }, async ({ db }) => ({ body: await projectSummary(db) }));

export const OPTIONS = preflight;
