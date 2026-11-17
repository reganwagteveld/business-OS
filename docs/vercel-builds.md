# Vercel builds: what deploys when (INFRA-VC-1)

Owner approval: Regan, 2026-11-17 16:08 UTC, in the INFRA-VC-1 project thread. He approved in principle turning off API previews, skipping web previews for docs-only and API-only changes, and never letting a spending limit suspend production. Background audit: INFRA-VC-1 report (project files, `infra-vc-1/vercel-build-cost-audit.md`).

## 1. Policy

| Change since the comparison commit | Web preview (`business-os-web`) | API preview (`business-os`) | Production (`main`) |
|---|---|---|---|
| Documentation only (`docs/**` text and images, root `*.md`; same rule as CI's `is_docs`) | skip | none | both build |
| `apps/api/**` only | skip | none | both build |
| Docs plus `apps/api/**` only | skip | none | both build |
| Anything else: `apps/web`, `packages/*`, contracts, lockfile, any `package.json`, workspace or TS config, `.nvmrc`, `vercel.json` of the web app, this script, `.github`, `scripts`, `tooling`, `apps/desktop`, unknown paths | **build** | none | both build |
| Empty diff, no comparison commit, git or fetch error, odd path name, `VERCEL_ENV` not `preview` | **build** | none | both build |

- **Fail open.** The web script exits 0 (skip) only on a positive decision. Every error path exits 1 (build). `ignoreCommand` itself ends in `|| exit 1`.
- **Comparison commit.** The script compares with the branch's last successful deployment (`VERCEL_GIT_PREVIOUS_SHA`). Without one, it compares with the current `main` tip. So a docs-only push after a web change skips, while the earlier web change still has its preview. A sync merge that brings web changes from `main` builds.
- **API-only cannot affect the web build.** The browser app's workspace closure is `apps/web`, `packages/app`, `packages/ui` and `packages/contracts`. `tests/ops/vercel-ignore-build.test.ts` derives it from the manifests, and fails if the web app ever gains a dependency on the API package.
- **Production is never filtered.** The web script builds for any `VERCEL_ENV` other than `preview`. The API rule `{ "main": true, "**": false }` keeps `main` enabled, because Vercel deploys a branch if *any* matching rule is true ([git configuration docs](https://vercel.com/docs/project-configuration/git-configuration)).
- **Environment-variable changes** are invisible to git and still need a manual redeploy, as before.

## 2. Effect on checks and process

- **`CI gate`** is the only required check (CLAUDE.md, `docs/merge-queue.md`). Vercel statuses are not required, so a skipped or absent Vercel status cannot leave a PR pending. **Never make a Vercel status a required check.** CI is unchanged. It still builds the API, web app and desktop frontend, boots the API without owner credentials and checks the bundles on every PR.
- **Merge queue step 5** (`docs/merge-queue.md`) still sees a production deployment of both projects for every merge, because production is never filtered.
- **Visual regression and E2E** run in GitHub Actions and do not use Vercel.
- **Reviews:** API PRs no longer get a Vercel API preview. Nothing consumed those previews: web previews proxy `/api` to the production API alias, and previews sit behind Vercel login. A one-off API preview is still possible with `vercel deploy` from a developer machine.
- **Open branches** keep the old behaviour until they contain this change. Vercel reads `vercel.json` from the commit being deployed, and branches sync with `main` at the queue head.

## 3. Measured baseline (before)

Read-only from the Vercel API on 2026-11-17 about 16:10 UTC, using the CLI login on the owner's Mac. History starts 2026-11-13, so these counts are complete. Project and team IDs are omitted.

| | business-os-web | business-os (API) |
|---|---|---|
| Deployments, all time | 514 | 544 |
| Production: READY / CANCELED | 92 / 5 | 94 / 9 |
| Preview: READY / CANCELED / ERROR / BUILDING | 380 / 35 / 1 / 1 | 379 / 55 / 6 / 1 |
| READY build time, median (min to max) | 21 s (14 to 41 s) | 30 s (2 to 76 s) |
| Build CPU minutes, 14 to 16 Nov (billing rows) | 1,572 (42%) | 2,212 (58%) |

Settings (both projects unless noted):
- Root `apps/web` (Vite) and `apps/api` (Next.js), production branch `main`.
- "Include files outside the root directory" on.
- Ignored Build Step not set.
- "Skip unaffected projects" on, but in practice both projects built on almost every push.
- Elastic build machine on standard (4 cores).
- Team concurrent builds: 1. Queued superseded builds are canceled before they start; all 104 cancellations had no build time.
- Standard Protection on preview URLs.
- Billing period 14 Nov to 14 Dec. Build CPU so far is covered by the Pro plan's included credit (billed cost US$0 to 16 Nov).

Before this change, every push to any branch built both projects. This was verified on docs-only PR #137 and API-test-only PR #111.

## 4. Expected effect (after) and how it is measured

| Change | Builds removed | Share of Build CPU | Confidence |
|---|---|---|---|
| API previews off | about 81% of API deployments (441 of 544 were previews) | about 45% (0.58 × 0.81) | High. No build is created at all. |
| Web docs-only and API-only skip | estimated 15 to 35% of web previews | about 5 to 12% | Medium. It depends on the PR mix, and on whether a build canceled by the ignore step bills a rounded minute. Vercel does not document this. |
| Together | | **about 50 to 55% expected (45% conservative, 57% optimistic)** | |

Measure after one week with the same read-only queries:
- deployments per project by target and state;
- web previews CANCELED by the ignore step;
- Build CPU per project per day (billing charges).

Compare against section 3.

## 5. Tests and verification

- `tests/ops/vercel-ignore-build.test.ts` runs in the Unit job (root `vitest run`):
  - real git repositories for skip cases and for build cases (shared packages, contracts, lockfile, manifests, config, CI, tooling, desktop, unknown paths, mixed sets);
  - production, an unset environment, an empty diff, a malformed, unknown or unfetchable SHA, and running outside a repository;
  - the comparison with `main` for a branch's first deployment;
  - parity with CI's docs rule;
  - the web dependency closure;
  - both `vercel.json` files.
  The tests were mutation-checked: an always-skip script fails 33 of 39 tests, an always-build script fails 8, and widening API-only to `apps/*` fails 5.
- Live checks on the PR branch:
  - A commit that changes `apps/web/vercel.json` must build a web preview.
  - A later docs-only commit must show the web preview as canceled by the Ignored Build Step.
  - No `Vercel – business-os` status may appear on either commit.
- After merge (queue step 5): both projects must show a READY production deployment for the merge commit, and `GET https://app.pixakova.com/api/v1/health` must return `status: ok`. If the API project shows no production deployment for the merge commit, revert at once (section 6). The previous production deployment stays live meanwhile.

## 6. Rollback

Everything is in the repository. Revert the PR, or delete `git` from `apps/api/vercel.json` and `ignoreCommand` from `apps/web/vercel.json`. The next push restores the old behaviour. No dashboard setting was changed. Do not "fix" a skipped preview by editing dashboard settings; redeploy it from the Vercel dashboard or push a commit.

## 7. Spend controls (owner dashboard only)

Path: Vercel dashboard → team **pixakova** → **Settings** → **Billing** → **Spend Management**.

- Notifications are automatic for any budget (50%, 75% and 100%).
- **Leave "Pause production deployments" off.** Pausing returns HTTP 503 for production, which is never acceptable here ([Spend Management docs](https://vercel.com/docs/spend-management)).
- A webhook action is optional.
- On Pro, a team budget counts only usage beyond the monthly credit.

The public API has no read endpoint for these settings, so their current state is recorded by the owner, not by this document.
