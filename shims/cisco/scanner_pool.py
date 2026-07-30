#!/usr/bin/env python3
"""
Pool of pre-built SkillScanner instances for the cisco shim.

WHY A POOL (vettd-scanner-suite#23): a SkillScanner is not safe to share
across concurrent scans. It owns per-scan mutable state that is written during
a scan and read back afterwards:

  * ContentExtractor._temp_dirs — appended while extracting archives, then
    deleted wholesale by cleanup() at the end of every scan_skill() call.
  * StaticAnalyzer._unreferenced_scripts — reset at the start of analyze(),
    read back afterwards via get_unreferenced_scripts().
  * validated_binary_files / last_error / last_overall_assessment — set during
    analyze() by the VirusTotal and LLM analyzers.

Several of those are only reachable with analyzers that are disabled by
default, so a shared instance may not corrupt anything *today*. That is a
property of Cisco's default policy, not of our code, and it would break
silently the moment an analyzer is enabled upstream. Exclusive checkout makes
the question moot.

WHY NOT A FRESH INSTANCE PER REQUEST: SkillScanner() costs ~290ms to build
(YaraScanner compiles its rule set from disk in __init__, uncached) — roughly
a 35% penalty on an ~811ms median scan. The pool pays it once per instance at
startup instead.
"""

from __future__ import annotations

import logging
import queue
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from skill_scanner.core.scanner import SkillScanner

log = logging.getLogger(__name__)

_WARM_UP_SKILL = """---
name: warm-up
description: Throwaway skill scanned once at startup to force lazy imports.
---
# Warm up
"""


def warm_up(scanner: SkillScanner) -> None:
    """Run one throwaway scan to pay process-wide lazy-init costs up front.

    The first scan in a process costs ~400ms instead of ~6ms because
    skill_scanner.core.file_magic._get_magika() lazily builds a Magika/ONNX
    object into a MODULE-LEVEL global on first use. That global is shared by
    every SkillScanner in the process, so warming one instance warms them all.

    Doing this before the server accepts traffic buys two things: the first
    real request does not eat the 400ms, and concurrent first requests cannot
    race on _get_magika()'s unguarded check-then-set.

    Warm-up failure is logged and swallowed — it is an optimisation, never a
    reason to refuse to start.
    """
    try:
        with tempfile.TemporaryDirectory(prefix="cisco-shim-warmup-") as tmp:
            (Path(tmp) / "SKILL.md").write_text(_WARM_UP_SKILL, encoding="utf-8")
            scanner.scan_skill(Path(tmp), lenient=True)
    except Exception as exc:  # noqa: BLE001 — never block startup on warm-up
        log.warning("scanner warm-up failed (continuing): %s", exc)


class ScannerPool:
    """Fixed-size pool of SkillScanner instances, checked out exclusively."""

    def __init__(self, size: int) -> None:
        if size < 1:
            raise ValueError(f"pool size must be >= 1, got {size}")
        self._free: queue.Queue = queue.Queue(maxsize=size)
        for _ in range(size):
            self._free.put(SkillScanner())
        self._size = size

    @property
    def size(self) -> int:
        return self._size

    @contextmanager
    def acquire(self) -> Iterator[SkillScanner]:
        """Check out a scanner for exclusive use, blocking until one is free.

        Blocking rather than erroring is deliberate. The TypeScript adapter
        already caps in-flight scans at [scanners.cisco].concurrency and applies
        its own scan_timeout_ms, so the only way to find an empty pool is a
        misconfiguration where that value exceeds this pool's size — and
        degrading to serialization there is strictly better than failing scans.
        """
        scanner = self._free.get()
        try:
            yield scanner
        finally:
            self._free.put(scanner)
