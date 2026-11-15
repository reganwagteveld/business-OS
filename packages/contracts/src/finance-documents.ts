import { z } from 'zod';

// Finance F5 (docs/finance-documents-f5.md): generated documents for quotes and invoices, and the
// business's document branding. Every path is under /api/v1/b/:slug/finance. Bodies are strict.
//
// A PDF version is an immutable record of a rendered document. Generating or downloading one never
// sends it anywhere and never changes the quote or invoice: there is no "sent" state here at all.

const Uuid = z.string().uuid();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const nullableText = (max: number) => z.string().trim().max(max).transform((v) => (v === '' ? null : v)).nullable().optional();

export const AccentColor = z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/, 'Use a colour such as #1F4B99');

export const BrandingLogo = z
  .object({
    id: Uuid, contentType: z.enum(['image/png', 'image/jpeg']), byteSize: z.number().int(), width: z.number().int(), height: z.number().int(),
    sha256: Sha256, createdAt: z.string(),
  })
  .strict();

export const DocumentBranding = z
  .object({
    accentColor: z.string(),
    footerText: z.string().nullable(),
    invoiceTitle: z.string().nullable(),
    invoiceTerms: z.string().nullable(),
    quoteTitle: z.string().nullable(),
    quoteTerms: z.string().nullable(),
    templateId: z.literal('standard'),
    defaultTitles: z.object({ INVOICE: z.string(), QUOTE: z.string() }).strict(),
    logo: BrandingLogo.nullable(),
    /** 0 until first saved. */
    version: z.number().int(),
    updatedAt: z.string().nullable(),
  })
  .strict();
export type DocumentBranding = z.infer<typeof DocumentBranding>;
export const DocumentBrandingResponse = z.object({ branding: DocumentBranding }).strict();

export const UpdateDocumentBrandingRequest = z
  .object({
    version: z.number().int().min(0),
    accentColor: AccentColor.optional(),
    footerText: nullableText(500),
    invoiceTitle: nullableText(60),
    invoiceTerms: nullableText(2000),
    quoteTitle: nullableText(60),
    quoteTerms: nullableText(2000),
    /** Null removes the logo (the asset itself is kept for the PDF versions that used it). */
    logoAssetId: Uuid.nullable().optional(),
  })
  .strict();

/** A logo upload: PNG or JPEG, base64, at most 512 KB decoded (checked again by the server). */
export const UploadBrandingLogoRequest = z
  .object({
    version: z.number().int().min(0),
    contentType: z.enum(['image/png', 'image/jpeg']),
    dataBase64: z.string().min(4).max(700_000),
  })
  .strict();

export const PdfVersionReason = z.enum(['ORIGINAL', 'BRANDING_UPDATED', 'TEMPLATE_UPDATED', 'RENDERING_CORRECTION', 'OTHER']);
export type PdfVersionReason = z.infer<typeof PdfVersionReason>;

/**
 * Stable reference to one stored PDF (for later attachment to an outbound message): the business-scoped
 * version id and the exact bytes' checksum. Holding it does not grant access; every read is authorised.
 */
export const DocumentFileReference = z.object({ type: z.literal('finance_document_pdf'), id: Uuid, sha256: Sha256 }).strict();

export const DocumentPdfVersion = z
  .object({
    id: Uuid,
    documentId: Uuid,
    documentKind: z.enum(['QUOTE', 'INVOICE']),
    versionNumber: z.number().int().min(1),
    reason: PdfVersionReason,
    reasonNote: z.string().nullable(),
    previousVersionId: Uuid.nullable(),
    documentNumber: z.string(),
    /** The document's status when this version was generated. */
    documentStatus: z.string(),
    documentContentSha256: Sha256,
    templateId: z.string(),
    templateVersion: z.number().int(),
    renderer: z.string(),
    snapshotSha256: Sha256,
    logoAssetId: Uuid.nullable(),
    fileName: z.string(),
    contentType: z.literal('application/pdf'),
    pageCount: z.number().int(),
    byteSize: z.number().int(),
    fileSha256: Sha256,
    generatedById: Uuid,
    createdAt: z.string(),
    reference: DocumentFileReference,
    /** Only on the response that created it: some text uses characters the template font cannot show. */
    unsupportedCharacters: z.boolean().optional(),
  })
  .strict();
export type DocumentPdfVersion = z.infer<typeof DocumentPdfVersion>;

export const DocumentPdfVersionResponse = z.object({ version: DocumentPdfVersion }).strict();
export const ListDocumentPdfVersionsResponse = z
  .object({
    /** False for drafts (preview only) and discarded drafts. */
    eligible: z.boolean(),
    versions: z.array(DocumentPdfVersion),
  })
  .strict();

/**
 * Create a version. `original` returns version 1, creating it on first use (idempotent). `new_version`
 * adds the next version; `basedOnVersion` is the latest version number the caller saw.
 */
export const CreateDocumentPdfVersionRequest = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('original') }).strict(),
  z
    .object({
      mode: z.literal('new_version'),
      reason: z.enum(['BRANDING_UPDATED', 'TEMPLATE_UPDATED', 'RENDERING_CORRECTION', 'OTHER']),
      note: nullableText(500),
      basedOnVersion: z.number().int().min(1),
    })
    .strict()
    .refine((v) => v.reason !== 'OTHER' || !!v.note, { message: 'Describe the reason', path: ['note'] }),
]);
