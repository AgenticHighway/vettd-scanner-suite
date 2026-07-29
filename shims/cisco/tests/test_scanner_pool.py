"""Pool semantics — the safety property behind vettd-scanner-suite#23.

A SkillScanner carries per-scan mutable state (ContentExtractor._temp_dirs,
StaticAnalyzer._unreferenced_scripts, VirusTotal/LLM result attributes). Whether
each of those is *observably* corrupted today depends on which analyzers happen
to be enabled — so the invariant these tests defend is the structural one: an
instance is only ever handed to one caller at a time, and always comes back.
"""

import threading

import pytest

from scanner_pool import ScannerPool


def test_rejects_a_zero_or_negative_size():
    with pytest.raises(ValueError):
        ScannerPool(0)
    with pytest.raises(ValueError):
        ScannerPool(-1)


def test_reports_its_size():
    assert ScannerPool(2).size == 2


def test_returns_the_same_instance_to_the_pool_after_use():
    pool = ScannerPool(1)
    with pool.acquire() as first:
        pass
    with pool.acquire() as second:
        # Discarding instances instead of reusing them would re-pay the ~290ms
        # SkillScanner construction (YARA compile) on every single scan.
        assert second is first


def test_concurrent_holders_never_share_an_instance():
    pool = ScannerPool(2)
    with pool.acquire() as first, pool.acquire() as second:
        assert first is not second


def test_returns_the_instance_even_when_the_caller_raises():
    pool = ScannerPool(1)
    with pytest.raises(RuntimeError):
        with pool.acquire():
            raise RuntimeError("scan blew up")
    # A leaked slot would wedge the shim permanently after one failed scan.
    with pool.acquire() as scanner:
        assert scanner is not None


def test_acquire_blocks_until_a_slot_is_released():
    pool = ScannerPool(1)
    acquired = threading.Event()

    def waiter():
        with pool.acquire():
            acquired.set()

    thread = threading.Thread(target=waiter, daemon=True)
    with pool.acquire():
        thread.start()
        # Pool is empty — the waiter must not be handed the in-use instance.
        assert not acquired.wait(timeout=0.5)
    assert acquired.wait(timeout=30)
    thread.join(timeout=30)
