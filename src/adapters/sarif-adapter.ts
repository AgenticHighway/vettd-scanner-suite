import {logger} from "../logger.js";
import type {AssetFinding} from "../contract/asset-finding.js";

// ─── SARIF level → AssetFinding severity ────────────────────────────────────
// Fallback when result.properties.severity is absent. SARIF level conflates
// CRITICAL and HIGH into "error" — prefer properties.severity when available.
const SARIF_LEVEL_TO_SEVERITY: Record<string, AssetFinding["severity"]> = {
	error: "critical",
	warning: "medium",
	note: "info",
	none: "info",
};
const DEFAULT_SARIF_SEVERITY: AssetFinding["severity"] = "medium";

// Native severity strings emitted in result.properties.severity by scanners that support it.
const VALID_VTD_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

// ─── SARIF rule tags → AssetFinding category ────────────────────────────────
const SARIF_TAG_TO_CATEGORY: Record<string, AssetFinding["category"]> = {
	security: "security",
	"prompt-injection": "security",
	"supply-chain": "security",
	"best-practice": "best-practices",
	"best-practices": "best-practices",
	structure: "structure",
	description: "description",
	scripts: "scripts",
	evals: "evals",
};
const DEFAULT_FINDING_CATEGORY: AssetFinding["category"] = "security";

// ─── Limits ──────────────────────────────────────────────────────────────────
const MAX_DETAIL_LENGTH = 4096;

// ─── Internal SARIF type shapes (kept private) ───────────────────────────────
interface SarifRule {
	id?: string;
	name?: string;
	shortDescription?: {text?: string};
	properties?: {tags?: string[]};
}

interface SarifLocation {
	physicalLocation?: {
		artifactLocation?: {uri?: string};
		region?: {startLine?: number};
	};
}

interface SarifResult {
	ruleId?: string;
	ruleIndex?: number;
	level?: string;
	message?: {text?: string};
	locations?: SarifLocation[];
	properties?: {severity?: string};
}

interface SarifRun {
	tool?: {driver?: {rules?: SarifRule[]}};
	results?: SarifResult[];
}

interface SarifDocument {
	runs?: SarifRun[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveRule(
	result: SarifResult,
	rulesById: Map<string, SarifRule>,
	rulesByIndex: SarifRule[]
): SarifRule | undefined {
	if (result.ruleId) return rulesById.get(result.ruleId);
	if (typeof result.ruleIndex === "number") return rulesByIndex[result.ruleIndex];
	return undefined;
}

function resolveCategory(rule: SarifRule | undefined): AssetFinding["category"] {
	const tags = rule?.properties?.tags ?? [];
	for (const tag of tags) {
		const mapped = SARIF_TAG_TO_CATEGORY[tag.toLowerCase()];
		if (mapped) return mapped;
	}
	return DEFAULT_FINDING_CATEGORY;
}

function buildDetail(result: SarifResult): string {
	const location = result.locations?.[0]?.physicalLocation;
	const uri = location?.artifactLocation?.uri;
	const line = location?.region?.startLine;
	const message = result.message?.text?.trim() ?? "";

	let detail: string;
	if (uri && line != null) {
		detail = `${uri}:${line} — ${message}`;
	} else if (uri) {
		detail = `${uri} — ${message}`;
	} else {
		detail = message;
	}

	return detail.length > MAX_DETAIL_LENGTH ? detail.slice(0, MAX_DETAIL_LENGTH) : detail;
}

function mapResult(
	result: SarifResult,
	rulesById: Map<string, SarifRule>,
	rulesByIndex: SarifRule[]
): AssetFinding {
	const rule = resolveRule(result, rulesById, rulesByIndex);

	const propertiesSev = result.properties?.severity?.toLowerCase();
	const severity: AssetFinding["severity"] =
		(propertiesSev && VALID_VTD_SEVERITIES.has(propertiesSev)
			? (propertiesSev as AssetFinding["severity"])
			: undefined) ??
		SARIF_LEVEL_TO_SEVERITY[result.level ?? ""] ??
		DEFAULT_SARIF_SEVERITY;

	const ruleId = result.ruleId ?? rule?.id ?? "";

	const label =
		rule?.shortDescription?.text ??
		rule?.name ??
		rule?.id ??
		result.ruleId ??
		"cisco finding";

	const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;

	return {
		category: resolveCategory(rule),
		label,
		detail: buildDetail(result),
		severity,
		source: "cisco",
		ruleId,
		...(uri ? {filepath: uri} : {}),
	};
}

function mapRun(run: SarifRun): AssetFinding[] {
	const rules: SarifRule[] = run.tool?.driver?.rules ?? [];
	const rulesById = new Map<string, SarifRule>(
		rules.filter((r) => r.id != null).map((r) => [r.id!, r])
	);
	const results: SarifResult[] = run.results ?? [];
	return results.map((r) => mapResult(r, rulesById, rules));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert a Cisco SARIF blob (from skill-scanner --format sarif) to AssetFindings.
 * Pure and sync — invalid or unexpected shapes return [].
 */
export function sarifToFindings(sarif: unknown): AssetFinding[] {
	if (!sarif || typeof sarif !== "object") return [];
	try {
		const doc = sarif as SarifDocument;
		const runs = doc.runs ?? [];
		return runs.flatMap(mapRun);
	} catch (err) {
		logger.error({module: "adapters.sarif-adapter", err}, "Failed to parse SARIF document");
		return [];
	}
}
