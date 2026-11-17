# Scheduling S3: navigation integration

Status: draft PR. No migration, no API change, no contract change.

## What changed

- Scheduling is a Zone in the shell registry (`packages/app/src/shell/registry.ts`): name "Scheduling", new `calendar` icon, order 45 (after Finance, before People; after Projects as asked), opens with `scheduling:read`. The server still checks every request.
- Sub-navigation: **Calendar**, **Resource schedule** and **Resources**. These are the three sections S2 already built. There is no **Bookings** destination: no bookings API or screen exists. The resource schedule is the per-resource view of bookings.
- `SchedulingZone` takes `section` and `onSection` from the shell, as Reporting does. The Zone stays mounted while moving between sections; its own tab strip is shown only when it is used without the shell.
- `app.tsx` mounts the Zone with a `scheduling` client prop (injectable for tests) and passes `onOpenCustomer` only when the viewer holds `customers:read`.
- Event detail shows the linked customer as a link to the Customers Zone when that deep link is available.
- Home "Upcoming schedule" panel gets an "Open Scheduling" button.
- The stale `docs/scheduling-s1-integration.patch` is removed.

## Not changed

Backend, locking order (ADR 0008), conflict checks, optimistic concurrency, permissions, RLS and contracts. Hidden navigation is presentation only.

## Gaps recorded for the Zone Completion Roadmap

1. **No URL routing in the shell.** Every Zone is held in memory (`app.tsx`), so a reload returns to Home and a typed URL such as `/scheduling` is not honoured. This is a shell-wide limitation, not specific to Scheduling; routes in the registry are descriptive. A router is a separate shell PR.
2. **No Bookings destination**; no standalone allocation list. Allocation and release happen on events (resource picker) and are visible on the resource schedule.
3. Events cannot link to a project, task or employee (W1 WF-4). Customer is the only existing link.
4. No leave on the calendar (P3-E), no event completion state (WF-5).
5. `getCalendar`, archive and restore calendar have no UI. The `scheduling.events_scheduled` metric is planned.
6. Calendar views have no drag and drop; the resource schedule is a day/week table.
