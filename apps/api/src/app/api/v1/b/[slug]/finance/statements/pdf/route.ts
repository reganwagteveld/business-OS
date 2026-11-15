import { StatementQuery } from '@business-os/contracts';
import { preflight } from '@/core/http';
import { RuleViolationError } from '@/core/http/errors';
import { contentDisposition, statementPdf } from '@/modules/finance';
import { tenantFileRoute } from '@/app/api/_lib/routes';

export const dynamic = 'force-dynamic';

/**
 * F6-2: the statement as a PDF attachment, rendered on demand and never stored (D-F6-9). The same rule
 * as F5's stored-PDF download (finance:documents_download); audited with the sha256 of the bytes served.
 */
export const GET = tenantFileRoute({ permission: 'finance:documents_download' }, async ({ request, db, actor }) => {
  const parsed = StatementQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) throw new RuleViolationError('invalid_query', 'Choose a customer, a currency and a date range.');
  const file = await statementPdf(db, actor.userId, parsed.data);
  return {
    bytes: file.bytes, contentType: 'application/pdf' as const, sha256: file.sha256, disposition: contentDisposition('attachment', file.fileName, file.utf8FileName),
    unsupportedCharacters: file.unsupportedCharacters,
  };
});

export const OPTIONS = preflight;
