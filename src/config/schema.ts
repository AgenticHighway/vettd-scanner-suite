// Suite configuration types and defaults.
//
// All scanners default to enabled = false — enablement must be explicit in
// the TOML file (fail-safe: a missing table never silently runs a scanner).

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 8080;
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
export const DEFAULT_MAX_BATCH_ITEMS = 50;
export const DEFAULT_SCANNER_TIMEOUT_MS = 120_000;
export const DEFAULT_VETTD_SHIM_URL = "http://127.0.0.1:8788";
export const DEFAULT_CISCO_SHIM_URL = "http://127.0.0.1:8787";
export const DEFAULT_CISCO_CONCURRENCY = 1;
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
export const DEFAULT_CISCO_QUEUE_DEPTH = 50;
export const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;
export const DEFAULT_SYSTEM1_MODEL = "typesafe/jev-1.13";
// Per call (rule scan, then aggregate), so a full run stays inside jobs.scannerTimeoutMs.
export const DEFAULT_SYSTEM1_TIMEOUT_MS = 45_000;
export const DEFAULT_SYSTEM1_MARGIN_THRESHOLD = 0.5;
export const DEFAULT_SYSTEM1_MAX_PAYLOAD_CHARS = 100_000;

export interface ServerConfig {
	host: string;
	port: number;
}

export interface JobsConfig {
	maxConcurrent: number;
	scannerTimeoutMs: number;
	/** Items allowed in one POST /scans/batch submission. */
	maxBatchItems: number;
}

/** Scanner reached through a local HTTP shim (vettd's Rust shim, cisco's Python shim). */
export interface ShimScannerConfig {
	enabled: boolean;
	shimUrl: string;
	healthTimeoutMs: number;
	scanTimeoutMs: number;
}

export interface CiscoScannerConfig extends ShimScannerConfig {
	/**
	 * Cisco scans allowed to run at once. Must not exceed the shim's own pool
	 * size (CISCO_SHIM_CONCURRENCY on the shim process) — a larger value here
	 * just queues inside the shim instead, which is safe but pointless.
	 */
	concurrency: number;
	/** Waiters allowed beyond the in-flight scans before runs are skipped. */
	queueDepth: number;
}

/** External SaaS scanner — no shim; SOCKET_API_KEY comes from the environment. */
export interface SocketScannerConfig {
	enabled: boolean;
	timeoutMs: number;
}

/**
 * System 1: typed-question decision model, served by OpenRouter's Decisions API (external SaaS, no
 * shim). OPENROUTER_API_KEY comes from the environment. The endpoint is deliberately not
 * configurable: the key is only ever sent to the origin pinned in the connector.
 */
export interface System1ScannerConfig {
	enabled: boolean;
	model: string;
	/** Per HTTP call. */
	timeoutMs: number;
	/**
	 * A rule counts as fired only when its non-"none" probability mass beats "none" by at least
	 * this much. 0.5 means p(fired) >= 0.75; a coin-flip plurality never clears it.
	 */
	marginThreshold: number;
	/** Cap on the concatenated skill text sent to the model, in characters. */
	maxPayloadChars: number;
}

export interface SuiteConfig {
	server: ServerConfig;
	jobs: JobsConfig;
	scanners: {
		vettd: ShimScannerConfig;
		cisco: CiscoScannerConfig;
		socket: SocketScannerConfig;
		system1: System1ScannerConfig;
	};
}
