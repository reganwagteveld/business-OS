"""Engine scenarios on synthetic repositories: the design's acceptance tests (§14.1, level U) and
adversarial cases (§5.2 T5, T6, T12). Each test builds its own throwaway repository."""
import os
import stat
import unittest

from helpers import Repo, load_policy
import engine

AC, IV, FR, BL = (engine.APPROVAL_CONTINUES, engine.INTEGRATION_VALIDATION_REQUIRED,
                  engine.FOCUSED_REAUDIT_REQUIRED, engine.BLOCKED)

APP = "packages/app/src/app.tsx"
REG = "packages/app/src/shell/registry.ts"
PERM = "apps/api/src/core/permissions.ts"
NOTES = "docs/notes.md"
PAGE = "packages/app/src/zones/settings/page.tsx"


def app(*zones):
    sig = ", ".join(zones)
    args = ", ".join(z.split(":")[1].strip() for z in zones)
    return f"export function App({{ {sig} }}) {{\n  return render({args});\n}}\n"


class Scenario(unittest.TestCase):
    def setUp(self):
        self.r = Repo()
        self.policy = load_policy()
        r = self.r
        r.write(APP, app("customers: c", "finance: f", "dashboard: d"))
        r.write(REG, "export type ZoneId = 'customers' | 'finance';\n")
        r.write(PERM, 'export const canEdit = (role) => role === "owner" || role === "admin";\n')
        r.write(NOTES, "one\n")
        r.write(PAGE, "export const Page = () => null;\n")
        self.base = r.commit("base")
        # The audited PR adds Settings to the App signature and changes its own page.
        r.branch("pr", self.base)
        r.write(APP, app("customers: c", "finance: f", "settings: s", "dashboard: d"))
        r.write(PAGE, "export const Page = () => 'settings';\n")
        self.A = r.commit("pr: settings")

    def tearDown(self):
        self.r.close()

    def ev(self, approved, candidate, **kw):
        return self.r.evaluate(self.policy, approved, candidate, **kw)

    def main_commit(self, path, text, msg="main"):
        self.r.checkout("main")
        self.r.write(path, text)
        return self.r.commit(msg)

    def sync(self, name, start):
        self.r.branch(name, start)
        return self.r.merge_main()

    # --- acceptance tests 1-6, 8, 13 (level U) ---

    def test_01_clean_sync_keeps_approval(self):
        self.main_commit(NOTES, "two\n")
        self.assertFalse(self.sync("c1", self.A))
        out = self.ev(self.A, self.r.head())
        self.assertEqual(out["result"], AC, out)
        self.assertEqual(out["level"], "L0")

    def test_02_unchanged_pr_new_head_exact(self):
        out = self.ev(self.A, self.A)
        self.assertEqual(out["result"], AC, out)

    def test_03_settings_scheduling_composition(self):
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.assertTrue(self.sync("c3", self.A))
        self.r.write(APP, app("customers: c", "finance: f", "scheduling: sc", "settings: s", "dashboard: d"))
        out = self.ev(self.A, self.r.commit("resolve: keep both"))
        self.assertEqual(out["result"], IV, out)
        self.assertEqual(out["level"], "L2")
        self.assertEqual(out["files"]["composed"], [APP])

    def test_03b_composition_other_order_is_also_mechanical(self):
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("c3b", self.A)
        self.r.write(APP, app("customers: c", "finance: f", "settings: s", "scheduling: sc", "dashboard: d"))
        self.assertEqual(self.ev(self.A, self.r.commit("resolve: other order"))["result"], IV)

    def test_04_resolution_dropping_main_side_needs_reaudit(self):
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("c4", self.A)
        self.r.write(APP, app("customers: c", "finance: f", "settings: s", "dashboard: d"))
        out = self.ev(self.A, self.r.commit("resolve: drop scheduling"))
        self.assertEqual(out["result"], FR, out)
        self.assertIn("residual_diff_from_reproducible_merge", out["packet"])
        self.assertIn(APP, out["packet"]["residual_diff_from_reproducible_merge"])

    def test_04b_resolution_dropping_pr_side_needs_reaudit(self):
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("c4b", self.A)
        self.r.write(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.assertEqual(self.ev(self.A, self.r.commit("resolve: drop settings"))["result"], FR)

    def test_05_permission_change_hidden_in_sync(self):
        self.main_commit(NOTES, "two\n")
        self.sync("c5", self.A)
        self.r.write(PERM, "export const canEdit = (role) => true;\n")
        self.r.git("add", "-A")
        self.r.git("commit", "-q", "--amend", "--no-edit")  # the edit hides inside the merge commit
        out = self.ev(self.A, self.r.head())
        self.assertEqual(out["result"], FR, out)
        self.assertTrue(any(PERM in x for x in out["reasons"]))

    def test_05b_composed_critical_file_is_not_carried(self):
        # PR and main both append to the same permission expression (composable), but critical.
        self.r.branch("prp", self.base)
        self.r.write(PERM, 'export const canEdit = (role) => role === "owner" || role === "admin" || role === "manager";\n')
        Ap = self.r.commit("pr: manager")
        self.main_commit(PERM, 'export const canEdit = (role) => role === "owner" || role === "admin" || role === "staff";\n')
        self.sync("c5b", Ap)
        self.r.write(PERM, 'export const canEdit = (role) => role === "owner" || role === "admin" || role === "staff" || role === "manager";\n')
        out = self.ev(Ap, self.r.commit("resolve"))
        self.assertEqual(out["result"], FR, out)
        self.assertEqual(out["risk_class"], "critical")

    def test_05c_overlapping_security_edit(self):
        self.r.branch("pr2", self.base)
        self.r.write(PERM, 'export const canEdit = (role) => role === "owner" || role === "manager";\n')
        A2 = self.r.commit("pr2")
        self.main_commit(PERM, 'export const canEdit = (role) => role === "owner";\n')
        self.sync("c12", A2)
        self.r.write(PERM, 'export const canEdit = (role) => role === "owner" || role === "manager";\n')
        out = self.ev(A2, self.r.commit("resolve: ours"))
        self.assertEqual(out["result"], FR, out)
        self.assertTrue(any("same tokens" in x for x in out["reasons"]), out["reasons"])

    def test_06_migration_added_after_approval(self):
        self.main_commit(NOTES, "two\n")
        self.sync("c6", self.A)
        self.r.write("apps/api/prisma/migrations/20990101000000_x/migration.sql", "DROP TABLE customers;\n")
        out = self.ev(self.A, self.r.commit("add migration"))
        self.assertEqual(out["result"], BL, out)  # residual (re-audit) plus the migration overlay (blocked)
        self.assertTrue(any("migration" in x for x in out["reasons"]))

    def test_06b_approved_migration_is_blocked_not_carried(self):
        self.r.branch("prm", self.base)
        self.r.write("apps/api/prisma/migrations/20990101000000_x/migration.sql", "CREATE TABLE t (id int);\n")
        Am = self.r.commit("pr: migration")
        self.main_commit(NOTES, "two\n")
        self.sync("c6b", Am)
        out = self.ev(Am, self.r.head())
        self.assertEqual(out["result"], BL, out)

    def test_08_stale_candidate_is_blocked(self):
        self.main_commit(NOTES, "two\n")
        self.sync("c8", self.A)
        C = self.r.head()
        self.main_commit(NOTES, "three\n")
        out = self.ev(self.A, C)
        self.assertEqual(out["result"], BL)
        self.assertIn("stale", out["reasons"][0])

    def test_13_stacked_child_after_parent_squash(self):
        self.r.branch("child", self.A)
        self.r.write("packages/app/src/zones/settings/team.tsx", "export const Team = () => null;\n")
        AC_ = self.r.commit("child")
        # Parent squash-merges into main.
        self.r.checkout("main")
        self.r.git("merge", "-q", "--squash", self.A)
        self.r.commit("squash parent")
        self.sync("c13", AC_)
        self.r.git("checkout", "main", "--", APP, PAGE)
        C = self.r.commit("resolve child")
        out = self.ev(AC_, C, base=self.A, base_source="verdict")
        self.assertIn(out["result"], (AC, IV), out)
        # Without the stacked base (v1 rule), the parent's delta would be counted too.
        self.assertEqual(out["files"]["approved_delta"], ["packages/app/src/zones/settings/team.tsx"])
        # 13b: the same child, but the resolution also reverts a main change.
        self.r.write(NOTES, "reverted\n")
        out = self.ev(AC_, self.r.commit("drop main content"), base=self.A, base_source="verdict")
        self.assertEqual(out["result"], FR, out)

    # --- adversarial: evil merges and tree tricks (T5) ---

    def test_evil_merge_extra_new_file(self):
        self.main_commit(NOTES, "two\n")
        self.sync("e1", self.A)
        self.r.write("packages/app/src/zones/settings/backdoor.tsx", "export const x = 1;\n")
        self.r.git("add", "-A")
        self.r.git("commit", "-q", "--amend", "--no-edit")
        self.assertEqual(self.ev(self.A, self.r.head())["result"], FR)

    def test_evil_merge_deleted_file(self):
        self.main_commit(NOTES, "two\n")
        self.sync("e2", self.A)
        self.r.rm(REG)
        self.r.git("commit", "-q", "--amend", "--no-edit")
        self.assertEqual(self.ev(self.A, self.r.head())["result"], FR)

    def test_evil_merge_mode_change(self):
        self.main_commit(NOTES, "two\n")
        self.sync("e3", self.A)
        os.chmod(os.path.join(self.r.dir, PAGE), stat.S_IRWXU)
        self.r.git("add", "-A")
        self.r.git("commit", "-q", "--amend", "--no-edit")
        self.assertEqual(self.ev(self.A, self.r.head())["result"], FR)

    def test_evil_merge_symlink_swap(self):
        self.main_commit(NOTES, "two\n")
        self.sync("e4", self.A)
        self.r.symlink(PAGE, "../../../../../etc/passwd")
        self.r.git("add", "-A")
        self.r.git("commit", "-q", "--amend", "--no-edit")
        self.assertEqual(self.ev(self.A, self.r.head())["result"], FR)

    def test_extra_commit_after_verdict(self):
        self.r.branch("x", self.A)
        self.r.write(PAGE, "export const Page = () => 'changed after audit';\n")
        C = self.r.commit("post-verdict edit")
        out = self.ev(self.A, C)
        self.assertEqual(out["result"], FR, out)
        self.assertTrue(any("outside any conflict" in x for x in out["reasons"]))

    def test_conflict_markers_left_in_file(self):
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.assertTrue(self.sync("cm", self.A))
        self.r.git("add", "-A")
        self.r.git("commit", "-q", "--no-edit")  # commits the conflict markers as they are
        self.assertEqual(self.ev(self.A, self.r.head())["result"], FR)

    def test_duplicated_insertion_is_not_composition(self):
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("dup", self.A)
        self.r.write(APP, app("customers: c", "finance: f", "scheduling: sc", "settings: s", "settings: s", "dashboard: d"))
        self.assertEqual(self.ev(self.A, self.r.commit("dup"))["result"], FR)

    def test_extra_token_inside_composition(self):
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("tok", self.A)
        self.r.write(APP, app("customers: c", "finance: f", "scheduling: sc", "settings: s", "admin: a", "dashboard: d"))
        self.assertEqual(self.ev(self.A, self.r.commit("extra"))["result"], FR)

    def test_binary_conflict_is_not_composable(self):
        img = "docs/img.bin"
        self.r.checkout("main")
        self.r.write(img, b"\x00\x01base")
        b = self.r.commit("bin")
        self.r.branch("pb", b)
        self.r.write(img, b"\x00\x01pr")
        Ab = self.r.commit("pr bin")
        self.main_commit(img, b"\x00\x01main")
        self.sync("cb", Ab)
        self.r.write(img, b"\x00\x01pr")
        self.assertEqual(self.ev(Ab, self.r.commit("take pr"))["result"], FR)

    def test_rebased_branch_is_blocked(self):
        self.main_commit(NOTES, "two\n")
        self.r.branch("rb", "main")
        self.r.git("cherry-pick", self.A)
        out = self.ev(self.A, self.r.head())
        self.assertEqual(out["result"], BL)
        self.assertIn("not an ancestor", out["reasons"][0])

    def test_base_not_ancestor_of_approved_head_is_blocked(self):
        other = self.main_commit(NOTES, "two\n")
        self.sync("bb", self.A)
        out = self.ev(self.A, self.r.head(), base=other, base_source="verdict")
        self.assertEqual(out["result"], BL)

    def test_manipulated_base_cannot_shrink_delta(self):
        # T6: a base that already contains the PR's change would hide it; it must be an ancestor of A
        # AND the candidate must equal the replay, so a forged base that is A itself is an empty delta.
        self.main_commit(NOTES, "two\n")
        self.sync("mb", self.A)
        out = self.ev(self.A, self.r.head(), base=self.A, base_source="verdict")
        self.assertEqual(out["result"], BL)
        self.assertIn("empty", out["reasons"][0])

    def test_too_many_composed_regions(self):
        policy = load_policy(limits={"max_composed_regions": 1})
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("many", self.A)
        self.r.write(APP, app("customers: c", "finance: f", "scheduling: sc", "settings: s", "dashboard: d"))
        out = self.r.evaluate(policy, self.A, self.r.commit("resolve"))
        self.assertEqual(out["result"], FR, out)

    def test_oversized_conflicted_file(self):
        policy = load_policy(limits={"max_conflicted_file_bytes": 10})
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("big", self.A)
        self.r.write(APP, app("customers: c", "finance: f", "scheduling: sc", "settings: s", "dashboard: d"))
        out = self.r.evaluate(policy, self.A, self.r.commit("resolve"))
        self.assertEqual(out["result"], FR)

    def test_critical_pr_composition_in_non_critical_file(self):
        self.r.branch("pc", self.base)
        self.r.write(APP, app("customers: c", "finance: f", "settings: s", "dashboard: d"))
        self.r.write("packages/app/src/zones/settings/members.tsx", "export const Members = () => null;\n")
        Ac = self.r.commit("critical pr")
        self.main_commit(APP, app("customers: c", "finance: f", "scheduling: sc", "dashboard: d"))
        self.sync("cc", Ac)
        self.r.write(APP, app("customers: c", "finance: f", "scheduling: sc", "settings: s", "dashboard: d"))
        out = self.ev(Ac, self.r.commit("resolve"))
        self.assertEqual(out["risk_class"], "critical")
        self.assertEqual(out["result"], FR, out)

    def test_critical_pr_l0_overlap_in_critical_file(self):
        self.r.branch("pk", self.base)
        self.r.write(PERM, 'export const canEdit = (role) => role === "owner" || role === "admin";\n// note\n')
        Ak = self.r.commit("critical pr")
        self.main_commit(PERM, '// header\nexport const canEdit = (role) => role === "owner" || role === "admin";\n')
        self.assertFalse(self.sync("ck", Ak))
        out = self.ev(Ak, self.r.head())
        self.assertEqual(out["level"], "L0")
        self.assertEqual(out["result"], FR, out)
        self.assertIn("main_changes_on_overlap", out["packet"])

    def test_declared_class_can_raise_never_lower(self):
        self.main_commit(NOTES, "two\n")
        self.sync("dc", self.A)
        C = self.r.head()
        self.assertEqual(self.ev(self.A, C, declared_class="critical")["risk_class"], "critical")
        self.assertEqual(self.ev(self.A, C, declared_class="routine")["risk_class"], "elevated")

    def test_contracts_change_on_main_needs_integration(self):
        self.main_commit("packages/contracts/src/api.ts", "export type X = 1;\n")
        self.sync("ct", self.A)
        out = self.ev(self.A, self.r.head())
        self.assertEqual(out["result"], IV, out)

    def test_paths_only_restriction(self):
        self.main_commit(NOTES, "two\n")
        self.sync("po", self.A)
        C = self.r.head()
        self.assertEqual(self.ev(self.A, C, restrictions=["paths-only:packages/app/src/**"])["result"], AC)
        self.assertEqual(self.ev(self.A, C, restrictions=["paths-only:packages/app/src/zones/**"])["result"], FR)

    def test_pr_cannot_change_its_own_policy(self):
        # T1/T12: the PR rewrites the policy file to call everything routine; the engine only uses
        # the policy object it was given (loaded from main) and treats the edit as Critical.
        self.r.branch("pol", self.A)
        self.r.write(".github/merge-governance/policy.json", '{"critical": []}\n')
        self.r.write(PERM, "export const canEdit = () => true;\n")
        Apol = self.r.commit("pr rewrites policy")
        self.main_commit(NOTES, "two\n")
        self.sync("cpol", Apol)
        out = self.ev(Apol, self.r.head())
        self.assertEqual(out["risk_class"], "critical")
        self.assertIn(".github/merge-governance/policy.json", out["class_paths"])

    def test_ordinary_docs_overlap_option(self):
        self.r.branch("pd", self.A)
        self.r.write(NOTES, "pr\n\none\n")
        Ad = self.r.commit("pr doc")
        self.main_commit(NOTES, "one\n\nmain\n")
        self.assertFalse(self.sync("cd", Ad))
        self.assertEqual(self.ev(Ad, self.r.head())["result"], IV)
        policy = load_policy(overlap={"ignore_ordinary_docs": True})
        self.assertEqual(self.r.evaluate(policy, Ad, self.r.head())["result"], AC)


class TokenMerge(unittest.TestCase):
    def test_identical_change_both_sides(self):
        alts, n = engine.token_merge("a b", "a c", "a c", 64)
        self.assertEqual(alts, {"a c"})

    def test_same_tokens_replaced_differently(self):
        alts, why = engine.token_merge("a b c", "a x c", "a y c", 64)
        self.assertIsNone(alts)

    def test_two_orders_offered(self):
        alts, n = engine.token_merge("[a]", "[a, b]", "[a, c]", 64)
        self.assertEqual(alts, {"[a, b, c]", "[a, c, b]"})
        self.assertEqual(n, 1)

    def test_alternative_bound(self):
        base = " ".join(f"x{i}" for i in range(10))
        ours = " ".join(f"x{i} o" for i in range(10))
        theirs = " ".join(f"x{i} t" for i in range(10))
        alts, why = engine.token_merge(base, ours, theirs, 64)
        self.assertIsNone(alts)
        self.assertIn("64", why)


if __name__ == "__main__":
    unittest.main()
