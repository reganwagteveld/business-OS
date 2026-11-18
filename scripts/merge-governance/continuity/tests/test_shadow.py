"""Shadow mode: PR evaluation through a fake read-only GitHub, event targeting, and the §14.3 exit
criteria in the report (two weeks AND 40 representative decisions, zero unexplained false
approvals, one false approval resets the count)."""
import datetime as dt
import unittest

from helpers import Repo, load_policy
import engine
import shadow

C = "chatgpt-codex-connector"
T0 = "2026-11-17T12:00:00Z"


class FakeGitHub:
    def __init__(self, pulls, comments):
        self.pulls, self.comments = pulls, comments

    def pull(self, n):
        return self.pulls[n]

    def issue_comments(self, n):
        return self.comments.get(n, [])


def verdict(pr, head, cid=1, at=T0, slug=C, extra=""):
    return {"id": cid, "html_url": "u", "created_at": at, "updated_at": at,
            "performed_via_github_app": {"slug": slug} if slug else None,
            "body": f"APPROVED — EXECUTE: MERGE\nPR #{pr}, exact reviewed head {head}\n{extra}"}


class EvaluatePR(unittest.TestCase):
    def setUp(self):
        r = self.r = Repo()
        r.write("packages/app/src/zones/x/page.tsx", "a\n")
        r.write("docs/notes.md", "one\n")
        base = r.commit("base")
        r.branch("pr", base)
        r.write("packages/app/src/zones/x/page.tsx", "b\n")
        self.A = r.commit("pr")
        r.checkout("main")
        r.write("docs/notes.md", "two\n")
        r.commit("main")
        r.branch("pr", self.A)
        r.merge_main()
        self.C = r.head()
        self.policy = load_policy()

    def tearDown(self):
        self.r.close()

    def fetch(self, repo_dir, specs):
        self.r.git("update-ref", "refs/remotes/origin/main", "main")

    def pull(self, head, base="main", labels=()):
        return {"base": {"ref": base}, "head": {"sha": head}, "draft": False, "labels": [{"name": x} for x in labels]}

    def run_pr(self, gh, **kw):
        return shadow.evaluate_pr(gh, self.r.vgit, self.policy, 7, fetch=self.fetch, **kw)

    def test_clean_sync_continues_and_record_is_complete(self):
        gh = FakeGitHub({7: self.pull(self.C)}, {7: [verdict(7, self.A)]})
        rec, skip, sec = self.run_pr(gh, run={"evaluated_at": "2026-11-18T00:00:00Z"})
        self.assertIsNone(skip)
        self.assertEqual(rec["result"], engine.APPROVAL_CONTINUES)
        self.assertEqual(rec["inputs"]["verdict"]["head"], self.A)
        self.assertEqual(rec["inputs"]["policy_mode"], "shadow")
        self.assertIn("does not change", rec["effect"])
        self.assertEqual(len(rec["inputs_sha256"]), 64)

    def test_claude_posted_verdict_is_ignored(self):
        gh = FakeGitHub({7: self.pull(self.C)}, {7: [verdict(7, self.A, slug="claude")]})
        rec, skip, _ = self.run_pr(gh)
        self.assertIsNone(rec)
        self.assertIn("no valid connector merge verdict", skip)

    def test_hold_label_blocks(self):
        gh = FakeGitHub({7: self.pull(self.C, labels=["queue:held"])}, {7: [verdict(7, self.A)]})
        rec, _, _ = self.run_pr(gh)
        self.assertEqual(rec["result"], engine.BLOCKED)

    def test_changes_required_after_verdict_blocks_from_any_source(self):
        cr = {"id": 2, "created_at": "2026-11-17T13:00:00Z", "updated_at": "2026-11-17T13:00:00Z",
              "body": "CHANGES REQUIRED\nsee finding", "performed_via_github_app": None}
        gh = FakeGitHub({7: self.pull(self.C)}, {7: [verdict(7, self.A), cr]})
        rec, _, _ = self.run_pr(gh)
        self.assertEqual(rec["result"], engine.BLOCKED)

    def test_stacked_pr_not_retargeted_is_skipped(self):
        gh = FakeGitHub({7: self.pull(self.C, base="feature")}, {7: [verdict(7, self.A)]})
        rec, skip, _ = self.run_pr(gh)
        self.assertIsNone(rec)
        self.assertIn("not main", skip)

    def test_stale_candidate_gets_a_secondary_result(self):
        self.r.checkout("main")
        self.r.write("docs/other.md", "x\n")
        self.r.commit("main moves")
        gh = FakeGitHub({7: self.pull(self.C)}, {7: [verdict(7, self.A)]})
        rec, _, sec = self.run_pr(gh)
        self.assertEqual(rec["result"], engine.BLOCKED)
        self.assertEqual(sec["result"], engine.APPROVAL_CONTINUES)

    def test_verifier_error_is_blocked_never_a_pass(self):
        gh = FakeGitHub({7: self.pull(self.C)}, {7: [verdict(7, "f" * 40)]})
        rec, _, _ = self.run_pr(gh)  # approved head does not exist
        self.assertEqual(rec["result"], engine.BLOCKED)
        self.assertEqual(rec["level"], "verifier error")


class Targets(unittest.TestCase):
    def test_workflow_run_pull_request(self):
        ev = {"workflow_run": {"event": "pull_request", "head_sha": "a" * 40, "pull_requests": [{"number": 12}]}}
        self.assertEqual(shadow.targets_from_event("workflow_run", ev, {}), [(12, "a" * 40)])

    def test_workflow_run_push_is_ignored(self):
        ev = {"workflow_run": {"event": "push", "head_sha": "a" * 40, "pull_requests": []}}
        self.assertEqual(shadow.targets_from_event("workflow_run", ev, {}), [])

    def test_dispatch_validation(self):
        self.assertIsNone(shadow.targets_from_event("workflow_dispatch", {}, {"pr": ""}))
        self.assertEqual(shadow.targets_from_event("workflow_dispatch", {}, {"pr": "5"}), [(5, None)])
        for bad in ({"pr": "5; rm -rf /"}, {"pr": "5", "candidate_sha": "main"}):
            with self.assertRaises(ValueError):
                shadow.targets_from_event("workflow_dispatch", {}, bad)

    def test_other_events_do_nothing(self):
        self.assertEqual(shadow.targets_from_event("pull_request_target", {}, {}), [])


def decision(i, at, result=engine.INTEGRATION_VALIDATION_REQUIRED, *, overlap=True, conflict=False,
             cls="elevated", stacked=False, post_verdict=False, exact=False, level="L0"):
    return {
        "inputs": {"pr": 100 + i, "verdict": {"approval_id": f"ap{i}"},
                   "shas": {"candidate": f"c{i}", "main": f"m{i}", "base_source": "verdict" if stacked else "merge-base"}},
        "inputs_sha256": f"h{i}",
        "result": result,
        "level": level,
        "risk_class": cls,
        "files": {"overlap": ["x"] if overlap else [], "conflicted_in_replay": ["x"] if conflict else []},
        "reasons": ["x: differs from the reproducible merge outside any conflict"] if post_verdict else [],
        "run": {"evaluated_at": at},
        "exact_head": exact,
    }


def ts(day, hour=0):
    return (dt.datetime(2026, 11, 18) + dt.timedelta(days=day, hours=hour)).strftime("%Y-%m-%dT%H:%M:%SZ")


def full_set(start_day=0, days=15):
    """45 representative decisions spread over `days` days, all compared with an audit."""
    recs, ann = [], {}
    for i in range(45):
        kw = {}
        if i < 6:
            kw = {"conflict": True, "level": "L2"}
        if 6 <= i < 9:
            kw = {"stacked": True}
        if 9 <= i < 12:
            kw = {"post_verdict": True, "result": engine.FOCUSED_REAUDIT_REQUIRED, "level": "L2"}
        recs.append(decision(i, ts(start_day + days * i / 44.0), **kw))
        ann[f"h{i}"] = ({"explained": "real post-verdict commits"} if 9 <= i < 12
                        else {"audit": "no-substantive-change"})
    return recs, ann


class Report(unittest.TestCase):
    def test_all_checked_criteria_met(self):
        recs, ann = full_set()
        rep = shadow.report(recs, ann, now=ts(15, 1))
        self.assertTrue(rep["all_checked_criteria_met"], rep["criteria_checked_here"])
        self.assertTrue(rep["criteria_not_checked_here"])  # audit, Regan, A6P stay outside the tool

    def test_forty_easy_decisions_in_two_days_are_not_enough(self):
        recs, ann = full_set(days=2)
        rep = shadow.report(recs, ann, now=ts(2, 1))
        self.assertFalse(rep["criteria_checked_here"]["1_two_weeks_and_40_decisions"])
        self.assertFalse(rep["all_checked_criteria_met"])

    def test_two_weeks_but_too_few_decisions(self):
        recs, ann = full_set()
        rep = shadow.report(recs[:39], ann, now=ts(30))
        self.assertFalse(rep["criteria_checked_here"]["1_two_weeks_and_40_decisions"])

    def test_unrepresentative_set_is_not_enough(self):
        recs = [decision(i, ts(15 * i / 44.0), conflict=False) for i in range(45)]
        ann = {f"h{i}": {"audit": "no-substantive-change"} for i in range(45)}
        rep = shadow.report(recs, ann, now=ts(16))
        self.assertFalse(rep["criteria_checked_here"]["2_representative_categories"])

    def test_one_false_approval_resets_the_count(self):
        recs, ann = full_set()
        ann["h40"] = {"audit": "substantive-change"}
        rep = shadow.report(recs, ann, now=ts(15, 1))
        self.assertEqual(rep["false_approvals"], ["h40"])
        self.assertLess(rep["window_decisions"], 5)
        self.assertFalse(rep["all_checked_criteria_met"])

    def test_carried_decision_without_audit_comparison_blocks_exit(self):
        recs, ann = full_set()
        del ann["h20"]
        rep = shadow.report(recs, ann, now=ts(15, 1))
        self.assertIn("h20", rep["carried_without_audit_comparison"])
        self.assertFalse(rep["criteria_checked_here"]["3_zero_false_approvals_and_all_carried_reviewed"])

    def test_unexplained_stricter_result_blocks_exit(self):
        recs, ann = full_set()
        ann["h10"] = {}
        rep = shadow.report(recs, ann, now=ts(15, 1))
        self.assertFalse(rep["criteria_checked_here"]["4_every_stricter_result_explained"])

    def test_unexplained_verifier_error_blocks_exit(self):
        recs, ann = full_set()
        recs.append(decision(99, ts(15), engine.BLOCKED, level="verifier error"))
        rep = shadow.report(recs, ann, now=ts(15, 1))
        self.assertFalse(rep["criteria_checked_here"]["5_zero_unexplained_verifier_errors"])

    def test_exact_head_and_duplicates_do_not_count(self):
        recs, ann = full_set()
        recs.append(decision(0, ts(1), exact=False))  # same key as h0, later run: deduplicated
        recs.append(decision(200, ts(3), exact=True))
        rep = shadow.report(recs, ann, now=ts(15, 1))
        self.assertEqual(rep["decisions_counted"], 45)


if __name__ == "__main__":
    unittest.main()
