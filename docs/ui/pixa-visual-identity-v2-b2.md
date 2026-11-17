# UI V2-B2: Pixa visual identity, audit and design proposal

**Status:** draft, revised after the ChatGPT audit of `c70c4cc` (CONDITIONAL PASS on Direction A; revisions in §17). Documentation and reference renders only: no code in `packages/`, no dependency, no API, permission, schema or money change, no deploy.
**Builds on:** [V2-A spec](pixa-design-system-v2-a.md) (direction, D-V2A-1..13) and [V2-B1 notes](pixa-design-system-v2-b1.md) (tokens on `main` since `e78c971`, D-V2B1-1..4).
**Base:** `main` at `ccfcc93`. No open UI PR overlaps this one (open PRs on 2026-11-17: #93 GS1-A backend, #53, #48).
**Evidence:** `v2-b2/before/` (current `main`, captured with the V2-A harness), `v2-b2/reference/` (concept renders, built from `reference.html` with the real V2-B1 tokens injected by `render.cjs.txt`).

## Contents

1. Summary and recommendation
2. Where I disagree with the brief
3. Audit: V2-B1 tokens, styling architecture, screens
4. Identity principles and rules
5. Layout directions compared
6. Design specification (Direction A)
7. Tokens: what is reused, what is new
8. Reference screens and before/after
9. Widget trace: every reference widget to its source
10. Anti-template criteria
11. Responsive desktop, keyboard and focus, motion, contrast
12. Component and interaction inventory: reuse, extend, replace
13. Dependency and migration impact
14. Implementation slices and PR boundaries
15. Acceptance criteria and visual QA checklist
16. Owner decisions

## 1. Summary and recommendation

Today Pixa OS looks like most SaaS dashboards: a light sidebar, a lavender canvas, and white rounded cards for everything (92 `<Card>` uses in `packages/app`, figures in 11 KPI/stat cards, `rounded-xl`/`2xl` 121 times). V2-B1 fixed the colours and the font; it did not change the structure, so the screens still read as a template.

I recommend **Direction A, "Ledger"**: the app is a single **sheet** of work set into a dark **bezel**, with the Pixa Rail on the bezel. Inside the sheet, content is organised with **hairline rules** rather than boxes: ruled section headers, figure strips, full-bleed tables, and an **inspector** beside lists where people triage records. Status is shown by **square pixel markers** drawn from the four-tile mark. It uses the V2-B1 tokens unchanged and adds **one** colour token (`--bg-bezel`).

The identity is five signatures used together, not one gimmick:

1. **Bezel and sheet.** The ink frame and rail in both themes, with the workspace as an inset sheet.
2. **Rules, not cards.** Hairline rules and labelled section headers; cards are not a layout tool.
3. **Pixel markers.** 6 px squares for status and progress, filled for "in a state", hollow for "not started", always beside words.
4. **Figure strips.** Money and counts on one ruled band with tabular figures and the currency stated, never a grid of KPI tiles.
5. **Inspector.** The selected record opens beside its list, read-first, where triage is the job.

What it costs: the shell (V2-C) and each Zone (V2-D) adopt it as they were already going to be rebuilt; nothing here needs a backend change. What I am asking for now: decisions in §16. Nothing is implemented in this PR.

## 2. Where I disagree with the brief

1. **"V2-B2" is already taken.** The approved V2-A plan (§11) names V2-B2 as the visual-regression harness. Two different B2s will confuse the merge queue and every later thread. I propose this package keeps its name, and the harness becomes its first slice (B2-1, §14), because before/after QA needs it anyway (D-V2B2-1).
2. **"Pixa Rail" as new navigation.** I recommend the rail as a new *material and frame*, not a new information architecture. D-V2A-5 (Zone children in the sidebar on wide screens, section bar at medium, one place only) stays. A rail plus a separate Zone pane, the obvious alternative, would be empty for four of six Zones: only Finance and Reporting have children (`shell/registry.ts`).
3. **Inspector panels everywhere.** No. An inspector helps where people work down a list (invoices to chase, tasks to unblock). For a rich record such as a customer, a full page is better, and a second editing surface would duplicate the unsaved-changes guard. The inspector is read-first; editing stays in the existing forms.
4. **"Contextual command areas".** This must not become a second toolbar or a second palette. It is the page's title row with the screen's existing actions (at most one primary and two secondary, the rest in "More"), plus its filters. `⌘K` stays the only global command surface (V2-A §8.2, GS2).
5. **"Excess whitespace".** Agreed, but the fix is structure and consistent density, not cramming. The sheet keeps 24 px side padding and 40 px rows (D-V2A-3).
6. **"Distinguishable without a brand logo".** No single element is unique to Pixa: dark rails, rules and square markers all exist elsewhere. The combination is what is recognisable, and it can be tested (§15, blind test). I would not promise more than that.
7. **Glass sidebar (D-V2A-4).** I recommend replacing it with the opaque ink rail. Glass over atmosphere is the most template-like element we have, and backdrop blur repaints on scroll in WKWebView (V2-A §12.2). This supersedes an accepted decision, so it needs your approval (D-V2B2-3).
8. **"Implement only approved, low-risk shared foundations".** Nothing is approved yet, so this PR implements nothing. §14 names the first slice I would implement after your decisions.
9. **The reference screens include Projects.** Projects is a Gen 1 Zone; changing it is V2-D work. The reference shows the direction only.

## 3. Audit

### 3.1 V2-B1 tokens (on `main`)

| Area | State | Assessment |
|---|---|---|
| Semantic colour | Every §7.2 token in light and dark, contrast-tested (`packages/ui/tests/tokens.test.ts`) | **Keep as is.** Strong base; Direction A needs one new colour token |
| Scale | Control 28/32/40, rows 32/40/48, radius 8/12/16/pill, sidebar 232/64, top bar 48, motion 100/160/240 ms, type scale 12–28 | **Keep.** Direction A uses these values; it adds layout tokens only (§7) |
| Font | Inter bundled, tabular figures available, `cv11` on | **Keep.** Mono stays the system stack (D-V2B1-1) |
| Treatments | `.bos-glass`, `.bos-atmosphere` (four variants), `--shadow-card` | **Narrow** (D-V2B2-3, -6): glass to overlays only, atmosphere to sign-in and first-run |
| V1 aliases | All present until V2-E | Unaffected |

### 3.2 Styling architecture

- Tokens live in `packages/ui/src/styles.css` (layers 1–7); Tailwind 4 maps them. Components in `packages/ui` are few (14 files); most screen styling is inline Tailwind in `packages/app` (V2-A F-03).
- Counts in `packages/app/src` on `ccfcc93` (grep, source files only): `<Card` 92 in 13 files, `<KpiCard` 8, `<StatCard` 3, `bg-card` 41, `rounded-2xl` 49, `rounded-xl` 72, arbitrary `w-[…]`/`-[…]` 59, `text-[…]` 15, `uppercase tracking` 7. These are the numbers the anti-template criteria (§10) burn down.
- `Surface`, `Atmosphere` and `glassClass` in `packages/ui/src/components/surface.tsx`: atmosphere is used once (the shell), glass not at all from `packages/app`.

### 3.3 Screens (current `main`, `v2-b2/before/`)

| ID | Finding | Evidence |
|---|---|---|
| B2-F1 | Home is two grids of equal cards; every figure card repeats an "Open in …" button, so 7 identical buttons compete with the three real actions | `before/desktop-light-01-home.png` |
| B2-F2 | Home's top 330 px hold a greeting, a slogan, a section title, a sub-title and a second date line before any figure | same |
| B2-F3 | Finance overview puts three figures in three cards that fill 60 % of the width and leave the rest empty | `before/desktop-light-10-finance-overview.png` |
| B2-F4 | Invoices: the filter block (two rows of labelled fields) is taller than the five rows of data; status uses up to three pills per row | `before/desktop-light-11-finance-invoices.png`, `desktop-dark-11-…` |
| B2-F5 | Project detail: the board is a card with three column cards holding task cards with shadows (three nested boxes), and Progress, Details, Description sit as three cards below the fold | `before/desktop-light-09-project-detail.png` |
| B2-F6 | Projects list: progress is a 2 px bar that is almost invisible; uppercase headers | `before/desktop-dark-08-projects-list.png` |
| B2-F7 | Same layout everywhere: page title 30 px, description, button row, then cards, on every Zone | all `before/` |
| B2-F8 | At 900 × 600 the invoice filters push all but two rows below the fold | `before/desktop-min-900-light-invoices.png` |
| B2-F9 | Harness note: Home's "Open opportunities" shows "Could not load the pipeline" because the harness fake has no `/sales/summary`; a harness gap, not a product bug | `before/desktop-light-01-home.png` |

The "before" images were captured on 2026-11-17 from `ccfcc93` with the V2-A harness (one fix: its fake `TenancyClient` now has `platformAccess`, recorded in `v2-a/harness/main.tsx.txt`). Sample data only. Colour-quantized like V2-A's evidence: **not golden baselines**.

## 4. Identity principles and rules

V2-A's six principles stand (calm, precise, trustworthy, fast, approachable, deliberate hierarchy). V2-B2 adds rules that make them visible:

1. **The work is a sheet.** One continuous surface per screen. Structure comes from rules, alignment and type, not from boxes inside boxes. Maximum nesting: sheet, then one bordered thing (a task item, a field, a menu).
2. **Every number is a fact.** Figures are tabular, carry their currency or unit, say what period or "as of" date they cover, and never mix currencies in one total. A figure without a source is left out (§9).
3. **Colour is spent on state and the one primary action.** Accent: primary button, selection, links, current place. Status colours only in markers and status words. No decorative colour, no gradients on working screens.
4. **Square, not round. No pills anywhere** (owner requirement, §17). No capsule or fully rounded shape on any control: buttons, filters, chips, toggles, search and select fields, tabs, navigation, status, labels and badges. Geometry is rectilinear with small, deliberate radii: 8 px (`--radius-control`) for controls, 6 px for small square items (avatars with initials, icon buttons inside rows), 4 px for keys, labels and tags, 1.5–2 px for markers. Status and progress use 6 px squares from the mark plus words. `--radius-pill` stays in V2-B1 for its existing consumers until they migrate (no B1 change) but **no new component uses it**. Target sizes and focus rings are unaffected: 32 px controls, ≥ 24 px targets (44 on coarse pointers), 2 px focus outline.
5. **One frame, many layouts.** The frame (bezel, rail, sheet, top bar, title row) never changes; the content layout follows the job: figures and lists on Home, a ledger table on Finance, lanes on Projects. Same frame plus different interiors is what stops "same layout everywhere".
6. **Density is a contract.** 40 px rows, 32 px controls, 12/13/14 px text in working areas, 24 px sheet padding, 12 px between groups. Large type (22/28 px) only for page titles and Home's figures.

## 5. Layout directions compared

Rendered for the same screen (Finance, Invoices, same data) in both themes: `reference/b2-direction-a-light-finance.png`, `b2-dir-b-{light,dark}-finance.png`, `b2-dir-c-{light,dark}-finance.png`.

| | **A. Ledger (recommended)** | B. Workbench | C. Tiles (V2-A reference as drawn) |
|---|---|---|---|
| Frame | Ink bezel and rail, inset sheet | Ink rail (compact), list pane and document pane always visible | Light sidebar, canvas, cards |
| Figures | Ruled figure strip | None in the list view | KPI cards |
| Records | Full-bleed table; inspector opens beside it on selection | Two-line list rows; full document always open | Table inside a card; detail on its own page |
| Distinctive without logo | High (frame plus rules plus markers) | High (mail-client feel) | Low: generic |
| Density at 1440 | 5 rows + 4 figures + filters + inspector | 5 rows, full document | 5 rows + 3 figures |
| At 900 × 600 | Works: inspector becomes an overlay, rail compact | Weak: list pane ~ 360 px, document cramped | Works |
| Behaviour change | Small: inspector is new and optional; pages unchanged | **Large:** master-detail in every Zone, new selection model, guard on every row change, no URL routing yet to keep state | None |
| Conflict with planned work | Fits V2-C (shell) and V2-D (one Zone per PR) | Rewrites every Zone at once; conflicts with V2-D order | None |
| Risk to tests | Low: roles and names kept | High | None |
| Verdict | **Recommend** | Use only inside a Zone where triage is the whole job, later, if pilots ask | Reject as the identity: it is the look the brief wants to leave |

## 6. Design specification (Direction A)

### 6.1 Bezel and sheet (workspace canvas)

- The window background is `--bg-bezel` (new, §7) in both themes. The **sheet** sits inside it with an 8 px gutter top, right and bottom, `--radius-panel` (12 px), background `--bg-surface`.
- In dark, sheet (`#121729`) and bezel (`#0b0f1e`) are only 1.07:1 apart, so the sheet gets a 1 px `--border-default` edge. Decorative, not relied on.
- The sheet scrolls; the bezel and rail do not. Only one scroll container per pane (main, inspector).

### 6.2 The Pixa Rail

- The existing sidebar, restyled. It is a **dark-scope island**: the rail element carries the `dark` class, so it uses the dark semantic tokens in both themes. No new rail colours are needed, and every rail text pair is already contrast-tested in V2-B1.
- Width: `--sidebar-w` 232 px expanded, `--sidebar-w-compact` 64 px compact (both V2-B1 tokens, unchanged). Below 1024 px and at the 900 px Tauri minimum it is compact; the existing Collapse control toggles it on wide screens.
- Contents in order: mark and "Business OS", business switcher, Home, "Zones" label, Zones in registry order, the current Zone's children nested (D-V2A-5), spacer, Collapse. "Powered by Pixakova" moves to the account menu (copy decision, minor).
- Current Zone: `--bg-selected` row, `--fg-default` text, and a 4 × 16 px `--fg-accent` bar on the rail's inner edge (non-text 9.85:1). Current child: `--bg-selected`, weight 600. `aria-current="page"` on both. Forced colours: `Highlight` background, as the V2-B1 `state-selected` recipe.
- Compact: icons only, each with a real tooltip and accessible name (V2-B3 `Tooltip`); the current Zone's children move to the section bar (§6.4).

### 6.3 Top bar

48 px (`--topbar-h`), inside the sheet: breadcrumbs (record level when V2-C adds `useBreadcrumb`), "Jump to… ⌘K" (V2-C palette; commands only until GS1-A), account avatar. The disabled "Search · Soon" field and the disabled bell are removed (D-V2A-6). A 1 px rule under it.

### 6.4 Section bar (compact only)

40 px, under the top bar, for the current Zone's children; overflow into "More…" (V2-A §8.1). Current child: 2 px `--fg-accent` underline plus weight 600 (not colour alone).

### 6.5 Command area (title row)

One row: `h1` at `--font-size-title` (22/28, weight 650), an inline meta in `--fg-muted` (count, sort, "5 shown, newest first"), then the screen's actions right-aligned: at most two secondary and one primary. Beyond that, or at compact widths, secondary actions fold into "More…" (V2-B3 `Menu`). An optional one-line lede under it. Filters sit on the next row (`FilterBar`, V2-B4), single row where possible, two at 900 px.

### 6.6 Ruled section header

`h2` at 13 px weight 600, then a 1 px rule filling the line, then meta in `--fg-subtle` 12 px (period, "as of", source), then at most one ghost action ("Open Finance ›"). Replaces `SectionHeader` + `Card` pairs. Height 40 px.

### 6.7 Figure strip

A grid of 2 to 5 cells on one band with top and bottom rules and vertical rules between cells. Each cell: label (12 px muted, optional marker), value (22 px, or 28 px on Home only; weight 600; tabular), optional second-currency line (13 px, weight 600), note (12 px subtle: period, comparison or "as of"). Values never combine currencies: a second currency is its own line. The whole strip is a `<dl>` or a list of `<section>`s with labels as accessible names.

### 6.8 Ledger table

Full bleed to the sheet edges with 24 px inner padding on the first and last columns. Header 32 px on `--bg-sunken`, 12 px sentence case, weight 500 (no uppercase). Rows 40 px with a bottom rule. Numbers right-aligned and tabular. Hover `--bg-hover`; selected `--bg-selected` plus a 3 px inset `--fg-accent` bar on the first cell and `aria-selected`. Column priority (V2-A §9.2 `DataTable.priority`): low-priority columns (for example "Issued") hide when the inspector is open or below 1280 px. Caption under the table states order and currency rule.

### 6.9 Inspector

- 360 px (`--inspector-w`, new), right of the list inside the sheet, separated by a rule.
- **Two distinct actions per row (revised after audit).** Where a record has its own page (an invoice), the record link in the first cell **navigates to the record**, exactly as today. Previewing is a **separate, visible "Preview" icon button** in a trailing column (`aria-label="Preview INV-0001"`, `aria-expanded`, `aria-controls` pointing at the inspector, a tooltip with the same words). Where a record has no page of its own (a project task, whose full form is the existing dialog), activating the item opens the inspector and "Edit task" in the inspector opens the dialog. Both rules are tested per screen.
- **Focus.** Opening moves focus to the inspector heading. Closing (close button or `Esc`) returns focus to the Preview button of the same row. If that row is no longer in the list (filter changed, reload, record removed or now hidden by permissions), the inspector closes, a polite live region says "INV-0001 is no longer in this list", and focus goes to the list's heading (`h1`). Switching business or role closes the inspector with no announcement of the old record. A Preview on another row replaces the content and keeps focus in the inspector heading.
- Header: record kind (12 px muted), identifier (`h2`, 18 px), status marker. Body: a `DescriptionList` (V2-B4) of fields from the **list response only**, so opening it costs no extra request; where a field is not in the list response it is left out. Footer: "Open …" (full record) and at most one existing action the person is allowed to take.
- Read-first: no inline editing. "Edit" opens the existing form or dialog with its guard. Money shown is exactly what the record holds; any derived "open" amount uses the existing exact decimal helper (`zones/finance/decimal.ts`), never floats (ADR 0007).
- Below 1280 px, and at 900 px, it is an overlay sheet (V2-B3 `Sheet`, modal, focus-trapped) instead of a column.
- Scope: Finance document and expense lists, Projects tasks (D-V2B2-5). Not Customers, Sales or People in V2.

### 6.10 Pixel markers

6 × 6 px squares, radius 1.5 px (the mark's tile radius ratio), always followed by the status word. Filled = in a state (Active, Paid, Overdue), hollow = not started (Draft, Planned, To do). Colours: `--status-*-solid` for success, warning, danger, info; `--fg-subtle` for neutral. Danger states also colour their word (`--status-danger-fg`) and weight 500. Contrast of markers on the surface: 5.4 to 6.6:1 light, ≥ 5.6:1 dark, although markers are never the only signal. Forced colours: markers become `CanvasText` squares; the word carries the meaning.

**Progress squares:** one square per task when the total is 24 or fewer, else a 4 px bar; always paired with "2 of 6 tasks done" and `aria-hidden` on the squares.

### 6.11 Typography hierarchy

| Role | Token | Use |
|---|---|---|
| Display figure | `display` 28/36, 600 | Home figures only |
| Page title | `title` 22/28, 650 | One `h1` per screen |
| Inspector title | `section` 18/24, 650 | Inspector `h2` |
| Figure | `title` 22/28, 600, tabular | Figure strips outside Home |
| Section header | `small` 13/18, 600 | Ruled headers, lane headers |
| Body and table | `body` 14/20 | Rows, form text |
| Meta and labels | `small` 13 or `caption` 12, muted or subtle | Labels, notes, table headers |

No uppercase eyebrows; no letter-spaced labels. Identifiers (INV-0001) in Inter weight 600 tabular, not monospace (D-V2B1-1).

### 6.12 Surfaces and elevation

| Level | Surface | Border | Shadow |
|---|---|---|---|
| Bezel | `--bg-bezel` | — | — |
| Sheet | `--bg-surface` | dark only, 1 px | none |
| Sunken (table header, segmented track, jump field) | `--bg-sunken` | — | none |
| Item (task, field) | `--bg-surface` | `--border-default` / `--border-input` | none |
| Raised (menu, popover, tooltip) | `--bg-raised` | `--border-default` | `--shadow-raised` |
| Overlay (dialog, inspector overlay, palette) | `--bg-raised` | — | `--shadow-overlay`, scrim `--overlay` |

`--shadow-card` is retired from working screens (removed with V2-E aliases).

### 6.13 Interaction states

The V2-A §7.4 recipes, unchanged, applied to the new parts: hover `--bg-hover`; selected `--bg-selected` plus the accent bar; focus 2 px `--focus-ring` outline with 2 px offset (inset inside tables and the inspector list); disabled `--disabled-*`; pressed `--bg-hover` × 2; loading keeps the label and adds `aria-busy`. Focus on the rail uses the dark-scope ring (`#c4a6d3`) automatically. See `reference/b2-desktop-light-finance-focus.png`.

### 6.14 Charts

Series from `--chart-*` only, square legend markers with words, grid `--chart-grid`, axis text 12 px subtle, one currency per chart with the other named in the header. No gradients, no 3D, no area fills under lines.

## 7. Tokens

| Token | Light | Dark | Kind | Why |
|---|---|---|---|---|
| `--bg-bezel` | `#0b0f1e` | `#0b0f1e` | **New colour** (themed, same value) | The frame. Equal to dark `--bg-canvas`, so the dark-scope rail and the frame match. Needs a token-test entry; no text sits on it except inside the rail (dark tokens, tested) |
| `--inspector-w` | 360 px | — | New layout | Two consumers: Finance, Projects |
| `--marker-size`, `--marker-radius` | 6 px, 1.5 px | — | New component | Markers and legends |
| `--bezel-gutter` | 8 px | — | New layout | Sheet inset |
| `--sidebar-w`, `--sidebar-w-compact`, `--topbar-h`, `--row-h-*`, `--control-h-*`, `--radius-*`, type scale | V2-B1 | — | **Reused unchanged** | — |
| `--command-h` | — | — | Not added: equals `--topbar-h` | — |

No V2-B1 value changes. `.bos-glass` and `.bos-atmosphere` stay in `packages/ui` for overlays, sign-in and first-run (D-V2B2-3, D-V2B2-6).

## 8. Reference screens and before/after

All renders: 1440 × 900 and 900 × 600, device scale 2, colour-quantized, labelled "Concept · sample data". Sample data is the same fake business as the "before" images (Harbour Design Studio, the harness data), so the pairs compare like with like.

| Screen | Before (current `main`) | After, light | After, dark | 900 × 600 |
|---|---|---|---|---|
| Dashboard (Home) | `before/desktop-light-01-home.png`, `…-dark-01-home.png` | `reference/b2-desktop-light-dashboard.png` | `reference/b2-desktop-dark-dashboard.png` | `reference/b2-min-900-light-dashboard.png` |
| Projects (project detail, task inspector) | `before/desktop-light-09-project-detail.png`, `…-dark-…`; list `…-08-projects-list.png` | `reference/b2-desktop-light-projects.png` | `reference/b2-desktop-dark-projects.png` | `reference/b2-min-900-light-projects.png` |
| Finance (invoices, invoice inspector) | `before/desktop-light-11-finance-invoices.png`, `…-dark-…`; overview `…-10-finance-overview.png` | `reference/b2-desktop-light-finance.png` | `reference/b2-desktop-dark-finance.png` | `reference/b2-min-900-{light,dark}-finance.png`; before `before/desktop-min-900-light-invoices.png` |
| Keyboard focus | — | `reference/b2-desktop-light-finance-focus.png` | — | — |
| Directions B and C | — | `reference/b2-dir-{b,c}-light-finance.png` | `reference/b2-dir-{b,c}-dark-finance.png` | — |

What changes, per screen:

- **Dashboard:** greeting and slogan collapse into one title row and one lede; 7 figure cards become two figure strips; the seven "Open in …" buttons become one "Open Finance ›" on the Money header; chart and lists sit side by side under rules. The heading text "Welcome to Harbour Design Studio." is kept so existing tests and copy stay valid.
- **Projects:** three nested boxes become ruled lanes with bordered task items (no shadows); Progress, Details and Description move from three cards below the fold into one facts strip and a lede above the board; the selected task opens in the inspector instead of a modal (V2-D Projects decision).
- **Finance:** filters shrink from two labelled rows to one row (search, status segmented, payment select, chips); three pills per row become one marker and one phrase ("Overdue · part paid"); receivables figures from the overview appear above the list.

## 9. Widget trace

Every widget in the reference screens, with its existing source. "Excluded" means it must not ship until the source exists.

### 9.1 Dashboard

| Widget | Source today | Status |
|---|---|---|
| Date range | `operational-dashboard.tsx` presets | Existing |
| New project, Add opportunity, Add customer | Home quick actions (`shell/home.tsx`), permission-gated | Existing |
| Amount invoiced, received, outstanding, overdue (per currency) | `POST /reporting/query` metrics `finance.invoiced_amount`, `finance.payments_received`, `finance.receivables_outstanding`, `finance.receivables_overdue` (`dashboard/sources.ts`) | Existing |
| "Previous 30 days: …" | Reporting comparison already shown by R2 ("No change vs previous period") | Existing; wording only |
| Financial performance chart | `panel.financial-performance`, reporting buckets | Existing |
| Overdue invoices list | `panel.overdue-invoices`, `GET /finance/invoices?overdue=true&limit=5` | Existing |
| "Due … · part paid" on that row | list item `dueDate`, `settlementState` | Existing |
| Recent activity | `panel.activity`, `GET /activities?limit=8` | Existing |
| Open opportunities count and totals | `GET /sales/summary` `summary.open` | Existing |
| Active projects, "also 1 planned, 1 on hold" | `GET /projects/summary` `byStatus` | Existing |
| Active customers | `GET /customers/summary` | Existing |
| Sales pipeline by stage | `panel.pipeline`, `summary.pipelines[].stages[]` `count`, `totals` | Existing |
| Upcoming schedule, scheduled next 7 days | `scheduling:read` widgets | **Excluded** from the reference: Scheduling is deferred under V2-C readiness (D-V2A-8). The production rule in `sources.ts` is unchanged |
| "Open Finance ›" | Shell navigation | Existing (replaces per-card buttons) |

### 9.2 Projects

| Widget | Source | Status |
|---|---|---|
| Title, status, priority, description | `GET /projects/:id` `name`, `status`, `priority`, `description` | Existing |
| Customer, owner, start, due | `customer.displayName`, `ownerUserId` → members list, `startDate`, `dueDate` | Existing |
| Progress "2 of 6 tasks done" and squares | `taskCounts.total`, `taskCounts.done` | Existing |
| Board, List, search, assignee, priority, due filters | `task-board.tsx` (client-side filters over one task page) | Existing |
| Lanes To do, In progress (with Blocked), Done | `board-stages.ts` `DEFAULT_TASK_BOARD` | Existing |
| Task title, priority, assignee, due, Blocked | `ProjectTask` fields | Existing |
| Inspector: status, column, priority, assignee, due, created, updated, description | `ProjectTask` fields from the task list response | Existing data; **new placement** |
| "tomorrow" beside the due date | Client date formatting in the business time zone | Existing helper pattern (`formatWhen`); no money |
| Edit task, Move… | Existing task dialog and move menu, `projects:manage_tasks` | Existing actions; inspector placement is V2-D |

### 9.3 Finance

| Widget | Source | Status |
|---|---|---|
| Outstanding and overdue per currency, open and overdue counts | `GET /finance/receivables` `currencies[]` (`outstanding`, `overdue`, `openCount`, `overdueCount`) | Existing (overview uses it) |
| Unallocated payments | same response, `unallocatedPayments` | Existing; one request |
| Customer filter, status, payment, overdue only, issue dates | `ListInvoicesQuery` `customerId`, `status`, `settlement`, `overdue`, date filters | Existing |
| Number, customer, due, status, total, open | List item `number`, `billToSnapshot.name` or names lookup, `dueDate`, `status` + `settlementState` + overdue, `total`, `openAmount()` (exact decimal) | Existing |
| Combined status phrase "Overdue · part paid" | Same fields, one phrase instead of three pills | Presentation only |
| Inspector: bill to, issued, due, currency, total, payments, credit applied, open | List item `billToSnapshot`, `issueDate`, `dueDate`, `currencyCode`, `total`, `allocatedTotal`, `creditAppliedTotal`, `openAmount()` | Existing data; new placement |
| Open invoice, Record payment | Existing detail route; existing record-payment flow (`finance:payments`) | Existing actions; inspector placement is V2-D |
| "Recurring invoices", "New invoice" | Existing header actions | Existing |

### 9.4 Directions B and C (comparison only)

Invoice lines in Direction B ("Packaging design…", "Print management", GST) are **sample values, not harness data**, shown only to compare layouts. Direction B and C screens are not proposed for production.

## 10. Anti-template criteria

Each is checkable in review or by a source scan; the counts are on `ccfcc93` and burn down per Zone in V2-D.

| # | Criterion | How it is checked |
|---|---|---|
| AT-1 | No card as a default wrapper. A bordered box is allowed only for: a form field, a task or similar movable item, a menu, popover or dialog. No `Card` around a table, a figure, a list or a section | Source scan in V2-D: `<Card`, `KpiCard`, `StatCard`, `bg-card` in `packages/app` (now 92 / 8 / 3 / 41) fall to 0 per migrated Zone |
| AT-2 | No nesting deeper than sheet then one bordered thing | Review against §4 rule 1 |
| AT-3 | No gradient on working screens; atmosphere only on sign-in, onboarding and empty first-run | Scan for `bos-atmosphere`, `Atmosphere`, `gradient` |
| AT-4 | No decorative colour: status colours only in markers and status words; accent only on primary action, selection, links, current place | Review; markers via one component |
| AT-5 | One frame, job-specific interior: the three reference screens use three different interiors (figures and lists, ledger table, lanes) | Visual review |
| AT-6 | Consistent density: 40 px rows, 32 px controls, 24 px sheet padding, 12 px group gaps; no `p-5`/`p-6` card padding in migrated screens | Scan for spacing outside the V2-A §7.3 set; arbitrary values (now 59 + 15) to 0 per migrated Zone |
| AT-7 | Data above the fold at 900 × 600: at least 3 rows or 2 figures plus 2 rows on every list and dashboard | Harness screenshot at 900 × 600 |
| AT-8 | No uppercase labels or letter-spaced eyebrows | Scan `uppercase tracking` (now 7) |
| AT-9 | No widget without a source (§9); no "Soon" or disabled placeholders | Endpoint-to-widget map in every V2-D PR (V2-A §10) |
| AT-10 | One primary action per view, at most two secondary visible | Review |
| AT-11 | No pills: no `rounded-full`, `rounded-pill` or `--radius-pill` on controls, chips, fields, tabs, badges or labels in new or migrated code | Source scan (now 21 uses in `packages/app/src`, 5 in `packages/ui/src/components`), to 0 per migrated Zone; new `packages/ui` components start at 0 |

## 11. Responsive desktop, keyboard and focus, motion, contrast

### 11.1 Widths

| Width | Rail | Children | Inspector | Figures |
|---|---|---|---|---|
| ≥ 1280 | 232 px expanded (or 64 if collapsed) | Nested in rail | Column, 360 px | 4–5 per strip |
| 1024–1279 | 232 or 64 | Nested in rail | Overlay sheet | 4 per strip |
| 640–1023 (includes 900 × 600) | 64 px | Section bar with "More…" | Overlay sheet | 4 per strip, values at title size; secondary actions in "More…" |
| < 640 | Existing drawer and app bar (V2-A §8.1) | Section select | Full-screen sheet | 2 per row |

Heights: at 600 px tall, the figure strip stays one band (about 90 px); the title row and filters fit in about 110 px, leaving room for 5 rows at 900 × 600 (`reference/b2-min-900-*-finance.png`).

### 11.2 Keyboard and focus

- Tab order: skip link, rail (switcher, Home, Zones, children), top bar (breadcrumbs, Jump, account), title row actions, filters, content, inspector.
- `Esc` closes the inspector (when it has focus or is an overlay) and returns focus to the row that opened it.
- Rows: links or buttons in the first cell, normal Tab navigation; arrow keys only if a `DataTable` uses the ARIA grid mode (V2-A §8.3). Selecting a row is the link's action; there is no hidden selection state.
- Inspector as a column is a labelled `aside` (`aria-label="Invoice INV-0001"`), not modal; as an overlay it is a modal dialog with a focus trap.
- Focus never hidden by the sticky top bar or table header (WCAG 2.4.11): `scroll-margin-top` equal to the sticky height.

### 11.3 Motion

Inspector and overlay open with `--duration-base` and `--ease-standard`, opacity plus 8 px slide; rail collapse animates width with `--duration-slow`. Under `prefers-reduced-motion` the V2-B1 tokens are 0 ms, so everything is instant. No motion on data (no counting up, no chart grow).

### 11.4 Contrast (measured from token values, WCAG formula)

| Pair | Ratio | Requirement |
|---|---|---|
| Rail muted text `#a6abc6` on bezel `#0b0f1e` | 8.41 | 4.5 text |
| Rail current bar `#aab6ff` on bezel | 9.85 | 3.0 non-text |
| Selected-row bar light `#2f42a6` on `#eef0fb` | 7.55 | 3.0 non-text |
| Selected-row bar dark `#aab6ff` on `#121729` | 9.19 | 3.0 |
| Markers on white: subtle / success / info / danger | 5.37 / 5.79 / 6.64 / 6.40 | 3.0 (and never alone) |
| Marker subtle dark `#8a8faa` on `#121729` | 5.58 | 3.0 |
| Progress square on `#384eba` / off `#d3d3e2` on white | 7.08 / 1.48 | Decorative (`aria-hidden`); text carries the value |
| Rules `#e4e4ee` on white | 1.26 | Decorative; structure also carried by spacing and headers |
| Sheet vs bezel, light / dark | 19.07 / 1.07 | Decorative; dark gets a 1 px edge |

All text pairs inside the sheet are V2-B1 pairs already in `tokens.test.ts`. B2-2 adds the bezel and marker pairs to it.

## 12. Component and interaction inventory

| Proposed part | Existing piece | Change | Where it lands |
|---|---|---|---|
| Bezel, sheet | `shell/app-shell.tsx` layout, `bos-atmosphere` wrapper | **Replace** layout wrapper (shell only) | V2-C |
| Pixa Rail | Sidebar in `app-shell.tsx`, `shell/icons.tsx` | **Extend**: restyle, dark-scope, same structure and behaviour | V2-C |
| Top bar | `app-shell.tsx` top bar | **Extend**: remove placeholders (already planned), palette button | V2-C |
| Section bar | `SecondaryNav`, `ZonePage` tabs | **Replace** with V2-B3 `Tabs`/`SectionNav` (already planned) | V2-B3 / V2-C |
| Command area | `PageHeader` (`packages/ui` `layout.tsx`), `shell/zone-page.tsx` | **Extend**: inline meta, "More" overflow, no eyebrow | V2-B3 (`Menu`) + V2-C |
| Ruled section header | `SectionHeader` | **Extend**: `variant="ruled"`, meta and one action | B2-2 |
| Figure strip | `KpiCard`, `StatCard` (`packages/ui`) | **Replace** in screens; old components kept until their last consumer moves (V2-E) | B2-2 (component), V2-D (adoption) |
| Pixel marker | `Badge`, `StatusIndicator`, local badges | **Extend** V2-B4 `StatusBadge` contract: marker + word, `tone`, `hollow`; no pill form | B2-2 (`PixelMarker`), V2-B4 (`StatusBadge`) |
| Toggle and removable filter ("chip") | Local pill chips and `rounded-full` toggles | **Replace**: rectangular 32 px control, `--radius-control`, pressed state by border, weight and `aria-pressed` | V2-B4 `FilterBar` |
| Ledger table | `Table` (`packages/ui`), hand-written tables | **Extend** V2-B4 `DataTable`: `bleed`, `selectedRowId`, column `priority` | V2-B4 |
| Inspector | Task dialog in `task-board.tsx`, detail pages | **New** pattern on V2-B3 `Sheet` plus a column mode | V2-B5 (pattern), V2-D (per Zone) |
| Description list | 7 local grid templates | V2-B4 `DescriptionList` (already planned) | V2-B4 |
| Progress squares | 2 px bar in `project-list.tsx` | **Replace** in Projects | B2-2 (component), V2-D Projects |
| Charts | `packages/ui` `chart.tsx` | **Extend**: square legend markers | V2-D Reporting/Home |
| Glass, atmosphere | `surface.tsx` | **Narrow** use (§7) | V2-C |

**Breaking replacements:** only inside V2-C (shell layout) and the Projects task modal to inspector (V2-D Projects, needs its own guard tests). Everything else is additive or an extension of a contract that V2-B3/B4 has not built yet.

## 13. Dependency and migration impact

- **New dependencies:** none. No npm package, no font, no icon set. JetBrains Mono not used (D-V2B1-1).
- **Tokens:** one new colour token, three layout or component tokens; V2-B1 values unchanged; V1 aliases unaffected.
- **API, contracts, permissions, schema, money:** no change. Every widget maps to an existing endpoint (§9).
- **Tests at risk when implemented:** shell tests that assert the sidebar's structure (V2-C rewrites them, as planned); tests that query status text inside pills (`Overdue`, `Partly paid`) if the phrase changes to "Overdue · part paid" (listed per V2-D PR); Projects task dialog tests when the inspector replaces it. Home heading text is kept.
- **Active work:** no open UI PR. GS2 (merged docs) builds the palette in `shell/palette/` on V2-B3 pieces; the top-bar "Jump to…" here is the same entry point, no conflict. R2 dashboard (`shell/dashboard/*`) is the Home adoption target in V2-D; its `sources.ts` stays the single widget table. GS1-A (#93) is backend only.
- **Desktop:** no Tauri capability, CSP or window change; the bezel is CSS. `:has()` is not needed (the reference avoids it).
- **Performance:** fewer shadows and no backdrop blur on large surfaces; CSS grows by an estimated 1–2 kB gzip for the new components (not measured).

## 14. Implementation slices and PR boundaries

Each slice is its own thread, branch and draft PR, audited and approved separately. None touches the API.

| Slice | Scope | Paths | Needs | Conflicts |
|---|---|---|---|---|
| **B2-1 Visual-regression harness** (the original V2-B2) | Promote the V2-A harness to a dev-only package; lossless goldens with bundled Inter, fixed clock, both themes, 1440 / 900 × 600 / 834 / 390, plus forced-colours, reduced-motion and focus captures; non-gating CI job until stable (D-V2A-11). Chromium goldens are **not** a substitute for macOS WKWebView or Windows WebView2: the D-V2A-10 compatibility matrix and real-device checks stay separate and required | new `tooling/visual/` (or `apps/web/visual/`), `.github/workflows` (new job only) | D-V2B2-1 | None |
| **B2-2 Identity foundations** (first implementation candidate) | `--bg-bezel`, `--inspector-w`, `--marker-*`, `--bezel-gutter`; components `PixelMarker`, `FigureStrip`/`Figure`, `SectionHeader variant="ruled"`, `ProgressSquares`; token and contrast tests; showcase section | `packages/ui/src/styles.css`, `packages/ui/src/components/*`, `packages/ui/tests/*`, `packages/ui/showcase/*` | D-V2B2-2, -4 | None: nothing in `packages/app` uses them yet |
| B2-3 Contract amendments | Fold into V2-B3/B4/B5 specs: `StatusBadge` marker form, `DataTable` bleed/selection/priority, `Inspector` pattern on `Sheet` | Docs in this file; code in those PRs | D-V2B2-5 | Coordinates with whoever opens B3/B4/B5 |
| V2-C Shell | Bezel, sheet, rail restyle, top bar, section bar | `packages/app/src/shell/*` | B2-2, V2-B3 | Shell is owned by V2-C only |
| V2-D Zones | Home (R2), Finance, Projects first for this identity, one Zone per PR, each with its endpoint-to-widget map | each Zone's folder | V2-C, B4/B5 parts it uses | One Zone per PR; R2 owner area for Home |

Order: B2-1 and B2-2 in parallel (disjoint paths), each a **separately audited draft PR**, started only after this revised document is approved; then V2-B3, V2-C, then V2-D. Approving B2-1 and B2-2 does **not** authorise the shell or Zone rework: V2-C and each V2-D PR get their own audit and approval. This keeps every PR inside one package or one Zone, so other threads are not blocked.

## 15. Acceptance criteria and visual QA checklist

### 15.1 Acceptance criteria for any PR that implements this

1. Typecheck, lint, boundaries, tests and `CI gate` pass; existing app tests pass unchanged except those listed in the PR with reasons.
2. Token test covers every new token in both themes and every new contrast pair (§11.4).
3. Both themes, 1440 and 900 × 600, reviewed from harness screenshots; forced-colours and reduced-motion emulation screenshots attached.
4. No widget without a source; endpoint-to-widget map in each Zone PR; request count unchanged or explained.
5. Anti-template criteria AT-1 to AT-10 hold for the screens touched; counts in §3.2 go down, never up.
6. Keyboard-only walk-through of the touched screen recorded (Tab order, `Esc`, focus return).
7. No new dependency, no API, permission, tenant or money change.

### 15.2 Visual QA checklist (per screen)

- [ ] Frame: bezel, rail, sheet and top bar identical to the shell spec; rail current item has bar and background.
- [ ] Title row: one `h1` at 22 px, at most one primary and two secondary actions, the rest in "More".
- [ ] No cards around sections, figures, tables or lists; nesting depth ≤ 2.
- [ ] Rules: section headers ruled; figure strips ruled; table full bleed with 24 px insets.
- [ ] Status: square marker plus word everywhere; danger word coloured.
- [ ] No pills: no capsule or `rounded-full` shape on any control, chip, field, tab, badge or label; radii only 8 / 6 / 4 / 2 px as in §4 rule 4.
- [ ] Numbers: tabular, right-aligned in tables, currency stated, no mixed-currency totals, period or "as of" stated.
- [ ] Density: 40 px rows, 32 px controls, 24 px sheet padding, no arbitrary values.
- [ ] 900 × 600: data above the fold (AT-7); inspector becomes overlay; secondary actions folded.
- [ ] Dark: sheet edge visible; no pure black; charts readable.
- [ ] Focus visible on every control in both themes and on the rail; not hidden under sticky parts.
- [ ] Forced colours: selection and markers still distinguishable; focus uses `Highlight`.
- [ ] Reduced motion: no animation.
- [ ] Inter loaded (check font requests), stored theme opens without a flash on a desktop build (B1 audit follow-up).
- [ ] **Blind test** (identity gate): three screenshots with the mark and wordmark blurred, shown beside two well-known SaaS dashboards; reviewers can pick the Pixa ones. Run once on the B2-1 harness output after V2-C, recorded in that PR.

## 16. Owner decisions

None of these authorises a merge, a deploy or work beyond the slice it names.

| ID | Decision | Recommendation | Alternatives |
|---|---|---|---|
| D-V2B2-1 | Naming: the approved plan's V2-B2 is the harness | Keep "V2-B2 identity" for this package and run the harness as its slice **B2-1** | Rename this package (for example V2-B6) and keep B2 as the harness |
| D-V2B2-2 | Identity direction | **A. Ledger** (§5) | B. Workbench; C. Tiles (V2-A reference as drawn) |
| D-V2B2-3 | Rail material, superseding D-V2A-4 (subtle glass sidebar) | Opaque ink rail on an ink bezel, in both themes; glass only on overlays | Keep glass sidebar; ink rail only in dark |
| D-V2B2-4 | Tokens | Add `--bg-bezel` (one colour) and the three layout/component tokens in §7; no V2-B1 value changes | No bezel (sheet fills the window, rail only) |
| D-V2B2-5 | Inspector scope | Finance document and expense lists and Projects tasks only; read-first; a separate Preview action where a record page exists (§6.9); overlay below 1280 px; the Projects task modal is replaced in V2-D Projects | Inspector nowhere in V2; or everywhere |
| D-V2B2-6 | Atmosphere | Retire from Home and Zones; keep on sign-in, onboarding and empty first-run | Keep `calm` behind Zones (V2-A §6.2) |
| D-V2B2-7 | Status display and shape | **Amended after audit:** square pixel marker plus word for status (amends the V2-A §9.2 `StatusBadge` "dot + text + border"), and **no pills anywhere** in functional UI, including chips, buttons, filters, fields, tabs and labels (§4 rule 4). Avatars use a 6 px rounded square; a circular crop is allowed only for a real photo, never for control chrome | Keep pill badges |
| D-V2B2-8 | First implementation | Authorise **B2-1** and **B2-2** (§14) as two separately audited draft PRs in their own threads, after this revised document is approved. Not an authorisation for V2-C or V2-D | Wait until V2-B3 is specified |

## 17. Audit log

**ChatGPT audit of `c70c4cc` (2026-11-17, posted on PR #103): CONDITIONAL PASS on Direction A.** Required revisions and where they are addressed:

| Audit item | Change in this revision |
|---|---|
| No pills anywhere, stated as an owner requirement (buttons, filters, fields, dropdowns, tabs, badges, chips, labels) | §4 rule 4 rewritten; AT-11 added with current counts; QA checklist item; §12 chip row; D-V2B2-7 amended; renders updated (chips, avatar and concept label are rectangular; no `--radius-pill` in the reference) |
| Inspector: keep record links as navigation, add a separate accessible preview action, define focus when the row disappears | §6.9 and §11.2; renders show the Preview button column and its focus state (`b2-desktop-light-finance-focus.png`) |
| Harness: Chromium goldens are not WKWebView; keep real-device checks separate; non-gating until stable; cover fonts, focus, forced colours, reduced motion, 900 × 600 and narrow | §14 B2-1 row |
| `--bg-bezel` acceptable with contrast and light/dark tests; markers always with text; money per currency, exact | Already in §6.10, §7, §9.3, §11.4; unchanged |
| B2-1 and B2-2 as separate draft PRs, not authorisation for the shell or Zone rework | §14 order note; D-V2B2-8 |

The audit's recommendations on D-V2B2-1..8 are recommendations, not decisions; §16 records only Regan's own decisions.
