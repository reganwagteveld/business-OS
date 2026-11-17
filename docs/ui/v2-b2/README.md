# UI V2-B2 evidence

Supporting files for [`../pixa-visual-identity-v2-b2.md`](../pixa-visual-identity-v2-b2.md). Documentation only: nothing here is built or shipped.

**None of these images are golden baselines.** They are colour-quantized to 256 colours to keep the repository small. Lossless goldens come from slice B2-1 (the visual-regression harness).

- `before/`: current `main` (`ccfcc93`, V2-B1 tokens), rendered by the real shared `App` against the in-memory test fakes with the V2-A harness (`../v2-a/harness/`, reproduction steps in `../v2-a/README.md`). Sample data only. 1440 × 900 and 900 × 600, device scale 2, Chromium.
- `reference/`: concepts, labelled "Concept · sample data · Direction A/B/C" in the image. `reference.html` is a static page with no app code and **no copied token values**: `render.cjs.txt` injects sections 1 to 4 of `packages/ui/src/styles.css` (bundled Inter, palette, scale and semantic tokens in both themes), so the renders use the real V2-B1 values. To reproduce: copy `render.cjs.txt` to `render.cjs` outside the repository and run `node render.cjs <repo root> <out dir>` with Playwright available. Query parameters: `screen=dashboard|projects|finance|dir-b|dir-c`, `theme=light|dark`, `w=compact` (900 px layout), `focus=1`.
- Sample data matches the harness business (Harbour Design Studio) so before and after compare the same records. Invoice lines in Direction B are illustrative only.
