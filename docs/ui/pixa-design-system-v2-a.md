# UI V2-A: Pixa Design System, architecture audit and specification

- Status: **Proposal for review.** Documentation only. Nothing here changes application code, API contracts, permissions, tenant isolation, financial rules or the database. Implementation starts at V2-B only after the approval gate in §13.
- Issue: #73. Branch: `claude/project-thread-d3hwy5`. Audited commit: `1b2bf15` (main, 2026-11-16).
- Visual direction (approved in #73): **Pixa Hybrid**. Linear-like precision, Raycast-like desktop ergonomics, Stripe-like clarity for business workflows. Not a clone of any of them.
- Themes: light and dark from day one, following the system preference unless the person chooses one.

How to read this: §2 to §5 are the audit (what exists, with evidence). §6 to §10 are the specification (what V2 should be). §11 to §13 are the plan, the risks and the decisions waiting on the owner. Every finding has an ID (`F-nn`) and every decision an ID (`D-V2A-n`).

## Contents

1. [Method and evidence](#1-method-and-evidence)
2. [Inventory](#2-inventory)
3. [What already works and must be kept](#3-what-already-works-and-must-be-kept)
4. [Gap analysis](#4-gap-analysis)
5. [Token coverage audit](#5-token-coverage-audit)
6. [Principles and visual identity](#6-principles-and-visual-identity)
7. [Token architecture](#7-token-architecture)
8. [Navigation and shell](#8-navigation-and-shell)
9. [Component contracts](#9-component-contracts)
10. [Reference screens](#10-reference-screens)
11. [Adoption plan V2-B to V2-E](#11-adoption-plan-v2-b-to-v2-e)
12. [Accessibility, performance and regression test plan](#12-accessibility-performance-and-regression-test-plan)
13. [Risks, open questions and the approval gate](#13-risks-open-questions-and-the-approval-gate)
14. [Existing decisions: preserved or superseded](#14-existing-decisions-preserved-or-superseded)

---

## 1. Method and evidence

- **Code read:** all of `packages/ui` (tokens, 15 component files, showcase, tests), `packages/app/src/shell`, `packages/app/src/app.tsx`, every Zone under `packages/app/src/zones`, both entry points (`apps/web`, `apps/desktop`), `tauri.conf.json`, `docs/ui/app-shell.md`, `docs/architecture.md` §6.5, ADR 0005 and the existing screenshot sets.
- **Counts:** taken with `grep` over `packages/app/src` at the audited commit. They are approximate (they count source occurrences, not rendered elements) and are there to show scale, not to be exact.
- **Screenshots of the current app** (`docs/ui/v2-a/current/`, 47 images): the real shared `App` from `@business-os/app`, built with Vite and Tailwind exactly as `apps/web` is, with every API call answered in the browser by the existing in-memory test fakes (`packages/app/tests/support/fake-*.ts`). No server, no database, no production data. Chromium, device scale 2. Widths: 1440 desktop, 900 × 600 (the Tauri minimum window), 834 tablet, 390 phone; light and dark. The harness source is kept as text in `docs/ui/v2-a/harness/` (same convention as `docs/ui/screenshots/finance-f4/shots.mjs.txt`). Scheduling is not captured because it is not reachable in the app (F-01).
- **Font caveat for every screenshot:** the capture machine has Inter installed, and the app asks for `ui-sans-serif, system-ui`, so these images show Inter. On a real Mac the app renders in SF Pro and on Windows in Segoe UI (F-11).
- **Contrast figures** were computed from the token values with the WCAG 2.x relative-luminance formula. Translucent tokens were composited onto the surface they sit on.
- **Reference screens** (`docs/ui/v2-a/reference/`): a static HTML concept (`reference.html`) rendered to PNG. Sample data only, labelled "Concept" on every image. It is not application code and is not built or shipped.

Verified versus assumed: everything marked "verified" was observed in the harness or read in code. Statements about real macOS or Windows rendering, WebView versions and performance are **not verified** here (no Mac or Windows runner was used) and are listed as checks for V2-B.

## 2. Inventory

### 2.1 Packages and ownership

| Layer | Where | What it owns |
|---|---|---|
| Design system | `packages/ui` | Palette and semantic tokens (`src/styles.css`), Tailwind mapping, glass and atmosphere treatments, 15 component files, dev showcase, token and interaction tests |
| Shared app | `packages/app` | Boot and auth screens, `AppShell`, Zone registry, `ZonePage`, every Zone, typed API clients |
| Entry points | `apps/web`, `apps/desktop` | Transport, configuration, `applyStoredTheme()`, the boot splash in `index.html` |

### 2.2 Shared components and how much they are used

| Component (`@business-os/ui`) | Source uses in `packages/app` | Notes |
|---|---|---|
| `Button` / `buttonClass` | 214 | Used only by Finance, People, Reporting, Scheduling and parts of the shell |
| `Field`, `Input`, `Select`, `Textarea` | 179, 93, 64, 20 | Same Zones |
| `Alert` | 72 | |
| `Badge` | 34 | Four local badge implementations exist alongside it (F-06) |
| `ZonePage` (`packages/app/src/shell/zone-page.tsx`) | 33 | Finance, People, Reporting, Scheduling, Home. Not Customers, Sales, Projects |
| `Card`, `Table` + `TableRow` | 29, 22 + 47 | Customers, Sales and Projects hand-write their tables |
| `Skeleton` | 28 | A second `Skeleton` lives in `zones/problem.tsx` |
| `FormSection`, `Dialog`/`DialogContent` | 24, 18/17 | Four other dialog mechanisms exist (F-04) |
| `EmptyState`, `SectionHeader`, `KpiCard`, `StatCard`, `Spinner`, `PageHeader` (direct) | 11, 6, 4, 3, 1, 1 | |
| `StatusIndicator`, `Surface` | **0** | Built and tested, never used |

### 2.3 Two UI generations

Files importing `@business-os/ui`, per area (verified):

| Area | Files using `@business-os/ui` | Files using the shell's local class strings¹ | Generation |
|---|---|---|---|
| Customers (`zones/customers`) | 0 of 8 | 6 | 1 |
| Sales (`zones/sales`) | 0 of 5 | 3 | 1 |
| Projects (`zones/projects`) | 0 of 8 | 5 | 1 |
| Activity (`zones/activity`) | 0 of 5 | 4 | 1 |
| Shared Zone helpers (`problem.tsx`, `drafts.tsx`, `customer-picker.tsx`) | 0 of 4 | 3 | 1 |
| Shell full-window states (`frame.tsx`, `states.tsx`, `choose.tsx`, `onboarding.tsx`) | 0 of 4 | 4 | 1 |
| Finance | 19 of 22 | 1 (`catalog-picker.tsx`) | 2 |
| People | 9 of 10 | 0 | 2 |
| Reporting | 5 of 5 | 0 | 2 |
| Scheduling | 7 of 7 | 0 | 2 |

¹ `actionClass`, `secondaryClass` and `inputClass`, exported from `packages/app/src/shell/frame.tsx:4-6`, referenced about 180 times (imports included) in 24 other files. They predate the design system and duplicate `Button` and `Input` with different sizes, radii and focus styles.

### 2.4 Screens

| Zone | Screens (component, file) | Layout contract | Screenshot |
|---|---|---|---|
| Shell | Sidebar, top bar, breadcrumbs, business switcher, account menu, mobile drawer (`shell/app-shell.tsx`) | — | `v2-a/current/desktop-*-02-account-menu.png`, `v2-a/current/mobile-*-02-drawer.png` |
| Full-window states | Startup, unreachable, failed, unverified, choose business, business setup, sign-in/up/reset, invitation (`shell/frame.tsx`, `states.tsx`, `choose.tsx`, `onboarding.tsx`, `auth/auth-screens.tsx`) | `Frame` (local) | not captured (no session states in the harness) |
| Home | Greeting, Zone launcher, shortcuts, activity placeholder (`shell/home.tsx`) | `ZonePage` | `v2-a/current/desktop-*-01-home.png` |
| Customers | Directory, detail, create/edit, manage contacts, activity timeline, note composer, log interaction, conversation history (`zones/customers/*`, `zones/activity/*`) | hand-written | `v2-a/current/desktop-*-03…05` |
| Sales | List, board, opportunity detail, opportunity form (`zones/sales/*`) | hand-written | `v2-a/current/desktop-*-06…07` |
| Projects | List, detail with task board and list, project form, task form, task panel (`zones/projects/*`) | hand-written | `v2-a/current/desktop-*-08…09` |
| Finance | Overview, quotes, invoices, credit notes (list, detail, form), payments, receivables and statements, expenses, payments made, categories, catalog, recurring, settings, branding, PDF preview (`zones/finance/*`) | `ZonePage` | `v2-a/current/desktop-*-10…13`, `v2-a/current/*-invoices.png` |
| People | Directory, profile, employee form, status and assignment dialogs, departments and locations (`zones/people/*`) | `ZonePage` | `v2-a/current/desktop-*-14-people.png` |
| Reporting | Dashboard, explore, saved reports (`zones/reporting/*`) | `ZonePage` | `v2-a/current/desktop-*-15…16`, `v2-a/current/mobile-*-05-reporting.png` |
| Scheduling | Day/week/month views, event detail and form, resources, resource timeline (`zones/scheduling/*`) | `ZonePage` | not reachable (F-01); see S1 screenshots in the project files |

### 2.5 Tests that touch the UI

- `packages/ui/tests`: `tokens.test.ts` (dark blocks identical, WCAG AA for each token pair in both themes), `ui.test.tsx`, `interaction.test.tsx` (dialog focus, keyboard, forms, roles), `charts.test.tsx`.
- `packages/app/tests`: 30 jsdom suites, including shell, responsive (simulated `matchMedia`), each Zone, and the unsaved-changes guard.
- **Not present:** real-browser tests, visual regression baselines, automated accessibility rules (axe), Mac or Windows WebView checks, forced-colours checks. Screenshots so far are one-off documentation.

## 3. What already works and must be kept

These are deliberate, tested decisions. V2 builds on them and must not regress them.

1. **Token layering** (`packages/ui/src/styles.css`): palette → semantic → Tailwind mapping, palette deliberately not mapped to utilities. No raw Tailwind palette colours (`bg-red-500` and so on) appear anywhere in `packages/app` (verified: zero matches). Hex values appear only in the logo.
2. **Contrast and theme-parity tests** (`tokens.test.ts`). Text contrast is high: muted text on the canvas is 7.0:1 (light) and 8.1:1 on cards (dark); input borders 3.4:1 and 3.8:1; focus ring 5.8:1 and 7.8:1.
3. **Glass with real fallbacks**: opaque under `prefers-reduced-transparency`, without `backdrop-filter`, and with a solid border in forced colours.
4. **Shell accessibility**: skip link, landmarks, `aria-current`, WAI-ARIA menu buttons, drawer with focus trap and restore, focus moved to the new `h1` on view changes, honest "not available yet" placeholders.
5. **`Field`** wiring (label, hint, error, `aria-describedby`, `aria-invalid`) and **`FormSection`** fieldsets.
6. **Charts**: figure + caption, legend that does not rely on colour (dashed comparison), visually hidden data table, exact decimal strings for display.
7. **Responsive table strategy** in the Customers directory: wide = all columns, medium = secondary facts move under the name, narrow = record list. Nothing is dropped, only moved.
8. **`ZonePage` contract** (one `h1`, actions that wrap and never hide, standard loading, error and empty states) and the **unsaved-changes guard** that every shell exit runs through.
9. **No fake features**: planned Zones say "coming soon"; search and notifications say "not available yet".

## 4. Gap analysis

Severity: **S1** blocks a task or fails an accessibility requirement; **S2** clear friction, inconsistency or desktop-ergonomics gap; **S3** polish. Effort: **S** under a day, **M** a few days, **L** a week or more. Kind: **F** functional (behaviour, access, data visibility), **V** visual preference.

| ID | Finding | Evidence | Sev | Kind | Effort | Phase |
|---|---|---|---|---|---|---|
| F-01 | **Scheduling is built and tested but cannot be opened.** There is no `scheduling` entry in `ZoneId` or `ZONES`, and `app.tsx` never renders `SchedulingZone`. | `shell/registry.ts:503`, `app.tsx` (no import), only `tests/scheduling-zone.test.tsx` renders it | S1 | F | S (after product sign-off) | Decision D-V2A-8, then V2-C |
| F-02 | **Clicking the current Zone in the sidebar does nothing from a record or form** in Customers, Sales, Projects and People: the route is unchanged, so the Zone does not remount and stays on the record. | Harness: on Kelp & Co Seafood, clicking "Customers" leaves `h1` = "Kelp & Co Seafood". Keys in `app.tsx` (`${slug}|${target}|${intent}`) | S2 | F | S | V2-C |
| F-03 | **Two UI generations.** Customers, Sales, Projects, Activity and the full-window states use local class strings instead of the design system, so controls differ by Zone: Gen 1 inputs are about 46 px tall with `rounded-xl` and a ring without offset, Gen 2 inputs are 40 px with `rounded-lg` and a border-plus-ring focus. | §2.3; `shell/frame.tsx:4-6`; compare `v2-a/current/desktop-light-05-customer-form.png` with `v2-a/current/desktop-light-13-finance-invoice-form.png` | S2 | F+V | L | V2-D |
| F-04 | **Five dialog mechanisms.** Radix `Dialog` (17 uses); `useDialog` overlays (`zones/drafts.tsx`, and a verbatim copy in `customers/customer-zone.tsx`); inline `role="alertdialog"` panels without `aria-modal` that sit in the page flow (`customers/customer-detail.tsx:153`, `projects/project-detail.tsx:163`, `:272`, `sales/opportunity-detail.tsx:181`); a custom task dialog (`projects/task-board.tsx:505`); the shell drawer. An `alertdialog` that is not modal and not focus-managed contradicts the ARIA pattern. | file references | S2 | F (a11y) | M | V2-B (component), V2-D (adoption) |
| F-05 | **Duplicated states.** Two `Skeleton`s (`ui/components/loading.tsx`, `zones/problem.tsx`); `Problem` is a third error-card style; three empty-state styles (`ui` `EmptyState`, `ZonePage` empty, `customers/directory.tsx` local `EmptyState`). | file references | S3 | V | S | V2-B |
| F-06 | **Status language differs by Zone.** Local badges in `customers/directory.tsx:19-34`, `projects/badges.tsx`, `activity/activity-badge.tsx` next to `ui` `Badge`. "Active" is a solid primary pill in Projects, a 10 % tint in Customers; Finance uses brand tint for "Issued". `KindBadge` uses the glyphs ▣ and ◉, which render differently per font. `StatusIndicator` is unused. | file references; `v2-a/current/desktop-light-03-customers-list.png`, `-09-project-detail.png`, `-11-finance-invoices.png` | S2 | F+V | M | V2-B, V2-D |
| F-07 | **Navigation is shown twice, sometimes three times.** On wide screens a Zone's children appear in the sidebar and again as the top section tabs (`app-shell.tsx:146` and `:243`). Reporting also repeats "Saved reports" and "Explore figures" as header buttons. At 900 px (the Tauri minimum) the nine Finance tabs overflow with no affordance and "Settings" is off-screen. | `v2-a/current/desktop-light-11-finance-invoices.png`, `v2-a/current/desktop-dark-15-reporting-dashboard.png`, `v2-a/current/desktop-min-900-light-invoices.png` | S2 | F | S | V2-C |
| F-08 | **Filters push data off the screen.** At 900 × 600 the Invoices list shows no rows above the fold; at 390 px the first row starts about 830 px down. There are four filter patterns: search + segmented (Customers), search + segmented + labelled selects (Sales), unlabelled selects in a panel (Projects), a labelled field grid with hints (Finance). | `v2-a/current/desktop-min-900-light-invoices.png`, `v2-a/current/mobile-light-04-finance-invoices.png`, `-03`, `-06`, `-09` | S2 | F | M | V2-B (FilterBar), V2-D |
| F-09 | **Low data density.** Table rows are about 65 to 68 px (`py-3` cells plus wrapping); a 1440 × 900 window shows nine customers. Uppercase, tracked headers add noise. | `v2-a/current/desktop-light-03-customers-list.png`, `-06-sales.png` | S3 | V | S (token) | V2-B |
| F-10 | **Placeholders take prime space.** The "Search · Soon" field is 224 px wide and the bell is permanently disabled, in the most valuable strip of the window. Honest, but costly. | `app-shell.tsx:140-141`, every desktop screenshot | S3 | V | S | V2-C |
| F-11 | **No product typeface.** `body` uses `ui-sans-serif, system-ui` (`styles.css:303`), so the product looks different on macOS, Windows and Linux, and screenshots are not representative. No type-scale tokens; 15 one-off `text-[10px]`/`text-[11px]` and five one-off letter-spacings (`.12em` to `.22em`). | `styles.css:303`; grep | S2 | V | M | V2-B |
| F-12 | **Boot splash does not match the brand or the chosen theme.** `apps/web/index.html` and `apps/desktop/index.html` paint neutral `#fff`/`#0a0a0a` greys and follow only the OS preference, then the app switches to lavender or navy (a visible flash, worse when the stored theme differs from the OS). The splash logo colours (`#8D7BFF`, `#FFD93B`) differ from `BusinessOsMark` (`#8674FB`, `#FDD237`). | both `index.html`; `shell/business-os-mark.tsx:10-14` | S3 | V | S | V2-B |
| F-13 | **Selection disappears in forced-colours mode.** The active sidebar marker, the active tab underline and the selected segmented-control option are coloured backgrounds, which Windows High Contrast removes. Only `.bos-glass` has a forced-colours rule. | `app-shell.tsx:274`, `:385`; `zone-page.tsx`; `customers/directory.tsx:79` | S2 | F (a11y) | S | V2-B |
| F-14 | **`title` used as the only visible label** for the compact rail and some icon buttons. Not shown on keyboard focus or touch. Accessible names exist, so assistive technology is fine; sighted keyboard users are not. | `app-shell.tsx:266`, `:205` | S3 | F (a11y) | S | V2-B (Tooltip) |
| F-15 | **Surfaces barely separate from the canvas**, especially in dark: card on canvas is 1.09:1 (light) and 1.13:1 (dark), so borders (1.4:1) do all the work and the saturated navy reads heavy on large panels. | computed; `v2-a/current/desktop-dark-04-customer-detail.png` | S3 | V | S (tokens) | V2-B |
| F-16 | **One-off layout values.** About 70 arbitrary-value classes in `packages/app`, including 13 table column percentages and 7 different key-value grid templates (`grid-cols-[7rem_minmax(0,1fr)]`, `[8.5rem_…]`, `[10rem_1fr]` …). They are the missing `DescriptionList` and `DataTable` column API. | grep | S3 | V | M | V2-B, V2-D |
| F-17 | **Few desktop ergonomics.** No command palette, no global shortcuts (`⌘/Ctrl+K`, `/`, `Esc` to close panels is per component), no shortcut help. Architecture §6.5 asks for keyboard shortcuts in the shared app. | grep for key handlers: menus, dialogs, task board only | S2 | F | M | V2-C |
| F-18 | **Breadcrumbs stop at the Zone**, and each detail screen adds its own "← All customers" link. Already listed as deferred in `docs/ui/app-shell.md`. | `v2-a/current/desktop-dark-04-customer-detail.png` | S3 | F | S | V2-C |
| F-19 | **Home spends space on little.** Every Zone card carries an "Open" badge, Zone icons are solid primary tiles, the description is a tagline, and the only figures are Customers counts. | `v2-a/current/desktop-light-01-home.png` | S3 | V | M | V2-D |
| F-20 | **Native date inputs follow the browser locale** (mm/dd/yyyy in an en-US Chromium) while every displayed date follows the business locale (en-AU). | `v2-a/current/desktop-light-11-finance-invoices.png` | S3 | F | M | Decision D-V2A-9 |
| F-21 | **Long forms hide their actions.** The Add customer submit button is below the fold at 1440 × 900; there is no sticky action bar. | `v2-a/current/desktop-light-05-customer-form.png` | S3 | F | S | V2-B (FormActions) |
| F-22 | **Architecture §6.5 patterns were never built.** It promises `packages/ui/src/patterns` (`ZoneHeader`, `EntityTable`, `EntityForm`, `EmptyState`, `Timeline`, `DetailPanel`) as "the only way Zones build standard screens", and "Zone accent colours" tokens. Neither exists; most of F-03 to F-16 follows from that. | `docs/architecture.md` §6.5; `packages/ui/src` | S2 | F | L | V2-B to V2-D |
| F-23 | **Three stacked bars on phones.** Top bar (64 px) + breadcrumb bar + section tabs use about 155 px of an 844 px screen before any content. | `v2-a/current/mobile-light-04-finance-invoices.png` | S3 | F | S | V2-C |
| F-24 | **No declared browser and WebView floor.** Tailwind 4 needs Safari 16.4+ / Chromium 111+. `.bos-glass` puts `color-mix(… var() …)` after an opaque fallback, but a declaration with `var()` fails at computed-value time, not parse time, so an engine without `color-mix` gets a transparent panel, not the fallback. `tauri.conf.json` sets no minimum macOS version. Not verified on a real old WebView. | `styles.css` `.bos-glass`; `tauri.conf.json` | S2 (risk) | F | S | Decision D-V2A-10 |
| F-25 | **No motion tokens.** `transition-colors` with default timing everywhere; reduced motion is handled for spinners and skeletons only. | grep | S3 | V | S | V2-B |

## 5. Token coverage audit

| Area | Light | Dark | Gap |
|---|---|---|---|
| Canvas, text, muted text | ✓ (fg 17:1, muted 7.0:1) | ✓ (muted 8.1:1 on cards) | No "subtle" third text level, so placeholders and captions reuse muted |
| Surfaces | `card`, `surface-raised`, `popover` | same | No sunken level (table headers use `muted/60`); card-to-canvas separation 1.09 / 1.13 (F-15) |
| Borders | `border` 1.4:1 (decorative), `input` 3.4:1 | `input` 3.8:1 | No `border-strong` for dividers that must be seen |
| Interactive | primary, hover, secondary, accent, ring | same | **No pressed, selected or disabled tokens.** Selected = `bg-accent`; disabled = `opacity-50` (white-on-primary drops to 2.4:1, acceptable for disabled under WCAG but unreadable) |
| Focus | `ring` 5.8:1 / 7.8:1 | ✓ | Two focus recipes (outline with offset vs border + 40 % ring on inputs; Gen 1 inputs ring without offset) |
| Status | success, warning, destructive, info with solid foregrounds | ✓ | No subtle background or border tokens: every badge mixes its own `/8`, `/10`, `/12`, `/35`, `/40` |
| Errors | `destructive` + `aria-invalid` styling | ✓ | Field error text is a colour plus text, which is fine |
| Charts | 5 series, comparison, grid; each ≥ 3:1 on cards | ✓ | No sequential or diverging ramps; axis text one-off 11 px |
| Data density | — | — | No row-height, cell-padding or control-height tokens |
| Typography | — | — | No font, size, line-height or weight tokens |
| Radius | `--radius` 12 px with derived sm/md/lg/xl | — | In use: `rounded-xl` 80, `-md` 51, `-2xl` 49, `-lg` 42, `-full` 25, `-3xl` 1. Panels use both xl and 2xl |
| Elevation | `shadow-card`, `glass-shadow` | ✓ | No popover/overlay levels; dialogs reuse `shadow-card` |
| Motion | — | — | No duration or easing tokens (F-25) |
| Forced colours | glass only | — | Selection states vanish (F-13) |
| Reduced transparency | glass falls back | ✓ | The dialog overlay uses `backdrop-blur-[2px]` without a fallback rule (harmless, noted) |

## 6. Principles and visual identity

### 6.1 Principles

1. **Calm.** The interface recedes; the business data is the loudest thing on screen. Colour is spent on meaning (status, the one primary action, selection), not decoration.
2. **Precise.** One grid, one type scale, one set of control heights. Numbers align, columns line up, nothing is off by a pixel because someone typed `[13px]`.
3. **Trustworthy.** Amounts are tabular and never approximated; states are written in words; nothing pretends to work before it does. Destructive actions look different and ask in a consistent way.
4. **Fast.** Keyboard first on desktop: every screen reachable from the command palette, lists usable without the mouse, no animation that makes anyone wait.
5. **Approachable at SMB scale.** Plain language, sensible defaults, progressive disclosure (common filters visible, rare ones one click away). Density that suits a bookkeeper on a laptop, not a trading floor.
6. **Deliberate hierarchy.** One `h1` per screen, one primary action per view, secondary actions quieter, everything else in a menu.

### 6.2 Identity

- **Typeface (D-V2A-1).** Recommend **Inter** (variable, SIL Open Font Licence), self-hosted and bundled with the app. Reasons: proven legibility at 12 to 14 px, tabular figures and slashed zero for amounts and IDs, wide language coverage, and a neutral precision that suits the Hybrid direction. Bundling is required: the desktop CSP allows `font-src 'self'` only, so a font CDN cannot be used, and a bundled font also makes visual-regression baselines identical on every runner. A Latin-subset variable WOFF2 is about 50 to 100 kB (not measured yet). Monospace for document numbers and codes: **JetBrains Mono** (OFL), or none if D-V2A-1 prefers fewer assets. Alternatives: Geist (OFL), or a licensed Pixakova face if one exists.
- **Type scale** (px / line height): 12/16 caption, 13/18 small and table, **14/20 body (default)**, 16/24 lead, 18/24 section title, 22/28 page title, 28/36 display (Home only). Weights 400, 500, 600 (650 for page titles where the variable axis allows). Page titles drop from today's 30 px to 22 px: a business tool's title labels the screen, it does not headline it.
- **Colour.** Keep the Pixakova palette. Indigo (`--pk-indigo`) is the single accent for primary actions, selection and links. Violet stays as the focus ring (it already passes 5.8:1 and 7.8:1). Lavender and pink are atmosphere only, never on controls. Add an indigo-tinted **neutral ramp** for surfaces and text so that "lavender" is a tint, not the whole page.
- **Dark theme direction (D-V2A-2).** Recommend moving dark surfaces from saturated navy (`#0d1a47` cards on `#070f2d`) to a deep **ink** (`#121729` on `#0b0f1e`) with clearer steps between canvas, sunken, surface and raised. The identity survives in the accent, the focus ring, the atmosphere on Home and the sidebar glass. See `v2-a/reference/v2-desktop-dark-*.png`.
- **Glass and atmosphere.** Allowed on the sidebar (subtle), the Home hero, the command palette and floating toolbars. Never on tables, forms, dialogs or long text. `calm` atmosphere behind every Zone; the stronger variants only on Home, sign-in and empty first-run screens.
- **Iconography.** Keep the 24-px line set in `shell/icons.tsx` (1.75 stroke). Move it into `packages/ui` and merge the 16-px set from `customers/icons.tsx` and `activity/activity-badge.tsx` into it, drawn at 16 and 20 px.
- **Zone identity.** Zones are recognised by name, icon and position, not by colour (D-V2A-7 supersedes the "Zone accent colours" line in architecture §6.5). A per-Zone colour would compete with status colours in dense screens.

## 7. Token architecture

### 7.1 Layers

```
raw palette (--pk-*)          never used by components; ramps per hue, light and dark
   ↓
semantic (--bg-*, --fg-*, --border-*, --accent-*, --status-*, --chart-*, --focus-ring, --overlay)
   ↓                           explicit light and dark value for every token
component (--control-h-*, --row-h-*, --radius-*, --sidebar-w, --topbar-h, --shadow-*, --duration-*)
   ↓
Tailwind theme (@theme inline) maps semantic and component tokens to utilities
```

Rules:

1. Components and Zones may use **only** semantic and component tokens (as Tailwind utilities). Raw palette tokens stay unmapped, as today.
2. **Every semantic token has a light and a dark value.** The dark block stays duplicated (OS preference and `.dark`) because `light-dark()` needs Safari 17.5+. `tokens.test.ts` keeps them identical and additionally checks, from a token manifest, that no semantic token is missing from either theme.
3. **No arbitrary values** in `packages/app`: no `-[…]` Tailwind classes, no inline colours, no `text-[Npx]`. Exceptions go in a short, reviewed allowlist (for example `max-h-[calc(100dvh-2rem)]` for a dialog). Enforced by a source-scan test like the existing architecture tests, failing CI on new violations (existing ones are listed and burned down in V2-D).
4. **Status colour is never the only signal**: every status token pair is used with text, and badges carry a dot or icon plus a border in forced colours.
5. A new token needs a reason in review and a contrast test entry; a new component token needs at least two consumers.

### 7.2 Semantic tokens (V2) and migration mapping

Values are provisional; V2-B makes them final through `tokens.test.ts`. The reference screens use these values.

| V2 token | Purpose | Light | Dark | Replaces (today) |
|---|---|---|---|---|
| `--bg-canvas` | Page background | `#f7f7fb` | `#0b0f1e` | `--background` |
| `--bg-surface` | Panels, tables, cards | `#ffffff` | `#121729` | `--card` |
| `--bg-sunken` | Table headers, sidebar sections, segmented track | `#f2f2f8` | `#0e1324` | `bg-muted/60` (ad hoc) |
| `--bg-raised` | Menus, popovers, dialogs | `#ffffff` + shadow | `#181e33` | `--popover`, `--surface-raised` |
| `--bg-hover` | Row and item hover | `rgb(16 20 46 / .04)` | `rgb(238 240 250 / .05)` | `bg-accent/60`, `bg-muted/50` (ad hoc) |
| `--bg-selected` | Selected row, current nav item | `#eef0fb` | `rgb(91 110 224 / .18)` | `--accent` |
| `--fg-default` | Body text | `#10142e` | `#eef0fa` | `--foreground` |
| `--fg-muted` | Secondary text | `#555a77` | `#a6abc6` | `--muted-foreground` |
| `--fg-subtle` | Captions, placeholders (≥ 4.5:1 on canvas and surface) | `#646987` | `#8a8faa` | — (new) |
| `--fg-accent` | Links, selected text on subtle accent | `#2f42a6` | `#aab6ff` | — |
| `--fg-on-accent` | Text on solid accent | `#ffffff` | `#ffffff` | `--primary-foreground` |
| `--border-default` | Panel and row dividers | `#e4e4ee` | `#262c45` | `--border` |
| `--border-strong` | Button outlines, separators that must be seen | `#d3d3e2` | `#323958` | — |
| `--border-input` | Field borders (≥ 3:1) | `#8e90ad` (3.1:1) | `#6b7193` (3.7:1) | `--input` |
| `--accent` / `-hover` / `-subtle` | Primary action, hover, selection tint | `#384eba` / `#2e42a3` / `#eef0fb` | `#4f63d6` / `#5d70e0` / `rgb(91 110 224 / .18)` | `--primary`, `--primary-hover`, `bg-primary/10..15` |
| `--focus-ring` | Focus outline | `#6b57b3` | `#c4a6d3` | `--ring` |
| `--status-{success,warning,danger,info}-fg` | Status text and icon | today's values | today's values | `--success` … |
| `--status-*-bg`, `--status-*-border` | Badge and alert fills | new | new | `bg-success/12` … (ad hoc) |
| `--status-*-solid`, `-on-solid` | Solid fills (rare) | today's | today's | `--success`, `--success-foreground` … |
| `--chart-1..5`, `--chart-comparison`, `--chart-grid` | Series | keep | keep (grid to `#20263d`) | same names |
| `--overlay` | Behind dialogs | keep | keep | same |
| `--disabled-fg`, `--disabled-bg` | Disabled controls (replaces blanket `opacity-50`) | new | new | `opacity-50` |

**Compatibility.** V2-B keeps every current Tailwind colour name (`background`, `card`, `muted-foreground`, `primary` …) as an alias of its V2 token, so no screen breaks on the day the tokens land. Aliases are removed in V2-E after the last consumer moves. `tokens.test.ts` checks the aliases resolve.

### 7.3 Component and scale tokens

| Group | Tokens | Values |
|---|---|---|
| Spacing | Tailwind 4 spacing scale (0.25 rem steps) | Use only 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 16 in layouts |
| Control height | `--control-h-sm/md/lg` | 28 / 32 / 40 px (desktop); `@media (pointer: coarse)` raises md to 40 and touch targets to 44 |
| Row height | `--row-h-compact/default/comfortable` | 32 / 40 / 48 px; default 40 (D-V2A-3) |
| Radius | `--radius-control`, `--radius-panel`, `--radius-dialog`, `--radius-pill` | 8 / 12 / 16 / 9999 px. Pills only for badges, chips and avatars |
| Elevation | `--shadow-raised`, `--shadow-overlay` | menus and popovers; dialogs and command palette. Panels have a border, no shadow |
| Layout | `--sidebar-w`, `--sidebar-w-compact`, `--topbar-h`, `--content-max` | 232 / 64 / 48 px / 1240 px |
| Motion | `--duration-fast/base/slow`, `--ease-standard`, `--ease-emphasised` | 100 / 160 / 240 ms; `cubic-bezier(.2,0,0,1)`; all 0 ms under `prefers-reduced-motion` |
| Typography | `--font-sans`, `--font-mono`, `--text-*` with line heights | §6.2 scale |

### 7.4 Interaction states (one recipe everywhere)

| State | Recipe | Non-colour signal | Forced colours |
|---|---|---|---|
| Hover | `--bg-hover` overlay | — | none needed |
| Pressed | `--bg-hover` × 2, no transform | — | — |
| Selected / current | `--bg-selected` + 2 px accent bar (nav) or check (menus) | `aria-current`, `aria-selected`, `aria-pressed` | `Highlight` background / `HighlightText` text, or a `CanvasText` outline |
| Focus | 2 px `--focus-ring` outline, 2 px offset (inset `-2px` inside tables) | outline itself | `outline-color: Highlight` |
| Disabled | `--disabled-fg` on `--disabled-bg`, `cursor: not-allowed` | `disabled` / `aria-disabled` | `GrayText` |
| Invalid | `--status-danger-fg` border + message | message text, `aria-invalid` | border `CanvasText` + message |
| Loading | inline spinner, label kept | `aria-busy` | — |

## 8. Navigation and shell

### 8.1 Information architecture

- **Sidebar (wide, ≥ 1024 px):** business switcher, Home, Zones in registry order, and the current Zone's children nested under it. This is the **only** place children appear on wide screens: the top section tabs are removed there (fixes F-07).
- **Compact rail (640 to 1023 px, including the 900 px Tauri minimum):** icons with real tooltips (F-14); the current Zone's children appear as a **section bar** under the top bar, with overflow collapsing into a "More" menu instead of scrolling off-screen.
- **Narrow (< 640 px):** one 52 px app bar (menu, page title, command button). Breadcrumbs are dropped below 640 px; the Zone's children become a **section select** at the top of the page (fixes F-23). The drawer stays as today.
- **Breadcrumbs** gain the record level through a small contract: a screen calls `useBreadcrumb(label)` and the shell shows `Home / Customers / Kelp & Co Seafood`, each level clickable. The per-screen "← All customers" links are then removed (F-18).
- **Clicking the current Zone** always returns to the Zone's root, through the unsaved-changes guard (F-02). Implementation: a navigation counter in the route so the Zone remounts.
- **Scheduling** gets its registry entry once D-V2A-8 approves it (F-01). It needs `scheduling:read`; the permission key already exists in `apps/api/src/modules/access/server/permissions.ts`.
- **Top bar:** breadcrumbs, the command button ("Jump to…  ⌘K"), the account menu. The disabled bell is removed until a notifications backend exists (D-V2A-6).
- **Page header:** title (22 px), one-line description, at most one primary and two secondary actions; anything more goes in an overflow menu. Header buttons never duplicate the navigation (fixes the Reporting double).

### 8.2 Command palette (client-side, no backend)

`⌘K` on macOS, `Ctrl+K` elsewhere, and the top-bar button. Built from the registry and the person's permissions only:

- **Go to:** every Zone and child the person can open ("Finance › Invoices").
- **Create:** the create intents already supported by routes (`intent: 'new'` for customers, opportunities, projects; Finance documents and expenses as their forms exist), shown only when the permission is held.
- **Switch business:** the businesses the server listed.
- **Preferences:** theme (System, Light, Dark), sidebar mode.

What it does **not** do: search records. Record search ("Kelp…") needs a search endpoint and is listed as future, backend-dependent work. The palette says so in its empty state ("Searching records is not available yet") rather than showing nothing. The same rule covers notifications and a cross-Zone activity feed: none of them is shown until its backend exists.

### 8.3 Keyboard map

| Keys | Action | Scope |
|---|---|---|
| `⌘/Ctrl+K` | Command palette | global |
| `/` | Focus the page's search or filter field | list screens |
| `?` | Keyboard shortcuts help | global (not while typing) |
| `Esc` | Close the top-most menu, popover, panel or dialog | global |
| `↑ ↓`, `Enter` | Move between rows, open the row | `DataTable` with row navigation |
| `⌘/Ctrl+Enter` | Submit the form | forms |
| `⌘/Ctrl+[` and `]` | Back and forward | after URL routing exists (deferred) |

Single-letter shortcuts are avoided (WCAG 2.1.4); every shortcut has a visible alternative.

### 8.4 Desktop (Tauri) and web parity

- Same React app and the same CSS in both (ADR 0005 unchanged).
- The Tauri window minimum (900 × 600) is a first-class layout: every reference screen must show data above the fold at that size.
- Native menus, a native title bar or tray need Tauri capabilities beyond `core:default` and are an architecture change under ADR 0005 rule 4. They are **out of scope** for V2; shortcuts are handled in the web layer.
- `⌘` versus `Ctrl` labels come from the platform (`navigator.platform` / `userAgentData`), used for labels only.
- URL routing and deep links stay deferred (`docs/ui/app-shell.md`). "Refresh keeps your place" from the pilot list depends on it and is tracked outside V2.

## 9. Component contracts

### 9.1 API conventions (all components)

- Styling props: `variant` (visual role), `size` (`sm`/`md`/`lg`), `tone` (status). No free-form colour props.
- `className` is accepted for layout (margin, width, grid placement) only; a source-scan test flags colour, padding or radius overrides on design-system components in `packages/app`.
- React 19 `ref` as a prop; `data-slot` on parts so parents can target them without new props.
- Interactive components require an accessible name at the type level: an icon-only `Button` must receive `aria-label` (a TypeScript union, not a lint rule).
- Controlled and uncontrolled forms where both make sense (`value`/`defaultValue`, `open`/`defaultOpen`).
- Radix primitives for anything with focus management (dialog, menu, popover, tooltip, tabs where needed). New Radix packages are a dependency decision (D-V2A-12).
- No data fetching, no app imports (enforced by `pnpm boundaries`, unchanged).

### 9.2 Contracts

| Component | Contract | Replaces |
|---|---|---|
| `Button`, `IconButton`, `LinkButton` | Variants `primary`, `secondary`, `ghost`, `danger`; sizes from control tokens; `loading` keeps the label; icon-only requires `aria-label` and gets a `Tooltip`. One primary per view. | `actionClass`, `secondaryClass` (about 180 references), `outline`/`destructive` variants merge into `secondary`/`danger` |
| `Input`, `Textarea`, `Select`, `Checkbox`, `RadioGroup`, `Switch` (only for instant settings) | Control-height tokens, `--border-input`, one focus recipe, `aria-invalid` styling | `inputClass`, Gen 1 `<input>`/`<select>` |
| `Field`, `FormSection`, `FormActions` | `Field` unchanged. `FormActions` is a sticky footer on long forms with primary and cancel, visible at 900 × 600 | ad hoc button rows (F-21) |
| `Combobox` | Searchable picker (customers, managers, catalog items) with async options supplied by the caller | `customer-picker.tsx`, `manager-picker.tsx`, `catalog-picker.tsx`, `resource-picker.tsx` |
| `DateField` | Wraps the native date input for now; shows the business-locale format as a hint; D-V2A-9 decides on a custom field | native inputs (F-20) |
| `SegmentedControl` | `role="radiogroup"` (or `aria-pressed` group for toggles), selected state with border + weight + forced-colours rule | three local implementations (Customers, Sales, Projects) |
| `Menu` / `DropdownMenu` | Promote `shell/menu.tsx` (already WAI-ARIA) into `packages/ui` | — |
| `Dialog`, `ConfirmDialog`, `Sheet` | One modal implementation (Radix). `ConfirmDialog` for archive, void, discard, delete: title, consequence sentence, safe action focused first, destructive action uses `danger`. `Sheet` for side panels and the mobile drawer | `useDialog` overlays, inline `alertdialog` panels, the duplicated discard dialog, custom task dialog (F-04) |
| `Tabs` / `SectionNav` | One component for the shell section bar, `ZonePage` tabs and record tabs; overflow into "More" | `SecondaryNav`, `ZonePage` tabs (F-07) |
| `DataTable` | Column definitions with `align` (numbers right, tabular), `priority` (which columns move under the primary cell at medium and become a record list at narrow, generalising the Customers pattern), `width` from a small set (`auto`, `xs`…`xl`), `aria-sort` on sortable headers, optional row navigation, row actions in an overflow menu, density from row tokens, sticky header, caption | hand-written tables in Customers, Sales, Projects; percentage widths (F-09, F-16) |
| `FilterBar` | Search field (with `/`), up to three visible quick filters, the rest behind "Filters"; active filters as removable chips; "Clear"; result count. Reflows to two rows at most at 900 px and collapses to search + "Filters" at narrow | four filter patterns (F-08) |
| `Toolbar` | Groups related actions with roving focus where it is a real toolbar | — |
| `Pagination` | Cursor pages with "Previous"/"Next" and a polite status; same in every Zone | three local versions |
| `Skeleton`, `Spinner` | One each; skeleton shapes for table rows, cards and detail panels | `zones/problem.tsx` `Skeleton` (F-05) |
| `Toast` | Polite region for non-blocking confirmations ("Changes saved."); never for errors that need action; pauses on hover and focus; 6 s default | inline `role="status"` notices |
| `Badge` / `StatusBadge` | `StatusBadge` takes a domain status and a per-Zone map to `tone` + label; dot + text + border; never colour alone | local badges (F-06), unused `StatusIndicator` |
| `EmptyState`, `ErrorState` | `ErrorState` takes the outcome kind and the "what"; the copy table stays in `packages/app` (it is product language) and the layout moves to `packages/ui` | `Problem` styling, local empty states |
| `PageHeader` / `ZonePage` | Unchanged contract, new type scale, overflow menu for actions beyond three | — |
| `DescriptionList` | Label/value pairs with one width token | 7 grid templates (F-16) |
| `Panel` (`Card`) | Border, `--radius-panel`, optional header with title and actions; no shadow | `Card` with `shadow-card`, mixed `xl`/`2xl` |
| `Avatar`, `Kbd`, `Tooltip` | Initials avatar; key caps from the platform; Radix tooltip on focus and hover | `title` attributes (F-14) |
| Patterns | `EntityList` (PageHeader + FilterBar + DataTable + Pagination + empty/error), `EntityDetail` (header, tabs, main column, side column), `EntityForm` (sections + FormActions + unsaved-changes wiring) | the never-built §6.5 patterns (F-22) |

## 10. Reference screens

Directions for review, not final designs. Rendered from `docs/ui/v2-a/reference/reference.html` with the V2 tokens of §7; sample data; every image is labelled "Concept". They show layout, density, hierarchy and theme, and they contain no controls that pretend to do something the product cannot do.

| Screen | Desktop light | Desktop dark | Phone light | Phone dark |
|---|---|---|---|---|
| Home | `v2-a/reference/v2-desktop-light-home.png` | `v2-a/reference/v2-desktop-dark-home.png` | `v2-a/reference/v2-mobile-light-home.png` | `v2-a/reference/v2-mobile-dark-home.png` |
| Customers list | `v2-a/reference/v2-desktop-light-customers.png` | `v2-a/reference/v2-desktop-dark-customers.png` | `v2-a/reference/v2-mobile-light-customers.png` | `v2-a/reference/v2-mobile-dark-customers.png` |
| Customer detail | `v2-a/reference/v2-desktop-light-customer.png` | `v2-a/reference/v2-desktop-dark-customer.png` | — | — |
| Finance invoices | `v2-a/reference/v2-desktop-light-invoices.png` | `v2-a/reference/v2-desktop-dark-invoices.png` | `v2-a/reference/v2-mobile-light-invoices.png` | `v2-a/reference/v2-mobile-dark-invoices.png` |
| Finance invoice form | `v2-a/reference/v2-desktop-light-invoice-form.png` | `v2-a/reference/v2-desktop-dark-invoice-form.png` | — | — |
| Data-dense dashboard (Reporting) | `v2-a/reference/v2-desktop-light-dashboard.png` | `v2-a/reference/v2-desktop-dark-dashboard.png` | `v2-a/reference/v2-mobile-light-dashboard.png` | `v2-a/reference/v2-mobile-dark-dashboard.png` |

What each one demonstrates, compared with today:

- **Home:** a compact hero (the one place for atmosphere), four figures, compact Zone tiles with a real count each, and a "Needs attention" list. Every figure and row comes from list or summary endpoints that already exist (Finance documents with status and overdue filters, Sales list, Customers and Projects summaries). **Not verified yet:** whether each figure can be produced in one request without new endpoints; V2-D confirms or drops each card. Tasks and opportunities in "Needs attention" need a cross-Zone summary endpoint and are not shown. Compare `v2-a/current/desktop-light-01-home.png`.
- **Customers list:** 40 px rows (roughly 15 rows fit at 1440 × 900 against 9 today, estimated from row heights), sentence-case headers, filter bar on one line, status shown only when it is not the default. The "Open invoices" column is a direction only: it appears only if an existing endpoint provides the figure per row; otherwise it is left out.
- **Customer detail:** full breadcrumb, record tabs (Overview, Activity, Finance, Projects; each maps to a panel that exists today), a description list, a side column with balance, contacts and projects, one primary action.
- **Invoices:** totals strip from the existing overview figures, `FilterBar` with chips (rows are visible above the fold at 900 × 600 and on a phone), monospaced document numbers, right-aligned tabular amounts, row overflow menu.
- **Invoice form:** two columns, with the summary panel on the right that states totals come from the server (no client arithmetic, preserving ADR 0007 and the Finance rules), sticky actions.
- **Dashboard:** eight KPIs in two rows of four instead of six cards filling the viewport, a chart with an honest legend, and a compact list beside it. Same metrics and the same API as today.

## 11. Adoption plan V2-B to V2-E

Each phase is its own numbered PR (or small PR series) in its own thread, as a draft for audit, with no API, permission, schema or financial-rule changes. Each PR is revertable on its own; no data migrations are involved, so rollback is `git revert` plus a redeploy.

| Phase | Scope | Exit criteria | Rollback |
|---|---|---|---|
| **V2-B Foundations** (`packages/ui` only, plus the two `index.html` splash files) | V2 tokens with compatibility aliases; bundled font; type scale; control, row, radius, motion tokens; state recipes and forced-colours rules; new components: `IconButton`, `Tooltip`, `SegmentedControl`, `Menu` (promoted), `ConfirmDialog`, `Sheet`, `Tabs`, `DataTable`, `FilterBar`, `Pagination`, `Combobox`, `DateField` wrapper, `Toast`, `StatusBadge`, `ErrorState`, `DescriptionList`, `FormActions`, `Avatar`, `Kbd`; patterns `EntityList`, `EntityDetail`, `EntityForm`; showcase pages for each; splash uses tokens and the stored theme. Visual-regression harness lands here (§12). | All existing app tests pass unchanged (aliases); token, contrast and forced-colours tests for every new token; interaction tests for every new component; showcase screenshots in both themes reviewed | Revert the PR; aliases mean nothing in `packages/app` depends on the new names yet |
| **V2-C Shell** (`packages/app/src/shell`) | Sidebar-only children on wide; section bar with overflow at medium; single app bar and section select on narrow; command palette; keyboard map and help; record breadcrumbs; current-Zone click returns to root (F-02); top bar cleanup; Scheduling entry if D-V2A-8 approves | Shell tests updated for the new structure (same behaviours: guard, switching, permissions, drawer); new tests for palette permissions (never lists a Zone the person cannot open) and shortcuts; baselines for every width | Revert; Zones are untouched in this phase |
| **V2-D Zones**, one PR per Zone, in this order: Customers, Sales, Projects (Gen 1, highest value), then Finance, People, Reporting, Scheduling (already Gen 2; mostly table, filter and status alignment) | Move each Zone onto the patterns; delete local class strings, badges, dialogs and tables as each Zone moves; Home direction | Zone tests pass with the same roles and names (tests query by role, so most survive); no new arbitrary values; that Zone's baselines approved; the source-scan allowlist shrinks | Revert that Zone's PR only |
| **V2-E Polish** | Remove compatibility aliases and `actionClass`/`secondaryClass`/`inputClass`; motion pass; empty-state and error copy pass; density option if D-V2A-3 asks for one; final accessibility audit with a screen reader on macOS and Windows | Zero allowlisted violations; the source-scan test switches from "no new" to "none" | Revert; aliases can be restored from V2-B |

Order constraints: V2-B before everything. V2-C and the first V2-D PR can overlap once V2-B is merged. Each V2-D PR must leave the app consistent (no half-migrated screens in a Zone).

## 12. Accessibility, performance and regression test plan

### 12.1 Accessibility (target WCAG 2.2 AA)

- **Automated in jsdom** (existing Vitest): add `axe-core` checks to the component tests and to one test per Zone screen (D-V2A-12). Contrast stays in `tokens.test.ts` (axe cannot compute contrast in jsdom).
- **Automated in a real browser** (the V2-B harness): axe on every captured screen in both themes; keyboard walk-through for the shell (Tab order, skip link, palette, Esc); `forced-colors: active` and `prefers-reduced-motion` and `prefers-reduced-transparency` emulation screenshots; target size check (≥ 24 × 24 px, 44 on coarse pointers); focus not obscured by sticky headers or footers (2.4.11).
- **Manual, per phase:** VoiceOver on macOS (Safari and the Tauri app), NVDA on Windows (WebView2 app and Edge), Windows High Contrast, 200 % and 400 % zoom (reflow at 320 CSS px), keyboard-only completion of the core tasks: add a customer, create and issue an invoice, record a payment, move a task, open a report.

### 12.2 Performance

- Budgets for the web build, checked in CI: CSS ≤ 60 kB gzip, font ≤ 110 kB total WOFF2 (Latin subset), no new runtime dependency over 15 kB gzip without review. Current sizes to be measured at the start of V2-B (not measured here).
- `font-display: swap` with metric-matched fallback (`size-adjust`) so text does not jump.
- Tables over 200 rows use pagination as today; virtualisation only if a Zone needs it, not by default.
- Glass and blur stay off large or scrolling surfaces (WKWebView repaints backdrop filters on scroll).
- Interaction latency checked in the Tauri app on a low-end Windows machine before V2-D ships Finance.

### 12.3 Visual regression

- Promote the harness used for this audit (`docs/ui/v2-a/harness/`) to a real dev-only package in V2-B: the shared `App` rendered against the existing test fakes, so no server or database is needed and data is deterministic.
- Matrix: light and dark × 1440, 900 × 600, 834 and 390, for each reference screen and each Zone's main screens, plus the component showcase. Fonts are bundled (D-V2A-1), so Linux CI baselines are stable.
- Playwright `toHaveScreenshot` with a small pixel threshold; baselines committed next to the harness; updates only in PRs that say why.
- CI: a separate job, **non-gating** for the first two weeks (D-V2A-11), then added to the `CI gate` once flake-free. The desktop matrix is not needed for it (it is a web build).

### 12.4 Existing tests and migration risk

- Most Zone tests query by role and accessible name, so they survive restyling. Tests that query by text which V2 changes (for example the "Open" badge on Home, the section tabs that move into the sidebar, `alertdialog` roles that become `dialog` with `ConfirmDialog`) are listed per PR and changed in the same PR with a reason.
- `shell.test.tsx` asserts the section navigation and drawer behaviour; V2-C rewrites those assertions for the new structure without dropping any behaviour (guard, permissions, switching, focus).

## 13. Risks, open questions and the approval gate

### 13.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Restyling Gen 1 Zones changes behaviour by accident (unsaved-changes guard, focus moves) | Medium | High | One Zone per PR; existing tests unchanged first; guard tests run on every PR |
| Dark ink palette weakens chart or status contrast | Low | Medium | Token test covers every pair before V2-B merges |
| Old WKWebView renders glass or `color-mix` incorrectly (F-24) | Unknown (not verified) | Medium | D-V2A-10 support floor; move the glass fallback into an `@supports (color: color-mix(in oklab, red, red))` block in V2-B |
| Font licence or size | Low | Low | OFL fonts only; size budget |
| Scope creep into backend (search, notifications, activity feed, Home figures) | Medium | Medium | Marked future and out of V2; Home cards dropped if they need a new endpoint |
| Desktop native features (menus, title bar) pull in Tauri capabilities | Low | High (security) | Out of scope; needs its own ADR 0005 review |
| Visual-regression flakiness blocks merges | Medium | Low | Non-gating first (D-V2A-11) |

### 13.2 Decisions for the owner

Recommended defaults are in **bold**; V2-B starts from them unless Regan decides otherwise.

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| D-V2A-1 | Typeface | **Inter (bundled) + JetBrains Mono for codes** · Inter only · Geist · licensed Pixakova face | Inter + JetBrains Mono |
| D-V2A-2 | Dark theme surfaces | **Neutral ink with indigo accent** · keep saturated navy | Ink |
| D-V2A-3 | Default density | **40 px rows, 32 px controls on desktop, 44 px targets on touch** · keep today's · add a per-person density setting now | 40 px default; setting later if asked |
| D-V2A-4 | Sidebar material | **Subtle glass over the calm atmosphere** · opaque | Subtle glass |
| D-V2A-5 | Zone sub-navigation | **Sidebar on wide, section bar at medium, section select on phones (no duplicates)** · keep both | No duplicates |
| D-V2A-6 | Top-bar placeholders | **Replace "Search · Soon" with the client-side command palette; remove the bell until notifications exist** · keep both placeholders | Palette, no bell |
| D-V2A-7 | Zone accent colours (architecture §6.5) | **Supersede: one accent; Zones by icon and name** · build per-Zone accents | Supersede |
| D-V2A-8 | Scheduling in navigation (F-01) | Add the registry entry in V2-C · keep hidden until a separate Scheduling release | Product call (pilot needs it; not a design decision) |
| D-V2A-9 | Date entry | **Keep native date inputs with a locale hint in V2-B; decide on a custom field after pilot feedback** · build a custom date field now | Native first |
| D-V2A-10 | Support floor | **macOS 13+ (WKWebView ≥ Safari 16.4), Windows 10/11 with evergreen WebView2, current Chrome, Edge, Firefox and Safari 16.4+** · other | As stated; record in ADR 0005 and `tauri.conf.json` (`minimumSystemVersion`) |
| D-V2A-11 | Visual regression in CI | **Non-gating for two weeks, then part of `CI gate`** · gating at once · local only | Non-gating first |
| D-V2A-12 | New dev and runtime dependencies | **Radix (dropdown, popover, tooltip, tabs), `axe-core` (dev), `@fontsource-variable/inter`** · build in-house | Approve the list in V2-B's PR |
| D-V2A-13 | Toasts | **Add for non-blocking confirmations only** · keep inline notices | Add |

### 13.3 Approval gate before V2-B

V2-B starts only when all of these are true:

1. Regan has reviewed this document and the reference screens, and recorded a choice (or accepted the default) for D-V2A-1 to D-V2A-7, D-V2A-9, D-V2A-10, D-V2A-12 and D-V2A-13. D-V2A-8 and D-V2A-11 can follow later.
2. The independent architecture review (ChatGPT audit) of this draft PR has been addressed in the PR.
3. This PR is merged by Regan (documentation only; no deploy, no migration).
4. A new thread and numbered PR is opened for V2-B.

## 14. Existing decisions: preserved or superseded

| Decision | Source | V2 position |
|---|---|---|
| One design system for desktop and web in `packages/ui`, tokens as CSS variables, light and dark from the start | architecture §6.5, ADR 0005 | **Preserved** |
| shadcn-style components owned by the project | architecture §6.5, `packages/ui/README.md` | **Preserved** |
| Standard-screen patterns in `packages/ui/src/patterns` | architecture §6.5 | **Preserved and finally implemented** (V2-B) |
| Zone accent colours | architecture §6.5 | **Superseded if D-V2A-7 is accepted** |
| Keyboard shortcuts, window sizing and menus in the shared app; platform differences only where the OS expects them | architecture §6.5 | **Preserved**; native menus excluded (ADR 0005 rule 4) |
| WCAG 2.2 AA | architecture §6.5 | **Preserved**, with more automation |
| Three token layers; palette not mapped to utilities | UI Phase 1, `packages/ui/README.md` | **Preserved**, component layer formalised |
| Dark identity, glass used selectively, opaque dense content, `calm` atmosphere on dense screens | UI Phase 1 design amendment | **Preserved**; dark surfaces change value, not role (D-V2A-2) |
| Theme from OS by default, `.dark`/`.light` override, stored per device | `docs/ui/app-shell.md` | **Preserved** |
| No URL routing yet; no search, notifications or activity feed until backends exist; no fake features | `docs/ui/app-shell.md` | **Preserved**; the command palette is real and client-only |
| Zone registry and permission filtering; Zones never shown disabled | `docs/ui/app-shell.md` | **Preserved** |
| Responsive breakpoints 640 / 1024 | `docs/ui/app-shell.md`, `zones/use-layout.ts` | **Preserved**; behaviour inside each band changes (§8.1) |
| Tauri least privilege, no plugins, strict CSP | ADR 0005 | **Preserved**; bundled font needs no CSP change |
| Server-calculated money, exact decimal strings | ADR 0007, Finance docs | **Preserved**; no client arithmetic in any V2 component |
| Client never enforces permissions, only hides | ADR 0005 | **Preserved**; the palette uses the same permission filter as the sidebar |
