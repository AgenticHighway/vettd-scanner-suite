import {describe, it, expect, vi, beforeEach} from "vitest";

import type {ScannerInput} from "../../contract/scanner.js";
import {createSocketScanner} from "../socket.js";

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

function makeSocketAlert(overrides: Partial<{
	type: string;
	severity: string;
	category: string;
	action: string;
	props: Record<string, unknown>;
}> = {}) {
	return {
		key: "Qabc123",
		type: "criticalCVE",
		severity: "critical",
		category: "vulnerability",
		action: "warn",
		props: {
			cveId: "CVE-2019-10744",
			ghsaId: "GHSA-jf85-cpcp-j695",
			title: "Prototype Pollution in lodash",
			description: "Versions before 4.17.12 are vulnerable to prototype pollution.",
			severity: "CRITICAL",
			firstPatchedVersionIdentifier: "4.17.12",
		},
		...overrides,
	};
}

function makeSocketPackage(name: string, version: string, alerts: ReturnType<typeof makeSocketAlert>[] = []) {
	return {
		id: "123",
		name,
		version,
		type: "npm",
		alerts,
		inputPurl: `pkg:npm/${name}@${version}`,
		batchIndex: 0,
		score: {overall: 0.25, vulnerability: 0.25, supplyChain: 0.75, license: 1, maintenance: 0.85, quality: 0.86},
	};
}

function mockSocketOk(packages: ReturnType<typeof makeSocketPackage>[]) {
	// NDJSON — one JSON object per line
	const ndjson = packages.map((p) => JSON.stringify(p)).join("\n");
	mockFetch.mockResolvedValueOnce({
		ok: true,
		status: 200,
		text: async () => ndjson,
	} as unknown as Response);
}

function mockSocketStatus(status: number) {
	mockFetch.mockResolvedValueOnce({
		ok: false,
		status,
		text: async () => JSON.stringify({error: "api error"}),
	} as unknown as Response);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("socketScanner", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		vi.unstubAllEnvs();
	});

	// SOCKET_API_KEY is deliberately env (a secret, never config) and is read
	// at call time by the adapter, so per-test env stubs apply with no
	// module-reset dance.
	function getScanner() {
		return createSocketScanner({enabled: true, timeoutMs: 30000});
	}

	describe("available()", () => {
		it("returns true when SOCKET_API_KEY is set", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();
			expect(await scanner.available()).toBe(true);
		});

		it("returns false when SOCKET_API_KEY is absent", async () => {
			vi.stubEnv("SOCKET_API_KEY", "");
			const scanner = getScanner();
			expect(await scanner.available()).toBe(false);
		});
	});

	describe("scan() — happy path", () => {
		it("produces a fail finding for a criticalCVE alert in a pinned npm dep", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketOk([makeSocketPackage("lodash", "4.17.4", [makeSocketAlert()])]);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {lodash: "4.17.4"}}),
			}));

			expect(result.run.source).toBe("socket");
			expect(result.run.status).toBe("success");
			expect(result.run.verdict).toBe("fail");
			expect(result.run.criticalCount).toBe(1);
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].severity).toBe("critical");
			expect(result.findings[0].category).toBe("scripts");
			expect(result.findings[0].source).toBe("socket");
			expect(result.findings[0].ruleId).toBe("criticalCVE");
			expect(result.findings[0].label).toContain("lodash@4.17.4");
		});

		it("sends correct PURL and uses alerts=true query param", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketOk([makeSocketPackage("lodash", "4.17.4", [])]);

			await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {lodash: "4.17.4"}}),
			}));

			const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
			expect(url).toContain("alerts=true");
			const body = JSON.parse(init.body as string) as {components: {purl: string}[]};
			expect(body.components).toContainEqual({purl: "pkg:npm/lodash@4.17.4"});
		});

		it("returns verdict=pass when all alerts are ignored", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketOk([makeSocketPackage("lodash", "4.17.4", [
				makeSocketAlert({action: "ignore"}),
			])]);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {lodash: "4.17.4"}}),
			}));

			expect(result.run.verdict).toBe("pass");
			expect(result.findings).toHaveLength(0);
			expect(result.run.findingCount).toBe(0);
		});

		it("stores raw Socket response in rawReport", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			const pkg = makeSocketPackage("lodash", "4.17.4", []);
			mockSocketOk([pkg]);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {lodash: "4.17.4"}}),
			}));

			expect(result.run.rawReport).toEqual([pkg]);
		});
	});

	describe("scan() — skip cases", () => {
		it("skips when textFiles has no manifest files", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			const result = await scanner.scan(makeInput({
				"SKILL.md": "# My Skill",
				"prompts/system.md": "You are helpful.",
			}));

			expect(result.run.status).toBe("skipped");
			expect(result.findings).toHaveLength(0);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("skips when package.json has only unpinned deps", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {"lodash": "^4.17.4", "express": "~4.18.0"}}),
			}));

			expect(result.run.status).toBe("skipped");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("skips when SOCKET_API_KEY is not set", async () => {
			vi.stubEnv("SOCKET_API_KEY", "");
			const scanner = getScanner();

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {lodash: "4.17.4"}}),
			}));

			expect(result.run.status).toBe("skipped");
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("scan() — error handling", () => {
		it("returns errored status on 429 with quota message", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketStatus(429);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {lodash: "4.17.4"}}),
			}));

			expect(result.run.status).toBe("errored");
			expect(result.run.error).toContain("quota");
		});

		it("returns errored status on 500", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketStatus(500);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {lodash: "4.17.4"}}),
			}));

			expect(result.run.status).toBe("errored");
			expect(result.run.error).toContain("500");
		});
	});

	describe("scan() — alert mapping", () => {
		it("maps knownMalware alert to security category with malicious intent", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketOk([makeSocketPackage("evil-pkg", "1.0.0", [
				makeSocketAlert({type: "knownMalware", severity: "critical", category: "supplyChainRisk", action: "warn"}),
			])]);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {"evil-pkg": "1.0.0"}}),
			}));

			expect(result.findings[0].category).toBe("security");
			expect(result.findings[0].intent).toBe("malicious");
			expect(result.findings[0].severity).toBe("critical");
		});

		it("maps license alert to best-practices category with warn severity", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketOk([makeSocketPackage("gpl-lib", "2.0.0", [
				makeSocketAlert({type: "copyleftLicense", severity: "low", category: "license", action: "monitor"}),
			])]);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {"gpl-lib": "2.0.0"}}),
			}));

			expect(result.findings[0].category).toBe("best-practices");
			expect(result.findings[0].severity).toBe("medium");
		});

		it("maps mediumCVE (severity=middle) to warn", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketOk([makeSocketPackage("some-pkg", "1.0.0", [
				makeSocketAlert({type: "mediumCVE", severity: "middle", category: "vulnerability", action: "monitor"}),
			])]);

			const result = await scanner.scan(makeInput({
				"package.json": JSON.stringify({dependencies: {"some-pkg": "1.0.0"}}),
			}));

			expect(result.findings[0].severity).toBe("medium");
			expect(result.run.verdict).toBe("warn");
		});
	});

	describe("scan() — ecosystems", () => {
		it("extracts correct PURL from requirements.txt", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			mockSocketOk([makeSocketPackage("requests", "2.28.0", [])]);

			await scanner.scan(makeInput({
				"requirements.txt": "requests==2.28.0\nflask>=2.0.0\n",
			}));

			const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {components: {purl: string}[]};
			expect(body.components).toContainEqual({purl: "pkg:pypi/requests@2.28.0"});
			// flask has >= so should be excluded
			expect(body.components).not.toContainEqual(expect.objectContaining({purl: expect.stringContaining("flask")}));
		});

		it("extracts correct PURL from Gemfile.lock", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			const gemfileLock = `GEM
  remote: https://rubygems.org/
  specs:
    rails (7.0.4)
    activesupport (7.0.4)

PLATFORMS
  ruby
`;
			mockSocketOk([makeSocketPackage("rails", "7.0.4", [])]);

			await scanner.scan(makeInput({"Gemfile.lock": gemfileLock}));

			const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {components: {purl: string}[]};
			expect(body.components).toContainEqual({purl: "pkg:gem/rails@7.0.4"});
			expect(body.components).toContainEqual({purl: "pkg:gem/activesupport@7.0.4"});
		});

		it("extracts correct PURL from go.mod", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			const goMod = `module example.com/myapp

go 1.21

require (
	github.com/gin-gonic/gin v1.9.1
	golang.org/x/crypto v0.14.0
)
`;
			mockSocketOk([makeSocketPackage("gin", "v1.9.1", [])]);

			await scanner.scan(makeInput({"go.mod": goMod}));

			const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {components: {purl: string}[]};
			expect(body.components).toContainEqual({purl: "pkg:golang/github.com/gin-gonic/gin@v1.9.1"});
			expect(body.components).toContainEqual({purl: "pkg:golang/golang.org/x/crypto@v0.14.0"});
		});

		it("extracts correct PURL from Cargo.toml", async () => {
			vi.stubEnv("SOCKET_API_KEY", "sk_test_123");
			const scanner = getScanner();

			const cargoToml = `[package]
name = "my-app"
version = "0.1.0"

[dependencies]
serde = "1.0.152"
tokio = { version = "1.25.0", features = ["full"] }
`;
			mockSocketOk([makeSocketPackage("serde", "1.0.152", [])]);

			await scanner.scan(makeInput({"Cargo.toml": cargoToml}));

			const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {components: {purl: string}[]};
			// serde = "1.0.152" is exact string form — should be included
			expect(body.components).toContainEqual({purl: "pkg:cargo/serde@1.0.152"});
			// tokio uses inline table form — not matched by our simple parser, which is acceptable
		});
	});
});
