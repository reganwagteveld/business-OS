import 'server-only';
// Finance F5 route handlers, shared by the quote and invoice paths (docs/finance-documents-f5.md §7).
// Each route file binds them to one document kind; a quote id under /invoices (or the reverse) is 404.
import {
  CreateDocumentPdfVersionRequest, DocumentPdfVersionResponse, ListDocumentPdfVersionsResponse,
} from '@business-os/contracts';
import { RecordNotFoundError } from '@/core/http/errors';
import { contentDisposition, createPdfVersion, draftPreview, getPdfVersion, listPdfVersions, pdfVersionFile, type PdfKind } from '@/modules/finance';
import { documentIdOf } from './finance';
import { isUuid, tenantFileRoute, tenantRoute } from './routes';

const versionIdOf = (params: Record<string, string>): string => {
  if (!isUuid(params.versionId)) throw new RecordNotFoundError();
  return params.versionId;
};

/** Rendering runs inside the unit of work: allow it more than the default 5 s. */
const RENDER_TIMEOUT_MS = 15_000;

export const pdfVersionRoutes = (kind: PdfKind) => ({
  list: tenantRoute({ permission: 'finance:read', response: ListDocumentPdfVersionsResponse }, async ({ db, params }) => ({
    body: await listPdfVersions(db, kind, documentIdOf(params)),
  })),
  create: tenantRoute(
    { permission: 'finance:documents_generate', input: CreateDocumentPdfVersionRequest, response: DocumentPdfVersionResponse, timeoutMs: RENDER_TIMEOUT_MS },
    async ({ db, actor, params, input }) => {
      const out = await createPdfVersion(db, actor.userId, kind, documentIdOf(params), input);
      return { status: out.status, body: { version: out.version } };
    },
  ),
  get: tenantRoute({ permission: 'finance:read', response: DocumentPdfVersionResponse }, async ({ db, params }) => ({
    body: { version: await getPdfVersion(db, kind, documentIdOf(params), versionIdOf(params)) },
  })),
  preview: tenantFileRoute({ permission: 'finance:documents_preview' }, async ({ db, actor, params }) => {
    const file = await pdfVersionFile(db, actor.userId, kind, documentIdOf(params), versionIdOf(params), 'inline');
    return { bytes: file.bytes, contentType: 'application/pdf', sha256: file.sha256, disposition: contentDisposition('inline', file.fileName, file.utf8FileName) };
  }),
  download: tenantFileRoute({ permission: 'finance:documents_download' }, async ({ db, actor, params }) => {
    const file = await pdfVersionFile(db, actor.userId, kind, documentIdOf(params), versionIdOf(params), 'attachment');
    return { bytes: file.bytes, contentType: 'application/pdf', sha256: file.sha256, disposition: contentDisposition('attachment', file.fileName, file.utf8FileName) };
  }),
  draft: tenantFileRoute({ permission: 'finance:documents_preview' }, async ({ db, params }) => {
    const file = await draftPreview(db, kind, documentIdOf(params));
    return { bytes: file.bytes, contentType: 'application/pdf', sha256: file.sha256, disposition: contentDisposition('inline', file.fileName, file.utf8FileName) };
  }),
});
