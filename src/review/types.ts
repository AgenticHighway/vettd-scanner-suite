// Types for the post-scan review stage: a reviewer judges each deterministic finding in context
// (is it real? how severe?) and the outcome rides on the finding's `payload.reviews`. The stage
// never removes or reorders findings — it only adds entries, so a failed review leaves the finding
// counting exactly as it does today (fail-closed).

import type {AssetFinding} from "../contract/asset-finding.js";
import type {ScannerInput} from "../contract/scanner.js";
import type {DecisionUsage} from "../system1/types.js";

/** The review stage's id-space is shared with scanners: excluding id "system1" excludes the reviewer. */
export const SYSTEM1_REVIEWER_ID = "system1";

export type ReviewStatus = "reviewed" | "exempt" | "not_run" | "failed";

/** Why a finding has no review outcome. Closed vocabulary; each maps to a plain-words display line in vettd. */
export type ReviewFailReason =
	| "excluded" // the reviewer was in this job's excludeScanners (consent gate)
	| "unavailable" // no API key / reviewer not available()
	| "cap" // max_findings or max_calls reached before this finding was asked
	| "budget" // the review time budget expired before this finding was asked
	| "timeout" // the model call for this finding timed out
	| "http_error" // the model call for this finding failed (transport, key, HTTP)
	| "unanswered" // the model returned no usable answer for this finding
	| "internal"; // the reviewer crashed; the finding counts exactly as unreviewed

export type ReviewVerdictChoice = "real" | "not_executed" | "not_applicable";

export interface SeverityReview {
	choice: "critical" | "high" | "medium" | "low";
	probabilities: Record<string, number>;
	confidence: number;
}

/** Where the review looked: the context window shown to the model, not just the cited line. */
export type ReviewContext = {filepath: string; lineStart: number; lineEnd: number} | {scope: "skill"; truncated?: boolean};

/** One reviewer's outcome for one finding. Written to `payload.reviews[i]` on the finding. */
export interface ReviewEntry {
	reviewer: string;
	/** The model that answered (connector-reported version), when a call happened. */
	model?: string | null;
	status: ReviewStatus;
	reason?: ReviewFailReason;
	/** "not_real" when the validity choice is not "real". */
	verdict?: "real" | "not_real";
	/** The validity choice itself (which flavour of not-real, or real). */
	choice?: ReviewVerdictChoice;
	/** Every validity option's probability, so any surface can show the full distribution. */
	probabilities?: Record<string, number>;
	/** p(real) for "real", summed not-real mass for "not_real". */
	confidence?: number;
	severity?: SeverityReview;
	context?: ReviewContext;
}

/** What a finding points at, derived purely from the finding row (no model input). */
export type ReviewLocation = {filepath: string; lineStart: number; lineEnd: number} | {scope: "skill"};

/** An eligible finding handed to a reviewer, with its resolved location. */
export interface ReviewTarget {
	/** Index into the stage's eligible list; the reviewer keys its questions and entries by it. */
	key: number;
	finding: AssetFinding;
	location: ReviewLocation;
}

export interface ReviewCallRecord {
	region: string;
	targets: number[];
	usage: DecisionUsage | null;
	ms: number;
	error?: ReviewFailReason;
}

export interface ReviewerReport {
	calls: ReviewCallRecord[];
	usage: DecisionUsage;
	stopped?: "max_calls" | "budget";
}

/** One entry per target, same order as the targets passed in. */
export interface ReviewOutcome {
	entries: ReviewEntry[];
	report: ReviewerReport;
}

export interface ReviewOptions {
	config: {
		contextLines: number;
		maxCalls: number;
		maxFindings: number;
		budgetMs: number;
	};
}

export interface FindingReviewer {
	id: string;
	available(): boolean;
	review(input: ScannerInput, targets: ReviewTarget[], opts: ReviewOptions): Promise<ReviewOutcome>;
}
