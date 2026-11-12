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
/** Characters per model call. Dense code runs about 2.4 characters a token and one call takes about
 *  250k tokens (measured 2026-11-09: 600k characters fit, 700k did not), so 400k leaves room for the
 *  questions. */
export const DEFAULT_SYSTEM1_PART_CHARS = 400_000;
/** Abuse ceiling only: 25 parts is 10 MB, vettd's own fetch limit for a skill's text. */
export const DEFAULT_SYSTEM1_MAX_PARTS = 25;
// Locating fired findings: provisional, to be set from the before/after measurement (vettd#1229).
export const DEFAULT_SYSTEM1_LOCATE_TARGET_LINES = 30;
export const DEFAULT_SYSTEM1_LOCATE_MAX_CALLS = 60;
export const DEFAULT_SYSTEM1_LOCATE_CONCURRENCY = 6;
export const DEFAULT_SYSTEM1_LOCATE_BUDGET_MS = 40_000;

// The review stage: System 1 judges each eligible regex/Cisco finding post-scan.
export const DEFAULT_REVIEW_SOURCES = ["vettd", "cisco"];
export const DEFAULT_REVIEW_MIN_SEVERITY = "medium";
export const DEFAULT_REVIEW_CONTEXT_LINES = 40;
export const DEFAULT_REVIEW_MAX_FINDINGS = 50;
export const DEFAULT_REVIEW_MAX_CALLS = 60;
export const DEFAULT_REVIEW_BUDGET_MS = 60_000;

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
	/** Characters per model call; larger skills are split into parts of this size. */
	partChars: number;
	/** Most parts read; past this the run is marked truncated. */
	maxParts: number;
	/** Locating fired safety findings by re-asking on smaller regions (vettd#1229). */
	locate: System1LocateConfig;
}

export interface System1LocateConfig {
	enabled: boolean;
	/** Line narrowing stops at a range this many lines long or shorter. */
	targetLines: number;
	/** Most extra model calls one scan may spend on locating. */
	maxCalls: number;
	/** Calls in flight at once. */
	concurrency: number;
	/** Wall time locating may take; past it, findings keep the narrowest range found so far. */
	budgetMs: number;
}

/** The post-scan review of deterministic findings (fp-check). See src/review/. */
export interface ReviewConfig {
	enabled: boolean;
	/** Finding sources eligible for review (regex and Cisco by default). */
	sources: string[];
	/** Findings below this severity are not reviewed. */
	minSeverity: "critical" | "high" | "medium" | "low";
	/** Context lines either side of a cited line. */
	contextLines: number;
	/** Most findings one scan may put through review, highest severity first. */
	maxFindings: number;
	/** Most model calls one scan's review may make. */
	maxCalls: number;
	/** Wall time the whole review may take. */
	budgetMs: number;
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
	/** Post-scan review stage; disabled by default like every model-touching scanner. */
	review: ReviewConfig;
}
