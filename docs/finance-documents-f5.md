# Finance F5: generated documents (quote and invoice PDFs)

Status: implemented on branch `claude/project-thread-jtkv3b`, awaiting audit. Migration
`20261120000000_finance_documents` is **not applied to production**.

F5 turns issued quotes and invoices into A4 PDFs, keeps each PDF as an immutable version, and lets a
business brand them. It adds no second invoice lifecycle and no sending: generating, previewing or
downloading a PDF never changes the quote or invoice and never records that it was sent. There is no
"sent" state anywhere in F5.

Out of scope (unchanged): SMTP or any outbound email, sending, reminders, scheduled delivery, a sent
status, quote-acceptance automation, credit-note PDFs, a template editor, multiple templates.

## 1. Lifecycle and versioning

| Document state | What exists | Who |
| --- | --- | --- |
| Draft | An on-demand **preview** only. Watermarked DRAFT, banner "Draft preview: not issued, not a valid document", number shown as "Not issued". Rendered from the draft's current lines and the business's current settings. **Never stored**, never audited. | `finance:documents_preview` |
| Discarded draft | Nothing. Never numbered, so no PDF. | |
| Issued, accepted, declined, expired, void (numbered) | Version 1, the **original**, plus any later versions. | create: `finance:documents_generate` |

Rules, enforced in the service and again in the database (trigger `finance_guard_document_pdf`):

- **Original (v1).** `POST …/pdf-versions {mode:"original"}` returns v1, creating it on first use. It is
  idempotent: a second call, or a concurrent one, returns the same row (200 instead of 201). Owner
  decision F5-D2 is whether to create it eagerly at issue instead (§12).
- **Later versions.** `{mode:"new_version", reason, note?, basedOnVersion}`. `reason` is one of
  `BRANDING_UPDATED`, `TEMPLATE_UPDATED`, `RENDERING_CORRECTION`, `OTHER` (a note is required for `OTHER`).
  `basedOnVersion` must be the latest version number the caller saw; otherwise 409 `stale`. A new
  version needs an original (409 `no_original`). At most 50 versions per document (409 `version_limit`).
- **Chain.** Each row stores `previous_version_id`. v1 has none and reason `ORIGINAL`; every later
  version points at the then-latest version. The trigger refuses gaps, forks and a wrong predecessor
  (`FN020`), and a row whose document number, content hash or status does not match the live document,
  or a DRAFT document (`FN019`).
- **Immutable.** `finance_document_pdfs` and `finance_branding_assets` are insert-only for `bos_app`
  (grants), and a trigger refuses UPDATE and DELETE for every role (`FN021`). Byte size, SHA-256 of the
  file and of the snapshot, and `created_at` are computed by the database, not trusted from the app.
- **Serialised.** Generation for one document takes `pg_advisory_xact_lock('finance.pdf:<business>:<doc>')`
  inside the unit of work, so two concurrent "new version" requests cannot both win.
- **What a version records** (`finance_document_pdfs`): business, document id and kind, version
  number, reason and note, previous version, document number, the document's status and sealed
  `content_sha256` at generation, template id and version, renderer (`pdfkit@0.20.2`), the full snapshot
  (JSON, §3) and its SHA-256, the logo asset used, file name, page count, size, file SHA-256, the bytes,
  the generating user, and the time.
- **Later status changes** do not alter kept PDFs. An invoice voided after its original was made keeps
  that original as it was (printed without VOID). A new version made after the void prints the VOID marker.

## 2. Branding

One row per business in `finance_document_branding`, created on first save (version 0 until then):

- accent colour (`#RRGGBB`, default `#1F4B99`), footer text (≤ 500), invoice and quote titles (≤ 60;
  empty means "Invoice" / "Quote"), invoice and quote terms (≤ 2000), template id (`standard` only), and
  the current logo asset.
- Seller name, address, email, phone, identifiers and payment instructions are **not** duplicated here.
  They stay in `finance_settings` (Business details tab), which is already sealed onto each document at
  issue (`sellerSnapshot`), so an issued document's PDF always shows the details it was issued with.
- Saving is optimistic on `version` (409 `stale`). Every change is audited as `finance.branding.changed`
  with the changed field names.
- **Logo** upload (`POST …/document-branding/logo`, base64 JSON): PNG or JPEG only; at most 512 KB
  decoded; at most 2000 × 2000 pixels. Validation order: base64, size, magic-byte sniff, declared type must
  equal sniffed type, dimensions from the header, a PNG decompression bound (IDAT is inflated with a
  `maxOutputLength`, so a decompression bomb is refused), then the image must embed in PDFKit. SVG,
  GIF, WebP and anything else is refused. Each upload is a new immutable asset; removing the logo
  (`logoAssetId: null`) only unlinks it, because kept PDF versions still reference their asset.

## 3. Snapshot

`buildSnapshot` (`document-pdfs.ts`) assembles a `DocumentSnapshot` (`pdf/snapshot.ts`, schema 1) from
the authoritative Finance records. There is no second calculation engine:

- Lines, quantities, prices, discounts, line net and line tax, subtotal, tax total and total are the
  stored exact decimal strings. The tax breakdown (`taxBreakdown` in `money.ts`) only **groups** stored
  line amounts by tax name and rate, and throws if the groups do not add up to the stored totals.
- Issued documents use the sealed `sellerSnapshot` and `billToSnapshot`. Drafts use the current settings
  and the live customer (that is why drafts are never stored).
- Branding (colour, resolved title, terms, footer, logo id, hash and size) is copied in at generation.
- `renderedAt` is set once and is also the PDF CreationDate, so rendering the stored snapshot again
  gives byte-identical output (tested in `tests/unit/pdf-examples.test.ts`).
- `source` records the document id, its row version, its sealed content hash and, for an invoice made
  from a quote, the quote number.

## 4. Template and rendering

`pdf/render.ts`, one template (`standard`, version 1), PDFKit 0.20.2, A4 portrait:

- Header: logo (or seller name) left; title in the accent colour and the number right; VOID marker.
- Three columns: From, Bill to (quotes: "Prepared for"), Details (number, dates, currency, source quote).
- Line table with Description, Qty, Unit price, Discount (only if any line has one), Tax, Amount. Rows
  wrap long text, never split across pages, and the header repeats on every page.
- Totals: subtotal, one row per tax group ("GST 10% on $300.00"), "Total AUD", "Prices exclude tax".
- Payment instructions (invoices only), terms, notes. Footer on every page: footer text and
  "NUMBER · Page i of n".
- Draft and void: diagonal watermark; drafts also carry the banner above.
- Numbers, money and dates are formatted with `Intl` in the business locale, from the exact strings
  (no floating-point arithmetic on amounts).
- Safety: user text is drawn only as text runs; control and bidirectional-override characters are
  removed (`clean`); no links, annotations, scripts, forms or external resources; fonts are embedded
  from base64 (`fonts.generated.ts`), so rendering needs no filesystem or network.
- No settlement or "paid" status is printed: a PDF is a document, not a statement.

## 5. Data model and storage

Three tables (schema `prisma/schema/finance-documents.prisma`, migration
`20261120000000_finance_documents`), all with forced RLS (`tenant_isolation`), `business_id` first in
every composite foreign key, `ON DELETE RESTRICT` to `businesses`, and RESTRICTIVE insert policies that
require `generated_by_id` / `created_by_id` to equal the session user.

**Storage decision (owner decision F5-D1).** Business OS has no object storage, and the brief forbids
inventing services or credentials. F5 therefore keeps PDF and logo bytes in PostgreSQL `bytea`, in
insert-only tables, as the safe minimum:

- Private by construction: bytes are only reachable through authorised tenant routes; there are no
  public URLs, and ids are random UUIDs that grant nothing on their own.
- Limits: PDF ≤ 4 MB (CHECK and service), ≤ 500 pages, ≤ 50 versions per document; logo ≤ 512 KB and
  ≤ 2000 px; file names `^[A-Za-z0-9._-]{1,120}\.pdf$`.
- Integrity: every read recomputes SHA-256 and refuses mismatched bytes (500 `integrity_error`).
- Size: a typical PDF is 17 to 28 KB (examples in §9), so 10,000 PDFs is roughly 250 MB, within Neon
  plans but counted against database storage, backups and PITR. Retention follows finance records:
  nothing is deleted (F5 adds no delete path).
- Memory and runtime: rendering is in-process (Node runtime, `pdfkit` in `serverExternalPackages`),
  inside the unit of work with a 15 s timeout; 200 lines render in under 1 s. Responses are buffered,
  which is fine at these sizes.
- Moving to object storage later (§10) keeps the same table as the index and checksum authority.

## 6. Fonts and Unicode

Inter Regular and SemiBold (SIL Open Font License 1.1, `pdf/fonts.LICENSE.txt`), generated into
`fonts.generated.ts` by `scripts/generate-pdf-fonts.mjs` from `@expo-google-fonts/inter@0.4.2`. They
cover Latin (incl. Vietnamese), Greek and Cyrillic. Chinese, Japanese, Korean, Arabic, Hebrew and Indic
scripts are **not** covered: such characters would print as missing glyphs. The renderer detects this and
the create response sets `unsupportedCharacters: true`; the UI warns the person to check the PDF.
Right-to-left layout is not supported. Adding a fallback font is an extension point (§10).

## 7. API, permissions, errors and audit

All under `/api/v1/b/:slug/finance`, through `tenantRoute` (JSON) or `tenantFileRoute` (files). Bodies
are strict zod contracts (`packages/contracts/src/finance-documents.ts`); file endpoints are listed in
`fileEndpoints` and the generated `api-v1.json`.

| Method and path | Permission | Notes |
| --- | --- | --- |
| GET `document-branding` | finance:read | |
| PATCH `document-branding` | finance:documents_branding | optimistic `version`; audited |
| GET `document-branding/logo` | finance:read | image bytes; 404 if none |
| POST `document-branding/logo` | finance:documents_branding | 201; audited |
| GET `{quotes,invoices}/:id/pdf-versions` | finance:read | `{eligible, versions}` newest first |
| POST `{quotes,invoices}/:id/pdf-versions` | finance:documents_generate | original or new version; audited |
| GET `{quotes,invoices}/:id/pdf-versions/:versionId` | finance:read | metadata and stable reference |
| GET `…/:versionId/preview` | finance:documents_preview | `inline` |
| GET `…/:versionId/download` | finance:documents_download | `attachment`; audited |
| GET `{quotes,invoices}/:id/draft-pdf` | finance:documents_preview | drafts only (409 `not_draft`) |

A quote id under `/invoices` (or the reverse), another business's id, and a malformed id all answer 404.

File responses: `Content-Type`, exact `Content-Length`, `Content-Disposition` with an ASCII file name
and an RFC 5987 `filename*` (for example `INV-0042.pdf`, `INV-0042-v2.pdf`), `X-Document-Sha256`,
`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
default-src 'none'; frame-ancestors 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-site`, and for
allowed CORS callers (desktop) `Access-Control-Expose-Headers: Content-Disposition, X-Document-Sha256`.
Errors stay JSON.

Permissions (`modules/access/server/permissions.ts`), **provisional, owner decision F5-D3**:

| Key | OWNER | ADMIN | MANAGER | MEMBER |
| --- | --- | --- | --- | --- |
| finance:documents_preview | yes | yes | yes | no |
| finance:documents_generate | yes | yes | yes | no |
| finance:documents_download | yes | yes | yes | no |
| finance:documents_branding | yes | yes | no | no |

Errors: 409 `not_eligible` (draft or discarded), `not_draft`, `no_original`, `stale`, `version_limit`,
`document_too_large`, `branding_logo_invalid`, `totals_mismatch`; 400 `invalid_image`,
`unsupported_image`, `image_too_large`, `image_dimensions`, `invalid_logo`; 503 `generation_failed`
(rendering failed, nothing stored, safe to retry); 500 `integrity_error`. Database codes FN019 to FN021
map to 409.

Audit: `finance.document_pdf.generated` (version, reason, number, file hash), `finance.branding.changed`
(changed fields, logo hash), `finance.document_pdf.downloaded` (downloads only; inline previews are not
audited because no read-audit policy exists yet; see §12).

## 8. Finance Zone interface

Inside the existing quote and invoice screens, without a redesign (`packages/app/src/zones/finance`):

- **PDF card** on the document detail (`document-pdf.tsx`). Draft: "Preview draft PDF". Numbered:
  "Preview PDF", "Download PDF", "New version", and a version history (version, reason and note, status
  when made, time, file name, pages, size, per-version preview and download). The first preview or
  download creates the original when the person may generate; otherwise the card says someone with that
  permission must create it. The card is hidden without any PDF permission, and for credit notes.
- Preview opens the bytes in a dialog from a local `blob:` URL in an iframe; the URL is released on close.
  Download saves the stored bytes under the server's file name. Loading, success, warning (unsupported
  characters), stale and failure (503: "Nothing was stored") states are shown in words.
- Wording never says or implies sent; the card states that downloading does not send the PDF to anyone.
- **Settings, Documents tab** (`branding-settings.tsx`): logo upload, preview and removal; accent colour;
  footer; invoice and quote titles and terms. Read-only without `finance:documents_branding`.
- CSP: `frame-src 'self' blob:` and `img-src … blob:` were added to the web (`vercel.json`) and desktop
  (`tauri.conf.json`) policies so the local preview can display. Nothing remote is allowed.

## 9. Tests and evidence

- `apps/api/tests/integration/finance-documents.test.ts` (23 tests, real PostgreSQL, RLS on): PDF text
  read back with pdf.js for content, exact totals and tax groups (several rates, EUR in de-DE), 200 lines
  over several pages with repeated headers, long text, Unicode and literal printing of markup, unsupported
  glyph reporting, empty and edge-case drafts, logo validation and immutability, branding validation and
  concurrency, historical versions unchanged after branding, customer, settings or payment changes,
  version rules and VOID marking, database guards (FN019 to FN021) and checksum refusal, the role matrix
  and the four distinct permissions, cross-business and wrong-kind ids, malformed ids, CORS header
  exposure, concurrency (one original, one next version per base), failure and retry, file names, and
  the source quote number.
- `apps/api/tests/unit/pdf-examples.test.ts`: renders the example set below and asserts deterministic bytes.
  `PDF_EXAMPLES_DIR=… pnpm --filter @business-os/api exec vitest run tests/unit/pdf-examples.test.ts` writes them.
- `packages/app/tests/finance-f5.test.tsx` (11 tests): client file handling, the PDF card (original on
  first use, preview, download, new version with reason, stale, draft preview, failure and retry,
  permissions, credit notes), the Documents settings tab.
- Inventory tests (`finance-integrity.test.ts`) now list the three F5 tables, triggers and functions.
- Example PDFs and page images: `docs/evidence/finance-f5/` (issued invoice with logo, issued quote,
  draft preview, void, 4-page invoice, EUR / de-DE with accented text).

## 10. Extension points

- **Email (later).** A version's `reference` `{type: "finance_document_pdf", id, sha256}` is the stable
  handle an outbound-message feature can attach. Holding it grants nothing: the sender must still read the
  bytes through an authorised path and should verify the checksum. Sending must be recorded by that
  feature, not by F5.
- **Credit notes.** The kind enum, routes and snapshot are kind-parameterised; adding `CREDIT_NOTE` needs a
  template variant, a CHECK change and routes.
- **Object storage.** Replace `file_data` with a storage key; keep `file_sha256`, size and the immutable
  row as the authority; serve through the same routes (or short-lived signed URLs after authorisation).
- **Templates.** `template_id` and `template_version` are stored per version; a new layout is a new
  template version and, for existing documents, a `TEMPLATE_UPDATED` version. The original stays.
- **Fonts.** Add a fallback font for CJK, Arabic or Hebrew (and RTL shaping) as a new template version.

## 11. Operations and migration

- Migration `20261120000000_finance_documents` is additive (three new tables, functions, triggers,
  grants, policies), wrapped in one transaction, no data backfill, no privileged extension. Rollback before
  any PDF exists: drop the three tables and four functions. After PDFs exist, rolling back loses them;
  restore from backup instead.
- Ordering: the Communications C2-A branch adds `20261121000000_communications_providers`. Whichever
  merges second must keep its migration sorting last (rename if needed).
- Deploy order (STAB-01 recommendation B): apply the migration before the code that uses it is published.
- New runtime dependency: `pdfkit@0.20.2` (MIT). Dev-only: `pdfjs-dist`, `@types/pdfkit`. The font
  source package is used only by the generator script.
- Database size grows with kept PDFs (§5); watch it alongside Neon backups.

## 12. Owner decisions

- **F5-D1 storage**: keep PDFs and logos in PostgreSQL (as built) or provide object storage first.
- **F5-D2 original timing**: create v1 on first preview or download (as built) or at issue.
- **F5-D3 permissions**: should MANAGER generate and download PDFs (as built) and who manages branding
  (OWNER and ADMIN as built).
- **Read audit**: downloads are audited, inline previews are not. Decide whether previews should be.
- **Scripts**: accept that CJK, Arabic, Hebrew and Indic text is flagged but not rendered, or fund a
  fallback font.

## 13. Not verified here

- PostgreSQL isolation spike tests (`pnpm test:isolation`) need PgBouncer, which is not available in this
  environment; CI runs them. F5 does not change their fixtures.
- Native desktop (Tauri) preview in an iframe and saving via an anchor download are not verified; the
  dialog falls back to "use Download". Browser PDF viewers differ; the web preview was not checked in a
  real browser here.
- Production: nothing deployed, no migration applied.
