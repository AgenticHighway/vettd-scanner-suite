/**
 * Canonical finding type produced by the asset scanner pipeline.
 * Represents a single check result for any scanned asset (skills, repos, etc.).
 *
 * This is the suite-owned canonical copy, originally taken verbatim from the
 * vettd web repo's `@vettd/types` (packages/types/src/asset-finding.ts).
 * vettd web keeps its own copy held honest by contract-drift tests — a change
 * here is a wire-format change and must be coordinated with that repo.
 */
export interface AssetFinding {
	category:
		| "structure"
		| "security"
		| "best-practices"
		| "description"
		| "scripts"
		| "evals";
	label: string;
	detail: string;
	severity: "critical" | "high" | "medium" | "low" | "info";
	/** Relative path from the asset root to the file that produced this finding; absent for package-level findings */
	filepath?: string;
	/** OWASP Top 10 for LLM Applications (2025) category, if applicable */
	owaspLlmCategory?: string;
	// whether the pattern suggests deliberate harmful intent vs. poor hygiene
	intent?: "malicious" | "negligent" | null;
	// links findings that co-occur in an attack chain; same chainId = same chain
	chainId?: string | null;
	/** Scanner that produced this finding; defaults to "vettd" for first-party findings */
	source?: string;
	/** Rule identifier — VTD-#### for vettd-native findings, upstream id (e.g. AITech-1.1.1) for external scanners */
	ruleId?: string;
}
