"""Shim server behaviour over real HTTP."""

import json
import threading
from contextlib import contextmanager
from http.client import HTTPConnection

import pytest
from skill_scanner.core.models import ScanResult

import server
from scanner_pool import ScannerPool, warm_up


# ─── helpers ─────────────────────────────────────────────────────────────────


@contextmanager
def running(shim_server):
    thread = threading.Thread(target=shim_server.serve_forever, daemon=True)
    thread.start()
    try:
        yield shim_server.server_address
    finally:
        shim_server.shutdown()
        shim_server.server_close()
        thread.join(timeout=30)


def post_scan(address, files):
    host, port = address
    conn = HTTPConnection(host, port, timeout=120)
    try:
        conn.request(
            "POST",
            "/scan",
            body=json.dumps({"files": files}),
            headers={"Content-Type": "application/json"},
        )
        response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally:
        conn.close()


def skill_files(name, extra_filename, extra_body):
    """A minimal skill with one uniquely-named extra file.

    No `license:` field, so MANIFEST_MISSING_LICENSE always fires and the SARIF
    is guaranteed to contain at least one result — the per-request assertions
    below would otherwise be able to pass vacuously.
    """
    return {
        "SKILL.md": f"---\nname: {name}\ndescription: {name} fixture for shim tests.\n---\n# {name}\n",
        extra_filename: extra_body,
    }


def artifact_uris(sarif):
    return {
        location["physicalLocation"]["artifactLocation"]["uri"]
        for run in sarif["runs"]
        for result in run.get("results", [])
        for location in result.get("locations", [])
        if "physicalLocation" in location
    }


# ─── concurrency of the server itself ────────────────────────────────────────


class _BarrierScanner:
    """Scanner stub that blocks until `parties` scans are in flight at once."""

    def __init__(self, barrier):
        self._barrier = barrier

    def scan_skill(self, directory, **_kwargs):
        self._barrier.wait()  # raises BrokenBarrierError on timeout
        return ScanResult(skill_name="stub", skill_directory=str(directory))


class _BarrierPool:
    def __init__(self, parties):
        self._barrier = threading.Barrier(parties, timeout=10)
        self._scanner = _BarrierScanner(self._barrier)

    @contextmanager
    def acquire(self):
        yield self._scanner

    @property
    def size(self):
        return 1


def test_server_processes_two_requests_at_the_same_time():
    """The whole point of ThreadingHTTPServer: with the stdlib HTTPServer the
    second request is not even read until the first response is written, so the
    barrier never trips and both requests fail."""
    shim_server = server.ShimServer(("127.0.0.1", 0), _BarrierPool(parties=2))
    results = []
    with running(shim_server) as address:
        def run():
            results.append(post_scan(address, {"SKILL.md": "# stub\n"}))

        threads = [threading.Thread(target=run) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)

    assert len(results) == 2
    for status, body in results:
        assert status == 200, body
        assert body["ok"] is True


# ─── real scans ──────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def real_shim():
    pool = ScannerPool(2)
    with pool.acquire() as scanner:
        warm_up(scanner)
    shim_server = server.ShimServer(("127.0.0.1", 0), pool)
    with running(shim_server) as address:
        yield address


def test_health_reports_the_scanner_version(real_shim):
    host, port = real_shim
    conn = HTTPConnection(host, port, timeout=30)
    try:
        conn.request("GET", "/health")
        response = conn.getresponse()
        body = json.loads(response.read())
    finally:
        conn.close()
    assert response.status == 200
    assert body == {"ok": True, "version": server._SCANNER_VERSION}


def test_rejects_a_request_with_no_files(real_shim):
    status, body = post_scan(real_shim, {})
    assert status == 400
    assert body["exception_type"] == "BadRequest"


def test_concurrent_scans_each_report_only_their_own_files(real_shim):
    """Each response's SARIF must mention only that request's own file.

    Every request writes a uniquely-named extra file into a fresh mkdtemp.
    This does NOT check that SARIF artifact URIs are rooted at the scan
    directory's basename — against the installed cisco-ai-skill-scanner,
    SARIFReporter._artifact_uri() only prepends that prefix when the
    process's CWD happens to be an ancestor of the temp directory, which it
    never is here (mkdtemp uses /tmp; the shim's CWD is shims/cisco locally
    or /app in Docker), so URIs come back as bare filenames. Instead this
    asserts filename membership directly: alpha's SARIF must contain
    alpha_only.py and must NOT contain beta_only.py, and vice versa. A
    response carrying the other request's file, or missing its own, means
    results crossed over or were destroyed mid-scan.
    """
    payloads = {
        "alpha": skill_files("alpha-skill", "alpha_only.py", "#!/bin/bash\necho alpha\n"),
        "beta": skill_files("beta-skill", "beta_only.py", "#!/bin/bash\necho beta\n"),
    }
    own_files = {"alpha": "alpha_only.py", "beta": "beta_only.py"}
    # Shell content in a .py file deterministically trips FILE_MAGIC_MISMATCH
    # (verified over repeated runs), giving each extra file its own SARIF
    # location. Plain "print(...)" content is not reliable here — Magika's
    # classification of short snippets isn't guaranteed to disagree with the
    # .py extension.
    results = {}
    errors = []

    def run(key):
        try:
            results[key] = post_scan(real_shim, payloads[key])
        except Exception as exc:  # surface, never swallow
            errors.append((key, exc))

    threads = [threading.Thread(target=run, args=(key,)) for key in payloads]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=180)

    assert not errors, errors
    assert set(results) == {"alpha", "beta"}

    for key, (status, body) in results.items():
        other_key = "beta" if key == "alpha" else "alpha"
        assert status == 200, body
        assert body["ok"] is True
        uris = artifact_uris(body["sarif"])
        assert uris, f"{key}: SARIF had no located results — assertion would be vacuous"
        assert own_files[key] in uris, f"{key}: missing its own file {own_files[key]!r} in {uris}"
        assert own_files[other_key] not in uris, (
            f"{key}: contains {other_key}'s file {own_files[other_key]!r} — results crossed over"
        )
