import {describe, expect, it, vi} from "vitest";

import type {ScannerInput, ScannerOutput, SkillScanner} from "../../contract/scanner.js";
import {logger} from "../../logger.js";
import {runScanners} from "../runner.js";

const TIMEOUT_MS = 120_000;

const baseInput: ScannerInput = {
	textFiles: new Map(),
	allPaths: [],
};

function makeScanner(id: string, scan: () => Promise<ScannerOutput>): SkillScanner {
	return {
		id,
		available: async () => true,
		scan: () => scan(),
	};
}

function successOutput(id: string): ScannerOutput {
	return {
		findings: [{category: "security", label: "test", detail: "d", severity: "medium", source: id}],
		run: {
			source: id,
			status: "success",
			findingCount: 1,
			criticalCount: 0,
			highCount: 0,
			scannedAt: new Date(),
		},
	};
}

describe("runScanners", () => {
	it("returns empty array when no scanners registered", async () => {
		const result = await runScanners([], baseInput, {timeoutMs: TIMEOUT_MS});
		expect(result).toEqual([]);
	});

	it("all-pass: returns one output per scanner with findings preserved", async () => {
		const scanners = [
			makeScanner("alpha", async () => successOutput("alpha")),
			makeScanner("beta", async () => successOutput("beta")),
		];
		const result = await runScanners(scanners, baseInput, {timeoutMs: TIMEOUT_MS});
		expect(result).toHaveLength(2);
		expect(result[0].run.source).toBe("alpha");
		expect(result[0].run.status).toBe("success");
		expect(result[0].findings).toHaveLength(1);
		expect(result[1].run.source).toBe("beta");
		expect(result[1].run.status).toBe("success");
	});

	it("one-errored: errored scanner returns empty findings and status errored, others succeed", async () => {
		const scanners = [
			makeScanner("good", async () => successOutput("good")),
			makeScanner("bad", async () => {
				throw new Error("scanner exploded");
			}),
		];
		const result = await runScanners(scanners, baseInput, {timeoutMs: TIMEOUT_MS});
		expect(result).toHaveLength(2);

		const goodResult = result.find((r) => r.run.source === "good")!;
		expect(goodResult.run.status).toBe("success");
		expect(goodResult.findings).toHaveLength(1);

		const badResult = result.find((r) => r.run.source === "bad")!;
		expect(badResult.run.status).toBe("errored");
		expect(badResult.findings).toHaveLength(0);
		expect(badResult.run.error).toBe("scanner exploded");
	});

	// Regression test: a scanner can resolve normally with status "errored"
	// (e.g. an adapter catching its own HTTP failure) instead of throwing.
	// That path bypassed the catch block entirely, so run.error was computed
	// but never logged — "scanner run completed" showed status: "errored"
	// with no indication of why. See vettd-skill-scanner shim 413s on large
	// payloads for the real-world case this hid.
	it("resolved-errored: logs run.error at error level even without a thrown exception", async () => {
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => logger);
		const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);

		const scanners = [
			makeScanner("vettd", async () => ({
				findings: [],
				run: {
					source: "vettd",
					status: "errored",
					findingCount: 0,
					criticalCount: 0,
					highCount: 0,
					error: "shim error (413)",
					scannedAt: new Date(),
				},
			})),
		];
		const result = await runScanners(scanners, baseInput, {timeoutMs: TIMEOUT_MS});

		expect(result[0].run.status).toBe("errored");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.objectContaining({scannerId: "vettd", status: "errored", error: "shim error (413)"}),
			"scanner run completed",
		);
		expect(infoSpy).not.toHaveBeenCalledWith(expect.anything(), "scanner run completed");

		errorSpy.mockRestore();
		infoSpy.mockRestore();
	});

	it("all-timeout: all scanners return status timeout within deadline", async () => {
		const timeoutMs = 50;
		const scanners = [
			makeScanner("slow1", () => new Promise<ScannerOutput>(() => {})),
			makeScanner("slow2", () => new Promise<ScannerOutput>(() => {})),
		];

		const start = Date.now();
		const result = await runScanners(scanners, baseInput, {timeoutMs});
		const elapsed = Date.now() - start;

		expect(result).toHaveLength(2);
		for (const r of result) {
			expect(r.run.status).toBe("timeout");
			expect(r.findings).toHaveLength(0);
		}
		// Both scanners ran in parallel so total elapsed should be close to one timeout, not two
		expect(elapsed).toBeLessThan(timeoutMs * scanners.length + 200);
	});

	it("durationMs is recorded for successful scans", async () => {
		vi.useFakeTimers();
		const scanners = [
			makeScanner("timed", async () => {
				vi.advanceTimersByTime(100);
				return successOutput("timed");
			}),
		];
		const result = await runScanners(scanners, baseInput, {timeoutMs: TIMEOUT_MS});
		vi.useRealTimers();
		expect(result[0].run.durationMs).toBeGreaterThanOrEqual(0);
	});
});
