import {describe, it, expect, vi, beforeEach} from "vitest";

import type {CiscoScannerConfig} from "../../config/schema.js";
import type {ScannerInput} from "../../contract/scanner.js";
import {logger} from "../../logger.js";
import {createCiscoScanner} from "../cisco.js";

// ─── fetch mock (hoisted) ────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInput(files: Record<string, string> = {}): ScannerInput {
	return {
		textFiles: new Map(Object.entries(files)),
		allPaths: Object.keys(files),
	};
}

function makeMinimalSarif() {
	return {
		version: "2.1.0",
		runs: [
			{
				tool: {driver: {rules: [{id: "RULE_1", shortDescription: {text: "Test rule"}, properties: {tags: ["security"]}}]}},
				results: [
					{ruleId: "RULE_1", level: "error", message: {text: "a finding"}, locations: []},
				],
			},
		],
	};
}

function mockHealthOk() {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		json: async () => ({ok: true, version: "2.0.11"}),
	} as unknown as Response);
}

function mockScanOk(sarif = makeMinimalSarif()) {
	mockFetch.mockResolvedValueOnce({
		ok: true,
		json: async () => ({ok: true, sarif, version: "2.0.11"}),
	} as unknown as Response);
}

function mockScanStatus(status: number, body: object = {ok: false, error: "err"}) {
	mockFetch.mockResolvedValueOnce({
		ok: false,
		status,
		json: async () => body,
	} as unknown as Response);
}

// ─── Scanner construction ────────────────────────────────────────────────────
// Each test builds a fresh instance, so the concurrency queue starts empty —
// no module-reset dance needed (the queue lives in the factory closure).

function makeScanner(overrides: Partial<CiscoScannerConfig> = {}) {
	return createCiscoScanner({
		enabled: true,
		shimUrl: "http://127.0.0.1:8787",
		healthTimeoutMs: 2000,
		scanTimeoutMs: 30000,
		queueDepth: 50,
		...overrides,
	});
}

// ─── available() ─────────────────────────────────────────────────────────────

describe("ciscoScanner.available()", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns true when /health responds 200", async () => {
		mockHealthOk();
		const scanner = makeScanner();
		expect(await scanner.available()).toBe(true);
	});

	it("returns false when /health responds non-2xx", async () => {
		mockFetch.mockResolvedValueOnce({ok: false, status: 503} as unknown as Response);
		const scanner = makeScanner();
		expect(await scanner.available()).toBe(false);
	});

	it("returns false when fetch throws (shim not running)", async () => {
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const scanner = makeScanner();
		expect(await scanner.available()).toBe(false);
	});
});

// ─── scan() ──────────────────────────────────────────────────────────────────

describe("ciscoScanner.scan()", () => {
	beforeEach(() => vi.clearAllMocks());

	it("successful scan: source=cisco, version recorded, rawReport set, findings mapped", async () => {
		const sarif = makeMinimalSarif();
		mockScanOk(sarif);
		const scanner = makeScanner();
		const result = await scanner.scan(makeInput({"SKILL.md": "# Skill"}));

		expect(result.run.source).toBe("cisco");
		expect(result.run.status).toBe("success");
		expect(result.run.version).toBe("2.0.11");
		expect(result.run.rawReport).toEqual(sarif);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].severity).toBe("critical");
		expect(result.findings[0].source).toBe("cisco");
	});

	it("POSTs JSON with files from textFiles map", async () => {
		mockScanOk();
		const scanner = makeScanner();
		await scanner.scan(makeInput({"SKILL.md": "content", "scripts/run.sh": "#!/bin/bash"}));

		const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(init.body as string) as {files: Record<string, string>};
		expect(body.files["SKILL.md"]).toBe("content");
		expect(body.files["scripts/run.sh"]).toBe("#!/bin/bash");
	});

	it("POSTs to /scan endpoint", async () => {
		mockScanOk();
		const scanner = makeScanner();
		await scanner.scan(makeInput());

		const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/scan");
	});

	it("400 response: status errored, error=shim rejected input", async () => {
		mockScanStatus(400);
		const scanner = makeScanner();
		const result = await scanner.scan(makeInput());

		expect(result.run.status).toBe("errored");
		expect(result.run.error).toBe("shim rejected input");
		expect(result.findings).toHaveLength(0);
	});

	it("500 response: status errored, error contains status code", async () => {
		mockScanStatus(500);
		const scanner = makeScanner();
		const result = await scanner.scan(makeInput());

		expect(result.run.status).toBe("errored");
		expect(result.run.error).toContain("500");
		expect(result.findings).toHaveLength(0);
	});

	// OOM must be surfaced loudly, not folded into a generic error string.
	it("503 response: status errored, error=shim oom, logged as error", async () => {
		const logSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
		mockScanStatus(503);
		const scanner = makeScanner();
		const result = await scanner.scan(makeInput());

		expect(result.run.status).toBe("errored");
		expect(result.run.error).toBe("shim oom");
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({status: 503}),
			expect.stringContaining("OOM"),
		);
		logSpy.mockRestore();
	});

	it("fetch throws: status errored, error is exception message", async () => {
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const scanner = makeScanner();
		const result = await scanner.scan(makeInput());

		expect(result.run.status).toBe("errored");
		expect(result.run.error).toContain("ECONNREFUSED");
	});

	it("fetch timeout: status errored, error=shim request timed out", async () => {
		const timeoutErr = Object.assign(new Error("The operation timed out."), {name: "TimeoutError"});
		mockFetch.mockRejectedValueOnce(timeoutErr);
		const scanner = makeScanner();
		const result = await scanner.scan(makeInput());

		expect(result.run.status).toBe("errored");
		expect(result.run.error).toBe("shim request timed out");
	});

	it("200 but invalid JSON body: status errored", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => { throw new SyntaxError("bad json"); },
		} as unknown as Response);
		const scanner = makeScanner();
		const result = await scanner.scan(makeInput());

		expect(result.run.status).toBe("errored");
		expect(result.run.error).toBe("shim response parse failed");
	});

	it("configured shim_url is used", async () => {
		mockScanOk();
		const scanner = makeScanner({shimUrl: "http://127.0.0.1:9999"});
		await scanner.scan(makeInput());

		const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("9999");
	});
});

// ─── queue ───────────────────────────────────────────────────────────────────

describe("ciscoScanner queue", () => {
	beforeEach(() => vi.clearAllMocks());

	it("queue-full: request beyond queue_depth returns status skipped", async () => {
		// Hold the first scan open until we call releaseFirst().
		let releaseFirst!: () => void;
		const firstScanDone = new Promise<void>((r) => {
			releaseFirst = r;
		});

		mockFetch.mockImplementation(() => {
			// first scan blocks; second resolves immediately once first unblocks
			return firstScanDone.then(() =>
				({ok: true, json: async () => ({ok: true, sarif: makeMinimalSarif(), version: "2.0.11"})})
			) as unknown as Promise<Response>;
		});

		const scanner = makeScanner({queueDepth: 1});

		// acquire() is synchronous — inFlight increments before any await:
		//   first:  inFlight=0 < 1 → resolves immediately, inFlight=1
		//   second: inFlight=1, waiters=0 < queueDepth=1 → enqueued
		//   third:  inFlight=1, waiters=1 ≥ queueDepth=1 → QueueFullError
		const first = scanner.scan(makeInput({"SKILL.md": "s1"}));
		const second = scanner.scan(makeInput({"SKILL.md": "s2"}));
		const third = scanner.scan(makeInput({"SKILL.md": "s3"}));

		const thirdResult = await third;
		expect(thirdResult.run.status).toBe("skipped");
		expect(thirdResult.run.error).toContain("queue is full");

		releaseFirst();
		await first;
		await second;
	});
});
