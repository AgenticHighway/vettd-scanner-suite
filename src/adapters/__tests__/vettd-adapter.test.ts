import {describe, expect, it, vi, beforeEach} from "vitest";

import type {ShimScannerConfig} from "../../config/schema.js";
import type {ScannerInput} from "../../contract/scanner.js";
import {createVettdScanner} from "../vettd.js";

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

function makeScanner(overrides: Partial<ShimScannerConfig> = {}) {
	return createVettdScanner({
		enabled: true,
		shimUrl: "http://127.0.0.1:8788",
		healthTimeoutMs: 2000,
		scanTimeoutMs: 30000,
		...overrides,
	});
}

function shimResponse(overrides: Record<string, unknown> = {}) {
	return {
		// The Rust shim omits `source` on first-party findings — mirror that.
		findings: [{ruleId: "VTD-0002", category: "structure", severity: "high", label: "l", detail: "d"}],
		hasSkillMd: true,
		hasScripts: false,
		hasReferences: false,
		hasEvals: false,
		fileCount: 3,
		scannerVersion: 9,
		...overrides,
	};
}

function mockScanOk(body: object = shimResponse()) {
	mockFetch.mockResolvedValueOnce({ok: true, json: async () => body} as unknown as Response);
}

// ─── available() ─────────────────────────────────────────────────────────────

describe("vettd scanner available()", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns true when /health responds 200", async () => {
		mockFetch.mockResolvedValueOnce({ok: true} as unknown as Response);
		expect(await makeScanner().available()).toBe(true);
	});

	it("returns false when /health responds non-2xx", async () => {
		mockFetch.mockResolvedValueOnce({ok: false, status: 500} as unknown as Response);
		expect(await makeScanner().available()).toBe(false);
	});

	it("returns false when fetch throws (shim not running)", async () => {
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		expect(await makeScanner().available()).toBe(false);
	});
});

// ─── scan() ──────────────────────────────────────────────────────────────────

describe("vettd scanner scan()", () => {
	beforeEach(() => vi.clearAllMocks());

	it("successful scan: source=vettd, stringified version, verdict null", async () => {
		mockScanOk();
		const result = await makeScanner().scan(makeInput({"SKILL.md": "# Skill"}));

		expect(result.run.source).toBe("vettd");
		expect(result.run.status).toBe("success");
		expect(result.run.version).toBe("9");
		expect(result.run.verdict).toBeNull();
		expect(result.findings).toHaveLength(1);
	});

	// The shim omits `source` for first-party findings (Rust serde skips the
	// default) — the adapter MUST fill it or merged findings lose attribution.
	it("fills in source=vettd on findings that omit it", async () => {
		mockScanOk();
		const result = await makeScanner().scan(makeInput());
		expect(result.findings[0].source).toBe("vettd");
	});

	it("puts structural flags and fileCount in run.rawReport", async () => {
		mockScanOk();
		const result = await makeScanner().scan(makeInput());
		expect(result.run.rawReport).toEqual({
			hasSkillMd: true,
			hasScripts: false,
			hasReferences: false,
			hasEvals: false,
			fileCount: 3,
		});
	});

	// highCount includes critical (cisco.ts convention, NOT web's
	// vettd-scanner.ts which hardcodes criticalCount: 0).
	it("computes criticalCount and highCount with the cisco convention", async () => {
		mockScanOk(
			shimResponse({
				findings: [
					{ruleId: "a", category: "security", severity: "critical", label: "l", detail: "d"},
					{ruleId: "b", category: "security", severity: "high", label: "l", detail: "d"},
					{ruleId: "c", category: "security", severity: "medium", label: "l", detail: "d"},
				],
			}),
		);
		const result = await makeScanner().scan(makeInput());
		expect(result.run.findingCount).toBe(3);
		expect(result.run.criticalCount).toBe(1);
		expect(result.run.highCount).toBe(2);
	});

	it("POSTs the parity envelope {textFiles, allPaths} to /scan", async () => {
		mockScanOk();
		await makeScanner().scan(makeInput({"SKILL.md": "content", "scripts/run.sh": "#!/bin/bash"}));

		const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/scan");
		const body = JSON.parse(init.body as string) as {textFiles: Record<string, string>; allPaths: string[]};
		expect(body.textFiles["SKILL.md"]).toBe("content");
		expect(body.allPaths.sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
	});

	it("configured shim_url is used", async () => {
		mockScanOk();
		await makeScanner({shimUrl: "http://127.0.0.1:9999"}).scan(makeInput());
		const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("9999");
	});

	it("non-ok response: status errored, error contains status code", async () => {
		mockFetch.mockResolvedValueOnce({ok: false, status: 500} as unknown as Response);
		const result = await makeScanner().scan(makeInput());
		expect(result.run.status).toBe("errored");
		expect(result.run.error).toContain("500");
		expect(result.findings).toHaveLength(0);
	});

	it("fetch throws: status errored, error is exception message", async () => {
		mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
		const result = await makeScanner().scan(makeInput());
		expect(result.run.status).toBe("errored");
		expect(result.run.error).toContain("ECONNREFUSED");
	});

	it("fetch timeout: status errored, error=shim request timed out", async () => {
		const timeoutErr = Object.assign(new Error("The operation timed out."), {name: "TimeoutError"});
		mockFetch.mockRejectedValueOnce(timeoutErr);
		const result = await makeScanner().scan(makeInput());
		expect(result.run.status).toBe("errored");
		expect(result.run.error).toBe("shim request timed out");
	});

	it("200 but invalid JSON body: status errored", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: async () => {
				throw new SyntaxError("bad json");
			},
		} as unknown as Response);
		const result = await makeScanner().scan(makeInput());
		expect(result.run.status).toBe("errored");
		expect(result.run.error).toBe("shim response parse failed");
	});
});
