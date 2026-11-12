// Reviewer construction from config: the System 1 reviewer shares the scanner's connector and
// model configuration. The reviewer id "system1" deliberately matches the scanner id so the
// existing consent gate (excludeScanners: ["system1"]) covers review without a new switch.

import {createOpenRouterConnector} from "../adapters/jev.js";
import type {SuiteConfig} from "../config/schema.js";
import type {ReviewStageOpts} from "./stage.js";
import {createSystem1Reviewer} from "./system1-reviewer.js";
import type {FindingReviewer} from "./types.js";

export function buildReviewers(config: SuiteConfig): FindingReviewer[] {
	if (!config.review.enabled) return [];
	return [createSystem1Reviewer(config.scanners.system1, createOpenRouterConnector(config.scanners.system1))];
}

export function reviewStageOpts(config: SuiteConfig): ReviewStageOpts {
	return {
		sources: config.review.sources,
		minSeverity: config.review.minSeverity,
		reviewerConfig: {
			contextLines: config.review.contextLines,
			maxCalls: config.review.maxCalls,
			maxFindings: config.review.maxFindings,
			budgetMs: config.review.budgetMs,
		},
	};
}
