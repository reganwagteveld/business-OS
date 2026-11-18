# Zones

Zones (Customer, Sales, Finance, Projects, Operations, People) are user-facing navigation and presentation areas in the shared client app, not data ownership boundaries. They render the same way in the desktop and browser apps.

Zones get their data only from the cloud API through the typed clients in `src/api` (contracts in `@business-os/contracts`). Domain logic, authorisation and tenant isolation live in the API's modules (`apps/api/src/modules`), never here.

## Built

- **Customers** (`customers/`): directory, create/edit form, customer workspace.
- **Sales** (`sales/`): opportunities list and board, opportunity workspace.
- **Projects** (`projects/`): project list, project workspace with tasks and board.
- **Finance** (`finance/`, F3): expenses (list with server-side search, filters and paging; draft form; detail with record, pay-in-full and void; no receipt attachments, FD-P6) and expense categories. The first Zone laid out with `ZonePage` and the `@business-os/ui` components. Quotes, invoices and payments screens come later.

- **Scheduling** (`scheduling/`, S1-S3): day, week and month calendar, event form and detail, resource directory and resource schedule, in the sidebar since S3 (docs/scheduling-s3.md). Sections follow the shell's secondary navigation.
- **Reporting** (`reporting/`, R1): headline KPIs, one chart with its period table and records, date range, Zone filter and saved reports (docs/reporting-r1.md). Figures come from the API's registered metrics; the screen never calculates. Shared `KpiCard`, `LineChart` and `BarChart` live in `@business-os/ui` for other Zones.
- **People** (`people/`, P2): employee directory, profile, create/edit, status changes, departments and locations (docs/people-p2.md). Personal details only with `people:read_sensitive`.

## Conventions for a new Zone

- Register it in `src/shell/registry.ts` and render inside `ZoneFrame`, passing the Zone's unsaved-changes `leave` guard. The application shell supplies the sidebar, breadcrumbs, business switcher and account menu (see `docs/ui/app-shell.md`); a Zone never draws its own header.
- Lay out new screens with `ZonePage` (`src/shell/zone-page.tsx`).
- Mount it with `key={businessSlug}`. All state lives in components, never in browser storage, and a business switch discards it. Requests name the business only through the `:slug` in the URL.
- Read with `useLoad(key, load)`: it aborts the previous request and ignores answers for an older key, so a slow response from another business or query never renders.
- Show every failure with `Problem` (offline, server error, forbidden, not found, ended session). An ended session hands control back to the app (`onSessionEnded`), which re-checks sign-in; offline is never treated as signed out.
- Gate write controls on `membership.permissions` for presentation only; the API enforces RBAC.
- Forms: lock submit while a request is in flight, show contract errors inline, and report unsaved changes to the Zone so leaving asks first.
