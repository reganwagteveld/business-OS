# Reporting R2 screenshots

Local data only: the R1 throwaway business ("Harbour Design Studio", Perth) seeded through the real API on the local
docker PostgreSQL, a production API build (`next start`) and a production web build, captured with Playwright
(Chromium) at device scale 2. No production data. Script: `shots.mjs.txt` (adapted from R1's).

- `desktop-{light,dark}-01-dashboard`: 1440 px Dashboard (last 3 months, automatic weekly interval, previous period).
- `desktop-light-02-drilldown-explore`: "Explore Won opportunity value" from the dashboard: same range, interval, comparison.
- `desktop-light-03-period-records`: Explore by month, "Records" for Oct 2026: records for 1–31 Oct only.
- `desktop-light-04-saved-reports`: Private / Shared by you / Shared with you (an ADMIN colleague's report; the owner
  holds reporting:manage, so Delete but no Rename on it).
- `desktop-light-05-delete-shared-confirm`, `desktop-light-06-custom-range-invalid`.
- `desktop-light-07-member-no-finance`, `desktop-light-08-member-saved-reports`: a MEMBER (no finance:read) sees no
  Finance KPI, section or planned Finance metric; on Saved reports, no actions on others' reports.
- `mobile-{light,dark}-01-dashboard`: 390 px.

Run report: console errors 0 everywhere; horizontal overflow 0 px (desktop and mobile, both themes); no Finance
figures on the MEMBER's pages.
