# Finance F4 screenshots

Local data only: a throwaway business ("Harbour Design Studio") seeded through the real API on a local docker Postgres, captured from a production web build with Playwright at device scale 2. No production data; production has no businesses.

- `desktop-light-*`: 1440 px, every Finance section and the main confirmations.
- `desktop-dark-01-overview`: 1440 px, dark.
- `mobile-{light,dark}-*`: 390 px phone: overview, invoices, invoice detail.

`shots.mjs.txt` is the seed-and-capture script (local only; it signs up a local test user and marks it verified in the throwaway database).
