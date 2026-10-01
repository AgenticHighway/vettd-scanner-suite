// Evaluations to Vettd's output channels. Pure.
//
// - finding rules: fired -> AssetFinding (category security).
// - signalFinding rules: fired -> finding-shaped AssetSignal (non-safety category).
// - classification rules: always -> AssetSignal carrying the chosen option as valueText, with a
//   severity only when that option is a negative one. A finding implies a severity; a severity does
//   not imply a finding.
// Every row states `derivation: "inferred"` and the model's confidence.

import type {AssetFinding, AssetSignal} from "../contract/scanner.js";
import type {RuleEvaluation} from "./evaluate.js";
import type {System1Rule, System1Severity} from "./rules.js";
import {SYSTEM1_SOURCE_ID} from "./types.js";

const SCAN_SOURCE_CLASS = "scan";

/** A finding rule's phrase for the aggregate question: its criteria sentence minus the lead-in. */
export function findingText(rule: System1Rule): string {
	if (rule.kind === "score") return rule.instructions;
	if (rule.kind === "classification") return rule.summary;
	return rule.present.replace(/^The skill package contains /, "").replace(/\.$/, "");
}

function severityFor(rule: System1Rule, level: string): System1Severity {
	if (rule.kind === "score") return rule.severityByLevel[level] ?? "low";
	if (rule.kind === "classification") return rule.severityByValue[level] ?? "info";
	return rule.severity;
}

export function mapEvaluations(
	evaluations: RuleEvaluation[],
	model: string,
	observedAt: string,
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
			});
		} else {
			findings.push({
				category: "security",
				label,
				detail,
				severity,
				source: SYSTEM1_SOURCE_ID,
				ruleId: rule.ruleId,
				derivation: "inferred",
				confidence: e.confidence,
			});
		}
	}
	return {findings, signals};
}
