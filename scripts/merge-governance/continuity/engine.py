"""CIQ-A6A approval continuity engine (docs/ciq-a6-autonomous-merge-governance.md §4.3).

Decides whether an existing, independently given approval of head A (audited delta B..A) still
covers a synced candidate C that contains main tip M. It never grants an approval. It is a pure
function of git objects, the policy and its inputs:

  L0  the candidate's tree equals git's own three-way merge of the approved delta onto M
      (git merge-tree --merge-base=B M A). Proof that C = approved change + main, nothing else.
  L2  where that merge conflicts, every differing file is a conflicted file whose candidate content
      equals a token-level three-way composition of both sides, outside critical paths.

Results, strictest last: APPROVAL_CONTINUES, INTEGRATION_VALIDATION_REQUIRED,
FOCUSED_REAUDIT_REQUIRED, BLOCKED. Anything the engine cannot establish is never a pass.

Read-only with respect to the repository: it runs only the git plumbing commands in GIT_READ_ONLY.
`git merge-tree --write-tree` stores the merged tree in the local object database (unreferenced
objects only); no ref, branch, index or working-tree file is written, and no PR code is executed.
"""
import difflib
import os
import re
import subprocess

from policy import max_class, CLASS_RANK

APPROVAL_CONTINUES = "APPROVAL_CONTINUES"
INTEGRATION_VALIDATION_REQUIRED = "INTEGRATION_VALIDATION_REQUIRED"
FOCUSED_REAUDIT_REQUIRED = "FOCUSED_REAUDIT_REQUIRED"
BLOCKED = "BLOCKED"
RESULTS = (APPROVAL_CONTINUES, INTEGRATION_VALIDATION_REQUIRED, FOCUSED_REAUDIT_REQUIRED, BLOCKED)
RANK = {r: i for i, r in enumerate(RESULTS)}

SHA_RE = re.compile(r"^[0-9a-f]{40}$")
GIT_READ_ONLY = frozenset(
    {"rev-parse", "merge-base", "diff", "ls-tree", "cat-file", "merge-tree", "version"}
)
REGULAR_MODES = ("100644", "100755")


class VerifierError(Exception):
    """Unreadable or inconsistent input. The caller reports BLOCKED: verifier error."""


def stricter(a, b):
    return a if RANK[a] >= RANK[b] else b


class Git:
    """Minimal read-only git runner. Revisions are passed after --end-of-options."""

    def __init__(self, repo_dir):
        self.repo_dir = repo_dir
        self._trees = {}
        self.env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": os.environ.get("HOME", "/nonexistent"),
            "LC_ALL": "C",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_NO_REPLACE_OBJECTS": "1",
        }

    def run(self, sub, *args, ok=(0,), stdin=None):
        if sub not in GIT_READ_ONLY:
            raise VerifierError(f"git {sub} is not a read-only command allowed in the verifier")
        cmd = ["git", "-C", self.repo_dir, "-c", "core.quotePath=false", sub, *args]
        p = subprocess.run(cmd, capture_output=True, env=self.env, input=stdin, timeout=300)
        if p.returncode not in ok:
            err = p.stderr.decode("utf-8", "replace").strip()
            raise VerifierError(f"git {sub} failed ({p.returncode}): {err[:500]}")
        return p

    def version(self):
        return self.run("version").stdout.decode().strip()

    def commit(self, rev):
        out = self.run("rev-parse", "--verify", "--quiet", "--end-of-options", f"{rev}^{{commit}}", ok=(0, 1))
        sha = out.stdout.decode().strip()
        if out.returncode != 0 or not SHA_RE.match(sha):
            raise VerifierError(f"not a commit available locally: {rev}")
        return sha

    def tree(self, commit):
        return self.run("rev-parse", "--verify", "--end-of-options", f"{commit}^{{tree}}").stdout.decode().strip()

    def is_ancestor(self, a, b):
        return self.run("merge-base", "--is-ancestor", "--end-of-options", a, b, ok=(0, 1)).returncode == 0

    def merge_base(self, a, b):
        out = self.run("merge-base", "--end-of-options", a, b, ok=(0, 1)).stdout.decode().split()
        return out[0] if out else None

    def diff_names(self, a, b):
        out = self.run("diff", "--name-only", "--no-renames", "-z", "--end-of-options", a, b).stdout
        return {p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p}

    def ls_tree(self, tree):
        out = self.run("ls-tree", "-r", "-z", "--full-tree", "--end-of-options", tree).stdout
        entries = {}
        for rec in out.split(b"\0"):
            if not rec:
                continue
            meta, path = rec.split(b"\t", 1)
            mode, typ, oid = meta.decode().split(" ")
            entries[path.decode("utf-8", "surrogateescape")] = (mode, typ, oid)
        return entries

    def entry(self, rev, path):
        """(mode, type, oid) of path in commit rev, or None. Each tree is listed once and cached."""
        if rev not in self._trees:
            self._trees[rev] = self.ls_tree(self.tree(rev))
        return self._trees[rev].get(path)

    def blob(self, oid):
        return self.run("cat-file", "blob", oid).stdout

    def blob_size(self, oid):
        return int(self.run("cat-file", "-s", oid).stdout.decode().strip())

    def merge_tree(self, base, ours, theirs):
        """git's own three-way merge, without touching refs, index or working tree."""
        p = self.run(
            "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z",
            f"--merge-base={base}", "--end-of-options", ours, theirs, ok=(0, 1),
        )
        parts = p.stdout.split(b"\0")
        tree = parts[0].decode().strip()
        if not SHA_RE.match(tree):
            raise VerifierError("git merge-tree returned no tree")
        conflicted = sorted({x.decode("utf-8", "surrogateescape") for x in parts[1:] if x})
        clean = p.returncode == 0
        if clean and conflicted:
            raise VerifierError("git merge-tree reported paths for a clean merge")
        if not clean and not conflicted:
            raise VerifierError("git merge-tree reported a conflict without paths")
        return clean, tree, conflicted

    def diff_text(self, a, b, paths, limit):
        if not paths:
            return ""
        out = self.run("diff", "--no-renames", "--no-color", "--end-of-options", a, b, "--", *paths).stdout
        text = out.decode("utf-8", "replace")
        if len(out) > limit:
            text = out[:limit].decode("utf-8", "replace") + f"\n... truncated at {limit} bytes\n"
        return text


# --- token-level three-way composition (L2) -------------------------------------------------

TOKEN_RE = re.compile(r"\s+|\w+|[^\w\s]")


def tokens(text):
    return TOKEN_RE.findall(text)


def _changes(base, other):
    sm = difflib.SequenceMatcher(None, base, other, autojunk=False)
    return [(i1, i2, tuple(other[j1:j2])) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal"]


def token_merge(base_text, ours_text, theirs_text, max_alternatives):
    """diff3 at token granularity. Returns (alternatives, regions) where alternatives is the set of
    acceptable merged texts, or (None, reason) when the two sides cannot be composed mechanically.

    Both sides changing the same tokens differently is refused. Two insertions at the same point
    with different content are the one ambiguity a line merge cannot settle (both sides appended
    to the same list or signature): both orders are accepted, bounded by max_alternatives.
    """
    B, O, T = tokens(base_text), tokens(ours_text), tokens(theirs_text)
    edits = sorted(
        [(i1, i2, r, 0) for i1, i2, r in _changes(B, O)] + [(i1, i2, r, 1) for i1, i2, r in _changes(B, T)],
        key=lambda e: (e[0], e[1], e[3]),
    )
    groups, pos, regions, i = [], 0, 0, 0
    while i < len(edits):
        i1, i2, r, side = edits[i]
        if i1 < pos:
            return None, "both sides edit the same tokens"
        nxt = edits[i + 1] if i + 1 < len(edits) else None
        groups.append([B[pos:i1]])
        if nxt and (nxt[0], nxt[1]) == (i1, i2) and nxt[3] != side:
            if nxt[2] == r:
                groups.append([list(r)])
            elif i1 != i2:
                return None, "both sides replace the same tokens differently"
            else:
                groups.append([list(r) + list(nxt[2]), list(nxt[2]) + list(r)])
            regions += 1
            pos, i = i2, i + 2
            continue
        if nxt and nxt[0] < i2:
            return None, "both sides edit the same tokens"
        groups.append([list(r)])
        pos, i = i2, i + 1
    groups.append([B[pos:]])
    texts = [""]
    for alts in groups:
        texts = [t + "".join(a) for t in texts for a in alts]
        if len(texts) > max_alternatives:
            return None, f"more than {max_alternatives} possible compositions"
    return set(texts), regions


# --- the classifier ---------------------------------------------------------------------------


def _result(result, level, reasons, notes, **extra):
    out = {"result": result, "level": level, "reasons": list(reasons), "notes": list(notes)}
    out.update(extra)
    return out


def evaluate(git, policy, approved_head, approved_base, candidate, main_tip,
             restrictions=(), declared_class=None, base_source="merge-base"):
    """Classify candidate C against the approval of A (delta B..A) on main tip M.

    approved_base may be None: then B = merge-base(A, M) (the v1 rule). Returns a dict with
    result, level, reasons, notes, class, files and packet. Raises VerifierError on unreadable input.
    """
    A = git.commit(approved_head)
    C = git.commit(candidate)
    M = git.commit(main_tip)
    if approved_base:
        B = git.commit(approved_base)
    else:
        B = git.merge_base(A, M)
        if B is None:
            raise VerifierError("approved head and main share no history")
        base_source = "merge-base"
    lim = policy.limits
    shas = {"approved_head": A, "approved_base": B, "candidate": C, "main": M, "base_source": base_source}

    def blocked(reason, **kw):
        return _result(BLOCKED, "precondition", [reason], [], shas=shas, **kw)

    # 0. Preconditions.
    if not git.is_ancestor(M, C):
        return blocked("stale candidate: it does not contain the current main tip")
    if not git.is_ancestor(A, C):
        return blocked("the approved head is not an ancestor of the candidate (rebase or force-push)")
    if not git.is_ancestor(B, A):
        return blocked("the approved base is not an ancestor of the approved head")

    pr_files = git.diff_names(B, A)
    if not pr_files:
        return blocked("the approved delta is empty")
    main_files = git.diff_names(B, M)
    cls, cls_why = policy.class_of(pr_files)
    if declared_class:
        cls = max_class(cls, declared_class)  # a verdict may raise the class, never lower it

    clean, T, conflicted = git.merge_tree(B, M, A)
    tC = git.tree(C)
    notes, reasons, packet = [], [], {}
    composed_files, residual, resolved_files = [], [], set()

    # 1. L0: reproducible merge.
    if clean and T == tC:
        overlap = pr_files & main_files
        if policy.overlap_ignores_ordinary_docs:
            overlap = {p for p in overlap if not policy.is_ordinary_doc(p)}
        overlap = sorted(overlap)
        level = "L0"
        if not overlap:
            result = APPROVAL_CONTINUES
            reasons.append("L0: candidate tree equals the approved delta merged onto main; main changed none of the PR's files")
        else:
            critical_overlap = [p for p in overlap if policy.is_critical(p)]
            if cls == "critical" and critical_overlap:
                result = FOCUSED_REAUDIT_REQUIRED
                reasons.append("L0, Critical PR: main changed critical files the PR also changes: " + ", ".join(critical_overlap))
                packet["main_changes_on_overlap"] = git.diff_text(B, M, critical_overlap, lim["max_packet_bytes"])
            else:
                result = INTEGRATION_VALIDATION_REQUIRED
                reasons.append("L0: candidate tree equals the reproducible merge; main changed PR files: " + ", ".join(overlap))
    else:
        # 2. Compare the candidate with the reproducible merge, file by file.
        level = "L2"
        if conflicted:
            notes.append("line-level replay conflicts in: " + ", ".join(conflicted))
        expect, got = git.ls_tree(T), git.ls_tree(tC)
        regions_total = 0
        for path in sorted(set(expect) | set(got)):
            if expect.get(path) == got.get(path):
                continue
            resolved_files.add(path)
            if path not in conflicted:
                residual.append(f"{path}: differs from the reproducible merge outside any conflict")
                continue
            ok, info = _compose_check(git, policy, B, M, A, path, got.get(path), expect.get(path))
            if not ok:
                residual.append(f"{path}: {info}")
            elif policy.is_critical(path):
                residual.append(f"{path}: composed resolution in a critical path")
            else:
                regions_total += info
                composed_files.append(path)
                notes.append(f"{path}: resolution equals the token-level composition of main and the approved delta")
        if not clean and T == tC:
            residual.append("candidate still contains git's conflict output for: " + ", ".join(conflicted))
        if residual:
            result = FOCUSED_REAUDIT_REQUIRED
            reasons.append("residual delta: only this goes to the auditor")
            reasons.extend(residual)
            paths = sorted({r.split(": ", 1)[0] for r in residual if not r.startswith("candidate still")} & (set(expect) | set(got)))
            packet["residual_diff_from_reproducible_merge"] = git.diff_text(T, C, paths, lim["max_packet_bytes"])
        elif regions_total > lim["max_composed_regions"]:
            result = FOCUSED_REAUDIT_REQUIRED
            reasons.append(f"{regions_total} composed regions exceed the limit of {lim['max_composed_regions']}")
        elif cls == "critical" and composed_files:
            result = FOCUSED_REAUDIT_REQUIRED
            reasons.append("Critical PR: a conflict composition never carries the approval")
            packet["composed_diff_from_reproducible_merge"] = git.diff_text(T, C, composed_files, lim["max_packet_bytes"])
        elif not composed_files:
            # Defensive: a non-clean merge must leave at least one composed file to reach here.
            result = FOCUSED_REAUDIT_REQUIRED
            reasons.append("the candidate differs from the reproducible merge in no conflicted file (unexpected)")
        else:
            result = INTEGRATION_VALIDATION_REQUIRED
            reasons.append(f"L2 mechanical composition ({regions_total} region(s)) in: " + ", ".join(composed_files))

    # 3. Overlays: each can only make the result stricter.
    touched = pr_files | resolved_files
    migrations = sorted(p for p in touched if policy.is_migration(p))
    if migrations:
        result = stricter(result, BLOCKED)
        reasons.append("migration or privileged SQL in the delta: merge prerequisites (§7.6) are checked by the "
                       "controller, not by this verifier: " + ", ".join(migrations))
    if result in (APPROVAL_CONTINUES,) and any(policy.is_contracts(p) for p in main_files) \
            and any(not policy.is_ordinary_doc(p) for p in pr_files):
        result = INTEGRATION_VALIDATION_REQUIRED
        reasons.append("contracts changed on main since the audit and the PR changes code")
    cand_delta = None
    for r in restrictions:
        if r == "no-migration" and any(policy.is_migration(p) and "/privileged/" not in p for p in touched):
            result = stricter(result, FOCUSED_REAUDIT_REQUIRED)
            reasons.append("restriction no-migration violated")
        elif r == "no-privileged" and any("/privileged/" in p for p in touched):
            result = stricter(result, FOCUSED_REAUDIT_REQUIRED)
            reasons.append("restriction no-privileged violated")
        elif r.startswith("paths-only:"):
            pat = _glob_to_re(r[len("paths-only:"):])
            if cand_delta is None:
                cand_delta = git.diff_names(M, C)
            outside = sorted(p for p in cand_delta if not pat.match(p))
            if outside:
                result = stricter(result, FOCUSED_REAUDIT_REQUIRED)
                reasons.append(f"restriction {r} violated by: " + ", ".join(outside[:20]))
        elif r.startswith("flag-off:"):
            notes.append(f"restriction {r} is not machine-checkable; carried as a note")

    return _result(
        result, level, reasons, notes,
        shas=shas,
        risk_class=cls,
        class_paths=cls_why,
        files={
            "approved_delta": sorted(pr_files),
            "main_since_base": len(main_files),
            "overlap": sorted(pr_files & main_files),
            "conflicted_in_replay": conflicted,
            "composed": composed_files,
            "resolved_or_differing": sorted(resolved_files),
        },
        reproducible_merge={"clean": clean, "tree": T, "candidate_tree": tC},
        packet=packet,
    )


def _compose_check(git, policy, B, M, A, path, cand_entry, merged_entry):
    lim = policy.limits
    entries = [git.entry(rev, path) for rev in (B, M, A)]
    if any(e is None for e in entries) or cand_entry is None:
        return False, "added, deleted or renamed on one side: not composable"
    for e in entries + [cand_entry]:
        if e[1] != "blob" or e[0] not in REGULAR_MODES:
            return False, "not a regular file on every side (symlink, submodule or mode): not composable"
    if merged_entry is not None and cand_entry[0] != merged_entry[0]:
        return False, "file mode differs from the reproducible merge"
    texts = []
    for e in entries + [cand_entry]:
        if git.blob_size(e[2]) > lim["max_conflicted_file_bytes"]:
            return False, f"larger than {lim['max_conflicted_file_bytes']} bytes: not composed"
        raw = git.blob(e[2])
        if b"\0" in raw:
            return False, "binary content: not composable"
        try:
            texts.append(raw.decode("utf-8"))
        except UnicodeDecodeError:
            return False, "not UTF-8 text: not composable"
    if any(len(tokens(t)) > lim["max_conflicted_file_tokens"] for t in texts):
        return False, "too many tokens to compose within the limit"
    alts, info = token_merge(texts[0], texts[1], texts[2], lim["max_composition_alternatives"])
    if alts is None:
        return False, info
    if texts[3] not in alts:
        return False, "resolution is not the token-level composition of both sides"
    return True, info


def _glob_to_re(glob):
    """paths-only glob: '**' any depth, '*' within one segment, '?' one character."""
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**", i):
            out += ".*"
            i += 2
        elif glob[i] == "*":
            out += "[^/]*"
            i += 1
        elif glob[i] == "?":
            out += "[^/]"
            i += 1
        else:
            out += re.escape(glob[i])
            i += 1
    return re.compile("^" + out + "$")
