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
		region?: {startLine?: number; snippet?: {text?: string}};
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

function buildDetail(result: SarifResult, line?: number): string {
	const uri = result.locations?.[0]?.physicalLocation?.artifactLocation?.uri;
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

// ─── Anchor correction ──────────────────────────────────────────────────────

/**
 * Verify a SARIF-cited startLine against the actual file content using the
 * result's snippet, and return the line the snippet actually appears on.
 *
 * Cisco's YARA scanner computes line numbers against the SKILL.md
 * "instruction body" (frontmatter stripped) but reports the location as the
 * full file, so its line numbers can be offset by the frontmatter length
 * while the snippet text itself is accurate.
 *
 * A finding may only move when its snippet unambiguously identifies one
 * line: a single-line snippet with one occurrence moves; a single-line
 * snippet with several occurrences moves to the occurrence closest to the
 * cited line. A multi-line snippet spans several lines and a tied closest
 * occurrence is genuinely ambiguous — in both cases keep the original cited
 * line, because collapsing distinct findings onto one line destroys their
 * distinct anchors.
 */
function resolveStartLine(
	result: SarifResult,
	files: Record<string, string> | undefined
): number | undefined {
	const location = result.locations?.[0]?.physicalLocation;
	const region = location?.region;
	const citedLine = region?.startLine;
	if (citedLine == null || region?.snippet?.text == null) return citedLine;

	const uri = location?.artifactLocation?.uri;
	const content = uri ? files?.[uri] : undefined;
	if (!content) return citedLine;

	const snippet = region.snippet.text.trim();
	if (!snippet) return citedLine;

	const lines = content.split("\n");
	const citedText = lines[citedLine - 1];
	if (citedText != null && citedText.includes(snippet)) return citedLine;

	if (snippet.includes("\n")) return citedLine;

	const occurrences: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].includes(snippet)) occurrences.push(i + 1);
	}
	if (occurrences.length === 1) return occurrences[0];

	if (occurrences.length > 1) {
		let best = citedLine;
		let bestDist = Infinity;
		let tied = false;
		for (const line of occurrences) {
			const dist = Math.abs(line - citedLine);
			if (dist < bestDist) {
				best = line;
				bestDist = dist;
				tied = false;
			} else if (dist === bestDist) {
				tied = true;
			}
		}
		if (!tied) return best;
	}
	return citedLine;
}

function mapResult(
	result: SarifResult,
	rulesById: Map<string, SarifRule>,
	rulesByIndex: SarifRule[],
	files: Record<string, string> | undefined
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
		detail: buildDetail(result, resolveStartLine(result, files)),
		severity,
		source: "cisco",
		ruleId,
		...(uri ? {filepath: uri} : {}),
	};
}

function mapRun(run: SarifRun, files: Record<string, string> | undefined): AssetFinding[] {
	const rules: SarifRule[] = run.tool?.driver?.rules ?? [];
	const rulesById = new Map<string, SarifRule>(
		rules.filter((r) => r.id != null).map((r) => [r.id!, r])
	);
	const results: SarifResult[] = run.results ?? [];
	return results.map((r) => mapResult(r, rulesById, rules, files));
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Convert a Cisco SARIF blob (from skill-scanner --format sarif) to AssetFindings.
 * Pure and sync — invalid or unexpected shapes return [].
 *
 * `files`, when provided, supplies the scanned files' contents so cited
 * startLines can be verified (and corrected) against the result snippets.
 */
export function sarifToFindings(sarif: unknown, files?: Record<string, string>): AssetFinding[] {
	if (!sarif || typeof sarif !== "object") return [];
	try {
		const doc = sarif as SarifDocument;
		const runs = doc.runs ?? [];
		return runs.flatMap((run) => mapRun(run, files));
	} catch (err) {
		logger.error({module: "adapters.sarif-adapter", err}, "Failed to parse SARIF document");
		return [];
	}
}
