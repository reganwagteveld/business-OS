# UI V2-B1: tokens and type

**Status:** PR #91, ChatGPT audit PASS, owner decisions recorded (§9). **Spec:** [`pixa-design-system-v2-a.md`](pixa-design-system-v2-a.md) §6.2, §7, §11 (V2-B1), §12, §13.2.
**Authorisation:** Regan approved V2-B foundation work on 2026-11-16, following the approved V2-A design. This PR is the first of the V2-B series (B1 to B5); B2 to B5 each get their own thread and draft PR.

Nothing here touches the API, permissions, schema, money or Zone code. No migration, no deploy.

## 1. What this PR delivers

| Spec item (§11, V2-B1) | Where | Notes |
|---|---|---|
| V2 semantic tokens, light and dark | `packages/ui/src/styles.css` §4 | Every token in §7.2, plus `--shadow-raised` and `--shadow-overlay` (§7.3) |
| Compatibility aliases | `styles.css` §5 | Every V1 name (`--background`, `--primary`, `--destructive`, …) points at its V2 token. Every V1 Tailwind colour still exists. Removed in V2-E |
| Bundled Inter and type scale | `packages/ui/src/fonts/`, `styles.css` §1 and §3 | Utilities `text-caption`, `text-small`, `text-body`, `text-lead`, `text-section`, `text-title`, `text-display`. Tailwind's own `text-sm`, `text-lg` … are unchanged |
| Control, row, radius, layout, motion tokens | `styles.css` §3 | Utilities `h-control-{sm,md,lg}`, `h-row-{compact,default,comfortable}`, `min-target`, `rounded-{control,panel,dialog,pill}`, `duration-{fast,base,slow}`, `ease-{standard,emphasised}`, `shadow-{raised,overlay}` |
| State recipes (§7.4) with forced-colours rules | `styles.css` §6 | `focus-ring`, `focus-ring-inset`, `state-interactive` (hover, pressed), `state-selected`, `state-disabled`; global `:focus-visible` → `Highlight` in forced colours |
| Glass `@supports` fallback (F-24) | `styles.css` §7 | Translucency only inside `@supports (color: color-mix(in oklab, red, red))`; otherwise opaque |
| Token and contrast tests | `packages/ui/tests/tokens.test.ts` | See §4 |
| Splash files use tokens and the stored theme | `apps/{web,desktop}/index.html`, `apps/{web,desktop}/public/theme-boot.js`, `packages/ui/tests/splash.test.ts` | See §3 |
| Showcase | `packages/ui/showcase/main.tsx` | New "Foundations (V2)" section; colour swatches now show V2 tokens |

Not in this PR (by the §11 split): visual-regression harness and goldens (B2), any new component (B3 to B5), `axe-core` (arrives with the first component PR that uses it), the source-scan test for arbitrary values in `packages/app` (§7.1 rule 3; it belongs with the first PR that changes `packages/app`).

## 2. What changes on screen

Because the V1 names are now aliases, every screen picks up the V2 values without any code change:

- **Dark theme:** surfaces move from saturated navy to neutral ink (D-V2A-2). The accent, focus ring and atmosphere keep the identity.
- **Light theme:** the canvas moves from lavender mist to an indigo-tinted neutral; borders and fills are neutral.
- **Font:** Inter on every platform (today: SF Pro on macOS, Segoe UI on Windows, finding F-11).
- **Not changed:** layout, spacing, text sizes, radius of existing components, behaviour. Existing components keep their classes; they adopt the new scale tokens only when they are rebuilt in B3 to B5 and moved in V2-D.

Screenshots of the app in both themes are attached to the PR.

## 3. Splash and stored theme

The splash paints before any CSS or JavaScript bundle loads. It now uses the V2 canvas, text and muted colours, and a tiny classic script (`/theme-boot.js`, served from `'self'`) applies the theme saved on this device (`bos.theme`, the same key and classes as `packages/app/src/shell/preferences.ts`) before first paint. So a person who chose Dark on a light OS no longer sees a light splash first.

- **CSP:** unchanged. The script is a file from `'self'`, not inline; `style-src 'unsafe-inline'` already covers the splash styles. No new Tauri capability or plugin.
- **Scope note:** §11 names "the two `index.html` splash files". Reading the stored theme needs a script, and the CSP forbids inline scripts, so the two small `public/theme-boot.js` files are added as well. `splash.test.ts` keeps both apps identical and in step with the tokens and the preference key.

## 4. Tests

`tokens.test.ts` (rewritten; 200+ cases):

- the OS-preference and `.dark` blocks stay identical; every themed token exists in both themes (token manifest); every §7.2 token is declared; scale tokens have the §6.2/§7.3 values and are not themed;
- every V1 Tailwind colour is still mapped and resolves in both themes; every V2 utility resolves; no palette token is reachable from components;
- contrast in both themes: text pairs ≥ 4.5:1 (default, muted and subtle text on every surface, accent text, text on the accent and its hover, each status on canvas, surface and its own subtle fill, text on each solid fill, fields, glass fallback); non-text ≥ 3:1 (focus ring on canvas, surface and raised; input border on field, surface and canvas; every chart series on a surface); disabled text ≥ 3:1 (not required by WCAG, but V2 stops relying on `opacity-50`); and every V1 pair again through the aliases;
- recipes: focus rings switch to `Highlight`, selection uses `Highlight`/`HighlightText` plus a `CanvasText` outline, disabled uses `GrayText`, motion durations go to 0 ms under reduced motion, coarse pointers get 40 px controls and 44 px targets, glass is opaque unless `color-mix` is supported and the opaque fallbacks come after it;
- font: both WOFF2 files exist and are referenced, the licence is present, the Latin file is within budget, `font-display: swap`, metric-matched fallback.

Existing app tests pass unchanged (aliases).

## 5. Deviations from the spec values

§7.2 says its values are provisional and that V2-B makes them final through the token test. Four changes came out of that:

| Token | Spec | This PR | Why |
|---|---|---|---|
| Solid accent | `--accent` | `--accent-solid` (Tailwind `bg-accent-solid`) | `--accent` / `bg-accent` is a V1 name meaning the selection tint, used 15+ times. Reusing the name would silently turn every selected row solid indigo. The V1 meaning is kept until V2-E |
| Dark `--accent-hover` | `#5d70e0` | `#4357c7` | White text on `#5d70e0` is 4.32:1 (fails 4.5:1). The hover is now slightly deeper than the base, as in V1 |
| Light `--border-input` | `#8e90ad` | `#878aa8` | `#8e90ad` is 3.1:1 on white but 2.91:1 on the new canvas, where inputs also sit |
| Spec tokens with no V2 name yet | — | `--muted`, `--secondary` (+ hover, foreground), `--field` kept as themed tokens with neutral and ink values | They have many consumers (`bg-muted` 74 uses) and no V2 replacement in §7.2; they go when their consumers move (V2-D/E) |

Tailwind names for V2 tokens: `bg-canvas`, `bg-surface`, `bg-sunken`, `bg-raised`, `bg-hover`, `bg-selected`, `text-fg`, `text-fg-muted`, `text-fg-subtle`, `text-fg-accent`, `text-fg-on-accent`, `border-line`, `border-line-strong`, `border-line-input`, `bg-accent-solid`, `bg-accent-solid-hover`, `bg-accent-subtle`, `outline-focus-ring`, `{text,bg,border}-status-{success,warning,danger,info}-{fg,bg,border,solid,on-solid}`, `text-disabled-fg`, `bg-disabled-bg`.

## 6. Dependency review: Inter (D-V2A-12)

| Question | Answer |
|---|---|
| What | Inter 4 variable font, weight axis 100–900, upright only. Two WOFF2 subsets: Latin and Latin Extended |
| Source | `@fontsource-variable/inter@5.3.0` from the npm registry (integrity `sha512-OupL48va…oUA==`), files copied unchanged |
| How it is added | **Vendored**, not an npm dependency: two binary files and the licence in `packages/ui/src/fonts/`. No install script, no code, nothing to update automatically. Updating means replacing the files in a reviewed PR |
| SHA-256 | Latin `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62`; Latin Extended `34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956` |
| Licence | SIL Open Font License 1.1 (`OFL-Inter.txt`, shipped next to the files). Allows bundling and redistribution in commercial software; the font may not be sold on its own |
| Size | Latin 48,256 bytes (47 kB); Latin Extended 85,068 bytes (83 kB), downloaded only when a page contains one of its characters (`unicode-range`) |
| Security | A static font file. Browsers and WebViews sanitise web fonts before use (OTS in Chromium/WebView2; WebKit's own parser). Served from `'self'`; the CSP `font-src 'self'` is unchanged |
| Accessibility | Legible at 12–14 px, tabular figures for amounts, `font-display: swap` so text is never invisible, metric-matched fallback (`size-adjust` on Arial/Helvetica) so the swap does not shift layout |
| Maintenance | Inter is actively maintained by its author; this copy is pinned and does not change unless a PR changes it |

**Budget (§12.2).** CSS: 59 kB raw, 11.6 kB gzip for the whole web build (budget 60 kB gzip). The token sheet alone grows from 3.3 to 6.9 kB gzip. Font: the Latin file is 47 kB (budget "≤ 110 kB total WOFF2, Latin subset"). Latin Extended adds 83 kB on top, so all font files together are 130 kB, accepted as an explicit exception (D-V2B1-2).

## 7. Monospace (JetBrains Mono decision, carried from D-V2A-1)

Decision D-V2B1-1 (accepted): **no JetBrains Mono now.** Inter's tabular figures already align amounts, and document numbers read well in Inter. `--font-mono` is a system monospace stack (`ui-monospace`, SF Mono, Cascadia Mono, Menlo, Consolas) for the rare code-like value. Adding JetBrains Mono later would cost roughly another 40–90 kB per subset (not measured) and a separate dependency review.

## 8. Compatibility matrix (D-V2A-10)

The support floor is **not** set in this PR. `minimumSystemVersion` and the ADR 0005 amendment wait until the matrix below is checked on real machines, as D-V2A-10 requires. On macOS the app uses the **system WKWebView**, so what matters is the WebKit version the OS actually has, not which Safari is installed (Safari updates on older macOS may or may not update the system WebKit; that is exactly what the real-machine check must establish).

Features V2-B1 relies on, with the first engine version that has them (from public compatibility data as remembered, approximate and **not verified**; the real-machine check is what counts):

| Feature | Used for | WebKit / Safari | Chromium (WebView2, Chrome, Edge) | Firefox | If missing |
|---|---|---|---|---|---|
| `color-mix()` | Glass translucency | 16.2 | 111 | 113 | Glass is opaque (`@supports`) |
| `@layer` | Tailwind 4 | 15.4 | 99 | 97 | **Breaks styling**: hard requirement |
| `@property` | Tailwind 4 utilities (gradients, transforms, rings) | 16.4 | 85 | 128 | Some utilities lose defaults: hard requirement |
| `:has()` | Not used by B1; may be used by later components | 15.4 | 105 | 121 | Later components must not depend on it without a check |
| `backdrop-filter` | Glass blur | 9 prefixed, 18 unprefixed | 76 | 103 | Opaque (`@supports not`) |
| `font-weight` range + variable WOFF2 | Inter | 11 | 62 | 62 | System font |
| `size-adjust`, `ascent-override`, `descent-override` | Fallback metrics | `size-adjust` 17; overrides to be verified | 92 | 89 | Small text shift when Inter swaps in |
| `forced-colors` media query | Recipes | macOS has no forced-colours mode | 89 | 89 | Only relevant on Windows |
| `prefers-reduced-transparency` | Glass | not supported (to verify) | recent versions (to verify) | behind a flag | Ignored; blur stays |

Rows to fill in on real machines (OS version → WebView engine and version → result):

| Machine | OS version | WebView engine and version (how to read it: §8.1) | `@layer`, `@property`, `color-mix` | Inter renders | Verified by, date |
|---|---|---|---|---|---|
| Mac, oldest available | _to fill_ | _to fill_ | _to fill_ | _to fill_ | _to fill_ |
| Mac, current | _to fill_ | _to fill_ | _to fill_ | _to fill_ | _to fill_ |
| Windows 10 | _to fill_ | WebView2 evergreen _version_ | _to fill_ | _to fill_ | _to fill_ |
| Windows 11 | _to fill_ | WebView2 evergreen _version_ | _to fill_ | _to fill_ | _to fill_ |

### 8.1 How to check a machine

In the desktop app's Web Inspector console (or a browser's console), run:

```js
({
  ua: navigator.userAgent,
  layer: 'CSSLayerBlockRule' in window,
  property: 'CSSPropertyRule' in window,
  colorMix: CSS.supports('color', 'color-mix(in oklab, red, red)'),
  backdrop: CSS.supports('backdrop-filter', 'blur(1px)') || CSS.supports('-webkit-backdrop-filter', 'blur(1px)'),
  has: CSS.supports('selector(:has(a))'),
  inter: document.fonts.check('14px "Inter Variable"'),
})
```

The WebKit version is in the user agent (`AppleWebKit/…`); on macOS the OS version is in "About This Mac". Paste the result into the table in the PR that sets the floor.

## 9. Owner decisions (recorded 2026-11-16, PR #91)

Regan accepted all four on 2026-11-16, after the ChatGPT audit of `1bf6f3b` (PASS) recommended the same. None of them authorises anything beyond V2-B1.

| ID | Decision | Outcome |
|---|---|---|
| D-V2B1-1 | Monospace face for document numbers and codes | **Accepted:** no JetBrains Mono for now. Inter tabular figures plus the system monospace stack in `--font-mono` (§7). Adding a monospace face later is a new decision with its own dependency review |
| D-V2B1-2 | Font budget | **Accepted as an explicit exception** to the §12.2 headline budget: the 47 kB Latin file every screen downloads is within the 110 kB budget; the 83 kB Latin Extended file is bundled too and downloads only when a page uses one of its characters (`unicode-range`). Total physical font payload about 130 kB |
| D-V2B1-3 | Token deviations in §5 | **Accepted:** `--accent-solid` naming, dark accent hover `#4357c7`, light input border `#878aa8`, and the temporary V1-only neutral roles (`--muted`, `--secondary`, `--field`). V1 aliases stay until V2-E |
| D-V2B1-4 | Real-machine compatibility check (§8) | **Accepted:** a hard gate before the minimum OS support floor (`minimumSystemVersion`, ADR 0005 amendment) is set; **not** a gate for merging V2-B1 |

Follow-ups from the audit (non-blocking for B1): during V2-B2 visual QA, check the actual font requests and that a stored theme opens without a flash on a real desktop build. Unit checks of HTML and CSS cannot prove either.
