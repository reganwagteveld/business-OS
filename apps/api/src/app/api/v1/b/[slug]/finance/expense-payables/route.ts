import { ExpensePayablesResponse } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { expensePayables } from '@/modules/finance';
import { tenantRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/** Recorded, not fully paid expenses per currency. Drafts and void expenses are excluded. */
export const GET = tenantRoute({ permission: 'finance:read', response: ExpensePayablesResponse }, async ({ db }) => ({
  body: { payables: await expensePayables(db) },
}));

export const OPTIONS = preflight;
