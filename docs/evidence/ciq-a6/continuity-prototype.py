#!/usr/bin/env python3
"""CIQ-A6 evidence only: a read-only PROTOTYPE of the approval-continuity classifier described in
docs/ciq-a6-autonomous-merge-governance.md §4. It is not the verifier, is not run by CI and confers
nothing. It exists so that the replay in §11 can be reproduced:

    python3 -I docs/evidence/ciq-a6/continuity-prototype.py APPROVED CANDIDATE [APPROVED_BASE]

APPROVED is the audited head, APPROVED_BASE the base its audited delta was taken from (default:
merge-base of APPROVED and $MAIN; give it explicitly for a stacked PR), CANDIDATE the synced head.
$MAIN (default origin/main) is the main commit the candidate must contain. It only reads git
objects (rev-parse, merge-base, diff, ls-tree, cat-file, merge-tree); no network, no writes.
Requires git >= 2.40 (merge-tree --write-tree --merge-base).

Classes (§4.3): APPROVAL_CONTINUES, INTEGRATION_VALIDATION_REQUIRED, FOCUSED_REAUDIT_REQUIRED, BLOCKED.
The production verifier adds what this prototype leaves out: approval provenance and scope, holds,
migration state, the risk-class policy file read from main, and the signed result record.
"""
import difflib, os, re, subprocess, sys

MAIN = os.environ.get("MAIN", "origin/main")
MAX_COMPOSED_REGIONS = 6   # more same-point insertions by both sides than this is not "mechanical"

# Prototype subset of the critical-path policy (§6). The real list lives on main, owner-approved.
CRITICAL = [
    r"^apps/api/prisma/", r"^\.github/", r"^scripts/merge-queue/", r"^ops/",
    r"(^|/)(CLAUDE|AGENTS|SECURITY)\.md$", r"^docs/(agent-|merge-queue|active-workstreams)",
    r"(^|/)vercel\.json$", r"(^|/)package\.json$", r"(^|/)pnpm-lock\.yaml$", r"(^|/)Cargo\.(toml|lock)$",
    r"(auth|session|admission|permission|tenan|rbac|role|csrf|token|secret|credential|rls|privileg|polic)",
]
critical = lambda p: any(re.search(r, p, re.I) for r in CRITICAL)

def git(*a, ok=(0,)):
    p = subprocess.run(["git", *a], capture_output=True, text=True)
    if p.returncode not in ok:
        raise SystemExit(f"git {' '.join(a)} failed: {p.stderr.strip()}")
    return p

def blob(rev, path):
    p = git("cat-file", "-p", f"{rev}:{path}", ok=(0, 128))
    return p.stdout if p.returncode == 0 else None

def tree_files(tree):
    out = {}
    for ln in git("ls-tree", "-r", tree).stdout.splitlines():
        meta, path = ln.split("\t", 1)
        out[path] = meta
    return out

TOK = re.compile(r"\s+|\w+|[^\w\s]")

def changes(base, other):
    """Token-level change regions of `other` relative to `base`: (i1, i2, replacement tokens)."""
    sm = difflib.SequenceMatcher(None, base, other, autojunk=False)
    return [(i1, i2, other[j1:j2]) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal"]

def token_merge(b, o, t):
    """diff3 at token granularity. Returns (list of acceptable merged texts, PR regions), or
    (None, reason) when both sides edit the same tokens. Two insertions at the same point with
    different content are the one ambiguity a line-level merge cannot settle (both sides appended
    to the same list or signature); both orders are offered, at most 2**6 combinations."""
    B, O, T = TOK.findall(b), TOK.findall(o), TOK.findall(t)
    co, ct = changes(B, O), changes(B, T)
    edits = sorted([(i1, i2, tuple(r), 0) for i1, i2, r in co] + [(i1, i2, tuple(r), 1) for i1, i2, r in ct],
                   key=lambda e: (e[0], e[1], e[3]))
    groups = []                     # each group: list of alternative replacement sequences at one span
    pos, regions = 0, 0
    i = 0
    while i < len(edits):
        i1, i2, r, side = edits[i]
        if i1 < pos:
            return None, "overlapping edits of the same tokens"
        nxt = edits[i + 1] if i + 1 < len(edits) else None
        groups.append(("keep", B[pos:i1]))
        if nxt and (nxt[0], nxt[1]) == (i1, i2) and nxt[3] != side:
            if nxt[2] == r:                                  # identical change on both sides
                groups.append(("alt", [list(r)])); i += 2; pos = i2; regions += 1; continue
            if i1 != i2:
                return None, "both sides replaced the same tokens differently"
            groups.append(("alt", [list(r) + list(nxt[2]), list(nxt[2]) + list(r)]))
            i += 2; pos = i2; regions += 1; continue
        if nxt and nxt[0] < i2:
            return None, "overlapping edits of the same tokens"
        groups.append(("alt", [list(r)]))
        pos = i2; i += 1
    groups.append(("keep", B[pos:]))
    texts = [""]
    for kind, val in groups:
        if kind == "keep":
            texts = [x + "".join(val) for x in texts]
        else:
            texts = [x + "".join(v) for x in texts for v in val]
            if len(texts) > 64:
                return None, "too many ambiguous insertions"
    return texts, regions

def classify(A, C, bA=None):
    bA = bA or git("merge-base", A, MAIN).stdout.strip()
    main_tip = git("rev-parse", MAIN).stdout.strip()
    if git("merge-base", "--is-ancestor", main_tip, C, ok=(0, 1)).returncode != 0:
        return "BLOCKED", "candidate does not contain current main", []
    # Reproduce the sync: the approved delta (bA -> A) merged onto main, line level (what git does).
    mt = git("merge-tree", "--write-tree", "--name-only", f"--merge-base={bA}", main_tip, A, ok=(0, 1))
    lines = mt.stdout.splitlines()
    tree = lines[0]
    conflicted = [] if mt.returncode == 0 else lines[1:lines.index("", 1) if "" in lines[1:] else None]
    ctree = git("rev-parse", f"{C}^{{tree}}").stdout.strip()
    pr_files = set(git("diff", "--name-only", "--no-renames", bA, A).stdout.split())
    if mt.returncode == 0 and tree == ctree:
        overlap = sorted(pr_files & set(git("diff", "--name-only", "--no-renames", bA, main_tip).stdout.split()))
        if overlap:
            return ("INTEGRATION_VALIDATION_REQUIRED", "L0 reproducible merge, shared files",
                    ["main changed PR files since the audit: " + ", ".join(overlap)])
        return "APPROVAL_CONTINUES", "L0 reproducible merge, no shared files", []
    notes = ["line-level replay conflicts in: " + ", ".join(conflicted)] if conflicted else []
    expect, got = tree_files(tree), tree_files(ctree)
    residual, composed = [], 0
    for path in sorted(set(expect) | set(got)):
        if expect.get(path) == got.get(path):
            continue
        if path not in conflicted:
            residual.append(f"{path}: differs from the reproducible merge outside any conflict")
            continue
        merged, info = token_merge(blob(bA, path) or "", blob(main_tip, path) or "", blob(A, path) or "")
        cand = blob(C, path)
        if merged is None:
            residual.append(f"{path}: {info}")
        elif cand not in merged:
            residual.append(f"{path}: resolution is not the token-level composition of both sides")
        elif critical(path):
            residual.append(f"{path}: composed resolution in a critical path")
        else:
            composed += info
            notes.append(f"{path}: resolution = token-level composition of main and the approved delta")
    if residual:
        return "FOCUSED_REAUDIT_REQUIRED", "residual delta (only this goes to the auditor)", notes + residual
    if composed > MAX_COMPOSED_REGIONS:
        return "FOCUSED_REAUDIT_REQUIRED", f"{composed} composed regions > {MAX_COMPOSED_REGIONS}", notes
    return "INTEGRATION_VALIDATION_REQUIRED", "L2 mechanical composition", notes

if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        raise SystemExit(__doc__)
    r, level, notes = classify(*sys.argv[1:])
    print(f"{sys.argv[1][:7]} -> {sys.argv[2][:7]}: {r}  [{level}]")
    for n in notes:
        print("   -", n)
