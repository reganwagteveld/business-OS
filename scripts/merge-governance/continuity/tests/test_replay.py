"""Replay of the real sync steps of PRs 119, 120, 122 and 124 (design §11.1) with the real policy.

Each step evaluates the approved head against the synced head, with main = the main commit the sync
merged (the merge commit's second parent). The commits come from refs/pull/<n>/head and main; CI
fetches them first (CIQ_A6A_REQUIRE_REPLAY=1 makes missing commits a failure instead of a skip).

Expected results follow the policy, and are sometimes STRICTER than the prototype in the design:
- #120 is Critical (it changes the OAuth callback route, provider adapters and the members screen),
  so its compositions go to a focused re-audit (§6.2: a Critical PR never carries an approval through
  a composition). The prototype, which had no risk classes, said INTEGRATION_VALIDATION_REQUIRED.
- #124's second step: main changed packages/contracts between the two syncs, and the contracts
  overlay (§4.3 step 4) asks for integration validation where the prototype said APPROVAL_CONTINUES.
- #122 is Critical (members, invitations, ownership), but main only overlapped app.tsx, which is not
  critical, so the L0 result stays INTEGRATION_VALIDATION_REQUIRED (§6.2 matrix).
None of these is a false approval: every step either carries the approval with integration evidence
or asks for more review.
"""
import os
import shutil
import subprocess
import tempfile
import unittest

from helpers import ROOT, load_policy
import engine

AC, IV, FR = engine.APPROVAL_CONTINUES, engine.INTEGRATION_VALIDATION_REQUIRED, engine.FOCUSED_REAUDIT_REQUIRED

# (PR, approved head, candidate, explicit base or None, expected result, expected level, expected class)
STEPS = [
    (124, "0f953c20c328827395559c1cc4eaae4226b6fde3", "0aba1b015c6b86f8a0054cc4852cf92efd19ea51", None, IV, "L0", "elevated"),
    (124, "0aba1b015c6b86f8a0054cc4852cf92efd19ea51", "2ae0a42f96f0028310b30a135cb9cdec381f3f4d", None, IV, "L0", "elevated"),
    (124, "0f953c20c328827395559c1cc4eaae4226b6fde3", "2ae0a42f96f0028310b30a135cb9cdec381f3f4d", None, IV, "L0", "elevated"),
    (119, "fd35003968f00f483670f8e134d95c15e04b3731", "421757d5d18539ffbd5395a4879dca1ea3afc5b5", None, IV, "L2", "elevated"),
    (119, "421757d5d18539ffbd5395a4879dca1ea3afc5b5", "b7af0439f4c856cbd063e0ad417a4d4401106cd0", None, IV, "L2", "elevated"),
    (119, "fd35003968f00f483670f8e134d95c15e04b3731", "b7af0439f4c856cbd063e0ad417a4d4401106cd0", None, IV, "L2", "elevated"),
    (120, "74b3788b7e92290b6b5fbddc365eaa188884070a", "a2a8b5050cdfea99a82091b8951c30c2d3644b86", None, FR, "L2", "critical"),
    (120, "a2a8b5050cdfea99a82091b8951c30c2d3644b86", "916462ecc55c956d1cce8c54185217f98bfa5d74", None, FR, "L2", "critical"),
    (120, "74b3788b7e92290b6b5fbddc365eaa188884070a", "916462ecc55c956d1cce8c54185217f98bfa5d74", None, FR, "L2", "critical"),
    (122, "f2309a121bd594670448bc2ae53ffba6cedce863", "972134e73f75f00b458ce7f393924f89c874ce3f",
     "fd35003968f00f483670f8e134d95c15e04b3731", IV, "L0", "critical"),
    (122, "f2309a121bd594670448bc2ae53ffba6cedce863", "1fb58825553afa83cdcbcb22cfb9ef2bc011ccfc",
     "fd35003968f00f483670f8e134d95c15e04b3731", IV, "L0", "critical"),
]


class Replay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.git = engine.Git(ROOT)
        cls.policy = load_policy()
        missing = []
        for step in STEPS:
            for sha in (step[1], step[2], step[3]):
                if sha:
                    try:
                        cls.git.commit(sha)
                    except engine.VerifierError:
                        missing.append(sha)
        if missing:
            msg = f"replay commits not available locally ({len(missing)} missing); fetch refs/pull/{{119,120,122,124}}/head"
            if os.environ.get("CIQ_A6A_REQUIRE_REPLAY") == "1":
                raise AssertionError(msg)
            raise unittest.SkipTest(msg)

    def test_steps(self):
        for pr, a, c, base, want, level, cls in STEPS:
            with self.subTest(pr=pr, approved=a[:7], candidate=c[:7]):
                main = self.git.commit(f"{c}^2")  # the main commit the sync merged
                out = engine.evaluate(self.git, self.policy, a, base, c, main,
                                      base_source="verdict" if base else "merge-base")
                self.assertEqual((out["result"], out["level"], out["risk_class"]), (want, level, cls), out["reasons"])

    def test_119_composition_keeps_both_zones(self):
        main = self.git.commit("b7af0439f4c856cbd063e0ad417a4d4401106cd0^2")
        out = engine.evaluate(self.git, self.policy, "421757d5d18539ffbd5395a4879dca1ea3afc5b5", None,
                              "b7af0439f4c856cbd063e0ad417a4d4401106cd0", main)
        self.assertEqual(out["files"]["composed"], ["packages/app/src/app.tsx"])

    def test_120_reaudit_packet_is_small(self):
        main = self.git.commit("a2a8b5050cdfea99a82091b8951c30c2d3644b86^2")
        out = engine.evaluate(self.git, self.policy, "74b3788b7e92290b6b5fbddc365eaa188884070a", None,
                              "a2a8b5050cdfea99a82091b8951c30c2d3644b86", main)
        diff = out["packet"]["composed_diff_from_reproducible_merge"]
        self.assertIn("packages/app/src/app.tsx", diff)
        self.assertLess(len(diff.splitlines()), 80)  # a few lines for the auditor, not 24 files

    def test_tampered_119_resolution_is_caught(self):
        # Adversarial replay on real objects: rebuild #119's real sync commit b7af043 with the
        # Scheduling prop removed from the App signature (a resolution that silently drops main's side). The
        # tampered commit lives in a throwaway repository that borrows the real objects through
        # objects/info/alternates, so nothing is written to this repository.
        real = "b7af0439f4c856cbd063e0ad417a4d4401106cd0"
        approved = "421757d5d18539ffbd5395a4879dca1ea3afc5b5"
        main = self.git.commit(f"{real}^2")
        common = subprocess.run(["git", "-C", ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                capture_output=True, text=True, check=True).stdout.strip()
        tmp = tempfile.mkdtemp(prefix="ciq-a6a-replay-")
        try:
            env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                       GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
                       GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid", GIT_INDEX_FILE=os.path.join(tmp, "idx"))

            def g(*args, inp=None):
                return subprocess.run(["git", "-C", tmp, *args], input=inp, capture_output=True,
                                      env=env, check=True).stdout

            g("init", "-q")
            with open(os.path.join(tmp, ".git", "objects", "info", "alternates"), "w") as f:
                f.write(os.path.join(common, "objects") + "\n")
            path = "packages/app/src/app.tsx"
            text = g("cat-file", "blob", f"{real}:{path}").decode()
            tampered = text.replace(" scheduling: schedulingOverride,", "", 1)
            self.assertNotEqual(tampered, text, "the tamper pattern no longer matches app.tsx")
            blob = g("hash-object", "-w", "--stdin", inp=tampered.encode()).decode().strip()
            g("read-tree", real)
            g("update-index", "--cacheinfo", f"100644,{blob},{path}")
            tree = g("write-tree").decode().strip()
            cand = g("commit-tree", tree, "-p", approved, "-p", main, "-m", "tampered sync").decode().strip()
            out = engine.evaluate(engine.Git(tmp), self.policy, approved, None, cand, main)
            self.assertEqual(out["result"], FR, out["reasons"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
