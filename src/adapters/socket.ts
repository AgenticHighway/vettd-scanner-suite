import type {SocketScannerConfig} from "../config/schema.js";
import type {AssetFinding, ScannerInput, ScannerOutput, SkillScanner} from "../contract/scanner.js";
import {logger} from "../logger.js";

const SOCKET_SOURCE_ID = "socket";
const SOCKET_API_URL = "https://api.socket.dev/v0/purl";

// ─── Socket API types ─────────────────────────────────────────────────────────

interface SocketAlertProps {
	cveId?: string;
	ghsaId?: string;
	title?: string;
	description?: string;
	severity?: string;
	firstPatchedVersionIdentifier?: string;
}

interface SocketAlert {
	key: string;
	type: string;
	severity: string; // "critical" | "high" | "middle" | "low"
	category: string; // "vulnerability" | "supplyChainRisk" | "license" | "quality" | "maintenance"
	action: string; // "warn" | "monitor" | "ignore"
	props?: SocketAlertProps;
}

interface SocketPackage {
	name: string;
	version: string;
	type: string;
	alerts: SocketAlert[];
	inputPurl: string;
}

// ─── Manifest parsers ─────────────────────────────────────────────────────────

// Returns true when a version string is exact (no range operators).
function isExactVersion(v: string): boolean {
	return /^[0-9]/.test(v);
}

function parseNpm(content: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const obj = parsed as Record<string, unknown>;
	const deps: Record<string, unknown> = {};
	if (typeof obj.dependencies === "object" && obj.dependencies !== null)
		Object.assign(deps, obj.dependencies);
	if (typeof obj.devDependencies === "object" && obj.devDependencies !== null)
		Object.assign(deps, obj.devDependencies);

	const purls: string[] = [];
	for (const [name, version] of Object.entries(deps)) {
		if (typeof version !== "string" || !isExactVersion(version)) continue;
		// Scoped packages: @scope/name → %40scope/name (only @ is percent-encoded per PURL spec)
		const encoded = name.startsWith("@")
			? name.replace(/^@/, "%40")
			: name;
		purls.push(`pkg:npm/${encoded}@${version}`);
	}
	return purls;
}

function parsePypi(content: string): string[] {
	const purls: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		// Match name==version only (exact pin)
		const match = trimmed.match(/^([A-Za-z0-9_.-]+)==([0-9][A-Za-z0-9._-]*)$/);
		if (match) purls.push(`pkg:pypi/${match[1].toLowerCase()}@${match[2]}`);
	}
	return purls;
}

function parseGoMod(content: string): string[] {
	const purls: string[] = [];
	let inRequire = false;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "require (") {
			inRequire = true;
			continue;
		}
		if (inRequire && trimmed === ")") {
			inRequire = false;
			continue;
		}
		// Single-line require: require module/path v1.2.3 [// indirect]
		const single = trimmed.match(/^require\s+(\S+)\s+(v[0-9][^\s]*)(\s+\/\/.*)?$/);
		if (single) {
			purls.push(`pkg:golang/${single[1]}@${single[2]}`);
			continue;
		}
		if (inRequire) {
			const match = trimmed.match(/^(\S+)\s+(v[0-9][^\s]*)(\s+\/\/.*)?$/);
			if (match) purls.push(`pkg:golang/${match[1]}@${match[2]}`);
		}
	}
	return purls;
}

function parseCargo(content: string): string[] {
	const purls: string[] = [];
	let inDeps = false;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "[dependencies]" || trimmed === "[dev-dependencies]") {
			inDeps = true;
			continue;
		}
		if (trimmed.startsWith("[") && trimmed !== "[dependencies]" && trimmed !== "[dev-dependencies]") {
			inDeps = false;
			continue;
		}
		if (!inDeps) continue;
		// Match: name = "version" (exact string value, not inline table)
		const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"([0-9][^"]*)"$/);
		if (match) purls.push(`pkg:cargo/${match[1]}@${match[2]}`);
	}
	return purls;
}

function parseGemfileLock(content: string): string[] {
	const purls: string[] = [];
	let inSpecs = false;
	for (const line of content.split("\n")) {
		if (line.trimEnd() === "  specs:") {
			inSpecs = true;
			continue;
		}
		// Empty line or non-indented line ends the specs block
		if (inSpecs && !/^    /.test(line)) {
			inSpecs = false;
			continue;
		}
		if (!inSpecs) continue;
		// 4-space indent: "    name (version)"
		const match = line.match(/^    ([A-Za-z0-9_.-]+) \(([0-9][^)]*)\)$/);
		if (match) purls.push(`pkg:gem/${match[1]}@${match[2]}`);
	}
	return purls;
}

// ─── PURL extraction ──────────────────────────────────────────────────────────

const MANIFEST_PARSERS: Record<string, (content: string) => string[]> = {
	"package.json": parseNpm,
	"requirements.txt": parsePypi,
	"go.mod": parseGoMod,
	"Cargo.toml": parseCargo,
	"Gemfile.lock": parseGemfileLock,
};

function extractPurls(textFiles: Map<string, string>): string[] {
	const purls: string[] = [];
	for (const [filePath, content] of textFiles) {
		const basename = filePath.split("/").pop() ?? filePath;
		const parser = MANIFEST_PARSERS[basename];
		if (parser) purls.push(...parser(content));
	}
	// Deduplicate
	return [...new Set(purls)];
}

// ─── Alert → AssetFinding mapping ────────────────────────────────────────────

function mapAlert(alert: SocketAlert, pkg: SocketPackage): AssetFinding | null {
	// Socket's own policy marks low-signal alerts as "ignore" — respect that
	if (alert.action === "ignore") return null;

	const {severity, category, type, props} = alert;
	const pkgRef = `${pkg.name}@${pkg.version}`;

	let findingSeverity: AssetFinding["severity"];
	let findingCategory: AssetFinding["category"];
	let intent: AssetFinding["intent"] = null;

	if (category === "license") {
		findingSeverity = "medium";
		findingCategory = "best-practices";
	} else if (category === "vulnerability") {
		if (severity === "critical" || severity === "high") {
			findingSeverity = "critical";
		} else if (severity === "middle") {
			findingSeverity = "medium";
		} else {
			// low vulnerability — not actionable for skill trust signal
			return null;
		}
		findingCategory = "scripts";
	} else if (category === "supplyChainRisk") {
		if (severity === "critical" || severity === "high") {
			findingSeverity = "critical";
			if (type === "malware" || type === "knownMalware") {
				findingCategory = "security";
				intent = "malicious";
			} else {
				findingCategory = "scripts";
			}
		} else {
			// middle / low supply chain — medium
			findingSeverity = "medium";
			findingCategory = "scripts";
		}
	} else {
		// quality, maintenance, unknown — not surfaced for skill trust
		return null;
	}

	const title = props?.title ?? type;
	const cveRef = props?.cveId ?? props?.ghsaId;
	const descSnippet = props?.description?.slice(0, 200) ?? type;

	return {
		category: findingCategory,
		label: `${title} in ${pkgRef}`,
		detail: cveRef ? `${cveRef}: ${descSnippet}` : descSnippet,
		severity: findingSeverity,
		source: SOCKET_SOURCE_ID,
		ruleId: type,
		...(intent ? {intent} : {}),
	};
}

// ─── Socket API call ──────────────────────────────────────────────────────────

async function querySocket(purls: string[], apiKey: string, timeoutMs: number): Promise<SocketPackage[]> {
	logger.debug({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, endpoint: SOCKET_API_URL, purlCount: purls.length}, "dispatching outbound HTTP call to Socket.dev");
	const res = await fetch(`${SOCKET_API_URL}?alerts=true`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({components: purls.map((purl) => ({purl}))}),
		signal: AbortSignal.timeout(timeoutMs),
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

// ─── Skipped output helper ────────────────────────────────────────────────────

function skippedOutput(reason?: string): ScannerOutput {
	return {
		findings: [],
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

			const purls = extractPurls(input.textFiles);
			if (purls.length === 0) return skippedOutput();

			const startedAt = Date.now();
			const scannedAt = new Date();

			logger.info({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, purlCount: purls.length}, "socket scanner run started");

			let packages: SocketPackage[];
			try {
				packages = await querySocket(purls, apiKey, cfg.timeoutMs);
			} catch (err) {
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

			const findings: AssetFinding[] = [];
			let criticalCount = 0;
			let highCount = 0;
			for (const pkg of packages) {
				for (const alert of pkg.alerts ?? []) {
					const finding = mapAlert(alert, pkg);
					if (finding) {
						findings.push(finding);
						if (["critical","high"].includes(finding.severity)) {
							if (alert.severity === "critical") criticalCount++;
							else highCount++;
						}
					}
				}
			}

			const verdict = findings.some((f) => ["critical","high"].includes(f.severity))
				? "fail"
				: findings.some((f) => ["medium","low"].includes(f.severity))
					? "warn"
					: "pass";

			const duration_ms = Date.now() - startedAt;
			logger.info({module: "external-scanners.socket", scannerId: SOCKET_SOURCE_ID, status: "success", duration_ms, findingCount: findings.length}, "socket scanner run completed");

			return {
				findings,
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
		},
	};
}
