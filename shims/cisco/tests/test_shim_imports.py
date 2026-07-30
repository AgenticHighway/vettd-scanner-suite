"""Guards the shim's import surface.

The shim depends on skill_scanner.core.* — an internal, non-public API of
cisco-ai-skill-scanner. A version bump that moves those paths must fail here
loudly rather than at container start in production.
"""

import server


def test_reports_a_scanner_version():
    assert server._SCANNER_VERSION
    assert server._SCANNER_VERSION[0].isdigit()


def test_exposes_a_sarif_reporter():
    # Shared singleton on purpose: SARIFReporter holds only immutable config
    # (tool name/version), so it is safe across concurrent requests.
    assert hasattr(server._sarif_reporter, "save_report")
