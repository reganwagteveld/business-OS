# Business OS — Product and Delivery Roadmap

Version 1 · 15 November 2026 (Perth) · Owner: Regan · Engineering: Codex and Claude

## 1. Product direction

Business OS is an AI-native operating system for small businesses: one shared workspace connecting customers, sales, work, people, money and communications. Its value is practical: less re-entry, fewer missed follow-ups, easier coordination, faster billing and a clearer picture of what needs attention.

The initial customer hypothesis is a business with roughly 5–50 employees. The core stays industry-independent; service businesses are a proposed first pilot segment because the existing customer → sale → project → invoice workflow already fits them. Restaurants, retail and other industries remain part of the wider vision through optional modules. Regan decides the first commercial segment and launch market.

The primary clients remain Tauri desktop and the shared browser app. Mobile employee workflows come later. Existing tenant isolation, RBAC, shared records, API boundaries, locale/currency/time-zone handling and audit guarantees apply throughout.

This roadmap consolidates the delivery sequence. Detailed approved decision registers, ADRs and feature specifications remain authoritative for behaviour. A proposed item here is not permission to build it.

## 2. Status and evidence

Baseline checked on 15 November: local checkout at `d81b445` plus GitHub merged/open PR searches. The local active branch is `feature/finance-f6-2-statements`, with uncommitted work. GitHub confirmed PRs #41–47 merged, including #43, #45 and #46. PR #48 is open for documentation corrections. Production database state and scheduler activation were not independently checked in this roadmap pass.

Status vocabulary: **Merged** = code in repository history; **In progress** = active work observed; **Planned** = documented remaining scope; **Proposed** = recommendation requiring feature approval; **Verify** = evidence needed. Merged does not imply migrated, activated, user-tested or commercially ready.

| Area | Current position | Remaining gap |
|---|---|---|
| Platform | Merged: identity, onboarding, businesses/memberships, tenant isolation, RBAC, audit, API contracts and CI | Production recovery/protection posture, operational monitoring, release automation and pilot readiness |
| Clients and design | Merged: Tauri/web shared client, design system and shell | Refresh-safe navigation, usable Settings, intended UI overhaul, external desktop release/signing/updating |
| Customers | Merged: customers, contacts, activities and restricted notes | Broader cross-Zone history, import/deduplication, concurrency improvements |
| Sales | Merged: opportunities, pipeline and Kanban | Connected handoff to delivery/billing; follow-ups and richer sales workflows |
| Projects | Merged: projects, tasks and board | Scheduling/resources, time/cost tracking and better customer-to-delivery flow |
| Finance F1–F5 | Merged: quotes/invoices/credits, payments, allocations, expenses, UI and immutable PDFs | Broader purchasing, product catalogue, payment integrations and optional accounting integrations |
| Finance F6-1 | Merged #45: recurring schedules and draft generation | Verify production migration, privileged SQL and cron activation; generation does not issue or send |
| Finance F6-2 | In progress locally: statements, ageing, PDF/API/UI/tests | Complete implementation, audit, CI and release evidence |
| Communications C1/C2-A/B1 | Merged: timeline/history, provider/OAuth foundation, mailbox identity and membership | Erasure, intake/retention, sync, sending and full communications UI |
| Scheduling S1 | Merged: calendars/events, conflict handling and screens | Registry does not expose Schedule as a Zone; resources, recurrence and private events remain future scope |
| People P1 | Merged: employee/workforce backend | People still planned in navigation; no employee management screens, leave, roster or timesheets |
| Reporting R1 | Merged #43: metric registry, query engine, saved reports and Reporting Zone | More source metrics and action-oriented dashboards |
| Operations / Inventory / POS | Proposed future product modules | No implemented module observed in this pass |
| AI in the product | Architecture direction exists | No implemented business assistant verified; developer-agent coordination is separate |

Source documents can contain stale status headers. Commit/PR evidence takes precedence for merge state. PR #48 specifically records contradictory production migration statements for migrations 12–16; reconcile against the live migration ledger rather than guessing.

## 3. Delivery milestones

Ordering is based on dependencies and complete customer workflows, not fixed dates. Capacity and calendar estimates should follow the coordinator trial and first pilot feedback.

| Milestone | Customer outcome | Scope | Exit evidence |
|---|---|---|---|
| M0 — Reliable delivery | Changes arrive safely without Regan relaying messages | Coordinator; release-state reconciliation; existing QA automated | One bounded change completes build → audit/fix loop → CI → release → verification automatically |
| M1 — Complete daily core | Run customers, sales, projects and billing in one workspace | F6-2; People UI; Scheduling navigation; Settings; durable navigation; connected workflows | Regan completes a real internal business workflow end to end, with honest errors and no re-entry of shared records |
| M2 — Connected communications | Customer mail and follow-ups are part of the work | E1; remaining C2-B stages; C2-C/D; F6-3 | Provider-specific tests, approved privacy/provider gates and successful controlled mailbox workflows |
| M3 — Pilot-ready product | A selected business can migrate and use the product with support | Import/export, recovery, monitoring, usability pass, onboarding, pilot reporting | Restore drill and pilot checklist pass; agreed workflow works with representative data |
| M4 — Paid core release | Customers can subscribe and operate reliably | Plans/entitlements, subscription billing, support/admin operations, release distribution | Paid onboarding, entitlement changes, cancellation/export and support recovery exercised |
| M5 — Workforce and operations | Coordinate staff and day-to-day delivery | Leave, roster, time/attendance, resources and operational jobs | Selected pilot workflow replaces an actual spreadsheet or disconnected process |
| M6 — Commerce extensions | Sell and fulfil products alongside services | Catalogue → purchasing/inventory → payments/POS | Stock, order, payment, refund and financial reconciliation agree under concurrency |
| M7 — Deeper intelligence and scale | Business OS assists with work across modules | AI actions, automation, expanded reporting, integrations and scale work | Permission-aware actions and measurable workflow improvements; operating targets met |

AI's first useful read-only features can start in M3 once source workflows and permissions are stable. M7 represents depth and breadth, not the first appearance of AI. UI refinement starts in M1; the larger overhaul is part of M3.

## 4. Recommended next delivery queue

Only work already requested/approved may run automatically. Each proposed feature needs Regan's scope decision before entering the executable queue; engineering choices inside approved scope belong to the agents.

| Order / ID | Deliverable | Dependencies | State | Claude model |
|---|---|---|---|---|
| 1 · ENG-01 | Local persistent coordinator with durable jobs, handoffs, audit/fix loops, usage pauses and status reports | Existing CLI logins, network and repo access | Requested; live handoff and audit/fix loop observed (`docs/evidence/coordinator/`); release qualification outstanding, not operational | Opus 5.5 |
| 2 · ENG-02 | Reconcile release records: merged SHAs, CI, live migration ledger, privileged SQL, cron and health | Read-only production access; PR #48 context | Necessary engineering follow-through | Opus 5.5 |
| 3 · F6-2 | Finish customer statements and accounts receivable ageing | F1–F5; current active work | In progress | Opus 5.5 |
| 4 · E1 | Erasure ledger, retention enforcement, legal holds and controlled purge paths | Approved C2 register; data ownership map | Planned dependency; detailed scope required | Opus 5.5 |
| 5 · UX-01 | Expose Scheduling; implement refresh/deep-link-safe navigation | S1 and app shell | Proposed | Sonnet 5.5 |
| 6 · P2 | Employee directory and management UI over P1 | P1 permissions and sensitive-data rules | Proposed | Sonnet 5.5 |
| 7 · SET-01 | Business/member/settings screens, including explicit communication retention setup | Existing tenancy/access and retention services | Proposed | Sonnet 5.5 |
| 8 · C2-B2 | Intake, promotion/sharing, retention and erasure integration | E1, B1; approved register | Planned; confirm detailed stage boundaries | Opus 5.5 |
| 9 · C2-B3 | Inbound provider sync, jobs, authority checks, cursor recovery and deduplication | B2, provider credentials and gates | Planned | Opus 5.5 |
| 10 · C2-B4 | Remaining sync lifecycle/operational verification from the approved C2 plan | B3; stage brief must be recovered/defined before coding | Planned; scope not fully established here | Opus 5.5 |
| 11 · C2-C | Sending, provider-specific reconciliation, sender permissions and UNKNOWN handling | Sync and provider validation | Planned | Opus 5.5 |
| 12 · C2-D | Mailbox settings, inbox, conversations and composer | Underlying C2 APIs; settings can start sooner | Planned | Sonnet 5.5 |
| 13 · F6-3 | Reminder policies, suppression, history and sending integration | F6-2; C2-C for dispatch | Planned | Opus 5.5 |
| 14 · FLOW-01 | Customer → sale → quote → project → invoice handoffs and linked history | Existing modules; agreed product workflow | Proposed | Opus 5.5 |
| 15 · PILOT-01 | Import/export, usability, operations and pilot acceptance | M1/M2 workflow; selected segment | Proposed | Opus for data/operations; Sonnet for UI |

After ENG-01/02, E1 can run alongside F6-2 when isolated branches and migration ordering permit. UX-01/P2 can proceed alongside Communications backend work once approved. Releases and production migrations are serialized. Do not start every row simultaneously.

## 5. Full feature map

The following is the product horizon, not a committed launch bundle. Each row requires a focused brief, acceptance criteria and approved scope before execution.

| Workstream | Next capability | Later capability | Dependency / business decision |
|---|---|---|---|
| Customers / CRM | Import preview/mapping, duplicates, linked cross-Zone history and consistent edit conflicts | Segmentation, consent/preferences, custom fields and customer portal | Choose migration sources and portal use cases |
| Sales | Follow-up tasks, templates and clean quote/project handoffs | Forecasting, targets, lead capture and optional signatures | Define first segment's actual sales process |
| Projects / service delivery | Milestones, task history, time/cost capture and resource booking | Recurring jobs, templates, service requests and field workflows | Agree job/project boundary before adding Operations |
| Finance | Finish F6, reusable product/service catalogue and invoice email | Payment links, bank feeds/matching, supplier bills, purchase orders and accounting exports/integrations | Select providers/markets; choose finance depth before presenting it as full accounting |
| Communications | Complete approved C2 and its retention rules | Saved replies, shared inbox assignment, attachment saving, optional SMS/chat channels | Consent, provider permissions, channel costs and approved retention behaviour |
| People | P2 directory UI, onboarding/offboarding workflows | Leave requests/balances, approvals, roster, timesheets and employee self-service | Team visibility, leave rules and first jurisdiction |
| Attendance | Time entries and approval/corrections | Phone clock-in/out with vicinity verification; employer-device option | User-requested future idea: keep location private; define verification/data policy before build |
| Scheduling | Reachable S1; recurring events and resource assignments | Availability, external calendar sync and customer booking | Private events and booking/conflict semantics need a brief |
| Operations | Jobs/checklists linked to customers, projects and resources | Assets, maintenance, service dispatch and industry packs | Select the first operational workflow with a pilot |
| Inventory / purchasing | Product catalogue, suppliers, purchase orders, receiving and stock ledger | Reservations, transfers, counts, returns, valuation and multi-location | Agree valuation/costing and stock policy; catalogue can precede stock tracking |
| POS | Orders, cart, tax, tender, receipts, returns and stock integration | Provider hardware, sessions/cash-up, offline operation and restaurant options | Inventory/payments/reconciliation first; choose retail vs hospitality scope |
| Reporting | Expense/project/scheduling/people metrics using owning module APIs | Cash/workforce views, scheduled exports and deeper forecasting | Respect source permissions, small-group privacy and currency separation |
| AI assistant | Permission-aware search, record summaries and suggested follow-ups | Drafts, approved actions, multi-step workflows and forecasting assistance | Opt-in processing where required; provider, usage limits and data controls |
| Workflow automation | Notifications, event triggers and simple approved rules | Cross-Zone approvals and reusable workflow templates | Idempotency, cancellation, audit and permission checks for every action |
| Files / documents | Secure attachments and document lifecycle | Templates, approvals and external sharing | Storage, access, retention and download controls |
| Platform / settings | Complete admin UI, notifications, search, preferences and reliable navigation | Configurable roles, team-scoped access, custom fields, API/webhooks and SSO | Add flexibility when a real workflow needs it |
| Commercial operations | Pilot onboarding, support, plans, entitlements and subscription lifecycle | Referral offers, migration service and partner channels | Regan sets pricing, launch market, offer and commitments |
| Clients / distribution | Supported browser/desktop verification and signed external releases | Signed updater, mobile workflows and selected offline capability | Public brand/app identity before external distribution; offline is separate product scope |

## 6. Pilot, paid release and quality gates

The existing QA process remains the delivery standard. Automate its handoffs and retain evidence; do not replace it with agent agreement alone. Required checks include contracts, types, lint, boundaries, appropriate unit/integration/isolation/pooler tests, migration order/schema checks, builds, security boundaries and relevant UI evidence. Codex reviews Claude's work independently, findings are resolved, and review/CI must match the released commit. A changed commit invalidates prior release clearance where affected.

For schema releases, use the established migration/recovery procedure and explicit sequencing appropriate to automatic Vercel deployment. Confirm the exact pending migration set and checksums, recovery point, privileged steps, compatibility, post-migration invariants and deployment health. Never treat a merged PR as proof of migration or scheduler activation. Failed release steps stop the job and preserve its evidence.

Before real pilot data: verify backup region/retention, restore procedure, production protection, data export/erasure and access/privacy boundaries; close the outstanding pilot gates from STAB-01. Communications retains its existing separate engineering, legal/privacy and provider gates. These are existing project obligations, not newly invented approval steps.

Pilot acceptance is a workflow: onboard a business, import a small representative dataset, manage a customer/opportunity, deliver work, quote/invoice, record settlement, inspect the report and export the records. Exercise restricted staff access, business switching, failure recovery and both intended clients. Select additional workflows according to the pilot's needs.

Paid release adds subscription/entitlement lifecycle, support/recovery operations, onboarding documentation and verified distribution. A 60-day migration offer and referrals remain commercial proposals until Regan fixes their terms. No fixed launch date or numerical reliability target is invented here.

## 7. Decision ownership and cost control

Regan owns feature priorities/behaviour, target segment/market, pricing, new material spending and material business commitments. Codex and Claude own architecture, implementation, testing, audits, migration planning, merges and routine releases within approved scope and the existing QA rules. The current request grants the intended engineering autonomy; older per-action owner-approval wording needs an explicit recorded policy reconciliation in ENG-01 so the coordinator follows one current authority model.

Use Sonnet 5.5 for routine UI, documentation, bounded implementation and straightforward fixes. Use Opus 5.5 for data integrity, migrations, concurrency, permissions, provider sync/sending and complex cross-module work. Codex planning/documentation can use GPT-6.1 Sol at Medium reasoning; use higher reasoning selectively for architecture/security/migration audits. Resolve configured model identifiers against installed availability rather than guessing them.

Each task has a bounded scope, saved state, retry limit and usage allowance. Repeated disagreements go through reproduction/tests and recorded reasoning; an unresolved engineering blocker can pause with a concise report. Usage/login/network failures pause cleanly and resume without duplicating migrations, sends or merges. Routine engineering uncertainty is not a business decision.

## 8. Roadmap maintenance and coordinator contract

Each executable job records: stable ID, approved brief/source, outcome and acceptance criteria, dependencies, branch/worktree, implementation model, risks, migration/deployment plan, current stage, exact reviewed SHA, test/CI evidence, findings and resolution, release/activation evidence and next action. Keep credentials and customer data out of job summaries.

Lifecycle: Proposed → Approved → Ready → Implementing → Audit/fixes → QA passed → Release ready → Released → Verified. Blocked/paused is explicit. Separate repository merge, production migration, deployment, activation and user verification fields.

Update this roadmap after each milestone or material scope decision. A feature becomes Verified only with its acceptance evidence. Keep detailed specs linked here rather than maintaining competing roadmaps. Existing Phase 1 implementation plan remains historical detail; this document owns the cross-product sequence.

## 9. Sources and unresolved evidence

Repository sources: `docs/architecture.md`, `docs/implementation-plan.md`, `docs/stabilisation-checkpoint.md`, `docs/migration-readiness.md`, `docs/deployment.md`, `docs/ci.md`, the Finance/People/Scheduling/Communications/Reporting specifications, `.github/workflows/ci.yml`, module source and `packages/app/src/shell/registry.ts`.

GitHub evidence: merged [#43](https://github.com/reganwagteveld/business-OS/pull/43), [#45](https://github.com/reganwagteveld/business-OS/pull/45), [#46](https://github.com/reganwagteveld/business-OS/pull/46), [#47](https://github.com/reganwagteveld/business-OS/pull/47); open documentation correction [#48](https://github.com/reganwagteveld/business-OS/pull/48), checked 15 November 2026. Earlier merged milestones are in local git history.

Unresolved: live production migration/activation evidence; exact remaining B2/B3/B4 stage briefs; initial commercial segment/market; detailed scopes of proposed features. No live production state or completed coordinator release trial is claimed by this roadmap; only the local handoff and fix-loop trials recorded under `docs/evidence/coordinator/` have been observed.
