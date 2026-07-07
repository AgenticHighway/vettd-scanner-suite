// First-party skill scanner adapter. Talks to the Rust vettd-skill-scanner
// via its HTTP shim (the http-shim crate in that repo): GET /health and
// POST /scan {textFiles, allPaths} → {findings, structural flags, version}.

import type {ShimScannerConfig} from "../config/schema.js";
import type {AssetFinding, ScannerInput, ScannerOutput, SkillScanner} from "../contract/scanner.js";

const VETTD_SOURCE_ID = "vettd";

interface VettdShimResponse {
	findings: AssetFinding[];
	hasSkillMd: boolean;
	hasScripts: boolean;
	hasReferences: boolean;
	hasEvals: boolean;
	fileCount: number;
	scannerVersion: number;
}

function erroredOutput(runError: string, startedAt: number, scannedAt: Date): ScannerOutput {
	return {
		findings: [],
		run: {
			source: VETTD_SOURCE_ID,
			status: "errored",
			verdict: null,
			findingCount: 0,
			criticalCount: 0,
			highCount: 0,
			error: runError,
			durationMs: Date.now() - startedAt,
			scannedAt,
		},
	};
}

export function createVettdScanner(cfg: ShimScannerConfig): SkillScanner {
	return {
		id: VETTD_SOURCE_ID,

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
			const startedAt = Date.now();
			const scannedAt = new Date();

			let response: Response;
			try {
				response = await fetch(`${cfg.shimUrl}/scan`, {
					method: "POST",
					headers: {"Content-Type": "application/json"},
					body: JSON.stringify({
						textFiles: Object.fromEntries(input.textFiles),
						allPaths: input.allPaths,
					}),
					signal: AbortSignal.timeout(cfg.scanTimeoutMs),
				});
			} catch (err) {
				const isTimeout = err instanceof Error && err.name === "TimeoutError";
				const runError = isTimeout ? "shim request timed out" : (err instanceof Error ? err.message : String(err));
				return erroredOutput(runError, startedAt, scannedAt);
			}

			if (!response.ok) {
				return erroredOutput(`shim error (${response.status})`, startedAt, scannedAt);
			}

			let body: VettdShimResponse;
			try {
				body = (await response.json()) as VettdShimResponse;
			} catch {
				return erroredOutput("shim response parse failed", startedAt, scannedAt);
			}

			// The shim omits `source` on first-party findings (Rust serde skips
			// the default value) — fill it so merged findings stay attributable.
			const findings = body.findings.map((f) => ({...f, source: f.source ?? VETTD_SOURCE_ID}));
			const criticalCount = findings.filter((f) => f.severity === "critical").length;
			// Count convention follows adapters/cisco.ts (highCount includes
			// critical). vettd web's vettd-scanner.ts hardcodes criticalCount: 0
			// instead — deliberate divergence from that, per the cisco convention.
			const highCount = findings.filter((f) => ["critical", "high"].includes(f.severity)).length;

			return {
				findings,
				run: {
					source: VETTD_SOURCE_ID,
					version: String(body.scannerVersion),
					status: "success",
					verdict: null, // grading/verdict stays a consumer (vettd web) concern
					findingCount: findings.length,
					criticalCount,
					highCount,
					// Structural flags ride in rawReport — consumers need them at
					// cutover for audit metadata, without extending the contract.
					rawReport: {
						hasSkillMd: body.hasSkillMd,
						hasScripts: body.hasScripts,
						hasReferences: body.hasReferences,
						hasEvals: body.hasEvals,
						fileCount: body.fileCount,
					},
					durationMs: Date.now() - startedAt,
					scannedAt,
				},
			};
		},
	};
}
