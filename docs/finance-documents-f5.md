# Finance F5: generated documents (quote and invoice PDFs)

Status: implemented on branch `claude/project-thread-jtkv3b` (PR #42), owner decisions F5-D1 to F5-D4
approved by Regan on 2026-11-15 and built in; awaiting re-audit. Not merged. Migration
`20261122000000_finance_documents` is **not applied to production**.

F5 turns issued quotes and invoices into A4 PDFs, keeps each PDF as an immutable version, and lets a
business brand them. It adds no second invoice lifecycle and no sending: generating, previewing or
downloading a PDF never changes the quote or invoice and never records that it was sent. There is no
"sent" state anywhere in F5.

Out of scope (unchanged): SMTP or any outbound email, sending, reminders, scheduled delivery, a sent
status, quote-acceptance automation, credit-note PDFs, a template editor, multiple templates.

## 1. Lifecycle and versioning

| Document state | What exists | Who |
| --- | --- | --- |
| Draft | An on-demand **preview** only. Watermarked DRAFT, banner "Draft preview: not issued, not a valid document", number shown as "Not issued". Rendered from the draft's current lines and the business's current settings. **Never stored**; each preview is audited as `finance.document_pdf.draft_previewed` (§7). | `finance:documents_preview` |
| Discarded draft | Nothing. Never numbered, so no PDF. | |
| Issued, accepted, declined, expired, void (numbered) | Version 1, the **original**, made at issue, plus any later versions. | original: `finance:issue` (as part of issuing); later versions: `finance:documents_generate` |

Rules, enforced in the service and again in the database (trigger `finance_guard_document_pdf`):

- **Original (v1), owner decision F5-D2.** v1 is the exact issued representation. `POST …/{quotes,invoices}/:id/issue`
  now issues the document **and** renders and stores v1 in the same database transaction
  (`issueWithOriginal` in `document-pdfs.ts`): the PDF lock is taken, the existing F1 `issueDocument`
  runs unchanged (numbering, sealed seller and bill-to snapshots, content hash, authoritative totals), the
  document is re-read, and v1 is rendered from it with status ISSUED, the issued number, the sealed
  snapshots, the business's branding at that moment, and `renderedAt` = `issuedAt`.
  - **Failure.** If rendering, size limits, the logo, the insert or the audit fail, the whole transaction
    rolls back: the document stays DRAFT, no number is consumed, nothing is stored, and the API answers
    503 `generation_failed` (safe to retry). An issued document can therefore never lack its original.
  - **Concurrency.** Concurrent issue requests serialise on the document lock; one wins (200) and the
    rest get 409. Exactly one v1 exists.
  - **No other way to make v1.** `pdf-versions` only accepts `mode:"new_version"`; `{mode:"original"}`
    is a 400. The database also refuses a v1 whose recorded status is not ISSUED
    (`CHECK version_number <> 1 OR document_status = 'ISSUED'`).
  - **Documents issued before F5** have no original and cannot get one (the issued state cannot be
    recreated after the fact). The card says so; `new_version` answers 409 `no_original`. Production has
    no businesses yet, so none exist today.
  - The issue route timeout is 15 s (was the default) to allow for rendering; 200 lines render in under 1 s.
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
- **Later changes** do not alter kept PDFs. Branding, customer, settings, payment, acceptance and void
  changes leave the original byte-for-byte unchanged and still recorded as ISSUED (tested). A new version
  made after a void prints the VOID marker.

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
`20261122000000_finance_documents`), all with forced RLS (`tenant_isolation`), `business_id` first in
every composite foreign key, `ON DELETE RESTRICT` to `businesses`, and RESTRICTIVE insert policies that
require `generated_by_id` / `created_by_id` to equal the session user.

**Storage (owner decision F5-D1, approved).** PDF and logo bytes stay in PostgreSQL `bytea`, in
insert-only tables, for the prototype. F5 introduces no object storage.

- Private by construction: bytes are only reachable through authorised tenant routes; there are no
  public URLs, and ids are random UUIDs that grant nothing on their own.
- Limits: PDF ≤ 4 MB (CHECK and service), ≤ 500 pages, ≤ 50 versions per document; logo ≤ 512 KB and
  ≤ 2000 px; file names `^[A-Za-z0-9._-]{1,120}\.pdf$`.
- Integrity: every read recomputes SHA-256 and refuses mismatched bytes (500 `integrity_error`).
- **Growth.** A typical PDF is 17 to 28 KB (examples in §9); a logo is at most 512 KB, stored once per
  upload. Roughly: 1,000 issued documents with one version each ≈ 25 MB; 10,000 ≈ 250 MB; worst case
  per document is 50 versions × 4 MB. Watch `pg_total_relation_size('finance_document_pdfs')`.
- **Backups.** The bytes are part of the database, so they are inside Neon PITR and branch restores
  with no extra setup, and they grow the backup and history size. Before real data: confirm the Neon
  plan's history window (Free is 6 h), protect the production branch, and take a logical backup that
  includes these tables. Restores bring PDFs back together with the records they belong to.
- **Retention.** Finance records are kept, and their PDFs with them: F5 adds no delete path and the
  trigger refuses UPDATE and DELETE. A legal retention period (for example 5 or 7 years for tax
  records, depending on country) and any erasure rule are a later Finance policy; erasing would need a
  deliberate, audited migration because the rows are immutable.
- **When to move.** Move to object storage when PDF bytes approach a few GB, dominate backup size or
  restore time, or when large attachments arrive. **Path:** add a nullable `storage_key` column, copy
  existing bytes to a private bucket under `business/<id>/pdf/<versionId>`, verify each object against
  `file_sha256`, then make `file_data` nullable and stop writing it; routes keep authorising and
  serving through the same endpoints (or short-lived signed URLs after authorisation). The row stays
  the index and checksum authority (§10).
- Memory and runtime: rendering is in-process (Node runtime, `pdfkit` in `serverExternalPackages`),
  inside the unit of work with a 15 s timeout; 200 lines render in under 1 s. Responses are buffered,
  which is fine at these sizes.
- Moving to object storage later (§10) keeps the same table as the index and checksum authority.

## 6. Fonts and Unicode

Inter Regular and SemiBold (SIL Open Font License 1.1, `pdf/fonts.LICENSE.txt`), generated into
`fonts.generated.ts` by `scripts/generate-pdf-fonts.mjs` from `@expo-google-fonts/inter@0.4.2`. They
cover Latin (incl. Vietnamese), Greek and Cyrillic. Chinese, Japanese, Korean, Arabic, Hebrew and Indic
scripts are **not** covered.

Handling is safe and visible, never silent:

- Before drawing, each text run is checked against the font (`hasGlyphForCodePoint`). Each character
  the font lacks is replaced by **□** (U+25A1, which Inter has), so the PDF shows a clear placeholder
  instead of invisible or wrong glyphs, and text extracted from the PDF shows the same placeholder.
  Nothing else in the run changes; amounts and numbers are always in covered characters.
- The version row stores `unsupported_characters` (also in the version DTO and the generated audit).
- Draft previews return `X-Unsupported-Characters: true|false`, so the warning appears **before** the
  document is issued, when the text can still be changed. The card also flags any kept version.
- Right-to-left layout is not supported. Proper rendering needs a fallback font (and shaping for RTL),
  added as a new template version (§10). Not added in F5 because each CJK font adds several MB.

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
| POST `{quotes,invoices}/:id/issue` (F1 route) | finance:issue | now also makes v1 in the same transaction; 503 `generation_failed` rolls back |
| POST `{quotes,invoices}/:id/pdf-versions` | finance:documents_generate | new version only; audited |
| GET `{quotes,invoices}/:id/pdf-versions/:versionId` | finance:read | metadata and stable reference |
| GET `…/:versionId/preview` | finance:documents_preview | `inline`; audited |
| GET `…/:versionId/download` | finance:documents_download | `attachment`; audited |
| GET `{quotes,invoices}/:id/draft-pdf` | finance:documents_preview | drafts only (409 `not_draft`); audited |

A quote id under `/invoices` (or the reverse), another business's id, and a malformed id all answer 404.

File responses: `Content-Type`, exact `Content-Length`, `Content-Disposition` with an ASCII file name
and an RFC 5987 `filename*` (for example `INV-0042.pdf`, `INV-0042-v2.pdf`), `X-Document-Sha256`,
`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
default-src 'none'; frame-ancestors 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-site`, and for
allowed CORS callers (desktop) `Access-Control-Expose-Headers: Content-Disposition, X-Document-Sha256,
X-Unsupported-Characters`. Draft previews add `X-Unsupported-Characters`.
Errors stay JSON.

Permissions (`modules/access/server/permissions.ts`), **owner decision F5-D3, approved**: managers may
preview, generate and download; branding stays with Owner and Admin.

| Key | OWNER | ADMIN | MANAGER | MEMBER |
| --- | --- | --- | --- | --- |
| finance:documents_preview | yes | yes | yes | no |
| finance:documents_generate | yes | yes | yes | no |
| finance:documents_download | yes | yes | yes | no |
| finance:documents_branding | yes | yes | no | no |

None of these grants issue or payment rights. Making the original needs `finance:issue`, which MANAGER
does not have (unchanged from F1); a manager's issue request is 403 and creates no PDF (tested).
`finance:documents_generate` only adds later versions to an already issued document and never changes
its status, number, totals or payments.

Errors: 409 `not_eligible` (draft or discarded), `not_draft`, `no_original`, `stale`, `version_limit`,
`document_too_large`, `branding_logo_invalid`, `totals_mismatch`; 400 `invalid_image`,
`unsupported_image`, `image_too_large`, `image_dimensions`, `invalid_logo`; 503 `generation_failed`
(rendering failed, nothing stored, safe to retry); 500 `integrity_error`. Database codes FN019 to FN021
map to 409.

Audit (owner decision F5-D4, approved). Every audit row has the actor, the business (the row's tenant),
the action and the time; targets and metadata are references only. No document contents, customer
details, amounts, document numbers or PDF bytes are logged.

| Action | Target | Metadata |
| --- | --- | --- |
| `finance.document_pdf.draft_previewed` | `finance_document` id | `kind`, `documentVersion` (draft row version) |
| `finance.document_pdf.previewed` | `finance_document_pdf` version id | `documentId`, `kind`, `versionNumber`, `fileSha256` |
| `finance.document_pdf.downloaded` | `finance_document_pdf` version id | same as previewed |
| `finance.document_pdf.generated` | `finance_document_pdf` version id | version, reason, file hash, `unsupportedCharacters` |
| `finance.branding.changed` | branding | changed field names, logo hash |

Draft previews and stored previews are separate actions, so they can be told apart. Audit rows are
written inside the same unit of work as the read, following the project convention: if the audit cannot
be written the transaction fails, the request answers an error and no bytes are returned (file routes
return the body only after the transaction commits). For issue, a failed audit rolls back the issue too.

## 8. Finance Zone interface

Inside the existing quote and invoice screens, without a redesign (`packages/app/src/zones/finance`):

- **PDF card** on the document detail (`document-pdf.tsx`). Draft: "Preview draft PDF". Numbered:
  "Preview PDF", "Download PDF", "New version", and a version history (version, "Made when issued" for
  the original, reason and note, status when made, time, file name, pages, size, a "Some characters
  shown as □" badge, per-version preview and download). Previewing or downloading never creates a PDF.
  A document issued before F5 shows "This invoice was issued before PDFs were kept, so it has no
  original PDF." The card is hidden without any PDF permission, and for credit notes.
- **Issue dialog** adds: "Its original PDF is made and kept at the same time, with your current
  document branding." A 503 at issue shows "Business OS could not finish this just now, so nothing was
  changed. Try again in a moment."; the document stays a draft.
- Preview draws the bytes in a dialog with PDF.js (`pdf-render.ts`, `pdfjs-dist` legacy build, loaded
  only when a preview opens): each page on a canvas, with a same-origin worker. It no longer uses the
  browser's own PDF viewer in a `blob:` iframe, which showed an empty panel in Safari (§13). If the
  pages cannot be drawn (or drawing takes over 20 s) the dialog says so and offers **Open in new tab**
  (the same bytes, not fetched again, so not audited twice; hidden in the desktop app) and, for stored
  versions with `finance:documents_download`, the audited **Download**. Drafts have no download.
  Download saves the stored bytes under the server's file name. Loading, success, warning (unsupported
  characters), stale and failure (503: "Nothing was stored") states are shown in words.
- Wording never says or implies sent; the card states that downloading does not send the PDF to anyone.
- **Settings, Documents tab** (`branding-settings.tsx`): logo upload, preview and removal; accent colour;
  footer; invoice and quote titles and terms. Read-only without `finance:documents_branding`.
- CSP: `img-src … blob:` was added to the web (`vercel.json`) and desktop (`tauri.conf.json`) policies
  for the local logo preview. `frame-src` is back to `'self'` (the preview has no frame) and
  `worker-src 'self'` names the PDF.js worker explicitly. Nothing remote is allowed.

## 9. Tests and evidence

- `apps/api/tests/integration/finance-documents.test.ts` (23 tests, real PostgreSQL, RLS on). Re-audit
  additions: original made at issue; render failure at issue rolls back (document stays DRAFT, number
  not consumed, series counter unchanged, no issued audit) and a retry succeeds; six concurrent issue
  requests give one 200, five 409 and exactly one v1; the original stays unchanged and ISSUED after
  branding, customer, settings, payment, acceptance and void; the v1-must-be-ISSUED CHECK; manager
  cannot issue and so creates no PDF; `{mode:"original"}` is 400; draft-preview, preview and download
  audits carry references only; CJK and Hebrew text prints as □ and is flagged. Earlier coverage: PDF text
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
- `packages/app/tests/finance-f5.test.tsx` (13 tests): client file handling, the PDF card (original made at
  issue, no creation on preview or download, legacy documents without an original, preview, download,
  new version with reason, stale, draft preview, unsupported-character warnings, failure and retry,
  permissions, credit notes), the issue dialog wording and a 503 issue failure then retry, the
  Documents settings tab.
- Inventory tests (`finance-integrity.test.ts`) now list the three F5 tables, triggers and functions.
- Example PDFs and page images: `docs/evidence/finance-f5/` (issued invoice with logo, issued quote,
  draft preview, void, 4-page invoice, EUR / de-DE with accented text), plus
  `browser-blob-preview-chromium.png` (§13).

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

- Migration `20261122000000_finance_documents` is additive (three new tables, functions, triggers,
  grants, policies), wrapped in one transaction, no data backfill, no privileged extension. Rollback before
  any PDF exists: drop the three tables and four functions. After PDFs exist, rolling back loses them;
  restore from backup instead.
- Ordering: C2-A (PR #41) merged first as `4f2d437` with `20261121000000_communications_providers`, so
  F5's migration was renamed from `20261120000000_finance_documents` to `20261122000000_finance_documents`
  (content unchanged, never applied to production under either name) to sort after it. The three text
  conflicts with C2-A (`apps/api/src/app/api/_lib/routes.ts`, `apps/api/src/core/http/errors.ts`,
  `scripts/check-boundaries.mjs`) were resolved by keeping both sides.
- Deploy order (STAB-01 recommendation B): apply the migration before the code that uses it is published.
- New runtime dependency: `pdfkit@0.20.2` (MIT). Dev-only: `pdfjs-dist`, `@types/pdfkit`. The font
  source package is used only by the generator script.
- Database size grows with kept PDFs (§5); watch it alongside Neon backups.

## 12. Owner decisions

Decided by Regan on 2026-11-15:

- **F5-D1 storage: approved.** PostgreSQL for prototype PDF and logo storage; no object storage in F5.
  Growth, backups, retention and the migration path are in §5.
- **F5-D2 original: approved, at issue.** v1 is the exact issued representation, made in the issuing
  transaction; failure prevents issue (§1).
- **F5-D3 permissions: approved.** Managers preview, generate and download; branding Owner and Admin;
  no indirect issue or payment rights (§7).
- **F5-D4 preview auditing: approved.** Draft previews, stored previews and downloads are audited with
  references only (§7).

Still open:

- **Scripts**: CJK, Arabic, Hebrew and Indic text prints as □ and is flagged (§6). A fallback font is a
  later decision.
- **Retention period** for finance records and their PDFs (§5), as part of Finance policy.

## 13. Not verified here

- PostgreSQL isolation spike tests (`pnpm test:isolation`) need PgBouncer, which is not available in this
  environment; CI runs them. F5 does not change their fixtures.
- **Browser (verified, Chromium 2026-11-15).** A page served with the exact production web CSP from
  `apps/web/vercel.json` loaded a generated invoice into an iframe from a `blob:` URL: Chromium's PDF
  viewer rendered it with no CSP violations (screenshot `docs/evidence/finance-f5/browser-blob-preview-chromium.png`),
  and an anchor download of a second blob URL saved `INV-0001.pdf` byte-identical to the source. As a
  control, the previous CSP (without `blob:`) blocked the frame with a `frame-src` violation. Safari and
  Firefox were not checked; their PDF viewers differ, and the dialog keeps a Download fallback.
- **Safari fix (2026-11-15).** Safari on macOS showed the draft preview dialog with an empty panel.
  The exact WebKit cause was not reproduced (no Safari in the cloud build environment), so the fix
  removes the dependency on the browser's built-in viewer instead: PDF.js draws the pages. Chromium
  drew the F5 sample PDFs (1-page draft with watermark, 4-page invoice, EUR/de-DE) under the exact
  production CSP with the real worker and no CSP violations (`docs/evidence/finance-f5/pdfjs-preview-chromium.png`). Safari, Firefox and the desktop app still
  need a manual check.
- **Native desktop (Tauri) not verified.** WebView2 (Windows) and WKWebView (macOS) blob iframes and
  anchor downloads need a real desktop build (the preview now uses PDF.js and a module worker, not a frame). CI
  builds the desktop bundles; a manual check on the Mac is still needed.
- Production: nothing deployed, no migration applied.
