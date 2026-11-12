// Eligibility and the secrets exemption, both pure: no model input decides either. A finding is
// reviewable when its source is configured for review, its severity clears the floor, and it is
// not itself model-inferred (System 1 findings are not re-judged by System 1).

import type {AssetFinding} from "../contract/asset-finding.js";
import {redactSecrets} from "../system1/redact.js";
import type {ReviewLocation} from "./types.js";

const SEVERITY_RANK: Record<AssetFinding["severity"], number> = {critical: 4, high: 3, medium: 2, low: 1, info: 0};

/**
 * Rules whose match itself is secret bytes (the Rust engine's `redact_match` patterns): their
 * cited line must never be quoted into a model call, so they are exempt from review entirely.
 * Any other rule whose *cited line* still contains secret material is caught by the placeholder
 * check in `secretsExempt`.
 */
const SECRET_RULE_IDS: readonly string[] = [
	"VTD-0001", // embedded private key
	"VTD-0002", // potential API token
	"VTD-0003", // high-entropy secret
	"VTD-0027", // shell base64 literal (the match is the secret-shaped blob)
	"SECRET_GITHUB_TOKEN", // Cisco pass-through secret rule
];

/** Severity floor: at or above `min` (inclusive). */
export function severityAtLeast(severity: AssetFinding["severity"], min: AssetFinding["severity"]): boolean {
	return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** Secrets exemption: rule-id list, or the cited line redacts to a placeholder — including a
 *  line that already carries a placeholder (redaction is idempotent, so a pre-redacted line
 *  would not otherwise register as changed). */
export function secretsExempt(finding: AssetFinding, location: ReviewLocation, textFiles: Map<string, string>): boolean {
	if (finding.ruleId && SECRET_RULE_IDS.includes(finding.ruleId)) return true;
	if ("scope" in location) return false;
	const content = textFiles.get(location.filepath);
	if (content === undefined) return false;
	const cited = content.split("\n").slice(location.lineStart - 1, location.lineEnd).join("\n");
	const redacted = redactSecrets(cited).text;
	return redacted !== cited || cited.includes("[REDACTED:");
}

/** Source in the configured set, severity at or above the floor, not model-inferred. */
export function isEligible(finding: AssetFinding, sources: readonly string[]): boolean {
	return sources.includes(finding.source ?? "") && finding.derivation !== "inferred";
}
