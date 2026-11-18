"""The verifier cannot act: read-only GitHub client, read-only git, shadow-only policy, and a static
guard on the shadow workflow (§5.1 verifier row, §8, T1, T2). A6A must not change how any PR is
approved or merged."""
import json
import os
import re
import unittest

from helpers import ROOT, POLICY_PATH, load_policy, Repo
import engine
import ghapi
from policy import Policy, PolicyError

WF_SHADOW = os.path.join(ROOT, ".github", "workflows", "approval-continuity.yml")
WF_SELFTEST = os.path.join(ROOT, ".github", "workflows", "merge-governance-selftest.yml")


def body(path):
    with open(path, encoding="utf-8") as f:
        return [ln for ln in f.read().splitlines() if not re.match(r"^\s*#", ln)]


def run_block_lines(lines):
    """Lines inside `run:` blocks (block scalars and one-line runs)."""
    out, in_run, indent = [], False, 0
    for ln in lines:
        stripped = ln.lstrip()
        cur = len(ln) - len(stripped)
        if in_run:
            if stripped and cur <= indent:
                in_run = False
            else:
                out.append(ln)
                continue
        m = re.match(r"^(\s*)(?:-\s+)?run:\s*(.*)$", ln)
        if m:
            if m.group(2).strip() in ("|", ">", "|-", ">-"):
                in_run, indent = True, len(m.group(1))
            else:
                out.append(m.group(2))
    return out


class ReadOnlyClient(unittest.TestCase):
    def test_only_get(self):
        gh = ghapi.ReadOnlyGitHub("o/r", token="x", opener=lambda *a, **k: self.fail("no network"))
        for method in ("POST", "PUT", "PATCH", "DELETE"):
            with self.assertRaises(PermissionError):
                gh.request(method, "repos/o/r/issues/1/comments")

    def test_only_api_host(self):
        gh = ghapi.ReadOnlyGitHub("o/r", token="x", opener=lambda *a, **k: self.fail("no network"))
        with self.assertRaises(ValueError):
            gh.request("GET", "https://example.com/x")

    def test_bad_repo_name(self):
        with self.assertRaises(ValueError):
            ghapi.ReadOnlyGitHub("o/r/../../x")


class ReadOnlyGit(unittest.TestCase):
    def test_write_commands_refused(self):
        g = engine.Git(ROOT)
        for sub in ("push", "commit", "update-ref", "merge", "checkout", "reset", "fetch", "config", "tag", "branch"):
            with self.assertRaises(engine.VerifierError):
                g.run(sub)

    def test_option_injection_in_revision(self):
        r = Repo()
        try:
            r.write("a", "a\n")
            r.commit("a")
            with self.assertRaises(engine.VerifierError):
                r.vgit.commit("--output=/tmp/x")
        finally:
            r.close()

    def test_no_refs_written_by_an_evaluation(self):
        r = Repo()
        try:
            r.write("docs/a.md", "a\n")
            b = r.commit("a")
            r.branch("p", b)
            r.write("docs/a.md", "p\n")
            a = r.commit("p")
            r.checkout("main")
            r.write("docs/b.md", "m\n")
            r.commit("m")
            r.branch("c", a)
            r.merge_main()
            before = r.git("for-each-ref"), r.git("status", "--porcelain")
            engine.evaluate(r.vgit, load_policy(), a, None, r.head(), "main")
            self.assertEqual(before, (r.git("for-each-ref"), r.git("status", "--porcelain")))
        finally:
            r.close()


class PolicyModes(unittest.TestCase):
    def test_checked_in_policy_is_shadow(self):
        self.assertEqual(Policy.load(POLICY_PATH).mode, "shadow")

    def test_enforce_is_refused(self):
        with open(POLICY_PATH, "rb") as f:
            data = json.loads(f.read())
        data["continuity_mode"] = "enforce"
        with self.assertRaises(PolicyError):
            Policy(json.dumps(data).encode())

    def test_malformed_policy_refused(self):
        for raw in (b"", b"{}", b"[]", b'{"schema": "ciq-a6/policy/v1", "continuity_mode": "shadow"}'):
            with self.assertRaises(PolicyError):
                Policy(raw)

    def test_classification_examples(self):
        p = load_policy()
        cases = {
            "docs/scheduling-s3.md": "routine",
            "docs/ui/screenshots/settings-a3/profile-dark-390-member.png": "routine",
            "packages/app/src/zones/finance/invoice-list.tsx": "routine",
            "packages/app/src/app.tsx": "elevated",
            "packages/app/src/shell/registry.ts": "elevated",
            "apps/api/src/modules/sales/server/summary.ts": "elevated",
            "packages/contracts/src/sales.ts": "elevated",
            "docs/scheduling-s1-integration.patch": "elevated",
            "something/unknown.xyz": "elevated",
            "CLAUDE.md": "critical",
            "docs/agent-task-protocol.md": "critical",
            "docs/merge-queue.md": "critical",
            ".github/workflows/ci.yml": "critical",
            ".github/merge-governance/policy.json": "critical",
            "scripts/merge-governance/continuity/engine.py": "critical",
            "apps/api/prisma/migrations/20990101000000_x/migration.sql": "critical",
            "apps/api/prisma/schema/tenancy.prisma": "critical",
            "apps/api/src/core/auth/session.ts": "critical",
            "packages/app/src/zones/settings/members.tsx": "critical",
            "packages/app/src/zones/settings/ownership.tsx": "critical",
            "apps/api/src/app/api/v1/communications/oauth/callback/route.ts": "critical",
            "package.json": "critical",
            "pnpm-lock.yaml": "critical",
            "apps/desktop/src-tauri/tauri.conf.json": "critical",
            "vercel.json": "critical",
            "../escape": "critical",
            "a//b": "critical",
        }
        for path, want in cases.items():
            with self.subTest(path):
                self.assertEqual(p.classify_path(path)[0], want)


class WorkflowGuard(unittest.TestCase):
    """Static guard on the shadow workflow text, in the style of release-workflow-guard.test.sh."""

    def setUp(self):
        self.lines = body(WF_SHADOW)
        self.text = "\n".join(self.lines)

    def forbid(self, name, pattern, text=None):
        with self.subTest(name):
            self.assertIsNone(re.search(pattern, text if text is not None else self.text, re.I | re.M), name)

    def test_forbidden(self):
        self.forbid("write permission", r"^\s*[a-z-]+:\s*write\s*$")
        self.forbid("write-all", r"write-all")
        self.forbid("OIDC token", r"id-token")
        self.forbid("secrets", r"secrets\.|secrets:\s*inherit")
        self.forbid("environment (credential gate)", r"^\s*environment:")
        self.forbid("pull_request_target", r"pull_request_target")
        self.forbid("plain pull_request trigger", r"^\s*pull_request\s*:")
        self.forbid("push trigger", r"^\s*push\s*:")
        self.forbid("persisted credentials", r"persist-credentials:\s*true")
        self.forbid("git push / tag", r"git\s+push|git\s+tag")
        self.forbid("API writes", r"(-X|--method)\s*(POST|PUT|PATCH|DELETE)|curl\s")
        self.forbid("merging, readiness, labels, comments", r"gh\s+pr\s+(merge|ready|edit|comment|review)|gh\s+issue|gh\s+label")
        self.forbid("workflow triggers", r"repository_dispatch|gh\s+workflow\s+run")
        self.forbid("checks or statuses", r"check-runs|/statuses/")

    def test_no_expression_interpolation_in_scripts(self):
        runs = "\n".join(run_block_lines(self.lines))
        self.assertTrue(runs, "run blocks not found")
        self.forbid("${{ }} inside run scripts (inputs travel through env)", r"\$\{\{", runs)

    def test_required_shape(self):
        self.assertRegex(self.text, r"(?m)^permissions:\n(\s+[a-z-]+: read\n)+")
        self.assertRegex(self.text, r"github\.ref == 'refs/heads/main'")
        self.assertRegex(self.text, r"\[ \"\$REF\" = refs/heads/main \]")
        self.assertIn("python3 -I scripts/merge-governance/continuity/verify.py", self.text)
        triggers = re.search(r"(?ms)^on:\n(.*?)^\S", self.text + "\nX").group(1)
        names = set(re.findall(r"(?m)^  ([a-z_]+):", triggers))
        self.assertEqual(names, {"workflow_run", "workflow_dispatch"})

    def test_selftest_workflow_is_read_only(self):
        text = "\n".join(body(WF_SELFTEST))
        self.assertRegex(text, r"(?m)^permissions:\n  contents: read\n")
        self.forbid("write permission", r"^\s*[a-z-]+:\s*write\s*$", text)
        self.forbid("secrets", r"secrets\.", text)
        self.forbid("pull_request_target", r"pull_request_target", text)
        self.forbid("persisted credentials", r"persist-credentials:\s*true", text)


if __name__ == "__main__":
    unittest.main()
