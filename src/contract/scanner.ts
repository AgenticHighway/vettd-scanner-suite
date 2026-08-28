import type {AssetFinding} from "./asset-finding.js";
import type {AssetSignal} from "./asset-signal.js";

export type {AssetFinding};
export type {AssetSignal};

// Ported from vettd packages/api/src/external-scanners/types.ts, with
// deliberate drops from the original:
// - ScannerInput.zipBuffer and .skillAuditId — no scanner ever read them.
// - ScannerOutput.analysis (SkillAnalysisResult) — a vettd-web coupling; the
//   first-party scanner's structural flags travel in run.rawReport instead.

export interface ScannerInput {
	textFiles: Map<string, string>;
	allPaths: string[];
}

/** Flat record describing a single scanner run. */
export interface ScannerRunResult {
	source: string;
	version?: string | null;
	status: string; // "success" | "skipped" | "errored" | "timeout"
	verdict?: string | null;
	findingCount: number;
	criticalCount: number;
	highCount: number;
	rawReport?: unknown;
	error?: string | null;
	durationMs?: number | null;
	/** Serializes to an ISO-8601 string over HTTP. */
	scannedAt: Date;
}

export interface ScannerOutput {
	findings: AssetFinding[];
	run: ScannerRunResult;
	/** Non-finding signals (first-party scanner only). Omitted when empty so a zero-signal run is byte-identical to today. */
	signals?: AssetSignal[];
}

export interface SkillScanner {
	id: string;
	available(): Promise<boolean>;
	scan(input: ScannerInput): Promise<ScannerOutput>;
}
