"""CIQ-A6A-2 shadow mode: evaluate PRs read-only and aggregate the shadow report (§14.3).

Shadow mode has no effect on any merge. The current rule (exact head, or the same patch-id with a
conflict-free sync, otherwise a fresh verdict) keeps governing every PR. This module only reads
GitHub (GET) and git objects, and writes result files into a local output directory.
"""
import datetime as dt
import json
import os
import re
import subprocess

import engine
import record
import verdicts

SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def git_fetch(repo_dir, refspecs):
    """Fetch objects into the local checkout (remote-tracking refs only; nothing is pushed)."""
    for spec in refspecs:
        if not re.match(r"^\+?[A-Za-z0-9_./:-]+$", spec):
            raise engine.VerifierError(f"refusing unusual refspec {spec!r}")
    p = subprocess.run(["git", "-C", repo_dir, "fetch", "--no-tags", "--quiet", "origin", *refspecs],
                       capture_output=True, timeout=600)
    if p.returncode != 0:
        raise engine.VerifierError("git fetch failed: " + p.stderr.decode("utf-8", "replace")[:300])


def have_commit(git, sha):
    try:
        git.commit(sha)
        return True
    except engine.VerifierError:
        return False


def evaluate_pr(gh, git, policy, pr, *, candidate=None, comment_id=None, fetch=git_fetch, run=None):
    """Evaluate one PR. Returns (record or None, skip reason or None, secondary record or None)."""
    info = gh.pull(pr)
    if info.get("base", {}).get("ref") != "main":
        return None, f"base is {info.get('base', {}).get('ref')!r}, not main (stacked PR not retargeted)", None
    head = info["head"]["sha"]
    cand = candidate or head
    if not SHA_RE.match(cand):
        raise engine.VerifierError("candidate must be a full 40-hex SHA")
    comments = gh.issue_comments(pr)
    if comment_id:
        chosen = [c for c in comments if str(c.get("id")) == str(comment_id)]
        if not chosen:
            return None, f"comment {comment_id} is not on PR #{pr}", None
        verdict, why = verdicts.parse_comment(chosen[0], pr, policy.connector_slug)
        if verdict is None:
            return None, f"comment {comment_id} is not a valid verdict: {why}", None
    else:
        verdict, rejected = verdicts.newest_verdict(comments, pr, policy.connector_slug)
        if verdict is None:
            reason = "no valid connector merge verdict"
            if rejected:
                reason += " (rejected: " + "; ".join(f"{r['comment_id']}: {r['reason']}" for r in rejected[-3:]) + ")"
            return None, reason, None
    fetch(git.repo_dir, ["+refs/heads/main:refs/remotes/origin/main", f"+refs/pull/{int(pr)}/head:refs/remotes/pr/{int(pr)}"])
    missing = [s for s in (verdict["head"], verdict.get("base"), cand) if s and not have_commit(git, s)]
    if missing:
        fetch(git.repo_dir, missing)
    main_tip = git.commit("refs/remotes/origin/main")
    labels = [lb.get("name") for lb in info.get("labels", [])]
    holds = verdicts.restrictions_after(comments, labels, verdict["created_at"])
    gv = git.version()

    def one(main):
        try:
            out = engine.evaluate(
                git, policy, verdict["head"], verdict.get("base"), cand, main,
                restrictions=verdict.get("restrictions") or (), declared_class=verdict.get("class"),
                base_source="verdict" if verdict.get("base") else "merge-base",
            )
        except engine.VerifierError as e:
            out = record.error_outcome(str(e))
        if holds:
            out["result"] = engine.stricter(out["result"], engine.BLOCKED)
            out.setdefault("reasons", []).extend(holds)
        return record.build(out, pr=pr, verdict=verdict, policy=policy, git_version=gv, run=run,
                            candidate_is_approved_head=(cand == verdict["head"]))

    rec = one(main_tip)
    rec["draft"] = bool(info.get("draft"))
    rec["verdict_ready"] = verdict.get("ready")
    secondary = None
    if rec["level"] == "precondition" and rec["reasons"][:1] == ["stale candidate: it does not contain the current main tip"]:
        contained = git.merge_base(cand, main_tip)
        if contained:
            secondary = one(contained)
            secondary["evaluated_against"] = "newest main commit the candidate contains (stale in reality)"
    return rec, None, secondary


def targets_from_event(event_name, event, inputs):
    """[(pr, candidate or None)] to evaluate, from the triggering event."""
    if event_name == "workflow_run":
        wr = event.get("workflow_run") or {}
        if wr.get("event") != "pull_request":
            return []
        head = wr.get("head_sha")
        return [(int(p["number"]), head) for p in (wr.get("pull_requests") or []) if str(p.get("number", "")).isdigit()]
    if event_name == "workflow_dispatch":
        pr = (inputs.get("pr") or "").strip()
        cand = (inputs.get("candidate_sha") or "").strip().lower() or None
        if pr:
            if not re.fullmatch(r"[0-9]{1,6}", pr):
                raise ValueError("pr must be a number")
            if cand and not SHA_RE.match(cand):
                raise ValueError("candidate_sha must be a full 40-hex SHA")
            return [(int(pr), cand)]
        return None  # all open PRs into main
    return []


# --- report ---------------------------------------------------------------------------------

CARRIED = (engine.APPROVAL_CONTINUES, engine.INTEGRATION_VALIDATION_REQUIRED)
STRICTER = (engine.FOCUSED_REAUDIT_REQUIRED, engine.BLOCKED)
CATEGORY_MINIMUMS = {
    "main_changed_pr_files": 10,
    "textual_conflict": 5,
    "elevated_or_critical": 5,
    "stacked": 2,
    "commits_after_verdict": 2,
}
MIN_DECISIONS = 40
MIN_DAYS = 14


def load_records(directory):
    recs = []
    for root, _dirs, files in os.walk(directory):
        for name in sorted(files):
            if not name.endswith(".jsonl"):
                continue
            with open(os.path.join(root, name), encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        recs.append(json.loads(line))
    return recs


def decision_key(rec):
    i = rec["inputs"]
    v = i.get("verdict") or {}
    s = i.get("shas") or {}
    return (i.get("pr"), v.get("approval_id"), s.get("candidate"), s.get("main"))


def categories(rec):
    f = rec.get("files") or {}
    cats = []
    if f.get("overlap") or f.get("conflicted_in_replay"):
        cats.append("main_changed_pr_files")
    if f.get("conflicted_in_replay"):
        cats.append("textual_conflict")
    if rec.get("risk_class") in ("elevated", "critical"):
        cats.append("elevated_or_critical")
    if ((rec["inputs"].get("shas") or {}).get("base_source")) == "verdict":
        cats.append("stacked")
    if any("outside any conflict" in r for r in rec.get("reasons", [])):
        cats.append("commits_after_verdict")
    return cats


def _ts(rec):
    return (rec.get("run") or {}).get("evaluated_at") or ""


def report(records, annotations=None, now=None):
    """Aggregate shadow decisions against the §14.3 exit criteria. Never changes any mode.

    annotations: {inputs_sha256: {"audit": "no-substantive-change" | "substantive-change",
                                  "explained": "<why a stricter result or error is correct>",
                                  "source": "<link to the audit>"}}
    """
    annotations = annotations or {}
    now = now or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    latest = {}
    for rec in records:
        eff = rec
        if rec.get("secondary"):
            eff = dict(rec["secondary"], run=rec.get("run"))
        k = decision_key(eff)
        if k not in latest or _ts(eff) > _ts(latest[k]):
            latest[k] = eff
    decisions = sorted(latest.values(), key=_ts)
    counted = [d for d in decisions if not d.get("exact_head")]

    false_approvals, unexplained_stricter, unexplained_errors, unreviewed = [], [], [], []
    for d in counted:
        a = annotations.get(d["inputs_sha256"], {})
        if d["result"] in CARRIED:
            if a.get("audit") == "substantive-change":
                false_approvals.append(d)
            elif a.get("audit") != "no-substantive-change":
                unreviewed.append(d)
        elif d.get("level") == "verifier error":
            if not a.get("explained"):
                unexplained_errors.append(d)
        elif d["result"] in STRICTER and not a.get("explained"):
            unexplained_stricter.append(d)

    # One false approval resets the count: the window starts after the latest one.
    window = counted
    if false_approvals:
        last = max(_ts(d) for d in false_approvals)
        window = [d for d in counted if _ts(d) > last]
    cat_counts = {c: 0 for c in CATEGORY_MINIMUMS}
    for d in window:
        for c in categories(d):
            cat_counts[c] += 1
    days = 0.0
    if window:
        start = dt.datetime.strptime(_ts(window[0]), "%Y-%m-%dT%H:%M:%SZ")
        end = dt.datetime.strptime(now, "%Y-%m-%dT%H:%M:%SZ")
        days = (end - start).total_seconds() / 86400
    window_keys = {d["inputs_sha256"] for d in window}
    criteria = {
        "1_two_weeks_and_40_decisions": days >= MIN_DAYS and len(window) >= MIN_DECISIONS,
        "2_representative_categories": all(cat_counts[c] >= m for c, m in CATEGORY_MINIMUMS.items()),
        "3_zero_false_approvals_and_all_carried_reviewed":
            not false_approvals and not [d for d in unreviewed if d["inputs_sha256"] in window_keys],
        "4_every_stricter_result_explained": not [d for d in unexplained_stricter if d["inputs_sha256"] in window_keys],
        "5_zero_unexplained_verifier_errors": not [d for d in unexplained_errors if d["inputs_sha256"] in window_keys],
    }
    return {
        "generated_at": now,
        "effect": record.EFFECT,
        "decisions_total": len(decisions),
        "decisions_counted": len(counted),
        "window_decisions": len(window),
        "window_days": round(days, 2),
        "category_counts": cat_counts,
        "category_minimums": CATEGORY_MINIMUMS,
        "false_approvals": [d["inputs_sha256"] for d in false_approvals],
        "carried_without_audit_comparison": [d["inputs_sha256"] for d in unreviewed],
        "stricter_without_explanation": [d["inputs_sha256"] for d in unexplained_stricter],
        "verifier_errors_without_explanation": [d["inputs_sha256"] for d in unexplained_errors],
        "criteria_checked_here": criteria,
        "criteria_not_checked_here": [
            "adversarial tests 11 and 12 pass against the real verifier (§14.1)",
            "independent ChatGPT audit of this report, then Regan's own approval of D-A6-1",
            "A6P concurrency proof before any unattended merge (§7.3a)",
        ],
        "all_checked_criteria_met": all(criteria.values()),
        "decisions": [
            {"inputs_sha256": d["inputs_sha256"], "pr": d["inputs"].get("pr"), "at": _ts(d),
             "result": d["result"], "level": d.get("level"), "class": d.get("risk_class"),
             "categories": categories(d), "audit": annotations.get(d["inputs_sha256"], {}).get("audit")}
            for d in decisions
        ],
    }


def markdown_summary(records):
    lines = ["## Approval continuity (shadow)", "", f"_{record.EFFECT}_", "",
             "| PR | approved → candidate | result | level | class |", "|---|---|---|---|---|"]
    for r in records:
        s = r["inputs"].get("shas") or {}
        a, c = (s.get("approved_head") or "?")[:7], (s.get("candidate") or "?")[:7]
        lines.append(f"| #{r['inputs'].get('pr')} | `{a}` → `{c}` | {r['result']} | {r.get('level')} | {r.get('risk_class')} |")
        for reason in r.get("reasons", [])[:6]:
            lines.append(f"|  | | {reason[:200]} | | |")
    return "\n".join(lines) + "\n"
