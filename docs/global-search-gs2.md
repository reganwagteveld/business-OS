# GS2: Global Search Experience, design and implementation plan

**Status:** Draft for ChatGPT audit and Regan's approval. Documentation only: no code, migration, deployment or production change.
**Base:** `main` at `7eea955` (GS1 merged as a document).
**Builds on:** [GS1](./global-search-gs1.md) (architecture, API, permission model; decisions D-GS1-1..18) and [UI V2-A](./ui/pixa-design-system-v2-a.md) §8 (shell, command palette, keyboard map).
**Naming note:** GS1 §4.3 used "GS2" for a possible future design of excluded data (activities, messages, leave). This document takes the name GS2 for the user-facing search experience. The excluded-data design, if ever wanted, becomes **GS3** (D-GS2-17).

## Contents

1. Summary
2. Preflight audit (verified on `main`)
3. Scope and relationship to GS1
4. Experience design
5. Interaction flows
6. Module coverage matrix
7. API dependency analysis
8. Security and privacy
9. Accessibility
10. Performance
11. Desktop (Tauri) and web parity
12. Work packages and implementation sequence
13. Test strategy
14. Security and accessibility checklist
15. Open decisions (D-GS2-n)
16. Risks

## 1. Summary

- **One search surface:** the ⌘K / Ctrl+K command palette from V2-A §8.2, opened from the top bar. It shows **commands** (client-side, instant) and, from two characters, **Records** grouped by Zone (server, via GS1's `POST /search`).
- **GS2 adds no new endpoint.** It is the client experience over GS1's contract. It never reads records except through that contract.
- **Hard dependency:** record search needs GS1-A (backend, index migration) **and** the V2-C palette shell. Neither is built or authorised today. Nothing in production serves a search endpoint.
- **No interim fan-out.** The existing per-Zone `?q=` list endpoints are not a safe substitute (§7.3): they put terms in URLs, scan unindexed, return more fields than the GS1 allow-list and would mean up to eight parallel requests per keystroke. Until GS1-A ships, the palette is commands-only, exactly as V2-A specified.
- **Privacy by design:** no counts across Zones, no snippets, no amounts, no server history, no error text that echoes the query or names a Zone the person cannot read (§8).
- **Work:** six small work packages (§12). Three can start without GS1-A (target entry points, client with fakes, test and a11y fixtures); the rest wait for the V2-C palette and the GS1-A contract.
- **Open decisions:** D-GS2-1..17 (§15), each with a recommendation.

## 2. Preflight audit (verified on `main` at `7eea955`)

| Area | Finding | Evidence |
|---|---|---|
| Search entry in the shell | Top bar has a **disabled** "Search · Soon" placeholder (`Unavailable`). No palette, no `⌘K` handler exists. | `packages/app/src/shell/app-shell.tsx:140`, `:410` |
| Palette spec | Specified (V2-A §8.2): commands from `resolveNavigation`, create commands gated on write keys, rebuild on context change, no capture while typing or in modals, platform labels. Built in **V2-C**, which is not authorised (V2-B waits for Regan's go-ahead). | `docs/ui/pixa-design-system-v2-a.md` §8.2, §11 |
| Search API | **None deployed.** GS1 is a merged document. `packages/contracts` has no `search.ts`; `apps/api/src/modules` has no `search` module. | `ls packages/contracts/src`; GS1 §12 |
| Existing per-Zone `q` filters | Customers, contacts, opportunities, projects, employees, catalog, expenses, scheduling resources, People leave config. Case-insensitive `contains` (`ILIKE '%term%'`), no supporting index, `q` in the GET query string. | `customers/server/customers.ts:39`, `contacts.ts:78`, `opportunities.ts:333`, `projects.ts:202`, `employees.ts:224`, `catalog.ts:119`, `expenses.ts:479`, `resources.ts:136` |
| No text search today | Quotes, invoices, credit notes, tasks, events. | GS1 §2.3 |
| Navigation targets | `ShellRoute = { zone, child?, target?, intent? }`; no URL routing. A route is honoured only for a Zone the server's permissions open and only in the business it was chosen in; otherwise Home. | `packages/app/src/app.tsx:212-214` |
| Record targets that open | customer, project, employee, finance documents (`quote:`, `invoice:`, `credit-note:`). | `app.tsx:227,245,254`; `finance-zone.tsx:40-42` |
| Record targets that do not | contact, opportunity (Sales receives only `initialAction`), task panel, catalog item. | `app.tsx:237`; GS1 §10.6 |
| Scheduling | Built, not in the navigation registry until its readiness check (D-V2A-8). `canOpen` rejects Scheduling routes. | V2-A §8.1 |
| Design system | Light and dark semantic tokens in `packages/ui/src/styles.css` (OS preference plus `.dark`/`.light` class; a test keeps the two dark blocks identical). `packages/ui` has `dialog`, `badge`, `loading`, `alert` but **no** combobox, `Kbd`, `Tooltip`, `IconButton`; those are V2-B3/B5. | `packages/ui/src/components`, V2-A §11 |
| Desktop | Tauri 2, capabilities `core:default` only, no shell/fs/http plugins; CSP `connect-src` allows `'self'`, IPC and the local API. Shortcuts live in the web layer (V2-A §8.4). | `apps/desktop/src-tauri/capabilities`, `tauri.conf.json` |
| Logging of terms | Not verified for existing GET `?q=` URLs. GS1 D-GS1-17: check by 2026-11-30. | GS1 §6.8 |
| Registry freshness | `docs/active-workstreams.md` and `docs/agent-context.md` still list GS1 as a draft with D-GS1-1..14 pending. They are stale (GS1 merged, D-GS1-1..18 decided). Not changed here; a registry refresh is a separate docs PR on request. | those files |

## 3. Scope and relationship to GS1

**GS1 owns:** the endpoint contract, providers, field allow-lists, indexing, ranking, limits, logging policy and the first UI specification (§10 of GS1). **GS2 owns:** how that looks and behaves in the Pixa Hybrid shell, in more detail than GS1 §10, plus the plan to deliver it.

Where GS2 refines GS1 §10 it says so. Where GS2 would **change** GS1 it is listed as a decision. Two refinements are proposed:

1. GS1 §10.2 lists `⌘↵` as "open in place of the current record". Without URL routing there is no second window or tab, so the key has no distinct meaning. **Drop it** until URL routing exists (D-GS2-9).
2. GS1 §10.3 says the live region announces "12 results in 3 Zones". That is a count of rows the person can already see on screen and is safe, but it must come from **rendered** rows only, never from a server total (the API returns none). Clarified in §9.

**Out of scope:** any backend work, migration, new search types, activities/messages/leave (GS3), saved searches, server-side history, notifications, URL routing, native OS-level hotkeys, AI or semantic search.

## 4. Experience design

### 4.1 Entry points

| Where | What |
|---|---|
| Keyboard | `⌘K` (macOS) / `Ctrl+K` (Windows, Linux). One palette, no second shortcut (D-GS1-8). Label chosen from the platform, labels only. |
| Top bar, ≥ 640 px | Replaces the disabled search placeholder: a button styled as a field, "Search or jump to…" with a `Kbd` hint (`⌘K` / `Ctrl K`). On compact widths: icon-only button with an accessible name "Search or jump to" and tooltip showing the shortcut. |
| App bar, < 640 px | Search icon button (44 px target). Opens the palette full-screen. |
| Page-level `/` | Unchanged: focuses the Zone list's own filter. The two are distinct and the palette footer never claims otherwise. |

The shortcut follows the V2-A capture rules: ignored while focus is in an editable field (except the palette's own input) or while another modal is open, and during IME composition. In a browser, `preventDefault` is called only when the app has focus and the rules allow capture, because `Ctrl+K` is a browser shortcut on Windows and Linux (verified per browser in the compatibility matrix, §11).

### 4.2 Anatomy

Modal dialog, top-aligned, 640 px wide on ≥ 1024 px (full-screen below 640 px), max height 70 dvh, scrim over the shell, the shell behind is `inert`.

```
┌ Search or jump to…                              esc ┐
│ 🔍  kelp▌                                           │   input (combobox)
├─────────────────────────────────────────────────────┤
│ COMMANDS                                            │   max 5, instant
│  → Go to Customers                                  │
│ CUSTOMERS                                           │   group heading
│  ◉ Kelp & Co Seafood            kelp@example.com    │   title (query bold) + subtitle
│  ◉ Kelpie Marine Ltd            Kelpie Marine Pty   │
│                                       Show more ▸   │   only when hasMore
│ FINANCE · INVOICES                                  │
│  ▤ INV-0042                Kelp & Co · due 3 Dec  ⟨Overdue⟩
│ …                                                   │
│ [ ] Include archived                                │
├─────────────────────────────────────────────────────┤
│ ↑↓ move  ↵ open  esc close     Searched: Customers, Sales, Projects, Finance
└─────────────────────────────────────────────────────┘
```

- **Order:** commands first (instant, local), then Records in a fixed Zone order that matches the sidebar (not by server rank, so the layout does not jump as groups arrive). Within a group, server order.
- **Row:** Zone/type icon, title (query highlighted client-side in the title only), subtitle, badges (closed enum from GS1 §8: archived, draft, void, former, won, lost, overdue, completed…). No amounts, notes, addresses or timestamps beyond GS1's list.
- **Group caps:** 5 rows per group; "Show more" (GS1 §7.2, `limit` up to 25 for one type) when `hasMore`.
- **Footer:** key hints and "Searched: …" from `searchedTypes`, which reflects the person's own permissions only. This is honest scoping, not a disclosure (§8.3).
- **Empty query:** "Recent" (session-only, re-authorised, §5.5) then command groups.

### 4.3 Visual design and theming

All colour, radius, elevation, focus and motion come from the V2 semantic tokens (`--surface`, `--muted`, `--accent`, `--border`, `--ring`, etc.). No raw hex or arbitrary Tailwind values in the palette; the V2-A source-scan test applies.

| Element | Light | Dark | Notes |
|---|---|---|---|
| Panel | raised surface + border + shadow | raised surface + border, shadow reduced | Glass/blur only inside `@supports` with an opaque fallback (V2-A) |
| Active row | accent tint + 2 px leading indicator | same tokens | Indicator, not colour alone (forced colours: system `Highlight`) |
| Highlighted match | semibold, not a coloured background | same | Contrast independent of theme |
| Badges | `StatusBadge` tokens | same | Text label always present |
| Scrim | token with alpha | token with alpha | |
| Motion | 120 ms fade/translate | same | Removed under `prefers-reduced-motion` |

Both themes follow the OS preference, the stored preference and the `.dark`/`.light` class exactly as the rest of the app does. Screenshot baselines in both themes at 1440, 900 and 375 px (V2-B2 harness).

### 4.4 Component boundaries

- The palette is a **shell component** (`packages/app/src/shell/palette/`), built on the existing `Dialog` and V2-B3 pieces (`Kbd`, `IconButton`, `Tooltip`). It is **not** the generic V2-B5 `Combobox`: a command/record palette has grouped, async, heterogeneous rows and a different focus model. Reusing `Combobox` would couple the palette to V2-B5 for no gain (D-GS2-10).
- No new runtime dependency. The ARIA pattern is implemented directly (D-V2A-12: Radix is only explored, each dependency reviewed in its own PR).
- The search **client** lives in `packages/app/src/api/search.ts`, uses the shared fetch wrapper (credentials, CSRF, error mapping) and the contract types from `@business-os/contracts`. Clients never import server code (ADR 0005).
- A pure **state machine** (`palette-state.ts`: idle → typing → loading → results | empty | error | offline | ended) is unit-tested without the DOM.

## 5. Interaction flows

### 5.1 Open, search, open a record (happy path)

1. `⌘K` → capture rules pass → palette opens, input focused, previous focus remembered.
2. Under two characters: Recent (if any) and commands. No request.
3. Person types "kel". Commands filter instantly. After 150 ms with no keystroke (D-GS1-9, provisional) one `POST /search` fires with `{ q, types: <types whose target works>, limit: 5 }`, tagged with sequence number and context key (§8.2).
4. After 300 ms without a response a thin progress bar shows; commands remain usable.
5. Response arrives under the same context key and sequence → groups render. First selectable row gets `aria-activedescendant`.
6. `↓`/`↑` move; `Enter` on a row → palette closes → **guarded navigation** (unsaved-changes guard first) → `route` opened through the shell. The Zone loads the record through its own API, which re-checks permission and tenant.
7. Focus lands on the Zone's main heading (shell focus rule), not back on the top-bar button, since the context changed. On cancel from the guard, the palette reopens with the same input (D-GS2-12).

### 5.2 Commands only (no GS1 yet, or no readable Zones)

Same dialog, no Records section, no request. The empty state reads "Type to jump to a page. Searching records is not available yet." until GS1-A and GS2-C ship. For a person with no readable searchable Zone, the same text but "Searching records isn't available for your role" is **not** shown (it would reveal the permission model beyond what the nav shows); they see commands only (§8.3).

### 5.3 No results

"No records match "kelp" in Customers, Sales and Projects." The Zone list comes from `searchedTypes`. If "Include archived" is off, an inline action offers to include them. No suggestion that records exist elsewhere.

### 5.4 Errors, offline, session

| Case | Behaviour |
|---|---|
| `429 search_busy` | Keep previous same-context results muted; retry once automatically after `Retry-After` (≤ 1 s); then "Search is busy. Try again." with a retry action |
| `503 search_timeout` / `503 search_busy` / network error | "Search didn't finish. Try again." + retry. No server message shown. |
| `400` | Treated as a client defect: generic error, logged to the client console in dev only; never shows the query back from the server |
| `401` | Discard results and recents; existing session-ended flow |
| `403` | Discard results and recents; shell refreshes membership (context key may change) |
| Offline (`navigator.onLine` false or fetch fails) | "You're offline. Commands still work; record search needs a connection." Search resumes on the next keystroke, no background polling |
| Aborted (superseded) | Silent |

Error text is fixed client copy. It never includes server text, the term, a type name the person cannot read or a count.

### 5.5 Recent

Session-only, in memory, `(type, id)` for the last 8 records opened from the palette. On open, `POST /search/resolve` re-authorises and supplies current titles; failures hide the section. Cleared on any context change. Nothing in local storage (D-GS1-6).

### 5.6 Context change while open

Business switch, role/permission change, sign-out or session end: in the same render, abort all requests, drop all results and recents, rebuild commands; late responses tagged with an old context key are dropped (GS1 §10.4). If the dialog is open it stays open but empties and shows commands.

### 5.7 Show more and Include archived

"Show more" re-queries that one type with `limit: 25` and a cursor; results replace the group in place, focus stays on the activated control or moves to the first new row. Toggling "Include archived" re-runs the current query; the toggle state is not persisted.

### 5.8 Narrow and touch

Full-screen sheet below 640 px; input at the top (16 px text to avoid iOS-style zoom), results scroll, 44 px row targets, a visible close button. The virtual keyboard shrinks the list, not the dialog.

## 6. Module coverage matrix

"Endpoint today" means an existing per-Zone list `q` filter. "GS1 provider" means the planned provider in GS1-A/C. **Nothing in the right-hand columns is built.**

| Zone / type | Read key | Existing list `q` (today) | GS1 provider | Opens from a result today | GS2 availability |
|---|---|---|---|---|---|
| Customers: customer | `customers:read` | name, legal name, email, phone (unindexed, GET) | GS1-A | Yes | **Phase 1** (GS1-A + palette) |
| Customers: contact | `customers:read` | name, email, phone, mobile (unindexed, GET) | GS1-A | **No** (entry point needed) | Phase 1 after target PR |
| Sales: opportunity | `sales:read` | title (unindexed, GET) | GS1-A | **No** (`initialOpportunityId` needed) | Phase 1 after target PR |
| Projects: project | `projects:read` | name (unindexed, GET) | GS1-A | Yes | **Phase 1** |
| Projects: task | `projects:read` | none | GS1-A | Partly (project opens; task panel does not) | Phase 1 after target PR |
| Finance: quote / invoice / credit note | `finance:read` | **none** | GS1-A | Yes | **Phase 1** |
| Finance: catalog item | `finance:read` | name, code, description (unindexed, GET) | GS1-A | **No** (`catalog:<id>` needed) | Phase 1 after target PR |
| People: employee | `people:read` | name, number, work email (unindexed, GET) | GS1-A (work fields only) | Yes | **Phase 1** |
| Finance: expense | `finance:read` | supplier, description, reference (GET) | GS1-C | Yes (expense detail) | Phase 2 |
| Finance: payment | `finance:read` | none | GS1-C (optional) | Verify | Phase 2, only if asked |
| People: department, location | `people:read` | none | GS1-C | Verify | Phase 2 |
| Scheduling: event, resource | `scheduling:read` | resources: name (GET); events none | GS1-C | **Blocked**: no registry entry (D-V2A-8) | Phase 2, after readiness check |
| Reporting: saved report | `reporting:read` | none | GS1-C | Verify | Phase 2, reuse R1 visibility |
| Administration: member | `members:read` | none | GS1-C (probably not) | Settings | Not planned |
| Activities / notes | `activity:read(_restricted)` | none | **Excluded** | n/a | GS3 only |
| Conversations / messages | `communications:read` | none | **Excluded** | n/a | GS3 only |
| People personal details, leave | `people:read_sensitive`, leave keys | n/a | **Never searchable** | n/a | Never (D-GS1-3) |
| PDFs, attachments, line items | n/a | n/a | Excluded | n/a | Not planned |

**Existing list endpoints that could be reused as-is:** none are suitable as the palette's data source (§7.3). They stay as in-Zone filters under `/`.

## 7. API dependency analysis

### 7.1 What GS2 consumes (all from GS1-A, none deployed)

| Dependency | Source | Status | Blocks |
|---|---|---|---|
| `POST /api/v1/b/:slug/search` and `/search/resolve` | GS1 §7 | Not built | All record search UI |
| `packages/contracts/src/search.ts` + snapshot | GS1-A | Not built | Typed client, fakes with the real shapes |
| Providers: customer, contact, opportunity, project, task, quote/invoice/credit note, catalog item, employee | GS1-A | Not built | Each group |
| Index migration `2026MMDD000000_search_indexes` | GS1-A | Not built; needs its own production approval (GS1 §12) | Production use, not UI development |
| Logging checklist L1..L5 | GS1 §6.8 | Not done | Enabling search in production |
| Concurrency slots (2/user, 8/business) and `429 search_busy` | GS1-A (D-GS1-15) | Not built | Error-state testing against the real server |
| V2-C palette shell | V2-A §11 | Not authorised | GS2-C merge (D-GS1-11) |
| V2-B1/B3 (`Kbd`, `IconButton`, `Tooltip`, tokens) | V2-A | Not authorised | Palette visuals |
| Target entry points: contact, opportunity, task panel, catalog | GS1 §10.6 | Not built | Those types in `types` |

### 7.2 What GS2 does **not** need

No change to authentication, RBAC/RLS, admission, schemas beyond GS1's own, notifications, scheduling navigation, or any provider-registration. No new permission key.

### 7.3 Why not fan out over existing list endpoints

The brief asks to reuse existing search APIs "where appropriate". Assessed and rejected as the palette's source:

| Concern | Detail |
|---|---|
| Terms in URLs | Every list sends `q` in a GET query string. Whether Vercel or any proxy retains it is unverified (D-GS1-17, due 2026-11-30). A palette multiplies the exposure to every keystroke. |
| Cost | Up to 8 parallel requests per settled keystroke, each an unindexed `ILIKE '%term%'` over the tenant's rows, each with its own transaction and pool connection. This is the unbounded pattern the brief rules out. |
| Field exposure | Lists return full list DTOs (amounts, phones, statuses, owners). GS1 §6.4 limits results to a fixed allow-list. A client trimming fields after receipt still received them. |
| Match-field mismatch | Customers match phone and catalog matches description; GS1 deliberately excludes both from global search. |
| Coverage gaps | No text search for quotes, invoices, credit notes, tasks. |
| Inconsistent behaviour | Different ordering, pagination and normalisation per Zone; no single "searched" set for honest UI. |
| Error leakage | Each list returns its own error shapes, some with validation text. |

**Conclusion:** the palette uses GS1's endpoint only. If search is wanted before GS1-A, the supported interim is the existing **in-Zone** filter via `/`, unchanged (D-GS2-2).

## 8. Security and privacy

### 8.1 Authorization (server decides)

All enforcement is GS1 §6: `tenantRoute`, membership, per-provider `requires`, explicit `business_id`, forced RLS, record and field rules. GS2 adds client rules only to avoid undoing it:

- The client sends `types` only to **narrow**; it derives them from the same `resolveNavigation` result as the sidebar and omits types whose target does not yet open (§6). The server remains authoritative (an unpermitted type is dropped silently).
- Routes from results are opened through the shell's `canOpen` + slug check; a forged or stale route lands on Home.
- The client holds no permission logic beyond hiding.

### 8.2 Context key and stale data

As GS1 §10.4: context key = user id, business id, role and the sorted permission set. Every request and response is tagged. A mismatching response is dropped on arrival, even if its sequence is current. No response cache. Results never survive close, business switch, sign-out or role change. Remaining window (revoked access while results show) equals any open list screen; opening a result re-checks on the server.

### 8.3 Information leakage review

| Vector | Control |
|---|---|
| Counts | The API returns no totals; `hasMore` only per permitted type. UI shows **no** "N results" figure from the server, no per-Zone badge counts, no "and 40 more". The live-region string counts **rendered** rows only. |
| Zones the person cannot read | Never queried, never listed. Footer "Searched: …" and the no-results copy list only permitted Zones, which the person already sees in the sidebar. Never "N Zones hidden" or "you don't have access to Finance". |
| Previews | No snippets, no `ts_headline`, no body text, no amounts. Subtitles from GS1 §8's table only. Client highlight operates on the title it already received. |
| Existence oracles | A record the person cannot read is indistinguishable from one that does not exist: it simply is not returned. Match fields are a subset of fields the person can already read (GS1 §6.4). |
| Error messages | Fixed client copy; server error bodies are never rendered; no echo of the term; `429/503` copy does not say which Zone was slow or which provider failed. A single provider failing fails the whole request (GS1's one SQL statement), so partial-result hints cannot reveal a hidden Zone. |
| Sensitive data on screen | Palettes are often open during calls and demos: no amounts, no personal contact details, no People personal data (never matched or shown). Employees show name, job title, department only. |
| Terms | Never in URLs (POST body), never logged by our code, never stored, not in analytics, not in React error boundaries or `console` output in production, not placed in `document.title`, history state or `localStorage`. |
| Recents | Ids only, session-only, re-resolved via the server before display. |
| Cross-tenant | No business id in the request; context key covers business switch. |
| Screen readers and DOM | Hidden content is not rendered, not `aria-hidden` (no off-screen rows for unpermitted types). |
| Clipboard, drag, "copy link" | None in GS2. |
| Browser autofill | Input has `autocomplete="off"`, `autocapitalize="off"`, `spellcheck="false"`, `type="text"` with `role="combobox"` (not `type="search"` to avoid native clear/history behaviours). |
| Desktop | No new Tauri capability, no IPC command, no native search index. |

## 9. Accessibility

Target WCAG 2.2 AA (V2-A §12.1).

- **Dialog:** `role="dialog"` `aria-modal="true"` labelled "Search"; focus trapped; `Esc` closes; focus returns to the opener (or the Zone heading after a navigation); background `inert`.
- **Combobox/listbox:** input `role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`, `aria-autocomplete="list"`; groups are `role="group"` labelled by their visible heading; rows are `option`s with `aria-selected`. DOM focus stays in the input; `Tab` moves out of the dialog only to its controls (Include archived, Show more, close), in a logical order, not through rows.
- **Keys:** `↑/↓` across groups (wraps within the list only, never into the input), `Home/End`, `Enter` opens, `Esc` closes (first `Esc` clears a non-empty query? No: it closes; `Ctrl/⌘+Backspace`/select-all work natively; D-GS2-12), `PageUp/PageDown` jump a group. No single-letter shortcuts (WCAG 2.1.4).
- **Live region:** one polite region announces after each **settled** update ("5 results in 2 groups", "No results", "Search didn't finish"). Not per keystroke, not for in-flight changes; messages exclude the term.
- **Loading:** progress bar has `role="progressbar"` with an accessible name only if longer than 1 s; otherwise the live region is enough.
- **Target size and zoom:** ≥ 44 px rows on touch, ≥ 24 px minimum elsewhere (2.5.8); reflows at 400 % zoom (1.4.10); text resizes to 200 %.
- **Contrast:** 4.5:1 text, 3:1 non-text and focus indicator in both themes; matches are shown by weight, not colour alone.
- **Forced colours / high contrast:** active row uses system `Highlight`/`HighlightText`; border visible; icons use `currentColor`.
- **Reduced motion:** no transitions, no animated reordering.
- **Language and names:** result titles keep the record's own text; icons are decorative (`aria-hidden`) with the type as visible or screen-reader-only text ("Invoice").
- **Shortcut discoverability:** `?` help (V2-A §8.3) lists `⌘/Ctrl+K`; the top-bar button is the visible alternative (2.1.4, 3.2.6).
- **Screen-reader pass:** VoiceOver on macOS (WKWebView in Tauri and Safari), NVDA on Windows (WebView2 and Chrome) before the palette is enabled (V2-E audit also covers it).

## 10. Performance

Targets are measurement goals, not CI gates (D-GS1-10); numbers come from GS1 §11 and are not restated as promises here.

- **Request discipline:** 150 ms debounce, 2-character minimum, abort-previous, drop stale; one request per settled query; `Enter` flushes the pending one. **No polling, no prefetch on open, no background refresh**, no request when the input is under two characters or the palette is closed.
- **Bounded:** `q` ≤ 100 chars, `limit` ≤ 5 per group (≤ 25 on Show more), at most 8 recents resolved, `types` ≤ the permitted set. Client mirrors the contract limits and the server re-clamps.
- **Rendering:** at most ~40 rows, no virtualization needed; memoised rows; highlight computed once per row; layout does not jump (fixed Zone order, reserved heights for the footer).
- **Perceived speed:** commands are instant; previous same-context results stay muted while loading (never across a context change); progress bar only after 300 ms.
- **Bundle:** palette code is lazy-loaded on first open or first idle after the shell mounts (no new dependency). Keyboard handler is a tiny eager module.
- **Server protection:** relies on GS1-A slots and timeout. Client handles `429/503` with at most one automatic retry (≤ 1 s) and never loops.
- **Budgets to measure** in the V2-B2 harness and a manual desktop pass: open-to-interactive, keystroke-to-render for commands, response-to-paint for 40 rows, long-task count while typing.
- **Memory:** state discarded on close; no caches; abort controllers cleaned up.

## 11. Desktop (Tauri) and web parity

- Same React code and CSS (ADR 0005). Shortcuts are handled in the web layer; no Tauri plugin, command or capability change; no native menu accelerator (V2-A §8.4).
- **Platform labels** from `navigator.userAgentData`/`platform`, labels only; on macOS WKWebView `⌘K` arrives as `metaKey`, on Windows (WebView2) and Linux (WebKitGTK) as `ctrlKey`. Both handled; `event.key.toLowerCase() === 'k'` with the layout-independent `event.code === 'KeyK'` fallback for non-QWERTY layouts.
- **Browser conflicts:** `Ctrl+K` focuses the address/search bar in Chrome/Edge/Firefox on Windows and Linux; `preventDefault` is honoured when the page has focus, but this is **verified per browser** in the compatibility matrix rather than assumed. Safari/macOS uses `⌘K` with no conflict we know of (to verify). The top-bar button is the fallback.
- **IME and dead keys:** ignore while `isComposing`.
- **Window minimum 900 × 600:** the palette fits with at least 6 visible rows; below 640 px full-screen.
- **System WKWebView** (not installed Safari) is the desktop baseline per D-V2A-10; the matrix runs on real machines.
- **CSP:** no change; search uses the same `connect-src` as every API call. No new inline script or style.
- **Web preview** (Vercel preview/browser app): identical; offline handling uses fetch failure, not `navigator.onLine` alone.
- **Updates and offline:** no service worker, no background sync, nothing cached for offline use.

## 12. Work packages and implementation sequence

Each package is its own thread, branch and draft PR, audited by ChatGPT and approved by Regan before merge. None applies a production migration. This document authorises none of them.

| WP | Scope | Depends on | Can start | Output |
|---|---|---|---|---|
| **GS2-0 Approval gate and hygiene** | Regan's decisions D-GS2-1..17; confirm GS1-A and V2-B/V2-C authorisation order; L1/L2 log check (GS1 D-GS1-17, due 2026-11-30) | none | Now | Decisions recorded |
| **GS2-A Target entry points** | Contact, opportunity, task panel and catalog item targets in their Zones (small PRs, one per Zone, no API change) | none | After GS2-0 | Types become openable (GS1 §10.6) |
| **GS2-B Search client and fakes** | `packages/app/src/api/search.ts`, request sequencing/abort, context-key tagging, pure palette state machine, fakes shaped by the GS1 contract | GS1-A contract merged (or a contract-only PR) | After GS1-A contract | Unit-tested client, no UI |
| **GS2-C Palette Records UI** | Records section, groups, keyboard model, states, recents + resolve, Show more, Include archived, a11y, themes, narrow layout, top-bar trigger | **V2-C palette merged**, GS2-B, GS2-A (per type), V2-B1/B3 | After V2-C | Feature behind existing `search` availability; hidden until the API reports it |
| **GS2-D Verification** | Visual baselines (light/dark, 1440/900/375), screen-reader passes, browser and WKWebView/WebView2 matrix, desktop walkthrough, term-leak tests | GS2-C | With GS2-C | Evidence recorded in the PR |
| **GS2-E Coverage growth** | UI strings, icons and badges per new GS1-C type, one small PR each | GS1-C providers | After each provider | New groups |

**Order:** GS2-0 → (GS2-A ‖ GS1-A and V2-B/V2-C when authorised) → GS2-B → GS2-C + GS2-D → GS2-E. GS1-A in production additionally needs its readiness gate, Regan's merge approval and a separate migration approval (GS1 §12). Until then the palette (V2-C) ships commands-only.

**Enablement:** GS2-C is merged dark behind a capability check. Record search is shown only when the deployed API serves the contract and logging checklist L1..L5 passed (GS1 §6.8). The flag is a code-level check on API availability, not a feature-flag service and not a production config change; turning it on is a deploy Regan approves.

**Independence from other work:** GS2-A is independent of everything. GS2-B/C do not touch Home, the dashboard, the contracts snapshot beyond GS1's own, notifications (N1) or settings (A3). Overlap to watch: V2-C owns `shell/app-shell.tsx`; GS2-C must wait for it rather than edit in parallel.

## 13. Test strategy

- **Unit:** state machine transitions; sequence and context-key dropping; debounce and abort; highlight function (escaping, no HTML injection, diacritics); platform label; shortcut capture rules (typing, modal, IME, layout); error mapping to fixed copy.
- **Component (jsdom + user-event, queries by role):** open/close/focus return; ArrowUp/Down across groups; Enter opens; Show more; Include archived; each state in §5; narrow layout; `types` omission for targets not yet openable; a forced result for an unreadable Zone lands on Home.
- **Leak tests:** no rendered text contains a server total, a hidden Zone name or the term in error/aria strings; fake server returns hostile fields (extra amount, note) and the UI renders only contract fields; `localStorage`/`sessionStorage`/`history` untouched after a session; no network call below two characters or when closed.
- **Isolation of context:** business switch, role downgrade, sign-out and `401/403` while results and recents are showing and in flight.
- **Accessibility:** axe-core only once reviewed under D-V2A-12; manual screen-reader scripts; forced-colours and reduced-motion snapshots; keyboard-only walkthrough.
- **Visual regression:** light/dark × 1440/900/375 in the V2-B2 harness.
- **End to end (when GS1-A exists):** per type, search → open → record visible, as a member with and without the key (GS1 §14 covers the server side).
- **Desktop:** manual pass on macOS (system WKWebView) and Windows (WebView2), shortcut and focus behaviour, recorded in the PR.

## 14. Security and accessibility checklist (to tick in each GS2 PR)

**Security**
- [ ] Only `POST /search` and `/search/resolve` are called; terms never in a URL, header, storage, log, title or analytics.
- [ ] `types` derived from `resolveNavigation`; server remains authoritative; unopenable types omitted.
- [ ] Every result opens through `canOpen` + slug check and the guard; forced foreign routes land on Home.
- [ ] Context key on every request/response; dropped on mismatch; everything cleared on switch, role change, sign-out, `401`, `403`.
- [ ] No server total, no hidden-Zone hint, no snippet, no amount, no personal details rendered.
- [ ] Fixed client error copy; no server text or term echoed; `console` silent in production.
- [ ] No response cache, no polling, no prefetch; bounded `limit`, `q`, recents.
- [ ] Recents: ids only, in memory, re-resolved, cleared on context change.
- [ ] No new dependency, Tauri capability, CSP change or API/contract change outside GS1's.
- [ ] Source-scan: no raw colours, no `dangerouslySetInnerHTML`, no `localStorage` use in the palette.

**Accessibility**
- [ ] Dialog and combobox roles, names, states and `aria-activedescendant` correct; focus trap and return.
- [ ] Full keyboard operation; no single-letter shortcut; visible alternative to `⌘/Ctrl+K`.
- [ ] Polite live region, settled updates only, no term.
- [ ] 4.5:1 / 3:1 contrast and focus indicator in both themes; not colour alone.
- [ ] Forced colours, reduced motion, 200 % text and 400 % reflow checked.
- [ ] Touch targets ≥ 44 px (narrow) and ≥ 24 px (pointer).
- [ ] VoiceOver (macOS) and NVDA (Windows) scripts run and recorded.

## 15. Open decisions

Recommendations are mine; none is approved. IDs continue independently of GS1's.

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D-GS2-1 | Delivery order | (a) Palette commands first (V2-C), record search when GS1-A and GS2-B/C land; (b) hold the palette until records can ship | **(a)**, as V2-A and GS1 §12 already imply |
| D-GS2-2 | Interim record search before GS1-A | (a) None; in-Zone `/` filters stay; (b) fan out over existing list endpoints | **(a)**. §7.3: terms in URLs, unindexed scans, field exposure, up to 8 requests per keystroke |
| D-GS2-3 | Top-bar trigger | (a) Field-style button with `Kbd` hint ≥ 640 px, icon button below; (b) icon only everywhere | **(a)** |
| D-GS2-4 | Presentation | (a) Modal dialog, top-aligned, full-screen below 640 px; (b) inline popover under the top bar | **(a)** (focus containment, simpler a11y, matches GS1 §10.8) |
| D-GS2-5 | Group ordering | (a) Fixed Zone order matching the sidebar; (b) server relevance across Zones | **(a)** (no layout jump; GS1 §9.4 cross-type ranking is not needed in the UI) |
| D-GS2-6 | Per-type scoping controls | (a) None at launch; "Show more" per group only; (b) type chips or prefix syntax (`inv:`) | **(a)**; revisit with GS1-D metrics |
| D-GS2-7 | Quick actions on a result ("New invoice for this customer") | (a) None; (b) later | **(a)**; keep search read-only and permission-light. Create commands stay in the V2-A command list |
| D-GS2-8 | Recents persistence | (a) Session-only (D-GS1-6); (b) persisted ids | **(a)** |
| D-GS2-9 | `⌘↵` "open in place" | (a) Drop until URL routing exists; (b) keep as an alias of `Enter` | **(a)**; amend GS1 §10.2 in the GS2-C PR |
| D-GS2-10 | Palette component | (a) Shell-specific palette on `Dialog` + B3 pieces; (b) generic V2-B5 `Combobox` | **(a)**; no dependency on B5; no new runtime dependency (D-V2A-12) |
| D-GS2-11 | Enablement | (a) Merge dark; shown when the API serves the contract and logging checks passed; (b) separate runtime flag service | **(a)**; no flag infrastructure |
| D-GS2-12 | Escape and focus rules | (a) `Esc` always closes; after a guard-cancelled navigation the palette reopens with the same input; focus returns to opener or Zone heading; (b) first `Esc` clears the query | **(a)** |
| D-GS2-13 | Telemetry | (a) None in GS2; term-free metrics only in GS1-D; (b) client usage analytics | **(a)** |
| D-GS2-14 | Global OS hotkey (summon from outside the app) | (a) Not planned; in-app only; (b) Tauri global-shortcut plugin | **(a)** (needs a new capability, an ADR 0005 amendment and conflicts with D-GS1-8's scope) |
| D-GS2-15 | Browser `Ctrl+K` conflicts | (a) `preventDefault` when the app has focus, verify per browser, button as fallback; (b) different shortcut on web | **(a)**; revisit only if the matrix finds a browser that cannot be captured |
| D-GS2-16 | Result row content beyond GS1 §8 | (a) None; keep the GS1 allow-list; (b) add owner/amount/date | **(a)**; amounts and owners stay out while screens are shared |
| D-GS2-17 | Naming of excluded-data design | (a) This document is GS2; excluded data becomes GS3; (b) keep GS1's usage | **(a)**; a small follow-up edit to GS1 §4.3 lives in the GS2-0 PR, not here |

Dates and prerequisites not decided here: GS1 D-GS1-17 log check due 2026-11-30 (Regan's date); V2-B and V2-C authorisation (Regan); GS1-A authorisation (Regan).

## 16. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| V2-C slips | Search UI cannot merge | GS2-A/B proceed; commands-only palette ships first |
| GS1-A index build or benchmark misses targets | Search stays off in production | UI ships dark (D-GS2-11); no UI change needed |
| Logging checks find query strings retained | Existing lists leak terms; palette unaffected (POST) | GS1 D-GS1-7 remediation dates stand |
| Result targets are inconsistent per Zone | Dead results | `types` omitted until target verified; per-type end-to-end test |
| Shortcut captured by browser or OS | ⌘/Ctrl+K unreliable on some platforms | Matrix; button fallback; D-GS2-15 |
| Screen-reader behaviour of a custom combobox differs by engine | A11y regressions | Manual passes on WKWebView and WebView2; no reliance on axe alone |
| Stale registry docs | Agents plan from wrong state | Separate registry-refresh docs PR on request |
| Hidden-Zone inference through UI copy | Permission-model disclosure | Copy rules in §8.3, tested |
| Scope creep into quick actions, AI search or content search | Cost and leakage | Out of scope; separate decisions |
