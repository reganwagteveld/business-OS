"""Verdict intake (§4.2, §5.1 T3/T4, acceptance test 11). The v1 cases mirror
scripts/merge-queue/verdict-status.test.sh, so both parsers agree on today's format."""
import unittest

import helpers  # noqa: F401  (sets sys.path)
import verdicts

C = "chatgpt-codex-connector"
H = "0123456789abcdef0123456789abcdef01234567"
H2 = "fedcba9876543210fedcba9876543210fedcba98"
T = "2026-11-17T12:00:00Z"


def comment(body, slug=C, created=T, updated=T, cid=1):
    return {"id": cid, "html_url": "u", "created_at": created, "updated_at": updated, "body": body,
            "performed_via_github_app": ({"slug": slug} if slug else None)}


def valid(body, pr, **kw):
    v, _why = verdicts.parse_comment(comment(body, **kw), pr, C)
    return v


V1_CASES = [
    # name, expected valid, pr, kwargs, body
    ("plain verdict", True, 119, {}, f"APPROVED — EXECUTE: MERGE\nPR #119\nExact reviewed head SHA: `{H}`"),
    ("heading verdict", True, 141, {}, f"## APPROVED — EXECUTE: MERGE\nPR #141\n**Exact approved/reviewed head:** `{H}`"),
    ("bold verdict", True, 1, {}, f"**APPROVED — EXECUTE: MERGE**\nPR #1\n\n**Exact reviewed head:** `{H}`."),
    ("leading blank lines", True, 1, {}, f"\n\nAPPROVED — EXECUTE: MERGE\nPR #1 head {H}"),
    ("claude app", False, 1, {"slug": "claude"}, f"APPROVED — EXECUTE: MERGE\nPR #1 head {H}"),
    ("posted by hand (no app)", False, 1, {"slug": ""}, f"APPROVED — EXECUTE: MERGE\nPR #1 head {H}"),
    ("edited", False, 1, {"updated": "2026-11-17T12:05:00Z"}, f"APPROVED — EXECUTE: MERGE\nPR #1 head {H}"),
    ("conditional pass", False, 1, {}, f"CONDITIONAL PASS\nPR #1 head {H}"),
    ("audit pass", False, 1, {}, f"AUDIT PASS — PR #1\nhead {H}"),
    ("negated verdict", False, 1, {}, f"Disposition: HOLD, not `APPROVED — EXECUTE: MERGE`\nPR #1 head {H}"),
    ("verdict not on first line", False, 1, {}, f"## ChatGPT final re-audit\n**APPROVED — EXECUTE: MERGE** through the queue\nPR #1 head {H}"),
    ("verdict with trailing words", False, 1, {}, f"APPROVED — EXECUTE: MERGE (pending CI)\nPR #1 head {H}"),
    ("hyphen instead of em dash", False, 1, {}, f"APPROVED - EXECUTE: MERGE\nPR #1 head {H}"),
    ("migration verdict", False, 1, {}, f"APPROVED — EXECUTE: MIGRATION\nPR #1 head {H}"),
    ("quoted verdict", False, 1, {}, f"> APPROVED — EXECUTE: MERGE\nPR #1 head {H}"),
    ("no head SHA", False, 1, {}, "APPROVED — EXECUTE: MERGE\nPR #1"),
    ("short SHA only", False, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1 head {H[:7]}"),
    ("two different head SHAs", False, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1 head {H}\nprevious head {H2}"),
    ("base SHA on a non-head line", True, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1\nExact reviewed head SHA: {H}\nReviewed base SHA: {H2}"),
    ("earlier reviewed SHA ignored", True, 156, {},
     f"APPROVED — EXECUTE: MERGE\n\nPR #156, exact reviewed head {H}\n\nReady and merge PR #156.\n\nThe audit reviewed `{H2}`."),
    ("head commit label", True, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1 at head commit {H}"),
    ("same head named twice", True, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1, exact reviewed head {H}\nMerge on exact head `{H}` only."),
    ("SHA not labelled as head", False, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1 reviewed at {H}"),
    ("head word far from SHA", False, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1, the head was reviewed as commit {H}"),
    ("uppercase SHA is normalised", True, 1, {}, f"APPROVED — EXECUTE: MERGE\nPR #1 head {H.upper()}"),
    ("names another PR", False, 120, {}, f"APPROVED — EXECUTE: MERGE\nPR #119\nhead {H}"),
    ("workflow run number is not a PR", True, 123, {}, f"APPROVED — EXECUTE: MERGE\nPR #123, audited head {H}, CI run #44110822911 succeeded"),
    ("names no PR", False, 1, {}, f"APPROVED — EXECUTE: MERGE\nExact reviewed head SHA: {H}"),
]

READY_CASES = [
    ("dedicated line", True, "Ready and merge this draft PR through the serialized merge queue, within the scope below."),
    ("dedicated line, bold label", True, "**Ready and merge** this draft PR through the merge queue."),
    ("dedicated list item", True, "- Ready and merge this draft PR."),
    ("absent", False, ""),
    ("negated", False, "Do NOT ready and merge this PR."),
    ("negated on the dedicated line", False, "Ready and merge is not authorised yet."),
    ("never", False, "Never ready and merge before main CI."),
    ("conditional: if", False, "Ready and merge if Regan agrees."),
    ("conditional: once", False, "Ready and merge once #140 lands."),
    ("conditional: until", False, "Ready and merge, but not until CI is green."),
    ("conditional: subject to", False, "Ready and merge subject to owner approval."),
    ("conditional: pending", False, "Ready and merge pending the macOS job."),
    ("contradiction elsewhere", False, "Ready and merge this draft PR.\nDo not ready and merge before the owner replies."),
    ("quoted historical phrase", False, "> Ready and merge this draft PR."),
    ("quoted negation does not veto", True, "Ready and merge this draft PR.\n> earlier: do not ready and merge"),
    ("mid-sentence phrase", False, "The serialized merge queue may ready and merge only this patch."),
    ("inline code mention", False, "This is an explicit `ready and merge` approval."),
    ("different phrase", False, "Mark ready; merge later."),
]


def v2(*lines, prose=""):
    return "APPROVED — EXECUTE: MERGE\n\n```approval\n" + "\n".join(lines) + "\n```\n" + prose


class V1(unittest.TestCase):
    def test_cases(self):
        for name, want, pr, kw, body in V1_CASES:
            with self.subTest(name):
                self.assertEqual(valid(body, pr, **kw) is not None, want)

    def test_head_lowercased(self):
        self.assertEqual(valid(f"APPROVED — EXECUTE: MERGE\nPR #1 head {H.upper()}", 1)["head"], H)

    def test_ready(self):
        for name, want, extra in READY_CASES:
            with self.subTest(name):
                v = valid(f"APPROVED — EXECUTE: MERGE\nPR #1, exact reviewed head {H}\n{extra}", 1)
                self.assertIsNotNone(v)
                self.assertEqual(v["ready"], want)

    def test_reason_is_machine_readable(self):
        _v, why = verdicts.parse_comment(comment(f"APPROVED — EXECUTE: MERGE\nPR #1 head {H}\nprevious head {H2}"), 1, C)
        self.assertIn("more than one", why)


class V2(unittest.TestCase):
    def test_valid_block(self):
        v = valid(v2("pr: 124", f"head: {H}", f"base: {H2}", "ready: true", "class: elevated",
                     "restrictions: no-migration, flag-off:COMMUNICATIONS_CONNECT_ENABLED"), 124)
        self.assertEqual((v["format"], v["head"], v["base"], v["ready"], v["class"]), ("v2", H, H2, True, "elevated"))
        self.assertEqual(v["restrictions"], ["no-migration", "flag-off:COMMUNICATIONS_CONNECT_ENABLED"])

    def test_block_without_head_label_in_prose_is_fine(self):
        self.assertIsNotNone(valid(v2("pr: 1", f"head: {H}", prose="Audit summary for people."), 1))

    def test_rejections(self):
        cases = {
            "two blocks": v2("pr: 1", f"head: {H}") + "```approval\npr: 1\nhead: " + H + "\n```\n",
            "unknown key": v2("pr: 1", f"head: {H}", "approver: me"),
            "duplicate key": v2("pr: 1", f"head: {H}", f"head: {H}"),
            "short sha": v2("pr: 1", f"head: {H[:7]}"),
            "uppercase sha": v2("pr: 1", f"head: {H.upper()}"),
            "other pr": v2("pr: 2", f"head: {H}"),
            "missing head": v2("pr: 1"),
            "bad ready": v2("pr: 1", f"head: {H}", "ready: yes"),
            "bad class": v2("pr: 1", f"head: {H}", "class: low"),
            "unknown restriction": v2("pr: 1", f"head: {H}", "restrictions: anything-goes"),
            "prose contradicts block": v2("pr: 1", f"head: {H}", prose=f"Exact reviewed head {H2}"),
            "unterminated": "APPROVED — EXECUTE: MERGE\n```approval\npr: 1\nhead: " + H + "\n",
            "malformed line": v2("pr: 1", f"head: {H}", "just text"),
        }
        for name, body in cases.items():
            with self.subTest(name):
                self.assertIsNone(valid(body, 1))

    def test_quoted_or_indented_block_is_not_a_block(self):
        body = "APPROVED — EXECUTE: MERGE\n> ```approval\n> pr: 1\n> head: " + H + "\n> ```\n"
        self.assertIsNone(valid(body, 1))  # no block, and no v1 head label either

    def test_v2_still_needs_provenance(self):
        body = v2("pr: 1", f"head: {H}")
        self.assertIsNone(valid(body, 1, slug="claude"))
        self.assertIsNone(valid(body, 1, updated="2026-11-17T13:00:00Z"))


class Selection(unittest.TestCase):
    def test_newest_valid_and_rejections(self):
        cs = [
            comment(f"APPROVED — EXECUTE: MERGE\nPR #5 head {H}", cid=1),
            comment(f"APPROVED — EXECUTE: MERGE\nPR #5 head {H2}", cid=2, created="2026-11-17T13:00:00Z", updated="2026-11-17T13:00:00Z"),
            comment(f"APPROVED — EXECUTE: MERGE\nPR #5 head {H}\nhead {H2}", cid=3, created="2026-11-17T14:00:00Z", updated="2026-11-17T14:00:00Z"),
            comment(f"APPROVED — EXECUTE: MERGE\nPR #5 head {H}", slug="claude", cid=4, created="2026-11-17T15:00:00Z", updated="2026-11-17T15:00:00Z"),
        ]
        v, rejected = verdicts.newest_verdict(cs, 5, C)
        self.assertEqual(v["comment_id"], 2)
        self.assertEqual([r["comment_id"] for r in rejected], [3])

    def test_approval_id_binds_body(self):
        a = valid(f"APPROVED — EXECUTE: MERGE\nPR #1 head {H}", 1)
        b = valid(f"APPROVED — EXECUTE: MERGE\nPR #1 head {H} ", 1)
        self.assertNotEqual(a["approval_id"], b["approval_id"])

    def test_restrictions_from_any_source(self):
        cs = [
            comment("CHANGES REQUIRED\nold", slug="", created="2026-11-17T11:00:00Z"),
            comment("## CHANGES REQUIRED\nfrom a Claude thread", slug="claude", created="2026-11-17T13:00:00Z"),
        ]
        out = verdicts.restrictions_after(cs, ["queue:held", "queue:eligible"], T)
        self.assertEqual(len(out), 2)
        self.assertTrue(any("queue:held" in x for x in out))


if __name__ == "__main__":
    unittest.main()
