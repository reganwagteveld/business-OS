# Visual regression harness (UI V2-B2-1)

Dev-only. Nothing here is built, bundled or shipped. Spec: [`docs/ui/pixa-visual-identity-v2-b2.md`](../../docs/ui/pixa-visual-identity-v2-b2.md) §14 (slice B2-1) and §15.

The harness renders the **real shared `App`** (`@business-os/app`) in Chromium. Every API call is answered in the browser by the in-memory test fakes in `packages/app/tests/support`, with a fixed sample business ("Harbour Design Studio"). No server, no database, no production data, no network. It is promoted from the V2-A capture harness (`docs/ui/v2-a/harness`), with the fixture drift since then fixed (`platformAccess`, People references, the R2 dashboard client).

## What it is not

- **Not a substitute for real desktop checks.** These are Chromium-on-Linux renders. The macOS WKWebView and Windows WebView2 compatibility matrix and the real-device checks (D-V2A-10) stay separate and required.
- **Not gating.** The `Visual regression` workflow is separate from `CI`, is not part of `CI gate` and must not be made a required check until there is a reviewed baseline and a documented flake rate (D-V2A-11). Making it gating is its own decision for Regan.

## What it captures

48 lossless PNGs in `goldens/`, one per screen, theme and width:

| Group | Widths | Themes | Screens |
|---|---|---|---|
| `desktop-*` | 1440 × 900 | light, dark | Home, Customers list and detail, Sales board, Projects list and detail, Finance overview, Invoices, invoice detail, People |
| `min-900-*` | 900 × 600 (Tauri minimum window) | light, dark | Home, Customers, project detail, Invoices |
| `tablet-834-*` | 834 × 1112 | light | Home, Invoices |
| `mobile-*` | 390 × 844 (touch) | light, dark | Home, Customers, Invoices |
| `focus-*` | 1440 and 900 | light, dark | Skip link, sidebar Zone, form field, invoice row (keyboard focus) |
| `forced-colors-*` | 1440 | forced colours | Home, Invoices, focus on the sidebar |
| `reduced-motion-*` | 1440 and 390 | light | Account menu and navigation drawer open |

## How it stays deterministic

- **One renderer.** Goldens are made and compared only inside the pinned Playwright image (`mcr.microsoft.com/playwright:v1.63.0-noble`, pinned by digest in `scripts/docker.sh` and the workflow), so Chromium, system fonts and libraries are identical locally and in CI. A run on a bare host can differ by a few pixels; do not commit goldens made outside the image.
- **Bundled Inter.** The app's own `@font-face` (vendored in `packages/ui/src/fonts`); every capture waits for `document.fonts.ready`.
- **Fixed clock and place.** `Date.now()` is frozen at 17 Nov 2026 09:00 in Perth; locale `en-AU`, time zone `Australia/Perth`.
- **Fixed ids.** `randomUUID` is a seeded counter (`harness/crypto-shim.ts`), so id-ordered lists never reorder.
- **No motion.** `prefers-reduced-motion: reduce` for every capture, plus Playwright's animation freeze and hidden caret.
- **Guard.** Any request that leaves the harness server, or any uncaught page error, fails the capture, so a golden can never record an error state (`tests/harness.ts`).
- **No retries.** A capture that passes only on a retry is a flake; flakes are what the gating decision is measured on.
- Comparison is strict (`maxDiffPixels: 0`, Playwright's default per-pixel colour threshold).

Device scale is 1 to keep the goldens small (about 5.5 MB for the set; at scale 2 it was about 14 MB and every UI PR that moves pixels adds that much to history). Higher-resolution review images can be taken with the V2-A/B2 reference scripts.

## Running it

From the repository root, after `pnpm install`:

```sh
pnpm --filter @business-os/visual visual:docker            # compare with the goldens (Docker)
pnpm --filter @business-os/visual visual:docker:update     # regenerate after an intended UI change
pnpm --filter @business-os/visual dev                      # open the harness at http://127.0.0.1:5199
```

`visual` and `visual:update` run on the host without Docker; use them only for quick local checks. The report is written to `playwright-report/` and differing captures (expected, actual, diff) to `test-results/`; both are ignored by Git.

Without Docker: run the workflow manually (Actions → Visual regression → Run workflow, `update` ticked) and download the `visual-goldens` artifact.

## Changing the UI

A PR that changes pixels on purpose regenerates the goldens in the image, commits them, and lists the changed captures in its description. Review the diff images, not only the new PNGs. A PR that changes pixels by accident shows up as a warning on the `Visual regression` run with the diffs as an artifact.

## Flake log

Record every run that differed without a UI change (date, capture, cause). The suite may be proposed as gating only after a reviewed baseline and a documented flake rate.

| Date (UTC) | Runs | Differing without a UI change | Notes |
|---|---|---|---|
| 2026-11-17 | 15 local, in the pinned image (5 at scale 2, 10 at scale 1) | 0 of 720 captures | Baseline made on this branch; first CI runs still to add |
