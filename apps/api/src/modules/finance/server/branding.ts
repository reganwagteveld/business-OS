import 'server-only';
// Document branding (Finance F5, docs/finance-documents-f5.md §2): accent colour, logo, footer and the
// per-kind title and terms of the standard template. Seller name, address, contact details, tax
// identifiers and payment instructions are NOT duplicated here: they stay in finance settings, which
// issue already snapshots onto every document. Every change is audited in the same unit of work
// (field names only, never the text).
import { randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { recordAudit } from '@/core/audit';
import type { AppTenantDb } from '@/core/db';
import { RecordNotFoundError, RuleViolationError, StateConflictError } from '@/core/http/errors';
import { changedFields } from './shared';

export const LOGO_MAX_BYTES = 512 * 1024;
export const LOGO_MAX_PIXELS = 2000;
export const DEFAULT_ACCENT = '#1F4B99';
export const DEFAULT_TITLES = { INVOICE: 'Invoice', QUOTE: 'Quote' } as const;

const brandingSelect = {
  accentColor: true, logoAssetId: true, footerText: true, invoiceTitle: true, invoiceTerms: true, quoteTitle: true, quoteTerms: true,
  templateId: true, version: true, updatedAt: true,
} as const;
type BrandingRow = {
  accentColor: string; logoAssetId: string | null; footerText: string | null; invoiceTitle: string | null; invoiceTerms: string | null;
  quoteTitle: string | null; quoteTerms: string | null; templateId: string; version: number; updatedAt: Date | null;
};
const DEFAULTS: BrandingRow = {
  accentColor: DEFAULT_ACCENT, logoAssetId: null, footerText: null, invoiceTitle: null, invoiceTerms: null, quoteTitle: null, quoteTerms: null,
  templateId: 'standard', version: 0, updatedAt: null,
};

const assetSelect = { id: true, contentType: true, byteSize: true, width: true, height: true, sha256: true, createdAt: true } as const;
export type LogoAsset = { id: string; contentType: 'image/png' | 'image/jpeg'; byteSize: number; width: number; height: number; sha256: string; createdAt: Date };

/** The saved branding, or the defaults (version 0) when it has never been saved. */
export async function loadBranding(db: AppTenantDb): Promise<BrandingRow> {
  return ((await db.financeDocumentBranding.findFirst({ select: brandingSelect })) as BrandingRow | null) ?? DEFAULTS;
}

export async function loadLogoAsset(db: AppTenantDb, id: string): Promise<LogoAsset | null> {
  return (await db.financeBrandingAsset.findFirst({ where: { id }, select: assetSelect })) as LogoAsset | null;
}

/** The bytes of a logo asset of this business (for rendering and for the settings preview). */
export async function logoBytes(db: AppTenantDb, id: string): Promise<Buffer | null> {
  const row = await db.financeBrandingAsset.findFirst({ where: { id }, select: { data: true } });
  return row ? Buffer.from(row.data) : null;
}

const assetDto = (a: LogoAsset) => ({
  id: a.id, contentType: a.contentType, byteSize: a.byteSize, width: a.width, height: a.height, sha256: a.sha256, createdAt: a.createdAt.toISOString(),
});

export async function getBranding(db: AppTenantDb) {
  const row = await loadBranding(db);
  const logo = row.logoAssetId ? await loadLogoAsset(db, row.logoAssetId) : null;
  return {
    accentColor: row.accentColor, footerText: row.footerText, invoiceTitle: row.invoiceTitle, invoiceTerms: row.invoiceTerms,
    quoteTitle: row.quoteTitle, quoteTerms: row.quoteTerms, templateId: 'standard' as const, defaultTitles: DEFAULT_TITLES,
    logo: logo ? assetDto(logo) : null, version: row.version, updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

export type BrandingInput = {
  version: number; accentColor?: string; footerText?: string | null; invoiceTitle?: string | null; invoiceTerms?: string | null;
  quoteTitle?: string | null; quoteTerms?: string | null; logoAssetId?: string | null;
};

async function businessIdOf(db: AppTenantDb): Promise<string> {
  return (await db.business.findFirstOrThrow({ select: { id: true } })).id;
}

/**
 * Saves branding with optimistic concurrency on `version` (0 = never saved). Branding changes only how
 * FUTURE versions look: stored PDF versions keep the branding they were rendered with (§3).
 */
export async function updateBranding(db: AppTenantDb, actorUserId: string, input: BrandingInput) {
  const before = await loadBranding(db);
  if (before.version !== input.version) throw new StateConflictError('stale');
  const { version, ...fields } = input;
  const data: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  if (typeof data.accentColor === 'string') data.accentColor = data.accentColor.toUpperCase();
  if (data.logoAssetId && data.logoAssetId !== before.logoAssetId && !(await loadLogoAsset(db, data.logoAssetId as string))) {
    throw new RuleViolationError('invalid_logo', 'Choose a logo uploaded to this business.');
  }
  const changed = changedFields(before as unknown as Record<string, unknown>, data);
  if (changed.length === 0) return getBranding(db);
  await writeBranding(db, actorUserId, version, data);
  await recordAudit(db, actorUserId, 'finance.branding.changed', { type: 'finance_document_branding', id: await businessIdOf(db) }, {
    fields: changed, ...(changed.includes('logoAssetId') ? { logoAssetIdFrom: before.logoAssetId, logoAssetIdTo: (data.logoAssetId as string | null) ?? null } : {}),
  });
  return getBranding(db);
}

async function writeBranding(db: AppTenantDb, actorUserId: string, version: number, data: Record<string, unknown>) {
  if (version === 0) {
    // First save: INSERT … ON CONFLICT DO NOTHING, so a concurrent first save answers 409 stale cleanly.
    const created = await db.financeDocumentBranding.createMany({ data: [{ ...data, createdById: actorUserId, updatedById: actorUserId } as never], skipDuplicates: true });
    if (created.count === 0) throw new StateConflictError('stale');
  } else {
    const result = await db.financeDocumentBranding.updateMany({ where: { version }, data: { ...data, version: { increment: 1 }, updatedById: actorUserId } as never });
    if (result.count === 0) throw new StateConflictError('stale');
  }
}

// ---- logo upload --------------------------------------------------------------------------------

type Sniffed = { contentType: 'image/png' | 'image/jpeg'; width: number; height: number };

/** Reads the real type and pixel size from the bytes (never trusts the declared type or a file name). */
export function sniffImage(bytes: Buffer): Sniffed | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && bytes.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { contentType: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = bytes.readUInt16BE(i + 2);
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { contentType: 'image/jpeg', height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
      }
      if (marker === 0xda || length < 2) return null;
      i += 2 + length;
    }
  }
  return null;
}

/**
 * Decompression-bomb guard for PNG: inflates the image data with a hard output cap derived from the
 * declared size (at most 16-bit RGBA plus a filter byte per row), and checks the chunk structure. A
 * small file that claims to inflate to far more than its pixels could need is refused before any
 * decoder sees it.
 */
export function pngWithinBounds(bytes: Buffer, width: number, height: number): boolean {
  const parts: Buffer[] = [];
  let i = 8;
  let ended = false;
  while (i + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(i);
    const type = bytes.subarray(i + 4, i + 8).toString('latin1');
    if (i + 12 + length > bytes.length) return false;
    if (type === 'IDAT') parts.push(bytes.subarray(i + 8, i + 8 + length));
    i += 12 + length;
    if (type === 'IEND') { ended = true; break; }
  }
  if (!ended || parts.length === 0) return false;
  try {
    inflateSync(Buffer.concat(parts), { maxOutputLength: height * (1 + width * 8) });
    return true;
  } catch {
    return false;
  }
}

/** Fully decodes and embeds the image with the same library that renders documents, so a logo that is accepted can be rendered. */
async function embeddable(bytes: Buffer): Promise<boolean> {
  try {
    const doc = new PDFDocument({ size: 'A4', autoFirstPage: true });
    const done = new Promise<void>((resolve, reject) => { doc.on('end', resolve); doc.on('error', reject); doc.resume(); });
    doc.image(bytes, 0, 0, { width: 10 });
    doc.end();
    await done;
    return true;
  } catch {
    return false;
  }
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Validates and stores a logo, then makes it the business's logo (one unit of work, one audit entry).
 * PNG or JPEG only (no SVG: it can carry script), at most 512 KiB and 2000 × 2000 px, the declared type
 * must match the bytes, and the image must decode. The asset row is immutable; older logos stay so that
 * earlier PDF versions remain traceable.
 */
export async function uploadLogo(db: AppTenantDb, actorUserId: string, input: { version: number; contentType: string; dataBase64: string }) {
  const before = await loadBranding(db);
  if (before.version !== input.version) throw new StateConflictError('stale');
  if (!BASE64.test(input.dataBase64) || input.dataBase64.length % 4 !== 0) throw new RuleViolationError('invalid_image', 'The file could not be read.');
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.length === 0) throw new RuleViolationError('invalid_image', 'The file is empty.');
  if (bytes.length > LOGO_MAX_BYTES) throw new RuleViolationError('image_too_large', 'A logo can be at most 512 KB.');
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new RuleViolationError('unsupported_image', 'Upload a PNG or JPEG image.');
  if (sniffed.contentType !== input.contentType) throw new RuleViolationError('unsupported_image', 'The file is not the type it claims to be. Upload a PNG or JPEG image.');
  if (sniffed.width < 1 || sniffed.height < 1 || sniffed.width > LOGO_MAX_PIXELS || sniffed.height > LOGO_MAX_PIXELS) {
    throw new RuleViolationError('image_dimensions', `A logo can be at most ${LOGO_MAX_PIXELS} × ${LOGO_MAX_PIXELS} pixels.`);
  }
  if (sniffed.contentType === 'image/png' && !pngWithinBounds(bytes, sniffed.width, sniffed.height)) {
    throw new RuleViolationError('invalid_image', 'The image could not be decoded. Export it again as PNG or JPEG.');
  }
  if (!(await embeddable(bytes))) throw new RuleViolationError('invalid_image', 'The image could not be decoded. Export it again as PNG or JPEG.');
  const id = randomUUID();
  await db.financeBrandingAsset.create({
    data: { id, contentType: sniffed.contentType, width: sniffed.width, height: sniffed.height, data: bytes, byteSize: 0, sha256: '0'.repeat(64), createdById: actorUserId } as never,
  });
  await writeBranding(db, actorUserId, before.version, { logoAssetId: id });
  const asset = (await loadLogoAsset(db, id))!;
  await recordAudit(db, actorUserId, 'finance.branding.changed', { type: 'finance_document_branding', id: await businessIdOf(db) }, {
    fields: ['logoAssetId'], logoAssetIdFrom: before.logoAssetId, logoAssetIdTo: id, contentType: asset.contentType,
    byteSize: String(asset.byteSize), sha256: asset.sha256,
  });
  return getBranding(db);
}

/** The current logo's bytes and type, for the settings preview. 404 when there is none. */
export async function currentLogo(db: AppTenantDb): Promise<{ bytes: Buffer; contentType: string; sha256: string }> {
  const branding = await loadBranding(db);
  if (!branding.logoAssetId) throw new RecordNotFoundError();
  const [asset, bytes] = await Promise.all([loadLogoAsset(db, branding.logoAssetId), logoBytes(db, branding.logoAssetId)]);
  if (!asset || !bytes) throw new RecordNotFoundError();
  return { bytes, contentType: asset.contentType, sha256: asset.sha256 };
}
