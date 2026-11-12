import type {CiscoScannerConfig} from "../config/schema.js";
import type {ScannerInput, ScannerOutput, SkillScanner} from "../contract/scanner.js";
import {logger} from "../logger.js";
import {mapCiscoRuleId} from "./cisco-rule-mapping.js";
import {sarifToFindings} from "./sarif-adapter.js";

const CISCO_SOURCE_ID = "cisco";

// ─── Queue ───────────────────────────────────────────────────────────────────
// Concurrency comes from [scanners.cisco].concurrency (default 1). It must not
// exceed the shim process's own pool size (CISCO_SHIM_CONCURRENCY): the shim
// hands each scan an exclusively-checked-out scanner instance, so a higher
// value here simply blocks inside the shim rather than running in parallel.
// Raise [scanners.cisco].queue_depth if queue pressure becomes observable via
// status="skipped" runs.

class QueueFullError extends Error {
	readonly code = "cisco_queue_full" as const;
	constructor(depth: number) {
		super(`cisco scanner queue is full (depth=${depth})`);
	}
}

// ─── HTTP error classification ───────────────────────────────────────────────

function classifyShimError(status: number, body: unknown): string {
	if (status === 400) return "shim rejected input";
	if (status === 503) {
		logger.error({module: "adapters.cisco", scannerId: CISCO_SOURCE_ID, status, body}, "shim OOM (503)");
		return "shim oom";
	}
	return `shim internal error (${status})`;
}

// ─── Output shaping ──────────────────────────────────────────────────────────

// SPDX families (word-bounded) that count as a license being *declared*.
const SPDX_FAMILY = /\b(?:SPDX-License-Identifier|MIT|Apache|BSD|ISC|MPL|AGPL|LGPL|GPL|Unlicense|CC0)\b/i;
const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/g;

/**
 * Whether the scanned bundle itself declares a license: a LICENSE file is
 * present, or a README carries a license section that states the license
 * inline rather than only linking to a file outside the bundle. A bare
 * frontmatter "license" absence in that case is a parent-repo question, not a
 * bundle question, and is handled by the importer. Exported for the
 * MANIFEST_MISSING_LICENSE post-filter tests and remap tooling.
 */
export function bundleDeclaresLicense(files: Record<string, string>): boolean {
	for (const name of Object.keys(files)) {
		const base = name.split("/").pop() ?? name;
		if (/^licen[cs]e(\.|$)/i.test(base)) return true;
	}
	for (const [name, content] of Object.entries(files)) {
		if (!/^readme(\.|$)/i.test(name.split("/").pop() ?? name)) continue;
		// Split into heading-delimited sections; the leading token of each
		// section is its heading text.
		for (const section of content.split(/^#{1,6}\s*/m)) {
			if (!/^licen[cs]e\b/i.test(section)) continue;
			// Strip markdown links: a section whose only mention is a link to
			// a file outside the bundle (e.g. [Apache 2.0](../../LICENSE)) does
			// not declare anything the bundle carries.
			if (SPDX_FAMILY.test(section.replace(MARKDOWN_LINK, ""))) return true;
		}
	}
	return false;
}

interface ShapeOutputArgs {
	version: string | null;
	sarifBlob: unknown;
	findings: ReturnType<typeof sarifToFindings>;
	runStatus: "success" | "errored";
	runError: string | null;
	startedAt: number;
	scannedAt: Date;
}

function shapeOutput({
	version,
	sarifBlob,
	findings,
	runStatus,
	runError,
	startedAt,
	scannedAt,
}: ShapeOutputArgs): ScannerOutput {
	const criticalCount = findings.filter((f) => f.severity === "critical").length;
	const highCount = findings.filter((f) => ["critical", "high"].includes(f.severity)).length;
	return {
		findings,
		run: {
			source: CISCO_SOURCE_ID,
			version: version ?? undefined,
			status: runStatus,
			verdict: null,
			findingCount: findings.length,
			criticalCount,
			highCount,
			rawReport: sarifBlob ?? undefined,
			error: runError ?? undefined,
			scannedAt,
			durationMs: Date.now() - startedAt,
		},
	};
}

function queueFullOutput(err: QueueFullError): ScannerOutput {
	return {
		findings: [],
		run: {
			source: CISCO_SOURCE_ID,
			status: "skipped",
			findingCount: 0,
			criticalCount: 0,
			highCount: 0,
			error: err.message,
			scannedAt: new Date(),
		},
	};
}

// ─── Core scan via shim ───────────────────────────────────────────────────────

async function runScanViaShim(cfg: CiscoScannerConfig, input: ScannerInput): Promise<ScannerOutput> {
	const startedAt = Date.now();
	const scannedAt = new Date();

	const files: Record<string, string> = {};
	for (const [name, content] of input.textFiles) {
		if (name) files[name] = content;
	}

	let response: Response;
	try {
		response = await fetch(`${cfg.shimUrl}/scan`, {
			method: "POST",
			headers: {"Content-Type": "application/json"},
			body: JSON.stringify({files}),
			signal: AbortSignal.timeout(cfg.scanTimeoutMs),
		});
	} catch (err) {
		const isTimeout = err instanceof Error && err.name === "TimeoutError";
		const runError = isTimeout ? "shim request timed out" : (err instanceof Error ? err.message : String(err));
		return shapeOutput({version: null, sarifBlob: null, findings: [], runStatus: "errored", runError, startedAt, scannedAt});
	}

	if (!response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			// ignore parse failure — status code is sufficient
		}
		const runError = classifyShimError(response.status, body);
		return shapeOutput({version: null, sarifBlob: null, findings: [], runStatus: "errored", runError, startedAt, scannedAt});
	}

	let body: {ok: boolean; sarif: unknown; version?: string};
	try {
		body = (await response.json()) as {ok: boolean; sarif: unknown; version?: string};
	} catch {
		return shapeOutput({version: null, sarifBlob: null, findings: [], runStatus: "errored", runError: "shim response parse failed", startedAt, scannedAt});
	}

	const sarifBlob = body.sarif ?? null;
	const version = body.version ?? null;
	const rawFindings = sarifBlob ? sarifToFindings(sarifBlob, files) : [];
	const findings = rawFindings
		.map((f) => ({...f, ruleId: mapCiscoRuleId(f.ruleId ?? "")}))
		.filter((f) => f.ruleId !== "MANIFEST_MISSING_LICENSE" || !bundleDeclaresLicense(files));
	return shapeOutput({version, sarifBlob, findings, runStatus: "success", runError: null, startedAt, scannedAt});
}

// ─── SkillScanner factory ─────────────────────────────────────────────────────

export function createCiscoScanner(cfg: CiscoScannerConfig): SkillScanner {
	// Queue state lives in this closure — one queue per scanner instance, not
	// per module, so each configured instance (and each test) starts fresh.
	let inFlight = 0;
	const waiters: Array<{resolve: () => void}> = [];

	function acquire(): Promise<void> {
		if (inFlight < cfg.concurrency) {
			inFlight++; // synchronous increment — atomic in single-threaded JS
			return Promise.resolve();
		}
		if (waiters.length >= cfg.queueDepth) {
			return Promise.reject(new QueueFullError(cfg.queueDepth));
		}
		return new Promise<void>((resolve) => {
			waiters.push({resolve});
		});
	}

	function release(): void {
		const next = waiters.shift();
		if (next) {
			// Transfer slot directly — do not decrement so inFlight stays at
			// the configured concurrency ceiling.
			next.resolve();
			return;
		}
		inFlight--;
		if (inFlight < 0) inFlight = 0; // defensive; should never trip
	}

	return {
		id: CISCO_SOURCE_ID,

		async available(): Promise<boolean> {
			try {
				const res = await fetch(`${cfg.shimUrl}/health`, {
					signal: AbortSignal.timeout(cfg.healthTimeoutMs),
				});
				return res.ok;
			} catch {
				return false;
			}
		},

		async scan(input: ScannerInput): Promise<ScannerOutput> {
			try {
				await acquire();
			} catch (err) {
				if (err instanceof QueueFullError) return queueFullOutput(err);
				throw err;
			}
			try {
				return await runScanViaShim(cfg, input);
			} finally {
				release();
			}
		},
	};
}
