import type {SocketScannerConfig} from "../config/schema.js";
import type {AssetCoverageEntry} from "../contract/asset-coverage.js";
import type {ScannerInput, ScannerOutput, SkillScanner} from "../contract/scanner.js";
import {logger} from "../logger.js";
import {extractDependencies} from "./dependencies/index.js";
import {
	extractionCoverage,
	lookupsNotPermittedCoverage,
	mapFindings,
	mapSignals,
	MAX_PURLS_PER_REQUEST,
	responseCoverage,
	SOCKET_SOURCE_ID,
	type SocketPackage,
} from "./socket-mapping.js";

// Origin is pinned so the token can only ever go to Socket. The legacy unscoped
// /v0/purl endpoint was removed on 2026-07-30; only the org path segment is configurable.
const SOCKET_API_ORIGIN = "https://api.socket.dev";

function purlEndpoint(orgSlug: string): string {
	return `${SOCKET_API_ORIGIN}/v0/orgs/${encodeURIComponent(orgSlug)}/purl`;
}

// ─── Socket API call ──────────────────────────────────────────────────────────

async function querySocket(purls: string[], apiKey: string, cfg: SocketScannerConfig): Promise<SocketPackage[]> {
	const endpoint = purlEndpoint(cfg.orgSlug);
	logger.debug({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, endpoint, purlCount: purls.length}, "dispatching outbound HTTP call to Socket.dev");
	const res = await fetch(`${endpoint}?alerts=true`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({components: purls.map((purl) => ({purl}))}),
		signal: AbortSignal.timeout(cfg.timeoutMs),
	});

	if (res.status === 429) {
		logger.warn({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, status: res.status}, "Socket.dev quota exhausted");
		throw Object.assign(new Error("socket quota exhausted"), {code: "quota"});
	}
	if (!res.ok) {
		logger.error({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, status: res.status}, "Socket.dev HTTP error response");
		throw new Error(`socket http ${res.status}`);
	}
	logger.info({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, status: res.status}, "Socket.dev HTTP response received");

	const body = await res.text();
	// Response is NDJSON — one JSON object per line per package. Skip malformed lines.
	const packages: SocketPackage[] = [];
	for (const line of body.trim().split("\n").filter(Boolean)) {
		try {
			packages.push(JSON.parse(line) as SocketPackage);
		} catch {
			// skip malformed line rather than failing the whole scan
		}
	}
	return packages;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function skippedOutput(reason?: string, coverage: AssetCoverageEntry[] = []): ScannerOutput {
	return {
		findings: [],
		...(coverage.length > 0 ? {coverage} : {}),
		run: {
			source: SOCKET_SOURCE_ID,
			status: "skipped",
			findingCount: 0,
			criticalCount: 0,
			highCount: 0,
			...(reason ? {error: reason} : {}),
			scannedAt: new Date(),
		},
	};
}

function failedOutput(err: unknown, startedAt: number, scannedAt: Date, coverage: AssetCoverageEntry[]): ScannerOutput {
	const isTimeout = err instanceof Error && err.name === "TimeoutError";
	const status = isTimeout ? "timeout" : "errored";
	const duration_ms = Date.now() - startedAt;
	if (isTimeout) {
		logger.warn({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, status, duration_ms}, "socket scanner timed out");
	} else {
		logger.error({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, status, duration_ms, err}, "socket scanner errored");
	}
	return {
		findings: [],
		...(coverage.length > 0 ? {coverage} : {}),
		run: {
			source: SOCKET_SOURCE_ID,
			status,
			findingCount: 0,
			criticalCount: 0,
			highCount: 0,
			error: err instanceof Error ? err.message : String(err),
			durationMs: duration_ms,
			scannedAt,
		},
	};
}

function successOutput(packages: SocketPackage[], startedAt: number, scannedAt: Date, coverage: AssetCoverageEntry[]): ScannerOutput {
	const findings = mapFindings(packages);
	// Suite convention (docs/design.md): criticalCount counts critical findings,
	// highCount counts critical+high. Counted on the mapped severity, not Socket's raw one.
	const criticalCount = findings.filter((f) => f.severity === "critical").length;
	const highCount = findings.filter((f) => f.severity === "critical" || f.severity === "high").length;
	const verdict = highCount > 0 ? "fail" : findings.length > 0 ? "warn" : "pass";
	const allCoverage = [...coverage, ...responseCoverage(packages)];
	const duration_ms = Date.now() - startedAt;
	logger.info({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, status: "success", duration_ms, findingCount: findings.length}, "socket scanner run completed");
	return {
		findings,
		signals: mapSignals(packages, scannedAt),
		...(allCoverage.length > 0 ? {coverage: allCoverage} : {}),
		run: {
			source: SOCKET_SOURCE_ID,
			status: "success",
			verdict,
			findingCount: findings.length,
			criticalCount,
			highCount,
			rawReport: packages,
			durationMs: duration_ms,
			scannedAt,
		},
	};
}

// ─── SkillScanner implementation ──────────────────────────────────────────────

export function createSocketScanner(cfg: SocketScannerConfig): SkillScanner {
	return {
		id: SOCKET_SOURCE_ID,

		async available(): Promise<boolean> {
			return !!process.env.SOCKET_API_KEY;
		},

		async scan(input: ScannerInput): Promise<ScannerOutput> {
			const apiKey = process.env.SOCKET_API_KEY;
			if (!apiKey) return skippedOutput();

			const {purls, unversioned} = extractDependencies(input.textFiles);
			if (purls.length === 0 && unversioned.length === 0) return skippedOutput();
			if (input.allowThirdPartyLookups !== true) {
				return skippedOutput(undefined, [lookupsNotPermittedCoverage(purls.length + unversioned.length)]);
			}
			const coverage = extractionCoverage(purls, unversioned);
			if (purls.length === 0) return skippedOutput(undefined, coverage);

			const startedAt = Date.now();
			const scannedAt = new Date();
			const batch = purls.slice(0, MAX_PURLS_PER_REQUEST);
			logger.info({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, purlCount: batch.length}, "socket scanner run started");
			try {
				const packages = await querySocket(batch, apiKey, cfg);
				return successOutput(packages, startedAt, scannedAt, coverage);
			} catch (err) {
				return failedOutput(err, startedAt, scannedAt, coverage);
			}
		},
	};
}
