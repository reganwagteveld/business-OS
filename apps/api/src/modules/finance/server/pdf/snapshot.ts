// The complete, JSON-serialisable input of one rendered document (docs/finance-documents-f5.md §3).
// Stored verbatim on every PDF version, so a version records exactly what it was rendered from and can
// be rendered again. Amounts are exact decimal strings formatted by the finance module (money.ts);
// nothing in the renderer computes a financial figure.

export const TEMPLATE_ID = 'standard' as const;
/** Bump when the standard template's layout changes in a way that changes output (§3.3). */
export const TEMPLATE_VERSION = 1;
/** Snapshot schema version: bump with any change to DocumentSnapshot's shape. */
export const SNAPSHOT_SCHEMA = 1;

export type SnapshotKind = 'QUOTE' | 'INVOICE';

export interface SnapshotParty {
  name: string;
  lines: string[];
  identifiers: { label: string; value: string }[];
  email: string | null;
  phone: string | null;
  attention: string | null;
}

export interface SnapshotLine {
  position: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxName: string | null;
  taxRatePercent: string;
  lineNet: string;
  lineTax: string;
}

export interface DocumentSnapshot {
  schema: typeof SNAPSHOT_SCHEMA;
  template: { id: typeof TEMPLATE_ID; version: number };
  /** When this snapshot was rendered (also the PDF's CreationDate, so a re-render is byte-identical). */
  renderedAt: string;
  kind: SnapshotKind;
  /** The document's status when rendered. DRAFT only for previews, which are never stored. */
  status: 'DRAFT' | 'ISSUED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'VOID';
  number: string | null;
  issueDate: string | null;
  dueDate: string | null;
  validUntil: string | null;
  locale: string;
  currencyCode: string;
  currencyScale: number;
  taxMode: 'EXCLUSIVE';
  seller: SnapshotParty;
  billTo: SnapshotParty;
  lines: SnapshotLine[];
  taxBreakdown: { taxName: string | null; taxRatePercent: string; net: string; tax: string }[];
  totals: { subtotal: string; taxTotal: string; total: string };
  paymentInstructions: string | null;
  notes: string | null;
  branding: {
    accentColor: string;
    title: string;
    terms: string | null;
    footerText: string | null;
    logo: { assetId: string; sha256: string; contentType: 'image/png' | 'image/jpeg'; width: number; height: number } | null;
  };
  /** Where the figures came from: the finance record and, once issued, its sealed content hash. */
  source: { documentId: string; documentVersion: number; contentSha256: string | null; sourceQuoteNumber: string | null };
}
