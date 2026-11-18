"""Read-only GitHub REST client for the CIQ-A6A verifier. It can only issue GET requests."""
import json
import os
import re
import urllib.error
import urllib.request

API = "https://api.github.com"
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse redirects, so the token is never forwarded to another host (fail closed)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"redirect refused: {msg}", headers, fp)


class ReadOnlyGitHub:
    def __init__(self, repo, token=None, opener=None):
        if not REPO_RE.match(repo or ""):
            raise ValueError(f"bad repository name: {repo!r}")
        self.repo = repo
        self.token = token if token is not None else (os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"))
        self._open = opener or urllib.request.build_opener(_NoRedirect).open

    def request(self, method, path):
        if method != "GET":
            raise PermissionError("the continuity verifier is read-only: only GET requests are allowed")
        if "://" in path and not path.startswith(API + "/"):
            raise ValueError("only api.github.com is allowed")
        url = path if path.startswith(API + "/") else f"{API}/{path.lstrip('/')}"
        req = urllib.request.Request(url, method="GET")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("X-GitHub-Api-Version", "2022-11-28")
        req.add_header("User-Agent", "ciq-a6a-continuity-verifier")
        if self.token:
            req.add_header("Authorization", f"Bearer {self.token}")
        with self._open(req, timeout=60) as resp:
            body = resp.read()
            link = resp.headers.get("Link", "") if hasattr(resp, "headers") else ""
        return json.loads(body.decode("utf-8")), link

    def get(self, path):
        return self.request("GET", path)[0]

    def get_all(self, path):
        sep = "&" if "?" in path else "?"
        url, out = f"{API}/{path.lstrip('/')}{sep}per_page=100", []
        for _ in range(50):  # at most 5000 items
            data, link = self.request("GET", url)
            out.extend(data)
            m = re.search(r'<([^>]+)>;\s*rel="next"', link or "")
            if not m:
                return out
            url = m.group(1)
        raise RuntimeError("pagination limit reached")

    # Convenience readers.
    def pull(self, n):
        return self.get(f"repos/{self.repo}/pulls/{int(n)}")

    def issue_comments(self, n):
        return self.get_all(f"repos/{self.repo}/issues/{int(n)}/comments")

    def open_pulls(self):
        return self.get_all(f"repos/{self.repo}/pulls?state=open&base=main")
