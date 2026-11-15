# STAB-01: integration and stabilisation checkpoint

Baseline: `main` at **0a3610b187dd7b7c52d73e135e6532f39ea764cc** (Communications C1, PR #39,
merged 2026-11-15 06:19 UTC). Assessed 2026-11-15 by Claude for Regan; ChatGPT audits.
Migration detail is in [migration-readiness.md](migration-readiness.md).

Nothing was merged, migrated or deployed. Production was only read (health and anonymous 401
checks); all signed-in testing used disposable local databases.

## 1. Recommendations

**Controlled migration: GO, with nothing to migrate.** All 11 migrations on `main` are applied to
production with matching checksums, and the schema has been rebuilt and upgraded cleanly on
disposable databases. The next schema change is GO only after Regan chooses the deploy sequencing
(STAB-H1).

**Integrated pilot: ready for an internal pilot with test or non-critical data. Not ready for a
pilot with real customer data.** The five built Zones work together across businesses and roles with
no defects found. Before real data: decide recovery posture (STAB-H2), and decide whether the pilot
needs Scheduling in the navigation (STAB-M2), a People screen (STAB-M3) and refresh-safe locations
(STAB-M4). Native desktop click-through on macOS and Windows (STAB-L8) should be done by hand first.

| Release criterion | State |
|---|---|
| Critical defects | None found |
| High findings | 2, both process/infrastructure, each with an owner and disposition (§4) |
| Required tests pass reproducibly | Yes: every CI check locally three times, plus main's own CI (incl. desktop matrix) on 0a3610b |
| Every risk owned and dispositioned | Yes (§4) |

## 2. Phase A: repository audit

- **HEAD**: 0a3610b. **Open PRs**: none. **Merged dependencies**: Finance F1–F4 (#31, #34, #35,
  #37), People P1 (#36), Scheduling S1 (#38), C1 (#39), UI phase 1–2 (#32, #33).
- **Outstanding audit findings carried in**: Scheduling navigation patch unapplied (by decision);
  C1 erasure not privacy-complete (documented in C1, out of scope here); the open items in the
  project's migration report (sequencing, PITR, branch protection).
- **main's CI on 0a3610b**: success, including the desktop matrix (Linux, macOS, Windows builds and
  Rust tests), run 43684883850.

Local reproduction (Node 22, pnpm 10.20, PostgreSQL 16.15 ICU en-US, PgBouncer 1.22.0 transaction
mode, the CI environment variables):

| Check | Result |
|---|---|
| `contracts:check` | snapshot up to date |
| `typecheck`, `lint`, `boundaries` | pass (361 files under source rules) |
| `test` (unit, contract, architecture) | 705 / 705 |
| `prisma migrate deploy` on a fresh database, `db:privileged` | 11 migrations, pass |
| `test:integration` | 344 / 344 on main; 389 / 389 with this PR's cross-Zone suite |
| `test:isolation` (RLS spike S1–S13 behind PgBouncer) | 75 / 75 |
| Finance integrity, payments and expenses behind PgBouncer | 92 / 92 |
| People behind PgBouncer | 22 / 22 |
| `db:check-migrations` | no difference |
| `build` (API, web, desktop frontend) | pass; Vite warns of an 865 kB chunk (STAB-L2) |
| API boots with `env -i` and no owner credentials; `/api/v1/health` | 200 `ok` |
| Client bundles contain no server configuration | none found |

**Flakiness**: unit, integration and isolation suites were each run three times on the same
database; all passes, no retries. **Hidden dependencies**: one, local-only: a customers sort test
needs an ICU (or `en_US`) collation; a `C.UTF-8` database fails it. Docker and CI are unaffected
(STAB-L5). **Migration order**: one real hazard, fixed (STAB-M1). **Regressions**: none.

## 3. Phases B, C and D

### Phase B: database readiness

See [migration-readiness.md](migration-readiness.md). In short: fresh database green; a
representative pre-migration database (production's schema before 06:16 UTC, populated with
synthetic, production-schema-compatible test data: 52 businesses created by the F3 integration
suite; no production data was used) upgraded with People, Scheduling and C1 in 2 s, with no schema
difference and **389 / 389** integration tests passing on the upgraded test data; roles, RLS, policies,
ownership, constraints, privileges and tenant ownership all verified. Two process findings
(STAB-M1, fixed; STAB-M6, Prisma leaves a partial schema when a migration fails).

### Phase C: cross-Zone integration

New suite `apps/api/tests/integration/cross-zone.test.ts` (45 tests, two businesses, every role,
real route handlers and PostgreSQL). It passes on the fresh database three times back to back and on
the upgraded representative database.

| Workflow | Result | Evidence |
|---|---|---|
| Customer creation, contact assignment, primary contact, activity history | Pass | timeline shows customer, contact, primary-contact, note and message entries |
| Customer → Sales opportunity → win | Pass | opportunity listed by customer, status WON |
| Customer → Finance quote (linked to contact, opportunity, project) → issue → accept → convert → invoice → payment → credit note → settled | Pass | links carried onto the invoice; settlement outstanding 0.00; customer leaves balances; reconciliation 200 |
| Expense with category, project and customer → record → pay → PAID | Pass | outstanding 0.00; payables 200 |
| Customer activity and communications visibility | Pass | conversation and message on the customer timeline; B sees none of it |
| Calendar default → event for customer → conflict 409 → move → cancel | Pass | `scheduling_conflict`; CANCELLED |
| People directory and sensitive fields | Pass | MANAGER reads work details only, 403 on personal; MEMBER 403; ADMIN reads personal |
| Projects, tasks, customer's projects | Pass | task assigned to a member; project on the customer |
| Cross-tenant links (19 attempts: contact, note, conversation ×2, opportunity ×3, project, task ×2, quote ×3, invoice, payment, event, employee, expense ×2) | Pass | every one 4xx with a specific error, no 500, and no A row points at a B record (checked in SQL) |
| B reading or changing A's records by id | Pass | 404 for customer, opportunity, project, invoice, event, employee, personal details, update |
| Business switching (one person, MEMBER in A, ADMIN in B, one session) | Pass | role, Finance access and data follow the business in the URL |
| Restricted roles via the API directly | Pass | 7 role/action pairs 403; anonymous 401 on all 7 Zones |

Board drag-and-drop and Sales/Projects board moves are covered by their own suites and were not
re-tested here. **Feature gaps (not defects)**: Sales, Finance, Projects and Scheduling write nothing
to the customer timeline (STAB-L4); customers have no optimistic concurrency, unlike every other
Zone (STAB-L3); People has no screen (STAB-M3); Scheduling's screen is not in the navigation
(STAB-M2).

### Phase D: application stability

Production builds served locally the way production serves them: API with `next start`, web from
`vite build` with same-origin `/api`, in headless Chromium. Users and businesses were seeded through
the API. Script results:

| Check | Result |
|---|---|
| Sign in, workspace chooser lists both businesses | Pass |
| Zone navigation: Customers, Sales, Projects, Finance | Pass |
| Business switching via the switcher; data follows | Pass |
| Form validation (empty customer name) | Pass: "A name is required" |
| Unsaved-change guard when leaving a dirty form | Pass: "Unsaved changes" dialog |
| Restricted role: MEMBER has no Finance entry | Pass |
| Session revoked server-side, then any action | Pass: "Your session has ended. Please sign in again." |
| Sign out; Back shows nothing; cookie cleared | Pass |
| Server error (500), then retry recovers | Pass: "Something went wrong", retry loads data |
| API unreachable | Pass: "Can't reach Business OS" |
| Loading state with a slow API | Pass (`aria-busy` region) |
| Empty state (new business, Projects) | Pass: "No projects yet" with a create action |
| Rate limiting on repeated sign-in | Pass: "Too many attempts. Please wait a minute and try again." |
| 390 px and 768 px: no horizontal overflow, mobile drawer works | Pass |
| Keyboard: skip link first, visible focus on every stop, Enter opens a Zone | Pass |
| Console errors | None, apart from the expected 401 from the signed-out session probe (STAB-L6) |
| Refresh keeps your place | **No**: reload returns to Home (STAB-M4, by design today) |
| Scheduling reachable | **No**: not in navigation (STAB-M2) |
| API contract compatibility | Pass: snapshot check, and contract-parsed responses throughout the integration suites |
| Production-build startup | Pass (API `env -i` boot; web and desktop frontends build; main's CI built the native apps) |

Not done here: the native Tauri window (no display in this sandbox) and a Windows machine
(STAB-L8). The Scheduling navigation patch still applies cleanly to 0a3610b, and with it applied the
client typechecks, lints and passes its 333 tests.

## 4. Remediation register

| ID | Sev | Finding | Disposition | Owner |
|---|---|---|---|---|
| STAB-H1 | High | Every merge to `main` deploys to production at once, before any migration can run (People code was live 51 min before its tables). | **Blocks the next schema change** until Regan picks sequencing A or B (migration-readiness §6; B recommended). No code change. | Regan |
| STAB-H2 | High | Neon Free plan: 6 h point-in-time history; backup storage region unverified (ADR 0002 stays Proposed); production branch not protected. | Accepted while production holds no business data. **Blocks a pilot with real data.** | Regan |
| STAB-M1 | Medium | Future-dated migration names (18–19 Nov) make `migrate dev` name new migrations so they sort earlier: production and fresh databases would apply them in different orders. Demonstrated (P3018 on a fresh database). | **Fixed in this PR**: `.github/scripts/check-migration-order.sh` on every PR. It also fails when a base migration is deleted or renamed (audit STAB-A01). 14-case self-test. | Developer |
| STAB-M2 | Medium | Scheduling S1 screen is built but not in the navigation. | Gap by earlier decision. Patch `docs/scheduling-s1-integration.patch` verified to apply and pass. Apply in its own PR when Regan approves. | Regan |
| STAB-M3 | Medium | People P1 is backend only; no screen. | Feature gap; not built here. | Regan (scope) |
| STAB-M4 | Medium | The app shell keeps its location in memory: refresh or a shared link returns to Home. | By design today ("future URLs" in the registry). Product decision before pilot. | Regan (scope) |
| STAB-M5 | Medium | C1 migration applied ~2 min before its PR merged. | Recorded approved exception; files byte-identical. Sequencing B prevents recurrence. | Regan |
| STAB-M6 | Medium | Prisma does not roll back a failed migration file: a failure leaves partial schema (verified). No existing migration wraps itself in a transaction. | Procedure documented (migration-readiness §7): recovery branch first; explicit `BEGIN … COMMIT` in new migrations. | Developer |
| STAB-L1 | Low | Five composite FKs without a supporting index. | Deferred; parents are archived, not deleted. Add in a future additive migration. | Developer |
| STAB-L2 | Low | Single 865 kB (233 kB gzip) client chunk; Vite warns. | Deferred; code-splitting is an improvement, not a fix. | Developer |
| STAB-L3 | Low | Customer and contact updates are last-write-wins (no `version`), unlike every other Zone. | Gap; decide with the next Customers change. | Regan (scope) |
| STAB-L4 | Low | Customer timeline shows only customer, contact, note and message entries. | Gap; Home already says a combined feed comes later. | Regan (scope) |
| STAB-L5 | Low | Local databases with `C.UTF-8` collation fail one customers sort test. | Use Docker (default) or ICU `en-US`; documented here. | Developer |
| STAB-L6 | Low | Signed-out first load logs a 401 in the browser console. | Accepted: expected session probe. | — |
| STAB-L7 | Low | Migration `20261119300000` encodes hour 30. | Accepted; cannot rename an applied migration. | — |
| STAB-L8 | Low | Native desktop click-through (macOS) and Windows testing not done in this checkpoint. | Manual pass on the Mac and a Windows machine before pilot. | Regan / Mac session |

Closed by this checkpoint (open in earlier project notes): rate-limit 429 check (integration test
plus UI message above); CI covering Better Auth's Origin check (`auth.test.ts` "rejects
cookie-authenticated state changes without the exact app origin"); CI on 0a3610b (green).

## 5. Changes in this PR

- `apps/api/tests/integration/cross-zone.test.ts`: Phase C suite (45 tests). Runs in the existing
  `test:integration` step; no CI change needed.
- `.github/scripts/check-migration-order.sh` and `.test.sh`, wired into the "Detect changes" job:
  regression guard for STAB-M1 (order and format of added migrations; no deleted or renamed base
  migrations).
- `docs/stabilisation-checkpoint.md`, `docs/migration-readiness.md`.

No application code, schema, migration, contract, permission or security control changed.

## 6. Reproducing

```bash
pnpm install --frozen-lockfile
pnpm db:reset && pnpm --filter @business-os/api exec prisma migrate deploy
ADMIN_DATABASE_URL=postgresql://postgres:local_postgres_only@localhost:5432/business_os DEPLOYMENT_REGION=local pnpm db:privileged
pnpm contracts:check && pnpm typecheck && pnpm lint && pnpm boundaries && pnpm test
pnpm test:integration && pnpm db:check-migrations   # test:isolation also needs PgBouncer on 6433 (docs/ci.md)
.github/scripts/check-migration-order.test.sh
```
