# Finance F-RCPT: receipts and attachments (architecture, security and provider feasibility)

**Status:** proposal, docs only. Nothing here is built, enabled, signed up for or decided. Owner decisions are in §17.
**Date:** 2026-11-17. Base: `main` at `06405a5`.
**Closes, when accepted:** FD-P6 (receipt storage) and F3-D2 (receipts deferred), `docs/finance-data-model.md` §19.6.
**Related:** F5 PDFs in Postgres (`finance-documents-f5.md` §5 "When to move"), E1 retention and erasure
(`communications-e1.md`), C2 attachments (D-C2-12, draft PR #118 D-UI-8), ADR 0002 (region and residency),
ZCR-1 (draft PR #117, D-ZCR-7).

This document answers four questions:

1. Where should receipt files live, at what cost, and how is each tenant kept apart?
2. How do upload, preview and download work safely on Vercel, in the browser and in the Tauri app?
3. What does malware scanning cost, and is it needed for the first stage?
4. How do retention, erasure, backups and restores work for files, in line with E1?

Pricing and provider facts are dated 2026-11-17 and labelled **verified** (read on the provider's own page
that day), **estimated** (our arithmetic) or **unverified** (not confirmed on a primary source).

---

## 1. Scope

**In scope (first build):** files attached to **expenses** (receipts, supplier bills), uploaded by business
members with Finance access, viewed and downloaded inside Pixa OS.

**Designed for, not built first:** supporting files on quotes, invoices, credit notes and payments
(for example proof of payment). The table and API shape below allow these later without a redesign.

**Not in scope:**

- OCR or AI extraction of amounts from receipts (needs the AI-provider decision D2 in ADR 0002).
- Receipts arriving by email ("forward to receipts@") or saving a mail attachment as a receipt. These bring
  third-party content and need malware scanning first (§11).
- A general file library for every Zone. A shared storage core is proposed (§6.1), but each Zone owns its own
  attachment table, permissions and retention.
- Sharing files outside the business (portal, public links).

## 2. What exists today (verified on `main` 06405a5)

| Fact | Where |
|---|---|
| No object storage anywhere. The only stored files are F5 PDFs and branding logos, as `bytea` in Postgres with database-computed SHA-256, immutable rows, ≤ 4 MB PDFs and ≤ 512 KB logos. | `prisma/schema/finance-documents.prisma`, F5 §5 |
| F5 already wrote down the path to object storage: the row stays the index and checksum authority, bytes move to a private bucket under a business-prefixed key, routes keep authorising and serving. | F5 §5 "When to move" |
| `finance_expenses.receipt_reference` (free text) exists from F1 but is never written, read or exposed, because it could hold a public link. | `finance.prisma` line ~430, data model §19.6 |
| Discarding a draft expense does not delete it: it becomes `VOID` with an audit entry. Recorded expenses are never edited; corrections are void and re-record. | `modules/finance/server/expenses.ts` |
| Permissions: `finance:read`, `finance:expenses` for OWNER, ADMIN and MANAGER; `finance:manage` for OWNER and ADMIN; MEMBER has no Finance access. | `modules/access/server/permissions.ts` |
| Web CSP: `connect-src 'self'`, `img-src 'self' data: blob:`, `worker-src 'self'`; the Tauri CSP is similar. PDFs are previewed with PDF.js from bytes, not a blob iframe (PR #47). | `apps/web/vercel.json`, `apps/desktop/src-tauri/tauri.conf.json` |
| `pdfjs-dist` 6.4.299 is already a dependency of both `apps/api` and `packages/app`. There is no image-processing library. | `package.json` files |
| E1 rule for attachments: file name and storage key count as content and are erased with their record; size and type may stay. | `communications-e1.md` §3 row 6 |
| E1 restore rule: a restored database is isolated until erasures are replayed. | `communications-e1.md` §10 |

No open PR touches Finance expenses, attachments or object storage. #118 (C2-B2) keeps mail attachments as
metadata only with an on-demand proxy, which is consistent with this design. #117 (ZCR-1) lists F-RCPT and
D-ZCR-7 and asks for this feasibility note first. #110 (WF-1B-1) changes Finance link rules but not expenses'
files.

## 3. Requirements and threat model

### 3.1 Requirements

- **R1 Tenant isolation.** A file is reachable only by members of its business with the right permission,
  through `/api/v1`, after the same checks as the expense it belongs to. No public URLs, ever.
- **R2 Integrity.** What is downloaded is byte-for-byte what was accepted (SHA-256 recorded and checked).
- **R3 Records.** Receipts on recorded expenses are accounting records. They are not silently lost, replaced
  or edited, and every change is audited.
- **R4 Erasure.** A file can really be removed when policy allows, including its name, and erasure survives a
  restore (E1 §10 model).
- **R5 Works on Vercel.** Function request bodies are limited to 4.5 MB (**verified**, Vercel Functions
  limits page). Non-streamed responses have the same limit.
- **R6 Works in all clients** (Tauri on macOS and Windows, browser) without loosening CSP more than necessary.
- **R7 Cheap at beta scale and predictable after.** No new paid service without Regan.
- **R8 Region.** Data stays in the US region of ADR 0002 (`us-east-1`), colocated with compute and database
  where possible (ADR 0002 principle 1).

### 3.2 Threats

| # | Threat | Main defence |
|---|---|---|
| T1 | Member of business A reads business B's file by guessing or swapping an id or key | Row lookup under `withTenant` + forced RLS; the storage key is generated by the database from `business_id` and the row id, never from input (§7.2) |
| T2 | Leaked or cached download link | No presigned URLs to clients in stage 1; responses are `no-store` (§9) |
| T3 | Malicious file (script in SVG/HTML, polyglot, exploit in a PDF or image) | Allow-list of types checked by content, not name; images re-encoded; PDFs parsed and refused if encrypted; served with `nosniff`, sandbox CSP and `attachment` disposition (§8, §9); scanning decision (§11) |
| T4 | Storage credential leak | Server-only credential, one per environment, least scope, rotation; clients never hold one (§6.3) |
| T5 | Orphaned bytes (no row) that erasure cannot find | Row is written first; every object has a row (§8.3) |
| T6 | Restore brings back erased content | E1 replay extended to attachments (§12.4) |
| T7 | Cost abuse (huge or many uploads) | Size and count limits, per-business quota (§8.2) |
| T8 | Personal data in file names, EXIF GPS in photos | File names treated as content; images re-encoded without metadata (§8.1) |
| T9 | Full card numbers on receipts | Product policy and copy (L4 in §18); we cannot reliably detect them |

## 4. Storage options compared

Five options were assessed. All are object stores except E (status quo). Prices are list prices, US.

| | A. Neon Object Storage | B. Cloudflare R2 | C. AWS S3 (us-east-1) | D. Vercel Blob (private) | E. Postgres `bytea` (status quo, F5 pattern) |
|---|---|---|---|---|---|
| New vendor or contract | **No.** Part of the existing Neon project and Launch-plan bill | Cloudflare account exists (DNS), but R2 is a new paid product to enable | **Yes**, new AWS account | No (hosting vendor), new product on the Vercel bill | No |
| Storage price | $0.023/GB-month, **no per-operation charge** (verified, Neon plans page) | $0.015/GB-month; 10 GB-month free (verified, R2 pricing) | $0.023/GB-month first 50 TB (unverified in this pass, AWS list price) | $0.023/GB-month (verified, Blob pricing page) | $0.35/GB-month (verified, Neon plans page), plus history and snapshot storage |
| Operations | Free | Writes $4.50/M, reads $0.36/M; 1M writes and 10M reads free monthly (verified) | PUT $0.005/1k, GET $0.0004/1k (unverified) | Uploads $5.00/M, reads $0.40/M (verified) | n/a |
| Egress | Counts toward the 500 GB/month project transfer allowance, then $0.10/GB (verified) | Free (verified) | $0.09/GB after the AWS free allowance (unverified) | Blob transfer about $0.05/GB in iad1 plus function transfer when proxied (verified example) | Counts toward the same Neon allowance |
| Region | `aws-us-east-1` available (verified). Same region as our database | Location hint `enam` is **best effort, not a guarantee**; jurisdictions exist only for EU and FedRAMP (verified) | `us-east-1`, exact | Store region selectable (unverified for private stores) | Same database |
| Isolation tools | Private bucket (default), credentials scoped to a branch with read or write scope, optional expiry up to 365 days (verified) | Bucket-scoped API tokens, private by default, no public access unless enabled | IAM policies, Block Public Access, prefix conditions | Private store, OIDC from Vercel functions (no long-lived secret) (verified) | RLS directly on the bytes. Strongest |
| Backup and restore consistency | **Buckets branch with the database, copy-on-write** (verified). A recovery branch holds rows and files at the same moment | Separate from the database. No object versioning (S3 versioning calls unsupported). Bucket locks can block deletion by prefix (verified) | Versioning, Object Lock, replication | Separate from the database | Same database, same branch |
| Deletion semantics | `DeleteObject` "soft-deletes the object on the current branch" (verified wording). How long it stays recoverable is **not documented** | Hard delete | Hard delete, or delete marker with versioning | Hard delete | Row delete; survives in history window and branches |
| Lifecycle, lock, notifications | Lifecycle and versioning stored but **not enforced**; object lock "limited"; no bucket notifications (verified) | Lifecycle, bucket locks, event notifications | All | TTL per blob | n/a |
| Encryption at rest | **Not stated in the docs read** (unverified) | Encrypted at rest by default (unverified in this pass, R2 docs) | SSE-S3 default, SSE-KMS optional | Not checked | Neon storage encryption (unverified in this pass) |
| Malware scanning available | No native option; upload triggers to Neon Functions exist | No native option on R2 (Cloudflare's upload scanning is a WAF add-on, unverified for R2) | **GuardDuty Malware Protection for S3**: $0.09/GB scanned in us-east-1 since Feb 2025 plus a per-object charge; free tier 1,000 objects and 1 GB per month (verified) | No | No |
| S3-compatible API | Yes (subset, path-style, SigV4) | Yes | Yes | No (own SDK) | n/a |
| Maturity | **New product** (docs dated 2026). No SLA or GA statement found | Mature | Mature | Private stores are GA (verified changelog title) | Proven in F5 |
| Upload size limit | 5 GiB single request | 5 GiB single | 5 GB single | Large; client uploads bypass function limit | Our own CHECK (4 MB) |

### 4.1 Cost scenarios (estimated)

Assumption: an average stored receipt is 0.5 MB after the client shrinks photos (§13), and each receipt is
opened three times. "Stored" is after 12 months of growth.

| Scenario | Uploads/month | Stored at month 12 | A. Neon OS | B. R2 | C. S3 | D. Vercel Blob | E. Postgres |
|---|---|---|---|---|---|---|---|
| Private beta: 20 businesses × 50 receipts | 1,000 | ≈ 6 GB | ≈ $0.14/mo | $0 (free tier) | ≈ $0.15/mo | ≈ $0.20/mo | ≈ $2.10/mo + history |
| Early growth: 500 businesses × 100 receipts | 50,000 | ≈ 300 GB | ≈ $6.90/mo (egress ≈ 75 GB/mo, inside the 500 GB allowance if the DB leaves room) | ≈ $4.35/mo, ops inside free tier | ≈ $7.15/mo + egress after free allowance | ≈ $11/mo incl. transfer | ≈ $105/mo + history and backup growth |

At beta scale every object store is effectively free. Cost does **not** decide between A to D; architecture,
residency and recovery do. Postgres (E) becomes the expensive option as soon as receipts accumulate, and it
also grows every recovery branch, restore and logical backup.

## 5. Recommendation

1. **Use an object store, not Postgres, for receipts.** Receipts are 10 to 100 times larger than F5 PDFs and
   grow with every expense. F5's own move criteria ("when large attachments arrive") are met.
2. **First choice: Neon Object Storage (A)**, *if* the verification gate G-1 (§15) passes. Reasons:
   - no new vendor, contract or sub-processor beyond Neon, which already holds all tenant data;
   - same region as the database and functions (`aws-us-east-1`), so ADR 0002 residency stays true without a
     best-effort hint;
   - files branch with the database, so the existing recovery-branch procedure (`pre-<change>-migration`)
     captures rows and files at the same instant, and preview or rehearsal branches never touch production
     files;
   - no per-operation charges.
3. **Fallback: Cloudflare R2 (B)** if G-1 fails (for example no at-rest encryption statement, or soft-deleted
   objects that cannot be purged). R2 is mature and the cheapest, but it is a new paid product, its US
   placement is a hint rather than a guarantee, and it is not covered by Neon recovery branches.
4. **Not recommended now:** S3 (C) adds a whole cloud account for one bucket; choose it only if Regan wants
   managed malware scanning (GuardDuty) from day one. Vercel Blob (D) is not S3-compatible, so it locks the
   code to Vercel, and proxied reads pay transfer twice.
5. **Design so the provider can be swapped.** All S3-compatible providers (A, B, C) share one adapter. The
   database row, not the bucket, is the source of truth, so moving providers is a copy-and-verify job.

## 6. Architecture

### 6.1 Modules and ownership

- `apps/api/src/core/storage/` (new, shared, controlled surface): the `ObjectStore` interface, an
  S3-compatible implementation, an in-memory implementation for tests, content sniffing, response headers.
  No tenant logic and no SQL. Other Zones may reuse it later through their own tables.
- `apps/api/src/modules/finance/server/attachments.ts` (new): validation, the unit of work, authorization,
  audit, routes under `/api/v1/b/:slug/finance/...`.
- `packages/contracts/src/finance-attachments.ts` (new, additive).
- `packages/app/src/zones/finance/expenses/*`: upload, list, preview and remove on the expense form and detail.
- Shared files that need coordinated edits: `routes.ts`, contracts `index.ts` and `api-v1.json`,
  `check-boundaries.mjs`, ADR 0002's residency table.

```ts
interface ObjectStore {
  put(key: string, body: Uint8Array, opts: { contentType: string; sha256: string }): Promise<void>;
  get(key: string): Promise<{ body: Uint8Array; size: number } | null>; // null: missing
  delete(key: string): Promise<void>; // idempotent
  head(key: string): Promise<{ size: number } | null>;
}
```

### 6.2 Buckets and environments

| Environment | Bucket | Credential |
|---|---|---|
| Production | `finance-attachments` on the production branch (A) or `pixa-prod-finance-attachments` (B) | read+write, production only |
| Preview deployments | Its own branch or bucket. With A, a preview Neon branch already has its own view of storage | separate credential |
| Local, CI | In-memory adapter, plus an S3 emulator for the adapter's contract tests. **CI never calls a real provider** | none |

One bucket per environment, not per tenant. Per-tenant buckets add provisioning without improving isolation,
because isolation is enforced before any storage call (§7.2).

### 6.3 Credentials

- Server-only environment variables (endpoint, key id, secret, bucket) set in Vercel for the API project only.
  Never in `apps/web`, the desktop build or any client. The client has no route to the store.
- Least scope: read+write for the API. A read-only credential would be used by any later read-only job.
- With A: a credential is valid for its branch and its descendants (verified), so recovery branches are
  readable with it; preview deployments must use a credential minted on a non-production branch. Set an expiry
  (≤ 365 days) and a rotation reminder.
- Creating buckets and credentials and setting Vercel variables is a **credential and deploy-config change:
  Regan's own approval** (protocol "Escalate to Regan").
- When unconfigured, attachment routes answer `503 storage_unconfigured` and the UI hides upload. This lets the
  code merge and deploy dark.

## 7. Data model (proposed migration, not written)

### 7.1 `finance_attachments`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | UUIDv7, server-generated |
| `business_id` | uuid | RLS key, leading index |
| `expense_id` | uuid null | composite FK `(business_id, expense_id)` → `finance_expenses` |
| *(later)* `document_id`, `payment_id` | uuid null | composite FKs; CHECK exactly one owner column is set |
| `status` | enum `PENDING`, `AVAILABLE`, `FAILED`, `REMOVED` | §8.3 |
| `storage_key` | text, **generated** | `'b/' || business_id || '/finance/attachments/' || id`. Never written by the app |
| `content_type` | text | CHECK in `image/jpeg`, `image/png`, `image/webp`, `application/pdf` |
| `byte_size` | int | CHECK `1..4194304` |
| `sha256` | char(64) | of the stored bytes; CHECK hex |
| `file_name` | text null | display name, sanitised, ≤ 160 chars. **Content** under E1: nulled on removal |
| `page_count`, `width`, `height` | int null | from validation |
| `duplicate_of_id` | uuid null | another attachment in the business with the same `sha256` (informational) |
| `scan_status` | enum `NOT_SCANNED`, `CLEAN`, `INFECTED`, `ERROR` | `NOT_SCANNED` until §11 is decided |
| `created_by_id`, `created_at` | | |
| `removed_by_id`, `removed_at`, `removed_reason` | null | set together (CHECK) |
| `version` | int | optimistic concurrency |

Constraints and guards:

- `ENABLE` and `FORCE ROW LEVEL SECURITY`, tenant policy as every Finance table; covered by `tests/isolation`
  and the schema test.
- Index `(business_id, expense_id, created_at)`; partial index on `(business_id, sha256)` where `AVAILABLE`.
- Guard trigger: `content_type`, `byte_size`, `sha256`, owner columns and `created_*` are immutable; status may
  only move `PENDING → AVAILABLE | FAILED` and `AVAILABLE → REMOVED`; a `REMOVED` row has `file_name` NULL and
  `sha256` replaced by `sha256('removed:' || id)` (as E1 does for content hashes).
- Trigger: no new attachment on a `VOID` expense (`409 expense_not_open`); at most 10 non-removed
  attachments per expense.
- No DELETE grant to the runtime role. Rows are tombstoned, never deleted, except by the business cascade.
- `finance_expenses.receipt_reference` is left as it is (unused). Dropping it is destructive and not needed.

### 7.2 Why isolation holds without RLS in the bucket

Object stores have no row-level security, so the bucket must never be the access check. Every path goes:

1. `withTenant(slug)` resolves the business and membership; permission check (§10).
2. Row lookup by `id` **and** `business_id` under forced RLS. A row from another business is invisible, so
   the answer is `404`, the same as a missing id.
3. The key comes from the generated column of that row. It is a pure function of `business_id` and `id`, so a
   tampered or buggy row cannot point at another tenant's prefix, and nothing a client sends ever becomes
   part of a key.
4. Bytes are read and their SHA-256 compared with the row before sending (as F5 does). Mismatch: `500
   integrity_error`, audited, nothing sent.

Tests must prove each step (§15, T-1..T-6).

## 8. Upload

### 8.1 Validation (server, before anything is stored)

1. Request `Content-Length` ≤ 4 MB, and the body read with a hard cap (an absent or false length cannot get
   past it). `413 attachment_too_large`.
2. Type from the **content** (magic bytes), not the name or header: JPEG, PNG, WebP or PDF. Anything else,
   including SVG, HTML, HEIC, TIFF, Office files and archives: `415 attachment_type_not_allowed`.
3. Images: decode fully, limit to 40 megapixels, **re-encode** (JPEG or PNG) without metadata. This removes
   EXIF location data and neutralises most image-parser exploits. Needs an image library in the API
   (for example `sharp`, a native dependency; decision D-RCPT-4).
4. PDFs: open with the existing `pdfjs-dist` on the server; refuse encrypted or unparseable files and more than
   50 pages (`422 attachment_invalid`). PDFs are stored as received (not rewritten).
5. File name: keep the base name only, strip control and path characters, cap at 160 chars. Used for display
   and the download name only.
6. SHA-256 of the bytes that will be stored.
7. Duplicate check: same `sha256` already `AVAILABLE` on this expense → `409 attachment_duplicate`; on another
   expense → accepted, `duplicateOfId` returned so the UI can say "This receipt is already on expense …"
   (useful against double-claiming).

### 8.2 Limits (proposed defaults, D-RCPT-10)

4 MB per file, 10 per expense, 2 GB per business during the beta (sum of `byte_size` of non-removed rows,
checked in the unit of work; `409 storage_quota_exceeded`). Upload requests are `Idempotency-Key` aware, as
payments are.

### 8.3 Write order and failure handling

The bucket is not transactional, so the row comes first. That way every object has a row, and erasure can always
find it (T5).

```text
validate bytes (no DB, no storage)
tx1: lock expense FOR SHARE → check open, count, quota → insert row PENDING → audit "upload started" → commit
put object at storage_key (retry up to 3 times)
tx2: lock row FOR UPDATE → head object, compare size → status AVAILABLE → audit finance.attachment.added → commit
```

- Put fails: tx2 marks the row `FAILED` (and best-effort deletes the key). The client gets `503 retryable`.
- The function dies between put and tx2: the row stays `PENDING`. `PENDING` rows are never listed. Any later
  upload or list on the same expense finishes or fails rows older than 15 minutes (head the key: present →
  `AVAILABLE` only if the hash check passes on read, otherwise delete and `FAILED`). A manual operations script
  does the same for the whole bucket. **No cron is introduced** (cron stays Regan's decision).
- Lock order: expense, then attachment rows by id, which fits ADR 0007 (expenses after documents and payments).

### 8.4 Why not direct-to-bucket uploads now

Presigned PUT would avoid the 4.5 MB function limit, but: R2 does not support presigned POST, so the size cannot
be enforced by the URL (verified); every client CSP would need the bucket origin in `connect-src` (a CSP change
needs an architecture note per ADR 0005 and is a deploy-config change); validation would run after the bytes
are already in the bucket. A 4 MB cap is enough for receipts once the client shrinks photos (§13). Revisit only
if real users hit the cap.

## 9. Preview and download

`GET /api/v1/b/:slug/finance/attachments/:id/content?disposition=inline|attachment`

- Authorised and integrity-checked as in §7.2, then served by the API (≤ 4 MB, under Vercel's 4.5 MB
  response limit; streaming not needed).
- Headers: `Content-Type` from the row (allow-listed), `Content-Disposition` with an RFC 6266 `filename*`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`,
  `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`.
- The client fetches bytes with the session, then shows images through a `blob:` URL (already allowed in
  `img-src`) and PDFs through the existing PDF.js viewer with scripting off. **No CSP change** on web or desktop.
- Desktop "Save" writes the file through the existing download path; "Open" hands it to the operating system,
  which is where a malicious PDF would act, hence §11.

**Presigned GET URLs are not given to clients in stage 1.** They are bearer tokens until they expire (up to
7 days on R2 and Neon, verified), cannot be revoked, and end up in history and logs. If later needed for size or
speed, use ≤ 60 seconds, one object, `response-content-disposition=attachment`, issued only after the checks
above, and audited.

## 10. Authorization and audit

| Action | Permission (recommended, D-RCPT-6) | Roles today |
|---|---|---|
| List, preview, download | `finance:read` and the expense is visible | OWNER, ADMIN, MANAGER |
| Upload to a draft or recorded expense | `finance:expenses` | OWNER, ADMIN, MANAGER |
| Remove from a draft expense | `finance:expenses` | OWNER, ADMIN, MANAGER |
| Remove from a recorded or void expense (reason required) | `finance:manage` | OWNER, ADMIN |

No new permission keys, so `permissions.ts` is not touched. MEMBER has no Finance access and gets `404`.

Audit events (ids, sizes, types and result codes only; never file names, keys or bytes):
`finance.attachment.added`, `.removed`, `.downloaded`, `.previewed`, `.integrity_failed`, `.upload_failed`.
Previews are audited because F5-D4 audits PDF previews; if that is too noisy, D-RCPT-9 lets Regan drop previews only.

## 11. Malware scanning

### 11.1 Options (pricing verified 2026-11-17 unless marked)

| Option | Cost | Data leaves our providers? | Notes |
|---|---|---|---|
| None, with strict validation (§8.1, §9) | $0 | No | Image re-encoding removes most image risk. PDFs and the OS viewer remain the gap |
| GuardDuty Malware Protection for S3 | $0.09/GB scanned + per-object charge (amount unverified); free tier 1,000 objects and 1 GB/month | No (AWS) | Only with S3 (option C). Asynchronous: needs a quarantine state until the result arrives |
| Scanning API (Scanii from $49/month; AttachmentScanner $99 to $849/month) | Fixed monthly | **Yes**: a new sub-processor sees receipts | DPA, residency and ADR 0002 table update needed |
| Self-hosted ClamAV on a small container | Host cost (unverified), operations work | No, if hosted in-region | Needs a new always-on service; ClamAV detection of targeted documents is modest |
| VirusTotal | n/a | Yes, shared with its community | **Rejected**: uploads become visible to third parties |

### 11.2 Recommendation (D-RCPT-5)

- **Stage 1 (staff uploads only): no scanner.** Uploaders are authenticated members of the same business,
  the audience is the same business, and the mitigations in §8.1 and §9 apply. The `scan_status` column is
  in place from day one (`NOT_SCANNED`), the UI says nothing that implies a scan happened.
- **Scanning becomes mandatory before any third-party content** enters (receipts by email, saving C2 mail
  attachments, customer uploads). That stage adds a quarantine flow: `PENDING_SCAN` rows are not downloadable
  until `CLEAN`. Choosing and paying for a scanner is Regan's decision then.

## 12. Retention, erasure, backups

### 12.1 Retention

- Attachments live as long as their expense. Expenses are kept (they are never deleted, only voided).
- **No automatic purge** until Finance retention periods are decided (legal question L1). This follows
  D-E1-5: no invented durations.
- Discarding a draft expense (it becomes `VOID`) removes its attachments: tombstone rows, delete objects
  after commit (recommended in D-RCPT-7, since a discarded draft was never a record).

### 12.2 Removal

- Removing tombstones the row (status `REMOVED`, `file_name` NULL, hash replaced, who, when, reason) and deletes
  the object after the transaction commits. If the delete fails, the row is still `REMOVED` and the
  operations script deletes the key later (deletes are idempotent).
- On recorded and void expenses removal needs `finance:manage` and a reason (a wrong file or someone's private
  document must be removable). The UI warns that the receipt may be a tax record.

### 12.3 Erasure requests

- A person's erasure request can touch receipts (their name, address, card digits). Receipts on recorded
  expenses are treated like E1's `RETAINED_RECORD`: the request is **deferred**, not silently refused, until
  L1 and L2 are answered. Draft attachments are erased.
- Finance has no erasure ledger yet. When it gets one (with the Finance retention policy), attachment removals
  are recorded there by id, and the E1 replay rule applies to them.

### 12.4 Backups and restores

| Event | Option A (Neon OS) | Option B (R2) |
|---|---|---|
| Recovery branch before a migration | Holds rows and files at the same moment | Holds rows only; files are live in R2 |
| Restore from a branch | Rows and files come back together. Files removed since then come back too, so **removals must be replayed** before the restored branch is used (E1 §10 steps apply) | Rows come back; files removed since then are gone. Rows whose object is missing answer `410 attachment_unavailable` |
| Erasure surviving in old branches | Yes, until the branch is deleted (same as database content today) | No copies, unless bucket locks or copies are added |
| Accidental deletion protection | Branches and the history window | None by default; bucket lock rules can prevent deletion but conflict with erasure |

The replay list for attachments is simple: every row that is `REMOVED` in the live database must have no
object in the restored environment. The operations script checks and deletes, and the E1 "isolated until
replayed" gate is extended to include it.

### 12.5 Business deletion

Deleting a business cascades rows but not objects. Before any business-deletion feature exists, it must delete
the prefix `b/<business_id>/` and verify it is empty. Archiving a business (what exists today) keeps everything.

## 13. Client and UI

- Expense form and detail get an "Attachments" section: drop zone and file picker, list with thumbnail, name,
  size and date, preview panel (images, PDF.js), download, remove (with reason when recorded).
- Before upload, the client shrinks photos larger than 2,400 px on the long edge to JPEG (about 0.3 to 1 MB).
  macOS WebKit (Tauri on Mac, Safari) can decode HEIC iPhone photos this way; Chromium and WebView2 on
  Windows cannot, so HEIC is refused there with a clear message (D-RCPT-3).
- States: uploading with progress, failed with retry, too large, wrong type, quota reached, storage not
  configured (upload hidden), duplicate warning, read-only for MANAGER on recorded expenses' removal.
- Built with the existing Finance zone components and design tokens; no new shell or navigation entries.

## 14. API (additive contracts)

| Method and path | Purpose | Errors |
|---|---|---|
| `GET …/finance/expenses/:id/attachments` | List `AVAILABLE` attachments | 404 |
| `POST …/finance/expenses/:id/attachments` (raw body, `Content-Type`, `X-File-Name`, `Idempotency-Key`) | Upload | 409 `expense_not_open`, `attachment_duplicate`, `attachment_limit`, `storage_quota_exceeded`; 413; 415; 422; 503 `storage_unconfigured`, `retryable` |
| `GET …/finance/attachments/:id/content?disposition=` | Bytes | 404, 410 `attachment_unavailable`, 500 `integrity_error` |
| `POST …/finance/attachments/:id/remove` (`reason`, `version`) | Tombstone | 403, 409 `version_conflict` |

Expense list and detail DTOs gain `attachmentCount` (additive), so the list can show a paperclip.

## 15. Gates and tests

**Gates before activation (each must be evidenced on the PR):**

- **G-1 Provider verification (A).** Written confirmation from Neon docs or support of: encryption at rest;
  what "soft-delete" means and how a deleted object is permanently purged (and when); GA status and SLA;
  that the Neon DPA covers Object Storage; that the bucket is in `aws-us-east-1`. If any answer is
  unsatisfactory, switch to B and record why.
- **G-2 Isolation proof.** Tests T-1..T-6 green in `tests/isolation`.
- **G-3 Restore runbook.** The removal replay (§12.4) written into `docs/operations/` and rehearsed once on a
  disposable branch.
- **G-4 Residency and sub-processors.** ADR 0002 table gains an "Object storage" row.
- **G-5 Legal.** L1 answered before any automatic purge (not before stage 1).

**Tests (implementation PRs):**

- T-1 Business B cannot list, read, download or remove A's attachment by id (404), with every role.
- T-2 Changing the slug, the expense id or the attachment id in any combination never crosses tenants.
- T-3 `storage_key` cannot be written (generated column) and always starts with the row's business prefix.
- T-4 RLS forced on `finance_attachments`; runtime role has no DELETE; schema test passes.
- T-5 MEMBER gets 404; MANAGER cannot remove from a recorded expense; reason required.
- T-6 Integrity: a byte flipped in the store gives 500 `integrity_error` and an audit entry, never the bytes.
- Validation: renamed HTML or SVG as `.jpg`, polyglot JPEG/HTML, encrypted PDF, 51-page PDF, 4 MB + 1 byte
  with a lying `Content-Length`, decompression-bomb PNG, EXIF GPS removed after upload.
- Consistency: put failure, crash between put and tx2 (row stays PENDING, then reconciled), concurrent uploads
  racing the 10-per-expense limit and the quota (exact winners), upload racing void (no attachment on a void
  expense), idempotent retry returns the same row.
- Erasure: removal nulls name and hash; object deleted; failed delete is picked up by the script; replay after a
  simulated restore deletes resurrected objects.
- Headers: `nosniff`, sandbox CSP, `no-store`, `filename*` encoding of non-Latin names.
- Audit entries contain no file names, keys or bytes.
- All storage tests use the in-memory adapter or the emulator; a manual smoke on a non-production bucket from the
  Mac session before activation.

## 16. Stages

| Stage | Content | Needs |
|---|---|---|
| F-RCPT-0 | This document | ChatGPT audit, Regan's decisions |
| F-RCPT-1 | `core/storage`, migration for `finance_attachments`, API, contracts, tests. Ships **dark** (`503 storage_unconfigured`) | Migration verdict and recovery branch per protocol; merge verdict |
| F-RCPT-2 | Expense UI (upload, list, preview, download, remove) | Merge verdict |
| F-RCPT-3 | Activation: bucket and credential created, Vercel variables set, smoke on preview then production | **Regan** (credentials, deploy config, provider product enabled), G-1, G-3, G-4 |
| Later | Attachments on documents and payments; scanning and third-party sources; OCR | Separate approvals |

F-RCPT-1 and 2 can be built and tested without any provider account.

## 17. Owner decisions (Regan)

| # | Decision | Recommendation | Why it is Regan's |
|---|---|---|---|
| D-RCPT-1 | Storage provider | **Neon Object Storage** if G-1 passes, otherwise **Cloudflare R2**. Not Postgres for receipts | Enables a paid product (both are usage-billed; beta cost under $1/month) |
| D-RCPT-2 | Transfer model | Through the API only, 4 MB cap, no presigned URLs to clients in stage 1 | Security posture |
| D-RCPT-3 | Allowed types | JPEG, PNG, WebP, PDF; HEIC converted on the client where the platform can, refused otherwise | Product scope |
| D-RCPT-4 | Image re-encoding and metadata removal | Yes, using an image library in the API | New native dependency |
| D-RCPT-5 | Malware scanning | None for staff uploads in stage 1; mandatory before any third-party source; paid scanner chosen then | Risk acceptance; future paid service |
| D-RCPT-6 | Permissions | As §10, no new keys | Role policy |
| D-RCPT-7 | Removal | Drafts: removable, and discarding a draft removes its files. Recorded and void: OWNER/ADMIN with reason, bytes deleted | Records vs privacy trade-off |
| D-RCPT-8 | Retention | Kept with the expense; no automatic purge until L1 | Legal |
| D-RCPT-9 | Auditing | Uploads, removals, downloads and previews (as F5-D4) | Audit volume |
| D-RCPT-10 | Limits | 4 MB, 10 per expense, 2 GB per business in beta | Cost and abuse control |
| D-RCPT-11 | Application-level encryption | Not in stage 1, **unless** G-1 cannot confirm encryption at rest | Key management cost |
| D-RCPT-12 | First scope | Expenses only; documents and payments later | Scope |

## 18. Open legal questions (not answered here)

- **L1 Retention periods** for receipts per country. Commonly cited: US IRS generally 3 years, longer in some
  cases; Australia ATO 5 years (both **unverified**, needs advice). Links to E1 open item 1.
- **L2 Erasure versus records.** May a business keep a receipt image after a person asks for erasure, and for
  how long (GDPR Art. 17(3)(b), Australian Privacy Act)? Links to D-E1-5.
- **L3 Sub-processor terms.** Confirm the Neon (or Cloudflare) DPA covers object storage; update the
  sub-processor list.
- **L4 Card data.** Receipts normally show only the last digits of a card. Pixa OS should tell users not to
  upload documents showing full card numbers; whether anything more is needed for PCI DSS is a question
  for advice.

## 19. Sources (read 2026-11-17)

- Cloudflare R2 pricing: developers.cloudflare.com/r2/pricing (verified figures in §4).
- R2 presigned URLs (expiry up to 7 days, POST unsupported): developers.cloudflare.com/r2/api/s3/presigned-urls.
- R2 data location (hints best effort; jurisdictions EU, FedRAMP): developers.cloudflare.com/r2/reference/data-location.
- R2 bucket locks: developers.cloudflare.com/r2/buckets/bucket-locks.
- Neon plans (storage $0.35/GB-month, object storage $0.023/GB-month, transfer allowance): neon.com/docs/introduction/plans.
- Neon Object Storage overview, buckets, authentication, S3 compatibility, objects: neon.com/docs/storage/*.
- Vercel Blob pricing and private storage: vercel.com/docs/vercel-blob/usage-and-pricing, /private-storage.
- Vercel Functions limits (4.5 MB request and response): vercel.com/docs/functions/limitations.
- GuardDuty Malware Protection for S3 price reduction (Feb 2025, $0.09/GB in us-east-1) and free tier:
  aws.amazon.com/about-aws/whats-new/2025/02/…; GuardDuty user guide "Pricing and usage cost for Malware Protection for S3".
- Scanii and AttachmentScanner public pricing pages.
