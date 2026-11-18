# CIQ-A6A approval continuity verifier (shadow mode only)

Implements packages **A6A-1** (verifier core, policy, tests) and **A6A-2** (read-only shadow workflow) of
`docs/ciq-a6-autonomous-merge-governance.md` (design PR #160, revision 2). Regan's review of that design
(2026-11-18) gave conditional architecture approval for further development only: build the read-only
verifier and run it in shadow mode. **Nothing here has merge or approval authority.**

## What it does, and what it does not

It answers one question: does an existing, independently given ChatGPT/Codex merge verdict on head `A`
still cover a synced candidate `C`? It returns `APPROVAL_CONTINUES`, `INTEGRATION_VALIDATION_REQUIRED`,
`FOCUSED_REAUDIT_REQUIRED` or `BLOCKED` (design §4.3) and records every input hash.

It does **not** change how any PR is approved or merged. It is not a required check, holds no write
token, posts no comment, label, check or status, and never marks ready, pushes or merges. The current
rule in `docs/agent-task-protocol.md` "Approval follows content" (exact head, or the same patch-id after a
conflict-free sync, otherwise a fresh verdict) keeps governing every merge. The policy refuses
`continuity_mode: enforce`; enforcement needs D-A6-1, the §14.3 shadow exit criteria, A6P and its own
package.

## Layout

| File | Role |
|---|---|
| `.github/merge-governance/policy.json` | Risk classes, critical paths, limits, `continuity_mode` (`shadow`). Read only from the checkout of `main` the verifier runs from. Critical. |
| `engine.py` | L0 reproducible merge (`git merge-tree --merge-base=B M A`, tree equality), L2 token-level composition, class rules (§6.2), overlays (migrations, contracts, restrictions). Read-only git allow-list. |
| `verdicts.py` | Verdict intake: provenance (connector slug, unedited, names the PR), v1 (same rules as `scripts/merge-queue/verdict-status.sh`), v2 fenced `approval` block (§4.2, D-A6-5 pending), restricting inputs from any source (§5.3). |
| `policy.py` | Policy loading and path classification (fail closed: unknown → Elevated, unparseable → Critical). |
| `ghapi.py` | GitHub REST client that can only send GET to api.github.com and refuses redirects. |
| `shadow.py` | Evaluates PRs for the shadow workflow; aggregates the §14.3 shadow report. |
| `record.py` | Result records with an `inputs_sha256` and a hash of the verifier sources. |
| `verify.py` | Command line: `evaluate` (offline), `shadow`, `report`. |
| `tests/` | 88 tests: engine scenarios and adversarial cases, verdict parsing, replay of PRs 119/120/122/124, shadow report, read-only guards. |
| `.github/workflows/approval-continuity.yml` | Shadow workflow: `workflow_run` after CI and `workflow_dispatch`, from `main` only, read permissions only. |
| `.github/workflows/merge-governance-selftest.yml` | Runs the tests on PRs and pushes that touch these files. Read-only, not required. |

## Running it

```sh
python3 -I scripts/merge-governance/continuity/run_tests.py           # all tests (replay skips if commits are missing)
python3 -I scripts/merge-governance/continuity/verify.py evaluate \
  --approved <audited head> --candidate <synced head> [--base <stacked base>] [--main origin/main]
python3 -I scripts/merge-governance/continuity/verify.py shadow --out-dir out [--pr N]   # read-only GitHub + git fetch
python3 -I scripts/merge-governance/continuity/verify.py report --dir <artifacts> [--annotations ann.json]
```

Always use `python3 -I` and run it from a checkout of `main`, so the policy and code are the trusted ones.

## Shadow mode procedure (§14.3)

1. After every CI run of a pull request, the workflow evaluates that PR's newest valid connector verdict
   against its current head and uploads `continuity-shadow-<run>` (kept 90 days). A stale candidate also
   gets a secondary result against the newest `main` commit it contains.
2. Anyone can dispatch the workflow with `mode: report` to aggregate the artifacts.
3. The comparison with the independent audit is added offline as an annotations file, keyed by
   `inputs_sha256`:
   ```json
   {"<inputs_sha256>": {"audit": "no-substantive-change", "source": "<link to the audit or verdict>"},
    "<inputs_sha256>": {"explained": "real post-verdict commits; stricter result correct", "source": "..."}}
   ```
   `audit` is `no-substantive-change` or `substantive-change`. A carried result (`APPROVAL_CONTINUES` or
   `INTEGRATION_VALIDATION_REQUIRED`) whose audit found a substantive change is a **false approval**: it
   resets the count, so the window restarts after it.
4. The report checks criteria 1 to 5: at least 14 days **and** at least 40 counted decisions in the window;
   the category minimums (10 where main changed PR files, 5 textual conflicts, 5 Elevated or Critical,
   2 stacked, 2 with commits after the verdict); zero false approvals and every carried decision compared
   with an audit; every stricter result explained; zero unexplained verifier errors. Exact-head decisions
   and duplicates do not count. Criterion 6 (ChatGPT audit of the report, then Regan's own approval of
   D-A6-1) and the A6P concurrency proof stay outside the tool, and the tool never changes a mode.

## Replay of PRs 119, 120, 122 and 124 (real commits, real policy)

| PR | Step | Result | Note |
|---|---|---|---|
| #124 | `0f953c2` → `0aba1b0` | INTEGRATION_VALIDATION_REQUIRED (L0) | main changed `app.tsx`, `index.ts` |
| #124 | `0aba1b0` → `2ae0a42` | INTEGRATION_VALIDATION_REQUIRED (L0) | stricter than the prototype: main changed `packages/contracts` (contracts overlay) |
| #119 | `fd35003` → `421757d` → `b7af043` | INTEGRATION_VALIDATION_REQUIRED (L2) | compositions in `index.ts`, `app.tsx`; Elevated |
| #120 | `74b3788` → `a2a8b50` → `916462e` | FOCUSED_REAUDIT_REQUIRED (L2) | stricter than the prototype: #120 is Critical (OAuth callback route, provider adapters, members screen), and a Critical PR never carries an approval through a composition (§6.2). The packet is the composed `app.tsx`/`registry.ts` lines only. |
| #122 | `f2309a1` (base `fd35003`) → `972134e`, `1fb5882` | INTEGRATION_VALIDATION_REQUIRED (L0) | Critical (members, invitations, ownership), but main overlapped only the non-critical `app.tsx` |

No step is a false approval. A tampered copy of #119's real sync (Scheduling dropped from the App
signature, built in a throwaway repository on the real objects) gives `FOCUSED_REAUDIT_REQUIRED`.

## Known limits (for the audit)

- **Shadow only.** No ledger, lease, controller, signing or `Merge authority` check (A6B, A6P, Phase 2).
- **Migrations are always `BLOCKED`.** Migration prerequisites (§7.6) belong to the controller; the
  verifier does not read apply records.
- **v1 verdicts on stacked PRs** use the merge-base as the base, so the parent's delta is counted too
  (stricter, never looser). Only a v2 `base:` gives the stacked base (D-A6-8 pending). A PR whose base is
  not `main` is skipped until it is retargeted.
- **Composition is syntactic** (§18): L2 proves the resolution equals a token-level merge of both sides,
  not that the code is right. It never yields `APPROVAL_CONTINUES`, and never applies to critical files
  or Critical PRs.
- `git merge-tree --write-tree` stores unreferenced tree objects in the runner's local object database;
  no ref, index or working-tree file is written.
- The workflows pin actions by major tag (`actions/checkout@v4`, `actions/upload-artifact@v4`), as the
  rest of this repository does.
- The keyword rules for Critical are deliberately broad (`token`, `member`, `auth` …) and will mark some
  ordinary files Critical. That is stricter, never looser, and is what shadow mode will measure.
