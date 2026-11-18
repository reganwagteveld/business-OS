"""CIQ-A6A verdict intake: provenance, format v1 (today's) and format v2 (fenced `approval` block).

v1 follows scripts/merge-queue/verdict-status.sh exactly (docs/agent-task-protocol.md "Provenance").
v2 is the proposed fenced block (docs/ciq-a6-autonomous-merge-governance.md §4.2, D-A6-5). When a
comment carries an `approval` block, the block alone decides and any failure is a rejection (no
fallback to v1). Every rejection has a machine-readable reason.

Asymmetric trust (§5.3): granting inputs (verdicts) are accepted only from the connector with
provenance. Restricting inputs (CHANGES REQUIRED, holds) are honoured from any source.
"""
import hashlib
import re

VERDICT_LINE = "APPROVED — EXECUTE: MERGE"
HEAD_RE = re.compile(r"\bhead\b(?:[ \t]*(?:sha|commit))?[\s:*`=]*\b([0-9a-f]{40})\b", re.IGNORECASE)
PR_RE = re.compile(r"(?:\bPR\s*#?|#)([0-9]{1,5})\b", re.IGNORECASE)
HEDGE_RE = re.compile(
    r"\b(not|never|no|don.?t|cannot|can.?t|unless|if|until|once|when|whenever|provided|pending|subject\s+to)\b",
    re.IGNORECASE,
)
FIRST_STRIP_RE = re.compile(r"^[\s#*_]+|[\s*_]+$")
PLAIN_STRIP_RE = re.compile(r"^[\s#*_-]+")
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
V2_KEYS = ("pr", "head", "base", "ready", "class", "restrictions", "owner-decisions", "depends-on", "continues")
RESTRICTION_RE = re.compile(r"^(no-migration|no-privileged|paths-only:[A-Za-z0-9_./*?-]+|flag-off:[A-Z][A-Z0-9_]*)$")
CHANGES_REQUIRED_RE = re.compile(r"^CHANGES REQUIRED\b")
HOLD_LABELS = ("queue:held", "queue:blocked")


def body_sha256(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def _lines(body):
    return [ln.replace("\r", "") for ln in body.split("\n")]


def first_line(body):
    for ln in _lines(body):
        if re.search(r"\S", ln):
            return FIRST_STRIP_RE.sub("", ln)
    return ""


def _ready_v1(lines):
    plain = [PLAIN_STRIP_RE.sub("", ln) for ln in lines if not re.match(r"^\s*>", ln)]
    affirm = any(re.match(r"^ready and merge\b", ln, re.I) and not HEDGE_RE.search(ln) for ln in plain)
    hedged = any(re.search(r"ready and merge", ln, re.I) and HEDGE_RE.search(ln) for ln in plain)
    return affirm and not hedged


def _approval_blocks(lines):
    """Fenced blocks opened by a line that is exactly ```approval (no quote or indent)."""
    blocks, i = [], 0
    while i < len(lines):
        if lines[i].rstrip() == "```approval":
            j = i + 1
            while j < len(lines) and lines[j].rstrip() != "```":
                j += 1
            if j == len(lines):
                return None  # unterminated block
            blocks.append(lines[i + 1:j])
            i = j + 1
        else:
            i += 1
    return blocks


def _parse_v2(block, pr):
    fields = {}
    for ln in block:
        if not ln.strip():
            continue
        m = re.match(r"^([a-z-]+):[ \t]*(.*?)[ \t]*$", ln)
        if not m:
            return None, f"v2: malformed line {ln[:60]!r}"
        k, v = m.group(1), m.group(2)
        if k not in V2_KEYS:
            return None, f"v2: unknown key {k!r}"
        if k in fields:
            return None, f"v2: duplicate key {k!r}"
        fields[k] = v
    for req in ("pr", "head"):
        if req not in fields:
            return None, f"v2: missing {req}"
    if not re.fullmatch(r"[0-9]{1,6}", fields["pr"]) or (pr is not None and int(fields["pr"]) != int(pr)):
        return None, "v2: pr does not name this PR"
    if not FULL_SHA.match(fields["head"]):
        return None, "v2: head must be a full lowercase 40-hex SHA"
    if "base" in fields and not FULL_SHA.match(fields["base"]):
        return None, "v2: base must be a full lowercase 40-hex SHA"
    ready = False
    if "ready" in fields:
        if fields["ready"] not in ("true", "false"):
            return None, "v2: ready must be true or false"
        ready = fields["ready"] == "true"
    cls = None
    if "class" in fields:
        if fields["class"] not in ("routine", "elevated", "critical"):
            return None, "v2: class must be routine, elevated or critical"
        cls = fields["class"]
    restrictions = []
    if fields.get("restrictions", "").strip():
        for r in (x.strip() for x in fields["restrictions"].split(",")):
            if not RESTRICTION_RE.match(r):
                return None, f"v2: unknown restriction {r!r}"
            restrictions.append(r)
    return {
        "format": "v2", "head": fields["head"], "base": fields.get("base"), "ready": ready,
        "class": cls, "restrictions": restrictions, "continues": fields.get("continues"),
    }, None


def parse_comment(comment, pr, connector_slug):
    """Return (verdict, None) for a valid merge verdict on this PR, else (None, reason)."""
    slug = (comment.get("performed_via_github_app") or {}).get("slug") or ""
    body = comment.get("body") or ""
    if slug != connector_slug:
        return None, f"not posted through {connector_slug} (app: {slug or 'none'})"
    if comment.get("updated_at") != comment.get("created_at"):
        return None, "edited after posting"
    if first_line(body) != VERDICT_LINE:
        return None, "first line is not exactly the merge verdict line"
    lines = _lines(body)
    blocks = _approval_blocks(lines)
    heads = sorted({m.lower() for m in HEAD_RE.findall(body)})
    base = {
        "comment_id": comment.get("id"),
        "url": comment.get("html_url"),
        "created_at": comment.get("created_at"),
        "body_sha256": body_sha256(body),
        "app_slug": slug,
    }
    if blocks is None:
        return None, "unterminated approval block"
    if blocks:
        if len(blocks) != 1:
            return None, "more than one approval block"
        v, err = _parse_v2(blocks[0], pr)
        if err:
            return None, err
        outside = [h for h in heads if h != v["head"]]
        if outside:
            return None, "v2: a head SHA in the prose contradicts the block"
        v.update(base)
        v["approval_id"] = hashlib.sha256(f"{v['comment_id']}|{v['body_sha256']}".encode()).hexdigest()
        return v, None
    if len(heads) != 1:
        return None, ("no SHA labelled as head" if not heads else "more than one distinct SHA labelled as head")
    prs = {m for m in PR_RE.findall(body)}
    if pr is not None and str(pr) not in prs:
        return None, "does not name this PR"
    v = {
        "format": "v1", "head": heads[0], "base": None, "ready": _ready_v1(lines),
        "class": None, "restrictions": [], "continues": None,
    }
    v.update(base)
    v["approval_id"] = hashlib.sha256(f"{v['comment_id']}|{v['body_sha256']}".encode()).hexdigest()
    return v, None


def newest_verdict(comments, pr, connector_slug):
    """The newest valid verdict (comments in API order, oldest first) and every rejection reason."""
    found, rejected = None, []
    for c in comments:
        v, why = parse_comment(c, pr, connector_slug)
        if v:
            found = v
        elif (c.get("performed_via_github_app") or {}).get("slug") == connector_slug \
                and VERDICT_LINE in (c.get("body") or ""):
            rejected.append({"comment_id": c.get("id"), "reason": why})
    return found, rejected


def restrictions_after(comments, labels, verdict_created_at):
    """Restricting inputs, accepted from any source: a CHANGES REQUIRED newer than the verdict,
    or a hold label. Returns a list of reasons (empty when nothing restricts)."""
    out = []
    for c in comments:
        if verdict_created_at and (c.get("created_at") or "") <= verdict_created_at:
            continue
        if CHANGES_REQUIRED_RE.match(first_line(c.get("body") or "")):
            out.append(f"CHANGES REQUIRED newer than the verdict (comment {c.get('id')})")
    for name in labels:
        if name in HOLD_LABELS:
            out.append(f"hold label {name}")
    return out
