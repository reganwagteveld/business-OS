# UI V2-A evidence

Supporting files for [`../pixa-design-system-v2-a.md`](../pixa-design-system-v2-a.md). Documentation only: nothing here is built or shipped.

- `current/`: the app on main (`1b2bf15`), rendered by the real shared `App` with every API call answered in the browser by the in-memory test fakes (`packages/app/tests/support`). Sample data only, no server, no database, no production data. Chromium, device scale 2, colours reduced to a 256-colour palette to keep the repository small.
  - `desktop-{light,dark}-NN-*.png`: 1440 × 900.
  - `desktop-min-900-light-*.png`: 900 × 600, the Tauri minimum window.
  - `tablet-834-light-*.png`, `mobile-{light,dark}-*.png`: 834 and 390 px.
  - `desktop-light-17-focus-ring.png`: keyboard focus on the Add customer form.
- `reference/`: V2 direction concepts. `reference.html` is a static page (no app code) using the proposed V2 tokens; open it with `?screen=home|customers|customer|invoices|invoice-form|dashboard&theme=light|dark`. The PNGs are its renders at 1440 × 900 and 390 px.
- `harness/`: the capture sources, kept as `.txt` so no tool picks them up. To reproduce: copy `main.tsx`, `vite.config.ts`, `index.html`, `index.css`, `buffer-shim.ts` and `crypto-shim.ts` into `apps/web/v2a-harness/` (dropping `.txt`), run `apps/web/node_modules/.bin/vite --config v2a-harness/vite.config.ts` from `apps/web`, then `node shots.cjs <out-dir>` and `node reference-shots.cjs <out-dir> <path to reference.html>` with Playwright available. The Add customer form and focus-ring images were taken by opening the form from Home's "Add customer" shortcut (the sidebar route does not leave a record, finding F-02).

Fonts: the capture machine has Inter installed, so these images show Inter. On macOS the current app renders in SF Pro and on Windows in Segoe UI (finding F-11).
