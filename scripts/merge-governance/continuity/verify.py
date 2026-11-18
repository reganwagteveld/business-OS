#!/usr/bin/env python3
"""CIQ-A6A approval continuity verifier: command line (docs/ciq-a6-autonomous-merge-governance.md §4).

Read-only and advisory. In A6A the policy mode is 'shadow' (or 'off'); 'enforce' is refused. No
subcommand writes to GitHub, pushes, labels, comments, marks ready or merges.

  verify.py evaluate --approved SHA --candidate SHA [--base SHA] [--main REV] [--class C]
                     [--restriction R]... [--repo DIR] [--policy FILE]
      Offline: git objects only. Prints the result record (JSON). Exit 0 whatever the result.

  verify.py shadow --out-dir DIR [--event-name NAME --event-file FILE] [--pr N] [--candidate SHA]
                   [--verdict-comment ID] [--repo DIR] [--policy FILE]
      Read-only GitHub (GET) plus git fetch. Writes DIR/decisions.jsonl and DIR/summary.md.

  verify.py report --dir DIR [--annotations FILE] [--now ISO8601]
      Aggregates decisions against the §14.3 shadow exit criteria. Prints JSON.

Always run it with `python3 -I` from a checkout of main: the policy is read from that checkout
(default: .github/merge-governance/policy.json next to these scripts), never from a pull request.
"""
import argparse
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import engine  # noqa: E402
import record  # noqa: E402
import shadow  # noqa: E402
from policy import Policy, PolicyError, CLASSES  # noqa: E402

DEFAULT_POLICY = os.path.normpath(os.path.join(HERE, "..", "..", "..", ".github", "merge-governance", "policy.json"))


def _now():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def cmd_evaluate(a):
    policy = Policy.load(a.policy)
    git = engine.Git(a.repo)
    for r in a.restriction:
        if not shadow.verdicts.RESTRICTION_RE.match(r):
            raise SystemExit(f"unknown restriction {r!r}")
    try:
        out = engine.evaluate(git, policy, a.approved, a.base, a.candidate, a.main,
                              restrictions=a.restriction, declared_class=a.risk_class,
                              base_source="argument" if a.base else "merge-base")
    except engine.VerifierError as e:
        out = record.error_outcome(str(e))
    rec = record.build(out, pr=a.pr, verdict=None, policy=policy, git_version=git.version(),
                       run={"evaluated_at": _now(), "mode": "offline"})
    print(json.dumps(rec, indent=2, sort_keys=True))
    return 0


def cmd_shadow(a):
    from ghapi import ReadOnlyGitHub
    policy = Policy.load(a.policy)
    os.makedirs(a.out_dir, exist_ok=True)
    if policy.mode == "off":
        with open(os.path.join(a.out_dir, "summary.md"), "w") as f:
            f.write("Approval continuity: policy mode is 'off'; nothing evaluated.\n")
        return 0
    gh = ReadOnlyGitHub(a.github_repo)
    git = engine.Git(a.repo)
    event = {}
    if a.event_file:
        with open(a.event_file, encoding="utf-8") as f:
            event = json.load(f)
    inputs = {"pr": a.pr or "", "candidate_sha": a.candidate or ""}
    targets = shadow.targets_from_event(a.event_name, event, inputs)
    if targets is None:
        targets = [(int(p["number"]), None) for p in gh.open_pulls()]
    run = {
        "evaluated_at": _now(),
        "event": a.event_name,
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT"),
        "workflow_ref": os.environ.get("GITHUB_WORKFLOW_REF"),
        "workflow_sha": os.environ.get("GITHUB_SHA"),
        "ref": os.environ.get("GITHUB_REF"),
    }
    records, skipped = [], []
    for pr, cand in targets:
        try:
            rec, skip, secondary = shadow.evaluate_pr(gh, git, policy, pr, candidate=cand,
                                                      comment_id=a.verdict_comment, run=run)
        except Exception as e:  # any failure is BLOCKED: verifier error, never a pass
            rec, skip, secondary = record.build(record.error_outcome(f"{type(e).__name__}: {e}"), pr=pr, verdict=None,
                                                policy=policy, git_version=git.version(), run=run), None, None
        if skip:
            skipped.append({"pr": pr, "reason": skip})
            continue
        if secondary:
            rec["secondary"] = secondary
        records.append(rec)
    with open(os.path.join(a.out_dir, "decisions.jsonl"), "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    with open(os.path.join(a.out_dir, "skipped.json"), "w", encoding="utf-8") as f:
        json.dump(skipped, f, indent=2)
    summary = shadow.markdown_summary(records)
    if skipped:
        summary += "\nSkipped (no decision): " + "; ".join(f"#{s['pr']}: {s['reason']}" for s in skipped) + "\n"
    with open(os.path.join(a.out_dir, "summary.md"), "w", encoding="utf-8") as f:
        f.write(summary)
    print(summary)
    return 0


def cmd_report(a):
    ann = {}
    if a.annotations:
        with open(a.annotations, encoding="utf-8") as f:
            ann = json.load(f)
    rep = shadow.report(shadow.load_records(a.dir), ann, now=a.now)
    print(json.dumps(rep, indent=2, sort_keys=True))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    e = sub.add_parser("evaluate")
    e.add_argument("--approved", required=True)
    e.add_argument("--candidate", required=True)
    e.add_argument("--base")
    e.add_argument("--main", default="origin/main")
    e.add_argument("--class", dest="risk_class", choices=CLASSES)
    e.add_argument("--restriction", action="append", default=[])
    e.add_argument("--pr", type=int)
    e.add_argument("--repo", default=".")
    e.add_argument("--policy", default=DEFAULT_POLICY)

    s = sub.add_parser("shadow")
    s.add_argument("--out-dir", required=True)
    s.add_argument("--event-name", default="workflow_dispatch")
    s.add_argument("--event-file")
    s.add_argument("--pr")
    s.add_argument("--candidate")
    s.add_argument("--verdict-comment")
    s.add_argument("--github-repo", default=os.environ.get("GITHUB_REPOSITORY", "reganwagteveld/business-OS"))
    s.add_argument("--repo", default=".")
    s.add_argument("--policy", default=DEFAULT_POLICY)

    r = sub.add_parser("report")
    r.add_argument("--dir", required=True)
    r.add_argument("--annotations")
    r.add_argument("--now")

    a = p.parse_args(argv)
    for name in ("approved", "candidate", "base", "main"):
        v = getattr(a, name, None)
        if v is not None and (v.startswith("-") or not v.strip()):
            raise SystemExit(f"--{name}: revision must not start with '-'")
    if getattr(a, "verdict_comment", None) and not str(a.verdict_comment).isdigit():
        raise SystemExit("--verdict-comment must be a number")
    try:
        return {"evaluate": cmd_evaluate, "shadow": cmd_shadow, "report": cmd_report}[a.cmd](a)
    except PolicyError as e:
        raise SystemExit(f"policy error: {e}")


if __name__ == "__main__":
    sys.exit(main())
