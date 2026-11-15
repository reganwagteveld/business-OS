import 'server-only';
// Generated documents (Finance F5, docs/finance-documents-f5.md): draft previews and immutable PDF
// versions of issued quotes and invoices. Reads the authoritative finance records only; every figure
// comes from F1's stored, sealed amounts and the shared money module (taxBreakdown sums stored line
// amounts). Nothing here changes a finance document, its status or its settlement.
//
// Lifecycle (§1): a DRAFT is previewed on demand and never stored. Issuing a quote or invoice creates
// version 1, the ORIGINAL, in the same transaction (owner decision F5-D2): if it cannot be rendered or
// stored, the issue rolls back. Later versions are added only on purpose, with a reason, and link to the
// version before. Financial content never differs between versions of one document: it is the content
// sealed at issue (the guard checks the hash).
import { createHash, randomUUID } from 'node:crypto';
import { recordAudit } from '@/core/audit';
import { type AppTenantDb } from '@/core/db';
import { RecordNotFoundError, ServiceFailureError, StateConflictError } from '@/core/http/errors';
import { DEFAULT_TITLES, loadBranding, loadLogoAsset, logoBytes } from './branding';
import { billToSnapshot, issueDocument, linesOf, load, type Row } from './documents';
import { formatAmount, formatPlain, taxBreakdown } from './money';
import { RENDERER, RenderError, renderDocument } from './pdf/render';
import { SNAPSHOT_SCHEMA, TEMPLATE_ID, TEMPLATE_VERSION, type DocumentSnapshot, type SnapshotParty } from './pdf/snapshot';
import { sellerSnapshot } from './settings';

export type PdfKind = 'QUOTE' | 'INVOICE';
export const PDF_MAX_BYTES = 4 * 1024 * 1024;
export const PDF_MAX_VERSIONS = 50;
export const PDF_REASONS = ['BRANDING_UPDATED', 'TEMPLATE_UPDATED', 'RENDERING_CORRECTION', 'OTHER'] as const;
export type PdfReason = (typeof PDF_REASONS)[number];

// ---- snapshot ---------------------------------------------------------------------------------------

type Seller = { legalName: string; address: string | null; email: string | null; phone: string | null; identifiers: { label: string; value: string }[]; paymentInstructions: string | null };
type BillTo = {
  name: string; legalName: string | null; email: string | null; phone: string | null; addressLine1: string | null; addressLine2: string | null;
  city: string | null; region: string | null; postalCode: string | null; countryCode: string | null; taxNumber: string | null; taxNumberType: string | null;
  contact: { name: string; email: string | null } | null;
};

/** "au_abn" → "ABN", "eu_vat" → "VAT"; unknown or missing types read "Tax number". */
export function taxNumberLabel(type: string | null): string {
  if (!type) return 'Tax number';
  const m = /^[a-z]{2}_([a-z0-9_]+)$/.exec(type);
  return (m ? m[1]! : type).replace(/_/g, ' ').toUpperCase();
}

function countryName(code: string | null, locale: string): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([locale, 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

const sellerParty = (s: Seller): SnapshotParty => ({
  name: s.legalName, lines: (s.address ?? '').split('\n').map((l) => l.trim()).filter(Boolean), identifiers: s.identifiers, email: s.email,
  phone: s.phone, attention: null,
});

const billToParty = (b: BillTo, locale: string): SnapshotParty => ({
  name: b.name,
  lines: [b.addressLine1, b.addressLine2, [b.city, b.region, b.postalCode].filter(Boolean).join(' '), countryName(b.countryCode, locale)]
    .filter((l): l is string => !!l && l.trim() !== ''),
  identifiers: b.taxNumber ? [{ label: taxNumberLabel(b.taxNumberType), value: b.taxNumber }] : [],
  email: b.contact?.email ?? b.email, phone: b.phone, attention: b.contact?.name ?? null,
});

/**
 * The render input for a document as it stands. Issued (and later) documents use only what issue
 * sealed: the seller and bill-to snapshots, the immutable lines and the stored totals. A draft uses the
 * current seller settings and customer, exactly what issuing it now would seal.
 */
async function buildSnapshot(db: AppTenantDb, kind: PdfKind, row: Row, renderedAt: Date): Promise<{ snapshot: DocumentSnapshot; logo: Buffer | null }> {
  const [business, lines, branding] = await Promise.all([
    db.business.findFirstOrThrow({ select: { locale: true } }), linesOf(db, row.id), loadBranding(db),
  ]);
  const scale = row.currencyScale;
  let breakdown;
  try {
    breakdown = taxBreakdown(lines, row);
  } catch {
    throw new StateConflictError('totals_mismatch'); // a document whose lines disagree with its totals is never printed
  }
  const draft = row.status === 'DRAFT';
  const seller = (draft ? await sellerSnapshot(db) : row.sellerSnapshot) as Seller | null;
  const billTo = (draft ? await billToSnapshot(db, row.customerId, row.contactId) : row.billToSnapshot) as BillTo | null;
  if (!seller || !billTo) throw new StateConflictError('not_eligible');
  const asset = branding.logoAssetId ? await loadLogoAsset(db, branding.logoAssetId) : null;
  const logo = asset ? await logoBytes(db, asset.id) : null;
  const sourceQuote = row.sourceQuoteId ? await db.financeDocument.findFirst({ where: { id: row.sourceQuoteId }, select: { number: true } }) : null;
  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  const snapshot: DocumentSnapshot = {
    schema: SNAPSHOT_SCHEMA, template: { id: TEMPLATE_ID, version: TEMPLATE_VERSION }, renderedAt: renderedAt.toISOString(), kind,
    status: row.status, number: row.number, issueDate: day(row.issueDate), dueDate: kind === 'INVOICE' ? day(row.dueDate) : null,
    validUntil: kind === 'QUOTE' ? day(row.validUntil) : null, locale: business.locale, currencyCode: row.currencyCode, currencyScale: scale,
    taxMode: 'EXCLUSIVE', seller: sellerParty(seller), billTo: billToParty(billTo, business.locale),
    lines: lines.map((l) => ({
      position: l.position, description: l.description, quantity: formatPlain(l.quantity), unitPrice: formatPlain(l.unitPrice),
      discountAmount: formatAmount(l.discountAmount, scale), taxName: l.taxName, taxRatePercent: formatPlain(l.taxRatePercent),
      lineNet: formatAmount(l.lineNet, scale), lineTax: formatAmount(l.lineTax, scale),
    })),
    taxBreakdown: breakdown.map((t) => ({ taxName: t.taxName, taxRatePercent: formatPlain(t.taxRatePercent), net: formatAmount(t.net, scale), tax: formatAmount(t.tax, scale) })),
    totals: { subtotal: formatAmount(row.subtotal, scale), taxTotal: formatAmount(row.taxTotal, scale), total: formatAmount(row.total, scale) },
    paymentInstructions: seller.paymentInstructions, notes: row.notes,
    branding: {
      accentColor: branding.accentColor, title: (kind === 'INVOICE' ? branding.invoiceTitle : branding.quoteTitle) ?? DEFAULT_TITLES[kind],
      terms: kind === 'INVOICE' ? branding.invoiceTerms : branding.quoteTerms, footerText: branding.footerText,
      logo: asset && logo ? { assetId: asset.id, sha256: asset.sha256, contentType: asset.contentType, width: asset.width, height: asset.height } : null,
    },
    source: { documentId: row.id, documentVersion: row.version, contentSha256: row.contentSha256, sourceQuoteNumber: sourceQuote?.number ?? null },
  };
  return { snapshot, logo };
}

async function render(snapshot: DocumentSnapshot, logo: Buffer | null) {
  let result;
  try {
    result = await renderDocument(snapshot, logo);
  } catch (error) {
    if (error instanceof RenderError && error.code === 'invalid_logo') throw new StateConflictError('branding_logo_invalid');
    console.error('[finance] document rendering failed', error instanceof Error ? error.name : typeof error);
    throw new ServiceFailureError(503, 'generation_failed');
  }
  if (result.bytes.length > PDF_MAX_BYTES) throw new StateConflictError('document_too_large');
  return result;
}

// ---- file names -------------------------------------------------------------------------------------

/** An ASCII-only file name safe in any header and file system: [A-Za-z0-9._-], ".pdf". */
export function safeFileName(base: string): string {
  const ascii = base.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return `${(ascii || 'document').slice(0, 100)}.pdf`;
}

/** Content-Disposition with an ASCII fallback and the exact name as RFC 5987 UTF-8 (filename*). */
export function contentDisposition(type: 'inline' | 'attachment', asciiName: string, utf8Name: string): string {
  const encoded = encodeURIComponent(utf8Name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

const utf8Name = (number: string, versionNumber: number) =>
  `${number.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '_')}${versionNumber > 1 ? `-v${versionNumber}` : ''}.pdf`;

// ---- draft preview ------------------------------------------------------------------------------------

export type PdfFile = { bytes: Buffer; fileName: string; utf8FileName: string; sha256: string };

/**
 * A rendered preview of a draft: watermarked DRAFT, never numbered, never stored. Audited as a draft
 * preview (F5-D4), distinct from a stored version's preview; the audit names the document only.
 */
export async function draftPreview(db: AppTenantDb, actorUserId: string, kind: PdfKind, id: string): Promise<PdfFile & { unsupportedCharacters: boolean }> {
  const row = await load(db, kind, id);
  if (row.status !== 'DRAFT') throw new StateConflictError('not_draft');
  const { snapshot, logo } = await buildSnapshot(db, kind, row, new Date());
  const result = await render(snapshot, logo);
  await recordAudit(db, actorUserId, 'finance.document_pdf.draft_previewed', { type: 'finance_document', id }, { kind, documentVersion: String(row.version) });
  const name = `draft-${kind.toLowerCase()}-preview.pdf`;
  return { bytes: result.bytes, fileName: name, utf8FileName: name, sha256: createHash('sha256').update(result.bytes).digest('hex'), unsupportedCharacters: result.unsupportedCharacters };
}

// ---- versions -------------------------------------------------------------------------------------------

const versionSelect = {
  id: true, documentId: true, documentKind: true, versionNumber: true, reason: true, reasonNote: true, previousVersionId: true, documentNumber: true,
  documentStatus: true, documentContentSha256: true, templateId: true, templateVersion: true, renderer: true, snapshotSha256: true,
  logoAssetId: true, fileName: true, contentType: true, pageCount: true, unsupportedCharacters: true, byteSize: true, fileSha256: true,
  generatedById: true, createdAt: true,
} as const;
type VersionRow = {
  id: string; documentId: string; documentKind: PdfKind; versionNumber: number; reason: string; reasonNote: string | null; previousVersionId: string | null;
  documentNumber: string; documentStatus: string; documentContentSha256: string; templateId: string; templateVersion: number; renderer: string;
  snapshotSha256: string; logoAssetId: string | null; fileName: string; contentType: string; pageCount: number; unsupportedCharacters: boolean;
  byteSize: number; fileSha256: string; generatedById: string; createdAt: Date;
};

/**
 * Metadata of one version. `reference` is the stable handle later work (Communications) can attach or
 * link: it names the business-scoped version id and the exact bytes (sha256). Nothing here records or
 * implies that a document was sent.
 */
const versionDto = (v: VersionRow) => ({
  id: v.id, documentId: v.documentId, documentKind: v.documentKind, versionNumber: v.versionNumber, reason: v.reason as 'ORIGINAL' | PdfReason,
  reasonNote: v.reasonNote, previousVersionId: v.previousVersionId, documentNumber: v.documentNumber, documentStatus: v.documentStatus,
  documentContentSha256: v.documentContentSha256, templateId: v.templateId, templateVersion: v.templateVersion, renderer: v.renderer,
  snapshotSha256: v.snapshotSha256, logoAssetId: v.logoAssetId, fileName: v.fileName, contentType: 'application/pdf' as const, pageCount: v.pageCount,
  byteSize: v.byteSize, fileSha256: v.fileSha256, generatedById: v.generatedById, createdAt: v.createdAt.toISOString(),
  reference: { type: 'finance_document_pdf' as const, id: v.id, sha256: v.fileSha256 },
  unsupportedCharacters: v.unsupportedCharacters,
});

/** Every version of a document, newest first. A draft or a discarded draft simply has none. */
export async function listPdfVersions(db: AppTenantDb, kind: PdfKind, id: string) {
  const row = await load(db, kind, id);
  const versions = (await db.financeDocumentPdf.findMany({
    where: { documentId: id, documentKind: kind }, select: versionSelect, orderBy: { versionNumber: 'desc' },
  })) as VersionRow[];
  return { eligible: row.status !== 'DRAFT' && row.number !== null, versions: versions.map((v) => versionDto(v)) };
}

async function findVersion(db: AppTenantDb, kind: PdfKind, documentId: string, versionId: string): Promise<VersionRow> {
  const v = (await db.financeDocumentPdf.findFirst({ where: { id: versionId, documentId, documentKind: kind }, select: versionSelect })) as VersionRow | null;
  if (!v) throw new RecordNotFoundError(); // another document's, kind's or business's version is simply not found
  return v;
}

export async function getPdfVersion(db: AppTenantDb, kind: PdfKind, documentId: string, versionId: string) {
  return versionDto(await findVersion(db, kind, documentId, versionId));
}

/** Serialises PDF generation for one document (transaction-scoped advisory lock, never a row lock on the document). */
async function lockDocumentPdfs(db: AppTenantDb, documentId: string) {
  await db.$queryRaw<{ locked: number }[]>`
    SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(
      'finance.pdf:' || current_setting('app.business_id', true) || ':' || ${documentId}::text, 0))) AS l`;
}

export type CreateVersionInput = { mode: 'new_version'; reason: PdfReason; note?: string | null; basedOnVersion: number };

/** Renders and stores one version of a numbered document, then audits it. The caller holds the PDF lock. */
async function storeVersion(
  db: AppTenantDb, actorUserId: string, kind: PdfKind, row: Row, renderedAt: Date,
  next: { versionNumber: number; reason: 'ORIGINAL' | PdfReason; note: string | null; previousId: string | null },
) {
  const { snapshot, logo } = await buildSnapshot(db, kind, row, renderedAt);
  const result = await render(snapshot, logo);
  const fileName = safeFileName(`${row.number}${next.versionNumber > 1 ? `-v${next.versionNumber}` : ''}`);
  const versionId = randomUUID();
  await db.financeDocumentPdf.create({
    data: {
      id: versionId, documentId: row.id, documentKind: kind, versionNumber: next.versionNumber, reason: next.reason, reasonNote: next.note,
      previousVersionId: next.previousId, documentNumber: row.number, documentStatus: row.status, documentContentSha256: row.contentSha256,
      templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION, renderer: RENDERER, snapshot: snapshot as never,
      logoAssetId: snapshot.branding.logo?.assetId ?? null, fileName, contentType: 'application/pdf', pageCount: result.pageCount,
      unsupportedCharacters: result.unsupportedCharacters, fileData: result.bytes, generatedById: actorUserId,
      // Database-owned (the guard recomputes them from the stored bytes and snapshot):
      byteSize: 0, fileSha256: '0'.repeat(64), snapshotSha256: '0'.repeat(64),
    } as never,
  });
  const created = await findVersion(db, kind, row.id, versionId);
  await recordAudit(db, actorUserId, 'finance.document_pdf.generated', { type: 'finance_document_pdf', id: versionId }, {
    documentId: row.id, kind, versionNumber: String(next.versionNumber), reason: next.reason, hasNote: next.note ? 'true' : 'false',
    previousVersionId: next.previousId, documentStatus: row.status, templateId: TEMPLATE_ID, templateVersion: String(TEMPLATE_VERSION),
    fileSha256: created.fileSha256, byteSize: String(created.byteSize), pageCount: String(created.pageCount), logoAssetId: created.logoAssetId,
    unsupportedCharacters: String(created.unsupportedCharacters),
  });
  return versionDto(created);
}

/**
 * Issues a quote or invoice and creates its original PDF in the same unit of work (owner decision F5-D2).
 * The original is rendered from the just-sealed record with the branding in force at issue, and records
 * status ISSUED. Any failure (rendering, size, logo, storage, audit) throws, so the transaction rolls
 * back and the document stays a draft: an issued quote or invoice never lacks its original.
 * This is the only issue path for quotes and invoices; credit notes have no PDF in F5.
 */
export async function issueWithOriginal(db: AppTenantDb, actorUserId: string, kind: PdfKind, id: string, input: Parameters<typeof issueDocument>[4]) {
  await load(db, kind, id); // 404 before anything else
  await lockDocumentPdfs(db, id);
  const document = await issueDocument(db, actorUserId, kind, id, input);
  const row = await load(db, kind, id);
  if (row.status !== 'ISSUED' || row.number === null || row.contentSha256 === null) throw new StateConflictError('not_eligible'); // unreachable
  const original = await storeVersion(db, actorUserId, kind, row, row.issuedAt ?? new Date(), { versionNumber: 1, reason: 'ORIGINAL', note: null, previousId: null });
  return { document, original };
}

/**
 * Adds the next PDF version of a numbered document, with a reason and the latest version number the
 * caller saw (409 stale otherwise). The original is made at issue; a document issued before F5 has none
 * (409 no_original) and cannot get one afterwards, because an original must show the issued state.
 */
export async function createPdfVersion(db: AppTenantDb, actorUserId: string, kind: PdfKind, id: string, input: CreateVersionInput) {
  await load(db, kind, id); // 404 first: never reveal anything about another business's or kind's ids
  await lockDocumentPdfs(db, id);
  const row = await load(db, kind, id); // re-read under the lock
  if (row.status === 'DRAFT' || row.number === null || row.contentSha256 === null) throw new StateConflictError('not_eligible');
  const latest = (await db.financeDocumentPdf.findFirst({
    where: { documentId: id, documentKind: kind }, select: versionSelect, orderBy: { versionNumber: 'desc' },
  })) as VersionRow | null;
  if (!latest) throw new StateConflictError('no_original');
  if (input.basedOnVersion !== latest.versionNumber) throw new StateConflictError('stale');
  if (latest.versionNumber >= PDF_MAX_VERSIONS) throw new StateConflictError('version_limit');
  const version = await storeVersion(db, actorUserId, kind, row, new Date(), {
    versionNumber: latest.versionNumber + 1, reason: input.reason, note: input.note ?? null, previousId: latest.id,
  });
  return { status: 201 as const, version };
}

/**
 * The stored bytes of a version, verified against the recorded checksum before they are served. Both a
 * preview (inline) and a download (attachment) are audited (owner decision F5-D4): who, which business
 * (the audit row's tenant), which document and version, which action, when. Never contents or bytes.
 */
export async function pdfVersionFile(db: AppTenantDb, actorUserId: string, kind: PdfKind, documentId: string, versionId: string, disposition: 'inline' | 'attachment'): Promise<PdfFile> {
  const v = await findVersion(db, kind, documentId, versionId);
  const stored = await db.financeDocumentPdf.findFirst({ where: { id: versionId }, select: { fileData: true } });
  const bytes = Buffer.from(stored!.fileData);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== v.fileSha256 || bytes.length !== v.byteSize) {
    console.error('[finance] stored PDF failed its integrity check');
    throw new ServiceFailureError(500, 'integrity_error');
  }
  await recordAudit(db, actorUserId, disposition === 'attachment' ? 'finance.document_pdf.downloaded' : 'finance.document_pdf.previewed',
    { type: 'finance_document_pdf', id: v.id }, { documentId, kind, versionNumber: String(v.versionNumber), fileSha256: v.fileSha256 });
  return { bytes, fileName: v.fileName, utf8FileName: utf8Name(v.documentNumber, v.versionNumber), sha256 };
}

