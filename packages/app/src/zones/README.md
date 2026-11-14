# Zones

Zones (Customer, Sales, Finance, Projects, Operations, People) are user-facing navigation and presentation areas in the shared client app, not data ownership boundaries. They render the same way in the desktop and browser apps.

Zones get their data only from the cloud API through the typed clients in `src/api` (contracts in `@business-os/contracts`). Domain logic, authorisation and tenant isolation live in the API's modules (`apps/api/src/modules`), never here.

## Built

- **Customers** (`customers/`): directory, create/edit form, customer workspace.

## Conventions for a new Zone

- Open it from the Zone home and render inside `ZoneFrame`: brand, a way back to all Zones, and the active business, always visible. No permanent sidebar.
- Mount it with `key={businessSlug}`. All state lives in components, never in browser storage, and a business switch discards it. Requests name the business only through the `:slug` in the URL.
- Read with `useLoad(key, load)`: it aborts the previous request and ignores answers for an older key, so a slow response from another business or query never renders.
- Show every failure with `Problem` (offline, server error, forbidden, not found, ended session). An ended session hands control back to the app (`onSessionEnded`), which re-checks sign-in; offline is never treated as signed out.
- Gate write controls on `membership.permissions` for presentation only; the API enforces RBAC.
- Forms: lock submit while a request is in flight, show contract errors inline, and report unsaved changes to the Zone so leaving asks first.
