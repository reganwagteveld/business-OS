# Zones

Zones (Customer, Sales, Finance, Projects, Operations, People) are user-facing navigation and presentation areas in the shared client app, not data ownership boundaries. They render the same way in the desktop and browser apps.

Zones get their data only from the cloud API through the typed client in `src/api` (contracts in `@business-os/contracts`). Domain logic, authorisation and tenant isolation live in the API's modules (`apps/api/src/modules`), never here. No Zone is built in Phase 1a.
