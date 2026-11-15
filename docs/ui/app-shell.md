# Application shell (UI Phase 2)

The shell is the frame around every signed-in screen in both the browser app (`apps/web`) and the desktop app (`apps/desktop`). Both apps render the same `App` from `@business-os/app`, so there is one shell, not two. Each app keeps only its own entry point: transport, configuration and the call to `applyStoredTheme()` before the first render.

It is built from the Phase 1 design system (`@business-os/ui`): semantic tokens, the `calm` atmosphere behind the workspace, one strong glass surface (the sidebar), and opaque cards and popovers for dense content. It adds no colours of its own.

## What the shell owns, and what it does not

| Shell (`packages/app/src/shell`) | Not the shell |
| --- | --- |
| Sidebar, top bar, breadcrumbs, mobile drawer | Business data and domain rules (the API's modules) |
| Business switcher (calls the existing tenant API through `useWorkspace`) | Authorisation decisions (the API checks every request) |
| Account menu, theme preference, sidebar preference | Each Zone's screens, filters and records |
| Zone registry and permission filtering for navigation | Search, notifications and activity backends (none exist yet) |

| File | Purpose |
| --- | --- |
| `shell/app-shell.tsx` | `AppShell`: layout, sidebar, top bar, drawer, switcher, account menu, notices |
| `shell/registry.ts` | `ZONES` registry, `ShellRoute`, `resolveNavigation()` and `canOpen()` |
| `shell/zone-page.tsx` | `ZonePage`: the page-layout contract for Zone screens |
| `shell/home.tsx` | Home: greeting, Zone launcher, shortcuts, real Customers counts, recent-activity placeholder |
| `shell/menu.tsx` | Accessible menu button (business switcher, account menu) |
| `shell/preferences.ts` | Per-device theme and sidebar preferences |
| `zones/zone-frame.tsx` | How a Zone plugs into the shell (it hands over its unsaved-changes guard) |

## Navigation and routes

Navigation is in memory: a `ShellRoute` (`{ zone: 'home' }` or `{ zone, child?, target?, intent? }`) held by `App` and remembered together with the business it was chosen in. A route is honoured only if `canOpen()` allows it under the current business's permissions. A business switch, sign-out or role change therefore always lands on Home.

The registry's `route` paths (`/customers` and so on) are stable identifiers ready for URL routing. Syncing routes to the browser URL (deep links, back and forward) is deferred, because it changes refresh and history behaviour on the web.

## Permissions and Zone availability

The registry only describes Zones. Access comes from the server: `membership.permissions` in the business context (`GET /api/v1/b/:slug`), using the existing keys in `apps/api/src/modules/access/server/permissions.ts`.

- **Built Zone, permissions held:** shown in the sidebar and on Home.
- **Built Zone, permissions missing:** not shown anywhere. It is not shown as disabled either, so the shell reveals nothing about what other roles can see.
- **Planned Zone** (People, Operations, Settings; Finance became built in F3, gated on `finance:read`; Reporting replaced the planned Insights entry in R1, gated on `reporting:read`): shown on Home as "coming soon" and never openable. It is not in the sidebar.
- **Loading** (a business is opening): skeleton items, and nothing from the previous business.
- **Failed:** a plain message, and no Zones listed.

There is no server-side module-availability contract yet. When one exists, it narrows `built` Zones inside `resolveNavigation()`, and no navigation component changes.

## Business switching and tenant isolation

The switcher lists exactly the businesses the server returns. Choosing one runs `useWorkspace().switchTo(slug)`:

1. The current Zone's unsaved-changes guard runs first.
2. The shell shows "Opening …" and the previous business's screens are unmounted straight away.
3. Session, memberships and the business context are checked again on the server (`resolveWorkspace`). Older in-flight resolutions are aborted and ignored.
4. On success, the new business opens on Home, and every Zone remounts (`key={slug}`), so no state or cached response carries over. `useLoad` also drops answers for an older key.
5. If the business is no longer listed, you stay in the business the server resolves and see an "access revoked" notice. If the server can't be reached, you stay where you were and see a "couldn't open" notice. If the session has ended, the sign-in screen appears.

"All businesses…" opens the full chooser, which has a Back button.

## Responsive behaviour

| Width | Navigation |
| --- | --- |
| >= 1024px | Sidebar, expanded or compact. The choice is remembered per device (`bos.sidebar`). |
| 640-1023px | Compact icon rail. Names stay available to assistive technology and as tooltips. |
| < 640px | Menu button that opens a modal drawer: focus moves in and is trapped, Escape and the backdrop close it, focus returns to the button, and the page behind is locked and inert. The active business stays in the top bar. |

The sidebar and the content area scroll independently. The page itself never scrolls horizontally, while data-heavy views keep their own horizontal scrolling.

## Accessibility

- Landmarks: a skip link to `main#bos-content`, `nav` "Zones", `nav` "Breadcrumb", and section navigation where a Zone declares children.
- Active state uses `aria-current="page"`, together with a visual marker that does not rely on colour alone.
- Menus follow the WAI-ARIA menu-button pattern: arrows, Home and End move between items; Escape closes the menu and returns focus; radio items show `aria-checked`.
- Search and notifications are focusable, `aria-disabled` and labelled "not available yet". No feature is faked.
- Notices use `role="alert"`, and loading states use `role="status"`.
- Reduced motion and reduced transparency are respected through the Phase 1 treatments.

## Theme

The account menu offers System, Light and Dark. The choice uses the design system's own `.dark` and `.light` classes on `<html>` and is stored on the device (`bos.theme`). No account-settings API exists yet.

## Registering a new Zone

1. Add an entry to `ZONES` in `shell/registry.ts`: `id` (extend `ZoneId`), `name`, `description`, `icon` (from `shell/icons.tsx`), `route`, `order`, and `requires`. `requires` lists the existing API permission keys the Zone needs; never invent keys or infer them from the name. Optionally add `children` for secondary navigation and a short `status` label. Start with `availability: 'planned'` until the screens exist.
2. Build the Zone under `zones/<name>/` following `zones/README.md`: render inside `ZoneFrame` (pass the Zone's `leave` guard), mount with `key={slug}`, and read data with `useLoad`.
3. In `app.tsx`, render the Zone when `current.zone` is its id, then switch the entry to `availability: 'built'`.
4. Lay new screens out with `ZonePage` (heading, description, primary and secondary actions, optional tabs, and loading, error and empty states).

The sidebar, drawer, breadcrumbs, Home launcher and permission filtering then pick the Zone up with no changes of their own.

## Deferred

- URL routing and deep links (see above).
- Moving the existing Customers, Sales and Projects screens onto `ZonePage`. Their headings and actions already follow the same visual pattern, and moving them means editing every screen.
- Breadcrumbs below Zone level (for example, a customer's name), Zone child navigation for existing Zones (for example, the Sales list and board), and a server-side module-availability contract.
- Search, notifications and a cross-Zone activity feed. Each needs a backend first.
- Storing the theme in account settings.

## Screenshots

`docs/ui/screenshots/phase-2/`: desktop (1440px), tablet (834px) and mobile (390px), in dark and light themes. They were captured from the production web build with the API answered by the in-memory test fakes, so the data shown is sample data.
