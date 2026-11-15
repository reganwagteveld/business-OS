# Reporting R1 screenshots

Local data only: a throwaway business ("Harbour Design Studio", Perth) seeded through the real API on a local docker
PostgreSQL (`bos_r1_shots`), served by a production API build (`next start`) and a production web build, captured with
Playwright (Chrome) at device scale 2. No production data.

- `desktop-light-01-reporting`, `desktop-dark-01-reporting`: 1440 px, the landing page (KPIs, bar chart with previous
  period, period table, records).
- `desktop-light-02-weekly-line-received`: weekly line chart of amount received.
- `desktop-light-03-save-report` → `04-saved-report` → `05-saved-report-reopened`: save, then close and reopen; same figures.
- `desktop-light-06-member-no-finance`: a MEMBER (no `finance:read`) sees only Sales and Customers figures.
- `mobile-{light,dark}-01-reporting`: 390 px. No horizontal overflow (measured 0 px).

Seed check: Sept invoiced $6,545.00 = (3,800 + 1,200 + 950) × 1.1 GST; outstanding $11,200.00 = $27,280.00 issued − $16,080.00
received; the USD invoice is reported separately.

`shots.mjs.txt` is the seed-and-capture script (local only; it signs up local test users, marks them verified and adds
the MEMBER directly in the throwaway database).
