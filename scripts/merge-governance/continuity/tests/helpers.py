"""Throwaway git repositories for the verifier tests. Nothing here touches the real repository."""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
ROOT = os.path.normpath(os.path.join(PKG, "..", "..", ".."))
POLICY_PATH = os.path.join(ROOT, ".github", "merge-governance", "policy.json")
if PKG not in sys.path:
    sys.path.insert(0, PKG)

import engine  # noqa: E402
from policy import Policy  # noqa: E402


def load_policy(**overrides):
    import json
    with open(POLICY_PATH, "rb") as f:
        data = json.loads(f.read())
    for k, v in overrides.items():
        if k == "limits":
            data["limits"].update(v)
        else:
            data[k] = v
    return Policy(json.dumps(data).encode())


class Repo:
    def __init__(self):
        self.dir = tempfile.mkdtemp(prefix="ciq-a6a-test-")
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, LC_ALL="C",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
        self.git("init", "-q", "-b", "main")
        self.vgit = engine.Git(self.dir)

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def git(self, *args, check=True):
        p = subprocess.run(["git", "-C", self.dir, *args], capture_output=True, env=self.env)
        if check and p.returncode != 0:
            raise RuntimeError(f"git {args}: {p.stderr.decode()}")
        return p.stdout.decode().strip()

    def write(self, path, text, mode=None):
        full = os.path.join(self.dir, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        if os.path.islink(full):
            os.unlink(full)
        with open(full, "wb") as f:
            f.write(text.encode() if isinstance(text, str) else text)
        if mode:
            os.chmod(full, mode)

    def symlink(self, path, target):
        full = os.path.join(self.dir, path)
        if os.path.lexists(full):
            os.unlink(full)
        os.symlink(target, full)

    def rm(self, path):
        self.git("rm", "-q", path)

    def commit(self, msg):
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", msg)
        return self.git("rev-parse", "HEAD")

    def branch(self, name, start):
        self.git("checkout", "-q", "-B", name, start)

    def checkout(self, name):
        self.git("checkout", "-q", name)

    def merge_main(self):
        """Merge main into the current branch; returns True when it conflicted (left unresolved)."""
        p = subprocess.run(["git", "-C", self.dir, "merge", "-q", "--no-edit", "main"], capture_output=True, env=self.env)
        return p.returncode != 0

    def head(self):
        return self.git("rev-parse", "HEAD")

    def evaluate(self, policy, approved, candidate, base=None, main="main", **kw):
        return engine.evaluate(self.vgit, policy, approved, base, candidate, main, **kw)
