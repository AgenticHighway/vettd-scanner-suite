// Scanner fan-out. Ported from vettd packages/api/src/external-scanners/runner.ts;
// the registry coupling was removed — callers pass the scanner list, and the
// per-scanner timeout comes from config ([jobs].scanner_timeout_ms).

import type {ScannerInput, ScannerOutput, SkillScanner} from "../contract/scanner.js";
import {logger} from "../logger.js";

export interface RunnerOptions {
	/** Per-scanner hard timeout in milliseconds. */
	timeoutMs: number;
}

async function runOne(scanner: SkillScanner, input: ScannerInput, timeoutMs: number): Promise<ScannerOutput> {
	const start = Date.now();
	const scannerId = scanner.id;

	logger.info({module: "core.runner", scannerId}, "scanner run started");

	// Pre-flight health check — unavailable scanners are skipped, not errored
	let isAvailable = false;
	try {
		isAvailable = await scanner.available();
	} catch {
		isAvailable = false;
	}
	if (!isAvailable) {
		const durationMs = Date.now() - start;
		logger.warn(
			{module: "core.runner", scannerId, status: "skipped", duration_ms: durationMs},
			"scanner unavailable, run skipped",
		);
		return {
			findings: [],
			run: {
				source: scanner.id,
				status: "skipped",
				findingCount: 0,
				criticalCount: 0,
				highCount: 0,
				durationMs,
				scannedAt: new Date(),
			},
		};
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const output = await Promise.race([
			scanner.scan(input),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
		clearTimeout(timer);
		const durationMs = Date.now() - start;
		const result = {...output, run: {...output.run, durationMs}};
		// A scanner can resolve normally with status "errored" (e.g. the vettd
		// adapter catching a shim fetch/HTTP failure and returning it as
		// run.error instead of throwing) — that path never hit the catch block
		// below, so its error text was silently dropped from every log line.
		const logFields = {
			module: "core.runner",
			scannerId,
			status: result.run.status,
			duration_ms: durationMs,
			findingCount: result.run.findingCount,
			...(result.run.error ? {error: result.run.error} : {}),
		};
		if (result.run.status === "errored") {
			logger.error(logFields, "scanner run completed");
		} else {
			logger.info(logFields, "scanner run completed");
		}
		return result;
	} catch (err) {
		clearTimeout(timer);
		const durationMs = Date.now() - start;
		const isTimeout = err instanceof Error && err.message === "timeout";
		const status = isTimeout ? "timeout" : "errored";
		if (isTimeout) {
			logger.warn(
				{module: "core.runner", scannerId, status, duration_ms: durationMs},
				"scanner run timed out",
			);
		} else {
			logger.error(
				{module: "core.runner", scannerId, status, duration_ms: durationMs, err},
				"scanner run errored",
			);
		}
		return {
			findings: [],
			run: {
				source: scanner.id,
				status,
				findingCount: 0,
				criticalCount: 0,
				highCount: 0,
				error: err instanceof Error ? err.message : String(err),
				durationMs,
				scannedAt: new Date(),
			},
		};
	}
}

export async function runScanners(
	scanners: SkillScanner[],
	input: ScannerInput,
	opts: RunnerOptions,
): Promise<ScannerOutput[]> {
	if (scanners.length === 0) return [];

	const settled = await Promise.allSettled(scanners.map((s) => runOne(s, input, opts.timeoutMs)));

	// runOne always resolves; the rejected branch is unreachable but kept for safety
	return settled.map((r) =>
		r.status === "fulfilled" ?
			r.value
		:	{
				findings: [],
				run: {
					source: "unknown",
					status: "errored",
					findingCount: 0,
					criticalCount: 0,
					highCount: 0,
					error: String((r as PromiseRejectedResult).reason),
					scannedAt: new Date(),
				},
			},
	);
}
