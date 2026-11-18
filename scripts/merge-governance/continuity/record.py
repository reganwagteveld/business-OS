"""Result records: every input hash, so anyone can re-run a decision and get the same output."""
import hashlib
import json
import os
import platform

import engine

SCHEMA = "ciq-a6a/continuity-result/v1"
EFFECT = "none: shadow mode. This result does not change how any PR is approved or merged."
_SOURCES = ("engine.py", "policy.py", "verdicts.py", "record.py", "shadow.py", "verify.py", "ghapi.py")


def verifier_sha256():
    here = os.path.dirname(os.path.abspath(__file__))
    h = hashlib.sha256()
    for name in _SOURCES:
        with open(os.path.join(here, name), "rb") as f:
            data = f.read()
        h.update(name.encode() + b"\0" + hashlib.sha256(data).hexdigest().encode() + b"\n")
    return h.hexdigest()


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def build(outcome, *, pr, verdict, policy, git_version, run=None, candidate_is_approved_head=None):
    inputs = {
        "pr": pr,
        "verdict": None if verdict is None else {
            k: verdict.get(k) for k in
            ("comment_id", "created_at", "body_sha256", "app_slug", "format", "head", "base", "class",
             "restrictions", "approval_id")
        },
        "shas": outcome.get("shas"),
        "policy_sha256": policy.sha256 if policy else None,
        "policy_mode": policy.mode if policy else None,
        "verifier_sha256": verifier_sha256(),
        "git_version": git_version,
        "python_version": platform.python_version(),
    }
    rec = {
        "schema": SCHEMA,
        "effect": EFFECT,
        "inputs": inputs,
        "inputs_sha256": hashlib.sha256(canonical(inputs).encode()).hexdigest(),
        "result": outcome["result"],
        "level": outcome.get("level"),
        "reasons": outcome.get("reasons", []),
        "notes": outcome.get("notes", []),
        "risk_class": outcome.get("risk_class"),
        "class_paths": outcome.get("class_paths", {}),
        "files": outcome.get("files", {}),
        "reproducible_merge": outcome.get("reproducible_merge"),
        "packet": outcome.get("packet", {}),
    }
    if run:
        rec["run"] = run
    if candidate_is_approved_head is not None:
        rec["exact_head"] = candidate_is_approved_head
    return rec


def error_outcome(message, shas=None):
    return {"result": engine.BLOCKED, "level": "verifier error", "reasons": [f"verifier error: {message}"],
            "notes": [], "shas": shas}
