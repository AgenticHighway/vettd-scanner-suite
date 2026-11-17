// Evaluations to Vettd's output channels. Pure.
//
// - finding rules: fired -> AssetFinding (category security).
// - signalFinding rules: fired -> finding-shaped AssetSignal (non-safety category).
// - classification rules: always -> AssetSignal carrying the chosen option as valueText, with a
//   severity only when that option is a negative one. A finding implies a severity; a severity does
//   not imply a finding.
// Every row states `derivation: "inferred"`, the model's confidence, and in `payload` the evidence
// (choice, every option's probability, and the margin for fired rules).

import type {AssetFinding, AssetSignal} from "../contract/scanner.js";
import type {RuleEvaluation} from "./evaluate.js";
import type {LocateOutcome} from "./locate.js";
import type {System1Rule, System1Severity} from "./rules.js";
import {SYSTEM1_SOURCE_ID} from "./types.js";

const SCAN_SOURCE_CLASS = "scan";

/**
 * A finding rule's phrase for the aggregate question: read from the definition, not the prompt —
 * stage 2 wants a short, stable phrase per confirmed finding, and tuned prompts get long and stop
 * starting with the lead-in this strips.
 */
export function findingText(rule: System1Rule): string {
	if (rule.kind === "score") return rule.instructions;
	if (rule.kind === "classification") return rule.summary;
	return rule.present.replace(/^The skill package contains /, "").replace(/\.$/, "");
}

/** The basis for one judgment, persisted per row so every surface can show it, not just rawReport. */
function evidence(e: RuleEvaluation, model: string): Record<string, unknown> {
	return {
		model,
		choice: e.choice,
		probabilities: e.probabilities,
		...(e.rule.kind === "classification" ? {} : {margin: e.margin}),
	};
}

function severityFor(rule: System1Rule, level: string): System1Severity {
	if (rule.kind === "score") return rule.severityByLevel[level] ?? "low";
	if (rule.kind === "classification") return rule.severityByValue[level] ?? "info";
	return rule.severity;
}

/**
 * A located finding's file goes to `filepath`; the lines, confidence and method ride in `payload.location`.
 * A file set has no `filepath`; its files ride in `payload.location.files`.
 */
function locationFields(loc: LocateOutcome | undefined): {filepath?: string; location?: Record<string, unknown>} {
	if (!loc) return {};
	if ("scope" in loc) return {location: {scope: loc.scope}};
	const {filepath, ...rest} = loc;
	return {filepath, location: rest};
}

export function mapEvaluations(
	evaluations: RuleEvaluation[],
	model: string,
	observedAt: string,
	locations: Map<string, LocateOutcome> = new Map(),
): {findings: AssetFinding[]; signals: AssetSignal[]} {
	const findings: AssetFinding[] = [];
	const signals: AssetSignal[] = [];
	for (const e of evaluations) {
		const {rule} = e;
		if (rule.kind === "classification") {
			const severity = rule.severityByValue[e.choice];
			signals.push({
				dataCategory: rule.dataCategory,
				sourceClass: SCAN_SOURCE_CLASS,
				ruleId: rule.ruleId,
				observedAt,
				source: SYSTEM1_SOURCE_ID,
				...(severity ? {severity} : {}),
				label: rule.summary,
				detail: `${rule.summary}: ${e.choice}.`,
				valueText: e.choice,
				derivation: "inferred",
				confidence: e.confidence,
				method: model,
				payload: evidence(e, model),
			});
			continue;
		}
		if (!e.fired) continue;
		const severity = severityFor(rule, e.level);
		const label = `System 1: ${rule.key.replace(/_/g, " ")}`;
		const detail = `${rule.summary}.`;
		if (rule.emit === "signalFinding") {
			signals.push({
				dataCategory: rule.dataCategory ?? "reliability",
				sourceClass: SCAN_SOURCE_CLASS,
				ruleId: rule.ruleId,
				observedAt,
				source: SYSTEM1_SOURCE_ID,
				severity,
				label,
				detail,
				derivation: "inferred",
				confidence: e.confidence,
				method: model,
				payload: evidence(e, model),
			});
		} else {
			const {filepath, location} = locationFields(locations.get(rule.key));
			findings.push({
				category: "security",
				label,
				detail,
				severity,
				...(filepath ? {filepath} : {}),
				source: SYSTEM1_SOURCE_ID,
				ruleId: rule.ruleId,
				derivation: "inferred",
				confidence: e.confidence,
				payload: {...evidence(e, model), ...(location ? {location} : {})},
			});
		}
	}
	return {findings, signals};
}
