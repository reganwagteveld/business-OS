# Finance F7-B: catalog items on quotes and invoices

> Status: **draft PR for independent audit.** Not merged, not deployed. **No migration.**
> Owner decisions D-F7B-1 to D-F7B-6 (§6) are built as proposed defaults and are **pending Regan's approval**.

## 1. Audit (main at 81ff625)

| Area | Finding | Consequence |
|---|---|---|
| F7-A | Merged as 15f7746 (PR #63). Migration `20261130000000_finance_catalog` is the newest on main; production state was recorded by the F7-A thread, not re-checked here (this change needs no migration). | Builds on the catalog table and `lineDefaultsOf` as they are. |
| Lines | `finance_document_lines` hold free text, quantity, unit price (6 decimals), optional tax rate; tax name and percentage are snapshotted by the line guard and sealed at issue. Lines are always sent as the complete list. | A catalog line becomes an ordinary line before pricing. Nothing in pricing, issuing, numbering, sealing or the content hash changes. |
| Recurring, credit notes | Share `FinanceLineInput`. | Unchanged (D-F7B-6): they keep `FinanceLineInput`, which refuses `catalogItemId`. |
| Permissions | Drafts are `finance:write`; reading the catalog is `finance:read`; every role with `finance:write` also has `finance:read` (now a unit test). | No new key. |
| Concurrency | Documents are locked first (`FOR NO KEY UPDATE`); catalog changes are conditional on `version`. | Catalog items are read `FOR SHARE` after the document lock, in id order. |

## 2. Why no migration

A stored `catalog_item_id` on lines would only serve reporting. Copying values is enough for everything in scope, keeps issued documents independent of the catalog by construction, and avoids touching the line guard and content hash. Adding the link later is additive (nullable column plus composite FK) if reporting needs it.

## 3. API

Quotes and invoices only (`POST /quotes`, `PATCH /quotes/:id`, `POST /invoices`, `PATCH /invoices/:id`). Each line is `FinanceDraftLineInput`:

- Without `catalogItemId`: exactly as before (description, quantity, unit price required).
- With `catalogItemId`: every other field is optional. The server reads the item and fills what was not sent: description = name, then description on the next line (≤ 1000); quantity 1; the item price **only if the item's currency is the document's currency**; tax = the item's rate, the business default rate now, or none. Any field the client sent wins (including `taxRateId: null`).
- The item id is not stored, not returned and not audited. The result is a plain line, priced by the existing `priceLines`.

| Error | When |
|---|---|
| `400 invalid_catalog_item` | Unknown id, or another business's item (same answer, nothing leaks). |
| `409 archived_reference` | Archived item; or the tax it brings (its rate, or the default rate) is archived and the draft did not already use it. |
| `409 catalog_item_inactive` | Item marked inactive. |
| `400 catalog_currency_mismatch` | Item priced in another currency and the line has no price. |
| `400 catalog_price_required` | Item has no default price and the line has no price. |
| `400 invalid_input` | `catalogItemId` on a credit note line (contract and service). |

Concurrency: `resolveCatalogLines` (finance `catalog.ts`) runs after the document lock and reads the items `FOR SHARE ... ORDER BY id`. A concurrent archive, deactivation or price change either commits first (and is seen) or waits for the save. Audit: `finance.document.created`/`updated` gain `catalogLineCount` when a line came from the catalog; no ids, names or prices.

## 4. UI

The draft quote and invoice form has **Add from catalog** next to **Add line**. It opens a search over active, unarchived items (name, code, description; 8 results; labelled search box, polite live region, one button per item). Picking an item adds a line with the copied values, a "From catalog" chip and a **Keep as manual line** action. A price in another currency is left empty with a note; switching a new draft's currency re-applies the item price only if the person did not type their own. An item rate that is archived is left empty with a note. The server decides on save; its refusals are shown in words.

Screenshots (local run, fake data): `docs/evidence/finance-f7b/`.

## 5. Tests

- `apps/api/tests/integration/finance-catalog-lines.test.ts` (19): defaults and overrides; mixed lines on create and edit; manual lines unchanged; 6-decimal prices; idempotent replay; currency; tax (default, none, archived rate and default, already-used rate); archived and inactive items leave the draft unchanged; another business's item; permissions by key; credit notes; issued documents unchanged after item edits and archive; quote issue and convert; audit content; two races staged with `pg_blocking_pids` (save vs archive, save vs price change incl. rollback).
- `packages/app/tests/finance-catalog-lines.test.tsx` (6), `packages/contracts/tests/finance-catalog-lines.test.ts` (3), `apps/api/tests/unit/access.test.ts` (+1).

## 6. Owner decisions (built as defaults, pending approval)

| # | Decision | Default built |
|---|---|---|
| D-F7B-1 | Store a link from a line to its item | No: values are copied, no migration; a link can be added later for reporting |
| D-F7B-2 | Item priced in another currency | Its price is never used or converted; the line needs a price in the document currency |
| D-F7B-3 | Who may change a catalog line's price, tax, description | Anyone who may edit drafts (`finance:write`); no price lock |
| D-F7B-4 | Archived and inactive items | Cannot be added; saved lines never change when the item changes later |
| D-F7B-5 | Business default tax archived | Refused (409 archived_reference) rather than silently untaxed |
| D-F7B-6 | Scope | Quotes and invoices only; recurring templates and credit notes later; units not shown (lines have no unit) |

## 7. Rollout and rollback

No migration and no privileged SQL, so deploy order does not matter. Rollback is a code revert; documents created meanwhile are ordinary documents.
