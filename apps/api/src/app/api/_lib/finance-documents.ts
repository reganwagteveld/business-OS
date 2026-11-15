import 'server-only';
// Finance F5 route handlers, shared by the quote and invoice paths (docs/finance-documents-f5.md §7).
// Each route file binds them to one document kind; a quote id under /invoices (or the reverse) is 404.
import {
  CreateDocumentPdfVersionRequest, DocumentPdfVersionResponse, ListDocumentPdfVersionsResponse,
} from '@business-os/contracts';
import { RecordNotFoundError } from '@/core/http/errors';
import { contentDisposition, createPdfVersion, draftPreview, getPdfVersion, listPdfVersions, pdfVersionFile, type PdfKind } from '@/modules/finance';
import { documentIdOf } from './finance';
import type { z } from 'zod';
import type { AppTenantDb } from '@/core/db';
import { isUuid } from './routes';

const versionIdOf = (params: Record<string, string>): string => {
  if (!isUuid(params.versionId)) throw new RecordNotFoundError();
  return params.versionId;
};

/** Rendering runs inside the unit of work: allow it more than the default 5 s. */
const RENDER_TIMEOUT_MS = 15_000;

/**
 * Route options and handlers, bound to one document kind. Each route file wraps them itself with
 * tenantRoute / tenantFileRoute (scripts/check-boundaries.mjs requires the wrapper in the route file).
 */
export const PDF_OPTIONS = {
  list: { permission: 'finance:read', response: ListDocumentPdfVersionsResponse },
  create: { permission: 'finance:documents_generate', input: CreateDocumentPdfVersionRequest, response: DocumentPdfVersionResponse, timeoutMs: RENDER_TIMEOUT_MS },
  get: { permission: 'finance:read', response: DocumentPdfVersionResponse },
  preview: { permission: 'finance:documents_preview' },
  download: { permission: 'finance:documents_download' },
  draft: { permission: 'finance:documents_preview' },
} as const;

type Ctx = { db: AppTenantDb; actor: { userId: string }; params: Record<string, string> };

export const pdfHandlers = (kind: PdfKind) => ({
  list: async ({ db, params }: Ctx) => ({ body: await listPdfVersions(db, kind, documentIdOf(params)) }),
  create: async ({ db, actor, params, input }: Ctx & { input: z.infer<typeof CreateDocumentPdfVersionRequest> }) => {
    const out = await createPdfVersion(db, actor.userId, kind, documentIdOf(params), input);
    return { status: out.status, body: { version: out.version } };
  },
  get: async ({ db, params }: Ctx) => ({ body: { version: await getPdfVersion(db, kind, documentIdOf(params), versionIdOf(params)) } }),
  preview: async ({ db, actor, params }: Ctx) => {
    const file = await pdfVersionFile(db, actor.userId, kind, documentIdOf(params), versionIdOf(params), 'inline');
    return { bytes: file.bytes, contentType: 'application/pdf' as const, sha256: file.sha256, disposition: contentDisposition('inline', file.fileName, file.utf8FileName) };
  },
  download: async ({ db, actor, params }: Ctx) => {
    const file = await pdfVersionFile(db, actor.userId, kind, documentIdOf(params), versionIdOf(params), 'attachment');
    return { bytes: file.bytes, contentType: 'application/pdf' as const, sha256: file.sha256, disposition: contentDisposition('attachment', file.fileName, file.utf8FileName) };
  },
  draft: async ({ db, actor, params }: Ctx) => {
    const file = await draftPreview(db, actor.userId, kind, documentIdOf(params));
    return {
      bytes: file.bytes, contentType: 'application/pdf' as const, sha256: file.sha256, disposition: contentDisposition('inline', file.fileName, file.utf8FileName),
      unsupportedCharacters: file.unsupportedCharacters,
    };
  },
});
