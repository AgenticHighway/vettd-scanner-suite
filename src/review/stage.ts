// The review stage: after all scanners finish, each reviewer judges each eligible deterministic
// finding. The stage owns eligibility, the secrets exemption and entry bookkeeping; the reviewer
// owns model calls. Never throws, never removes or reorders findings — it only appends
// `payload.reviews` entries, so a failed or missing review leaves the finding exactly as it is.

import type {AssetFinding} from "../contract/asset-finding.js";
import type {ScannerInput, ScannerOutput} from "../contract/scanner.js";
import {logger} from "../logger.js";
import {isEligible, secretsExempt, severityAtLeast} from "./eligibility.js";
import {findingLocation} from "./locate-finding.js";
import type {FindingReviewer, ReviewEntry, ReviewLocation, ReviewTarget} from "./types.js";

const MODULE = "review.stage";

/** Fallback stage options when the executor is built without config-provided opts. */
export const DEFAULT_REVIEW_OPTS: ReviewStageOpts = {
	sources: ["vettd", "cisco"],
	minSeverity: "medium",
	reviewerConfig: {contextLines: 40, maxCalls: 60, maxFindings: 50, budgetMs: 60_000},
};

export interface ReviewStageOpts {
	sources: readonly string[];
	minSeverity: AssetFinding["severity"];
	reviewerConfig: {
		contextLines: number;
		maxCalls: number;
		maxFindings: number;
		budgetMs: number;
	};
}

interface StagedFinding {
	finding: AssetFinding;
	location: ReviewLocation;
	eligible: boolean;
	exempt: boolean;
}

/** Attach an entry to a finding's payload.reviews (one entry per reviewer). */
function attach(finding: AssetFinding, entry: ReviewEntry): void {
	const payload: Record<string, unknown> = {...(finding.payload ?? {})};
	payload.reviews = [...((payload.reviews as ReviewEntry[] | undefined) ?? []), entry];
	finding.payload = payload;
}

/** The reviewer's call log lands on its own run's rawReport.review (no new ScannerRun source). */
function attachReport(results: ScannerOutput[], reviewerId: string, report: unknown): void {
	const run = results.find((r) => r.run.source === reviewerId);
	if (!run || report === null) return;
	const raw = ((run.run.rawReport ?? {}) as Record<string, unknown>) ?? {};
	raw.review = report;
	run.run.rawReport = raw;
}

/** Run every reviewer over every finding of every result. Mutates findings in place. */
export async function runReviewers(
	reviewers: readonly FindingReviewer[],
	input: ScannerInput,
	results: ScannerOutput[],
	opts: ReviewStageOpts,
	excluded: readonly string[],
): Promise<void> {
	try {
		const staged: StagedFinding[] = [];
		for (const result of results) {
			for (const finding of result.findings) {
				const location = findingLocation(finding, input.textFiles);
				const eligible = isEligible(finding, opts.sources) && severityAtLeast(finding.severity, opts.minSeverity);
				staged.push({finding, location, eligible, exempt: eligible && secretsExempt(finding, location, input.textFiles)});
			}
		}

		for (const reviewer of reviewers) {
			const targets: ReviewTarget[] = [];
			const stagedIndex: number[] = [];
			for (const [index, s] of staged.entries()) {
				if (!s.eligible) continue;
				if (s.exempt) {
					attach(s.finding, {reviewer: reviewer.id, status: "exempt"});
					continue;
				}
				targets.push({key: targets.length, finding: s.finding, location: s.location});
				stagedIndex.push(index);
			}
			if (targets.length === 0) continue;

			const isExcluded = excluded.includes(reviewer.id);
			if (isExcluded || !reviewer.available()) {
				const reason = isExcluded ? "excluded" : "unavailable";
				for (const t of targets) attach(staged[stagedIndex[t.key]].finding, {reviewer: reviewer.id, status: "not_run", reason});
				continue;
			}

			let outcome: Awaited<ReturnType<FindingReviewer["review"]>> | null = null;
			try {
				outcome = await reviewer.review(input, targets, {config: opts.reviewerConfig});
			} catch (err) {
				logger.error({module: MODULE, reviewer: reviewer.id, err}, "reviewer crashed; findings keep their unreviewed effect");
			}
			const entries = outcome && outcome.entries.length === targets.length ? outcome.entries : null;
			for (const t of targets) {
				const s = staged[stagedIndex[t.key]];
				attach(s.finding, entries ? entries[t.key] : {reviewer: reviewer.id, status: "failed", reason: "internal"});
			}
			attachReport(results, reviewer.id, outcome?.report ?? null);
		}
	} catch (err) {
		// The stage never throws: a broken review must not break the scan.
		logger.error({module: MODULE, err}, "review stage failed; findings keep their unreviewed effect");
	}
}
