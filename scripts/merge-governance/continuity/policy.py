"""CIQ-A6A policy loading and risk classes (docs/ciq-a6-autonomous-merge-governance.md §6).

The policy is read from a trusted path (the checkout of main the verifier runs from). A pull
request's own copy of the policy is never read: the engine only sees git objects of the PR.
"""
import hashlib
import json
import re

CLASSES = ("routine", "elevated", "critical")
CLASS_RANK = {c: i for i, c in enumerate(CLASSES)}
ALLOWED_MODES = ("off", "shadow")  # 'enforce' is not part of A6A and is refused
SCHEMA = "ciq-a6/policy/v1"
_LIMIT_KEYS = (
    "max_composed_regions",
    "max_composition_alternatives",
    "max_conflicted_file_bytes",
    "max_conflicted_file_tokens",
    "max_packet_bytes",
)
_PATTERN_LISTS = ("governance_docs", "ordinary_docs", "critical", "elevated", "routine_client")


class PolicyError(Exception):
    pass


def safe_path(p):
    """A plain repository-relative path; anything else is classified Critical (fail closed)."""
    if not p or p.startswith("/") or p.startswith("./") or p.startswith("../"):
        return False
    if any(ch in p for ch in ("\n", "\r", "\t", "\\", "\0")):
        return False
    parts = p.split("/")
    return all(part not in ("", ".", "..") for part in parts)


def max_class(*classes):
    best = "routine"
    for c in classes:
        if c is not None and CLASS_RANK[c] > CLASS_RANK[best]:
            best = c
    return best


class Policy:
    def __init__(self, raw_bytes, source="policy.json"):
        try:
            data = json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as e:
            raise PolicyError(f"{source}: not valid UTF-8 JSON ({e})")
        if not isinstance(data, dict) or data.get("schema") != SCHEMA:
            raise PolicyError(f"{source}: schema must be {SCHEMA!r}")
        mode = data.get("continuity_mode")
        if mode not in ALLOWED_MODES:
            raise PolicyError(
                f"{source}: continuity_mode {mode!r} is not allowed; A6A supports only {ALLOWED_MODES} "
                "(enforcement needs D-A6-1 and its own package)"
            )
        self.mode = mode
        self.sha256 = hashlib.sha256(raw_bytes).hexdigest()
        self.source = source
        self.connector_slug = data.get("connector_app_slug")
        if not isinstance(self.connector_slug, str) or not self.connector_slug:
            raise PolicyError(f"{source}: connector_app_slug missing")
        limits = data.get("limits")
        if not isinstance(limits, dict):
            raise PolicyError(f"{source}: limits missing")
        self.limits = {}
        for k in _LIMIT_KEYS:
            v = limits.get(k)
            if not isinstance(v, int) or isinstance(v, bool) or v <= 0:
                raise PolicyError(f"{source}: limits.{k} must be a positive integer")
            self.limits[k] = v
        overlap = data.get("overlap", {})
        self.overlap_ignores_ordinary_docs = overlap.get("ignore_ordinary_docs") is True
        self.patterns = {}
        for key in _PATTERN_LISTS:
            self.patterns[key] = self._compile(data.get(key), f"{source}: {key}")
        overlays = data.get("overlays")
        if not isinstance(overlays, dict):
            raise PolicyError(f"{source}: overlays missing")
        self.migration = self._compile(overlays.get("migration"), f"{source}: overlays.migration")
        self.contracts = self._compile(overlays.get("contracts"), f"{source}: overlays.contracts")

    @staticmethod
    def _compile(lst, where):
        if not isinstance(lst, list) or not lst or not all(isinstance(x, str) and x for x in lst):
            raise PolicyError(f"{where}: must be a non-empty list of patterns")
        try:
            return [re.compile(x, re.IGNORECASE) for x in lst]
        except re.error as e:
            raise PolicyError(f"{where}: bad pattern ({e})")

    @classmethod
    def load(cls, path):
        with open(path, "rb") as f:
            return cls(f.read(), source=path)

    @staticmethod
    def _any(pats, path):
        return any(p.search(path) for p in pats)

    def is_ordinary_doc(self, path):
        return (
            safe_path(path)
            and not path.rsplit("/", 1)[-1].startswith(".")
            and self._any(self.patterns["ordinary_docs"], path)
            and not self._any(self.patterns["governance_docs"], path)
        )

    def classify_path(self, path):
        """Return (class, rule) for one path. Order: unsafe -> critical; governance docs -> critical;
        ordinary docs -> routine; critical patterns; elevated patterns; routine client source;
        anything unmatched -> elevated."""
        if not safe_path(path):
            return "critical", "unrecognised path name (fail closed)"
        if self._any(self.patterns["governance_docs"], path):
            return "critical", "governance document"
        if self.is_ordinary_doc(path):
            return "routine", "ordinary documentation"
        for p in self.patterns["critical"]:
            if p.search(path):
                return "critical", f"critical pattern {p.pattern}"
        for p in self.patterns["elevated"]:
            if p.search(path):
                return "elevated", f"elevated pattern {p.pattern}"
        base = path.rsplit("/", 1)[-1]
        if not base.startswith(".") and ".config." not in base and not base.startswith("tsconfig"):
            if self._any(self.patterns["routine_client"], path):
                return "routine", "client source"
        return "elevated", "no rule matched (fail closed to elevated)"

    def is_critical(self, path):
        return self.classify_path(path)[0] == "critical"

    def class_of(self, paths):
        """Maximum class over paths, with the paths that set it."""
        cls, why = "routine", {}
        for p in sorted(paths):
            c, rule = self.classify_path(p)
            if CLASS_RANK[c] > CLASS_RANK[cls]:
                cls, why = c, {}
            if c == cls and len(why) < 20:
                why[p] = rule
        return cls, why

    def is_migration(self, path):
        return self._any(self.migration, path)

    def is_contracts(self, path):
        return self._any(self.contracts, path)
