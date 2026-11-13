# @business-os/ui

The shared design system for the desktop and web clients (architecture §6.5, ADR 0005).

- `src/styles.css`: design tokens (light and dark) and the Tailwind theme mapping. Each app's entry CSS imports Tailwind first, then this file, and adds an `@source` for this package so its classes are generated.
- `src/components`: presentational shadcn/ui-style primitives. shadcn/ui is configured by hand in `components.json` because the shadcn registry is not reachable from every build environment.
- `src/lib/utils.ts`: `cn()` for merging class names.

Rules (enforced by `pnpm boundaries`): no data fetching, no API client, no imports from `@business-os/app` or any `apps/*` package, no database or server-only packages. Tenant data reaches components only as props.
