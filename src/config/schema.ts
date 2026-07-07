// Suite configuration types and defaults.
//
// All scanners default to enabled = false — enablement must be explicit in
// the TOML file (fail-safe: a missing table never silently runs a scanner).

export const DEFAULT_SERVER_HOST = "127.0.0.1";
export const DEFAULT_SERVER_PORT = 8080;
export const DEFAULT_MAX_CONCURRENT_JOBS = 2;
export const DEFAULT_SCANNER_TIMEOUT_MS = 120_000;
export const DEFAULT_VETTD_SHIM_URL = "http://127.0.0.1:8788";
export const DEFAULT_CISCO_SHIM_URL = "http://127.0.0.1:8787";
export const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
export const DEFAULT_SCAN_TIMEOUT_MS = 30_000;
export const DEFAULT_CISCO_QUEUE_DEPTH = 50;
export const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;

export interface ServerConfig {
	host: string;
	port: number;
}

export interface JobsConfig {
	maxConcurrent: number;
	scannerTimeoutMs: number;
}

/** Scanner reached through a local HTTP shim (vettd's Rust shim, cisco's Python shim). */
export interface ShimScannerConfig {
	enabled: boolean;
	shimUrl: string;
	healthTimeoutMs: number;
	scanTimeoutMs: number;
}

export interface CiscoScannerConfig extends ShimScannerConfig {
	/** Waiters allowed beyond the single in-flight scan before runs are skipped. */
	queueDepth: number;
}

/** External SaaS scanner — no shim; SOCKET_API_KEY comes from the environment. */
export interface SocketScannerConfig {
	enabled: boolean;
	timeoutMs: number;
}

export interface SuiteConfig {
	server: ServerConfig;
	jobs: JobsConfig;
	scanners: {
		vettd: ShimScannerConfig;
		cisco: CiscoScannerConfig;
		socket: SocketScannerConfig;
	};
}
