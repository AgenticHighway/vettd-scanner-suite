#!/usr/bin/env python3
"""
Cisco AI Defense scanner HTTP shim.

Wraps the cisco-ai-skill-scanner Python API in a minimal http.server so the
TypeScript adapter can call it over localhost without spawning a new Python
process per scan. Python startup (~2.8s) is paid once; each warm scan is ~0.2s.

GOTCHA: skill_scanner.core.* is an internal (non-public) API. Re-validate
import paths whenever cisco-ai-skill-scanner is upgraded.

GOTCHA: SkillScanner instances are NOT safe to share across concurrent scans
(see scanner_pool.py for the specific mutable state). Each request checks one
out of a ScannerPool for exclusive use; pool size is CISCO_SHIM_CONCURRENCY
(default 1) and must be >= the suite's [scanners.cisco].concurrency, or scans
serialize inside this process. SARIFReporter is deliberately still a shared
singleton — it holds only immutable config.

Run standalone (python3 shims/cisco/server.py); the suite's cisco adapter
connects to it via [scanners.cisco].shim_url in scanner-suite.toml. Binds to
127.0.0.1 by default; set CISCO_SHIM_BIND=0.0.0.0 to accept connections from
other containers (e.g. the Docker Compose deployment).
"""

import importlib.metadata
import json
import logging
import os
import shutil
import tempfile
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# One-time initialisation — cost paid at shim startup, not per scan
# ---------------------------------------------------------------------------

from skill_scanner.core.reporters.sarif_reporter import SARIFReporter  # noqa: E402

from scanner_pool import ScannerPool, warm_up  # noqa: E402

_SCANNER_VERSION: str = importlib.metadata.version("cisco-ai-skill-scanner")
_sarif_reporter = SARIFReporter()

PORT = int(os.environ.get("CISCO_SHIM_PORT", "8787"))

logging.basicConfig(level=logging.INFO, stream=__import__("sys").stderr,
                    format="[cisco-shim] %(message)s")
log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Path sanitisation
# ---------------------------------------------------------------------------

def _safe_rel_path(name: str) -> str | None:
    """Return the name unchanged if it is a safe relative path, else None."""
    if not name:
        return None
    p = Path(name)
    if p.is_absolute():
        return None
    # Resolve against a dummy root to catch traversal (../../etc/passwd)
    try:
        root = Path("/tmp/safe-check").resolve()
        resolved = (root / p).resolve()
        resolved.relative_to(root)
    except (ValueError, OSError):
        return None
    return name


# ---------------------------------------------------------------------------
# Request handler
# ---------------------------------------------------------------------------

class ShimHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # suppress default access log to stdout
        log.debug(fmt, *args)

    def _send_json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"ok": True, "version": _SCANNER_VERSION})
        else:
            self._send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path != "/scan":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        self._handle_scan()

    def _handle_scan(self) -> None:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self._send_json(400, {"ok": False, "error": "empty body",
                                  "exception_type": "BadRequest"})
            return

        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            self._send_json(400, {"ok": False, "error": str(exc),
                                  "exception_type": type(exc).__name__})
            return

        files: dict = data.get("files", {})
        if not files:
            self._send_json(400, {"ok": False, "error": "no files provided",
                                  "exception_type": "BadRequest"})
            return

        tmp_dir = tempfile.mkdtemp(prefix="cisco-shim-")
        try:
            # Write skill files to a clean temp dir
            for name, content in files.items():
                rel = _safe_rel_path(str(name))
                if rel is None:
                    self._send_json(400, {"ok": False,
                                          "error": f"invalid path: {name!r}",
                                          "exception_type": "BadRequest"})
                    return
                dest = Path(tmp_dir) / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(str(content), encoding="utf-8")

            # Exclusive checkout — see scanner_pool.py for why sharing is unsafe
            with self.server.pool.acquire() as scanner:
                result = scanner.scan_skill(Path(tmp_dir), lenient=True)

            # Write SARIF to a temp file within the temp dir, then load as dict
            sarif_path = os.path.join(tmp_dir, "output.sarif")
            _sarif_reporter.save_report(result, sarif_path)
            with open(sarif_path, encoding="utf-8") as f:
                sarif = json.load(f)

            self._send_json(200, {"ok": True, "sarif": sarif,
                                  "version": _SCANNER_VERSION})

        except MemoryError as exc:
            log.error("OOM during scan: %s", exc)
            self._send_json(503, {"ok": False, "error": "out of memory",
                                  "exception_type": "MemoryError"})
        except Exception as exc:
            log.error("scan failed: %s\n%s", exc, traceback.format_exc())
            self._send_json(500, {"ok": False, "error": str(exc),
                                  "exception_type": type(exc).__name__})
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


class ShimServer(ThreadingHTTPServer):
    """Threaded HTTP server carrying the scanner pool its handlers share."""

    # One thread per request. Daemonised so a scan blocked on acquire() can
    # never keep the process alive after shutdown.
    daemon_threads = True

    def __init__(self, address, pool):
        self.pool = pool
        super().__init__(address, ShimHandler)


def _read_concurrency() -> int:
    """Pool size from CISCO_SHIM_CONCURRENCY. Fails loudly on a bad value."""
    raw = os.environ.get("CISCO_SHIM_CONCURRENCY", "1")
    try:
        value = int(raw)
    except ValueError:
        raise SystemExit(f"[cisco-shim] CISCO_SHIM_CONCURRENCY must be an integer, got {raw!r}")
    if value < 1:
        raise SystemExit(f"[cisco-shim] CISCO_SHIM_CONCURRENCY must be >= 1, got {value}")
    return value


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    HOST = os.environ.get("CISCO_SHIM_BIND", "127.0.0.1")
    pool = ScannerPool(_read_concurrency())
    # Pay the process-wide lazy-init cost before accepting traffic.
    with pool.acquire() as _warm_scanner:
        warm_up(_warm_scanner)
    server = ShimServer((HOST, PORT), pool)
    log.info("listening on %s:%d (cisco-ai-skill-scanner %s, pool=%d)",
              HOST, PORT, _SCANNER_VERSION, pool.size)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
