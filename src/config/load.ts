import {readFileSync} from "node:fs";

import {parse} from "smol-toml";

import {
	DEFAULT_CISCO_CONCURRENCY,
	DEFAULT_CISCO_QUEUE_DEPTH,
	DEFAULT_CISCO_SHIM_URL,
	DEFAULT_HEALTH_TIMEOUT_MS,
	DEFAULT_MAX_CONCURRENT_JOBS,
	DEFAULT_SCANNER_TIMEOUT_MS,
	DEFAULT_SCAN_TIMEOUT_MS,
	DEFAULT_SERVER_HOST,
	DEFAULT_SERVER_PORT,
	DEFAULT_SOCKET_TIMEOUT_MS,
	DEFAULT_VETTD_SHIM_URL,
	type ShimScannerConfig,
	type SuiteConfig,
} from "./schema.js";

export class ConfigError extends Error {}

// ─── Validation helpers ──────────────────────────────────────────────────────
// Hand-rolled on purpose: one small fixed schema does not justify a validation
// library. Every branch fails fast with a ConfigError naming the bad key.

function asTable(value: unknown, ctx: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConfigError(`[${ctx}] must be a table`);
	}
	return value as Record<string, unknown>;
}

function optionalTable(parent: Record<string, unknown>, key: string, ctx: string): Record<string, unknown> {
	return parent[key] === undefined ? {} : asTable(parent[key], ctx);
}

function checkKeys(table: Record<string, unknown>, allowed: string[], ctx: string): void {
	for (const key of Object.keys(table)) {
		if (!allowed.includes(key)) {
			throw new ConfigError(`unknown key "${key}" in [${ctx}]`);
		}
	}
}

function readBool(table: Record<string, unknown>, key: string, fallback: boolean, ctx: string): boolean {
	const value = table[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		throw new ConfigError(`[${ctx}] ${key} must be a boolean`);
	}
	return value;
}

function readPositiveInt(table: Record<string, unknown>, key: string, fallback: number, ctx: string): number {
	const value = table[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new ConfigError(`[${ctx}] ${key} must be a positive integer`);
	}
	return value;
}

function readHost(table: Record<string, unknown>, key: string, fallback: string, ctx: string): string {
	const value = table[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string" || value.length === 0) {
		throw new ConfigError(`[${ctx}] ${key} must be a non-empty string`);
	}
	return value;
}

function readUrl(table: Record<string, unknown>, key: string, fallback: string, ctx: string): string {
	const value = table[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string") {
		throw new ConfigError(`[${ctx}] ${key} must be a string`);
	}
	try {
		new URL(value);
	} catch {
		throw new ConfigError(`[${ctx}] ${key} is not a valid URL: "${value}"`);
	}
	return value;
}

function readShimScanner(
	scanners: Record<string, unknown>,
	name: string,
	defaultShimUrl: string,
): ShimScannerConfig {
	const ctx = `scanners.${name}`;
	const table = optionalTable(scanners, name, ctx);
	return {
		enabled: readBool(table, "enabled", false, ctx),
		shimUrl: readUrl(table, "shim_url", defaultShimUrl, ctx),
		healthTimeoutMs: readPositiveInt(table, "health_timeout_ms", DEFAULT_HEALTH_TIMEOUT_MS, ctx),
		scanTimeoutMs: readPositiveInt(table, "scan_timeout_ms", DEFAULT_SCAN_TIMEOUT_MS, ctx),
	};
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function parseConfig(toml: string): SuiteConfig {
	let parsed: unknown;
	try {
		parsed = parse(toml);
	} catch (err) {
		throw new ConfigError(`invalid TOML: ${err instanceof Error ? err.message : String(err)}`);
	}
	const root = asTable(parsed, "config");
	checkKeys(root, ["server", "jobs", "scanners"], "top level");

	const server = optionalTable(root, "server", "server");
	checkKeys(server, ["host", "port"], "server");

	const jobs = optionalTable(root, "jobs", "jobs");
	checkKeys(jobs, ["max_concurrent", "scanner_timeout_ms"], "jobs");

	const scanners = optionalTable(root, "scanners", "scanners");
	checkKeys(scanners, ["vettd", "cisco", "socket"], "scanners");

	const cisco = optionalTable(scanners, "cisco", "scanners.cisco");
	checkKeys(
		cisco,
		["enabled", "shim_url", "health_timeout_ms", "scan_timeout_ms", "concurrency", "queue_depth"],
		"scanners.cisco",
	);
	const vettd = optionalTable(scanners, "vettd", "scanners.vettd");
	checkKeys(vettd, ["enabled", "shim_url", "health_timeout_ms", "scan_timeout_ms"], "scanners.vettd");
	const socket = optionalTable(scanners, "socket", "scanners.socket");
	checkKeys(socket, ["enabled", "timeout_ms"], "scanners.socket");

	return {
		server: {
			host: readHost(server, "host", DEFAULT_SERVER_HOST, "server"),
			port: readPositiveInt(server, "port", DEFAULT_SERVER_PORT, "server"),
		},
		jobs: {
			maxConcurrent: readPositiveInt(jobs, "max_concurrent", DEFAULT_MAX_CONCURRENT_JOBS, "jobs"),
			scannerTimeoutMs: readPositiveInt(jobs, "scanner_timeout_ms", DEFAULT_SCANNER_TIMEOUT_MS, "jobs"),
		},
		scanners: {
			vettd: readShimScanner(scanners, "vettd", DEFAULT_VETTD_SHIM_URL),
			cisco: {
				...readShimScanner(scanners, "cisco", DEFAULT_CISCO_SHIM_URL),
				concurrency: readPositiveInt(cisco, "concurrency", DEFAULT_CISCO_CONCURRENCY, "scanners.cisco"),
				queueDepth: readPositiveInt(cisco, "queue_depth", DEFAULT_CISCO_QUEUE_DEPTH, "scanners.cisco"),
			},
			socket: {
				enabled: readBool(socket, "enabled", false, "scanners.socket"),
				timeoutMs: readPositiveInt(socket, "timeout_ms", DEFAULT_SOCKET_TIMEOUT_MS, "scanners.socket"),
			},
		},
	};
}

export function loadConfig(path: string): SuiteConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new ConfigError(
			`cannot read config file at ${path} — copy scanner-suite.example.toml to scanner-suite.toml and adjust`,
		);
	}
	return parseConfig(raw);
}
