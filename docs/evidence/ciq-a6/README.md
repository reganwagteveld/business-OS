# CIQ-A6 evidence

Read-only material behind `docs/ciq-a6-autonomous-merge-governance.md`. Nothing here is run by CI or confers approval.

| File | What it is | How to reproduce |
|---|---|---|
| `continuity-prototype.py` | Prototype of the A6A classifier (git objects only, no network). Not the verifier. | `MAIN=<main sha> python3 -I docs/evidence/ciq-a6/continuity-prototype.py <approved> <candidate> [approved_base]` |
| `continuity-prototype.test.sh` | 10 synthetic scenarios in a throwaway repository (acceptance tests 1–6, 8, 12 and stacked PRs). | `docs/evidence/ciq-a6/continuity-prototype.test.sh` |
| `merge-verdicts-2026-11-17.csv` | Every PR merged 2026-11-17 06:47 to 2026-11-18 04:53 UTC: connector `APPROVED — EXECUTE: MERGE` comments, distinct labelled heads, other connector comments, sync merge commits. | `gh api repos/{owner}/{repo}/issues/{n}/comments` and `/pulls/{n}/commits`, first non-empty line and the CIQ-A3 head rule |

The replay pairs in §11 of the document were run with `MAIN` set to the main commit each candidate was synced onto (`git merge-base <candidate> origin/main`), and for the stacked PR #122 with `approved_base` = the parent PR's audited head (`fd35003`).
