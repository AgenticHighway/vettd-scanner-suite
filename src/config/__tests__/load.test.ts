import {describe, expect, it} from "vitest";

import {ConfigError, loadConfig, parseConfig} from "../load.js";

const FULL_CONFIG = `
[server]
host = "0.0.0.0"
port = 9090

[jobs]
max_concurrent = 4
scanner_timeout_ms = 60000
max_batch_items = 10

[scanners.vettd]
enabled = true
shim_url = "http://127.0.0.1:9788"
health_timeout_ms = 1000
scan_timeout_ms = 20000

[scanners.cisco]
enabled = true
shim_url = "http://127.0.0.1:9787"
health_timeout_ms = 1500
scan_timeout_ms = 25000
concurrency = 3
queue_depth = 10

[scanners.socket]
enabled = true
timeout_ms = 15000
`;

describe("parseConfig", () => {
	it("round-trips a fully specified config", () => {
		const config = parseConfig(FULL_CONFIG);
		expect(config).toEqual({
			server: {host: "0.0.0.0", port: 9090},
			jobs: {maxConcurrent: 4, scannerTimeoutMs: 60000, maxBatchItems: 10},
			scanners: {
				vettd: {enabled: true, shimUrl: "http://127.0.0.1:9788", healthTimeoutMs: 1000, scanTimeoutMs: 20000},
				cisco: {
					enabled: true,
					shimUrl: "http://127.0.0.1:9787",
					healthTimeoutMs: 1500,
					scanTimeoutMs: 25000,
					concurrency: 3,
					queueDepth: 10,
				},
				socket: {enabled: true, timeoutMs: 15000},
			},
		});
	});

	it("applies defaults for an empty config", () => {
		const config = parseConfig("");
		expect(config.server).toEqual({host: "127.0.0.1", port: 8080});
		expect(config.jobs).toEqual({maxConcurrent: 2, scannerTimeoutMs: 120000, maxBatchItems: 50});
		expect(config.scanners.vettd.shimUrl).toBe("http://127.0.0.1:8788");
		expect(config.scanners.cisco.shimUrl).toBe("http://127.0.0.1:8787");
		expect(config.scanners.cisco.concurrency).toBe(1);
		expect(config.scanners.cisco.queueDepth).toBe(50);
		expect(config.scanners.socket.timeoutMs).toBe(30000);
	});

	// Fail-safe: a config that never mentions a scanner must not run it.
	it("defaults every scanner to disabled", () => {
		const config = parseConfig("");
		expect(config.scanners.vettd.enabled).toBe(false);
		expect(config.scanners.cisco.enabled).toBe(false);
		expect(config.scanners.socket.enabled).toBe(false);
	});

	// Typo protection: [scanners.vetd] must be an error, not a silently
	// ignored table that leaves the real scanner disabled.
	it("rejects an unknown scanner table", () => {
		expect(() => parseConfig("[scanners.vetd]\nenabled = true\n")).toThrow(ConfigError);
		expect(() => parseConfig("[scanners.vetd]\nenabled = true\n")).toThrow(/unknown key "vetd"/);
	});

	it("rejects an unknown key inside a scanner table", () => {
		expect(() => parseConfig('[scanners.vettd]\nshim = "http://x"\n')).toThrow(/unknown key "shim"/);
	});

	it("rejects an unknown top-level table", () => {
		expect(() => parseConfig("[serverr]\nport = 1\n")).toThrow(/unknown key "serverr"/);
	});

	it("rejects non-positive numeric values", () => {
		expect(() => parseConfig("[server]\nport = 0\n")).toThrow(ConfigError);
		expect(() => parseConfig("[scanners.vettd]\nscan_timeout_ms = -5\n")).toThrow(ConfigError);
	});

	// Concurrency below 1 would deadlock the adapter's mutex — it must never
	// parse, rather than being clamped silently at load time.
	it("rejects a non-positive cisco concurrency", () => {
		expect(() => parseConfig("[scanners.cisco]\nconcurrency = 0\n")).toThrow(ConfigError);
	});

	it("rejects a non-positive max_batch_items", () => {
		expect(() => parseConfig("[jobs]\nmax_batch_items = 0\n")).toThrow(ConfigError);
	});

	it("rejects non-integer numeric values", () => {
		expect(() => parseConfig("[server]\nport = 8080.5\n")).toThrow(ConfigError);
	});

	it("rejects a malformed shim_url", () => {
		expect(() => parseConfig('[scanners.vettd]\nshim_url = "not a url"\n')).toThrow(/not a valid URL/);
	});

	it("rejects a non-boolean enabled", () => {
		expect(() => parseConfig('[scanners.socket]\nenabled = "yes"\n')).toThrow(/must be a boolean/);
	});

	it("rejects invalid TOML syntax", () => {
		expect(() => parseConfig("[server\nport = 1")).toThrow(/invalid TOML/);
	});
});

describe("loadConfig", () => {
	// The service is useless without a config that enables scanners — a
	// missing file must fail fast and point the operator at the example.
	it("throws a ConfigError pointing at the example file when missing", () => {
		expect(() => loadConfig("/nonexistent/scanner-suite.toml")).toThrow(ConfigError);
		expect(() => loadConfig("/nonexistent/scanner-suite.toml")).toThrow(/scanner-suite\.example\.toml/);
	});
});
