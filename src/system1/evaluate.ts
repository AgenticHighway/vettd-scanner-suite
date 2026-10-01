// Turning raw decision answers into per-rule evaluations. Pure: no network, no mapping.

import type {DecisionAnswer, DecisionResponse} from "./types.js";
import {SYSTEM1_RULES, type System1Rule} from "./rules.js";

export interface Normalized {
	choice: string;
	probabilities: Record<string, number>;
}

/**
 * Choice answers arrive as `{choice, probabilities: {<option>: p}}`. Score answers do not: the live
 * API returns `{score, legend: {"0":"none","1":"mild","2":"strong"}, probabilities: {"0":..}}` (the
 * public demo only shows the choice form). `score` is the probability-weighted expected level, not
 * an index (0.02 when 98% of the mass is on "none"), so the chosen level is the legend entry with
 * the most probability. Both forms are folded into the choice form so the logic below has one shape
 * to read. Returns null when the answer is unusable.
 */
export function normalizeAnswer(answer: DecisionAnswer): Normalized | null {
	if (typeof answer.choice === "string") return {choice: answer.choice, probabilities: answer.probabilities ?? {}};
	const legend = answer.legend;
	if (!legend) return null;
	const probabilities: Record<string, number> = {};
	let best: {label: string; p: number} | null = null;
	for (const [index, p] of Object.entries(answer.probabilities ?? {})) {
		const label = legend[index];
		if (typeof label !== "string" || typeof p !== "number") continue;
		probabilities[label] = p;
		if (!best || p > best.p) best = {label, p};
	}
	return best ? {choice: best.label, probabilities} : null;
}

/**
 * The model's confidence in the chosen answer, always in [0, 1] and never silently zero. The live
 * API reports `confidence: 0` on every score-form answer, which would read as "no confidence" on a
 * real finding, so a missing or zero reported value falls back to the probability of the choice.
 */
export function confidenceFor(answer: DecisionAnswer, normalized: Normalized): number {
	const pChoice = normalized.probabilities[normalized.choice];
	const reported = answer.confidence;
	const value = typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : (pChoice ?? 0);
	return Math.min(1, Math.max(0, value));
}

export interface RuleEvaluation {
	rule: System1Rule;
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
	/** Non-"none" probability mass minus "none" mass; positive means the rule leans fired. Finding rules only. */
	margin: number;
	/** Finding rules: cleared the margin. Classification rules never "fire"; they always emit. */
	fired: boolean;
	/** For score rules, the winning non-"none" level; "present" for choice rules. */
	level: string;
}

function evaluateRule(
	rule: System1Rule,
	answer: DecisionAnswer,
	normalized: Normalized,
	marginThreshold: number,
): RuleEvaluation {
	const probs = normalized.probabilities;
	if (rule.kind === "classification") {
		return {
			rule,
			choice: normalized.choice,
			probabilities: probs,
			confidence: probs[normalized.choice] ?? confidenceFor(answer, normalized),
			margin: 0,
			fired: false,
			level: normalized.choice,
		};
	}
	const pNone = probs.none ?? 0;
	const firedEntries = Object.entries(probs).filter(([option]) => option !== "none");
	const firedMass = firedEntries.reduce((sum, [, p]) => sum + p, 0);
	const margin = firedMass - pNone;
	const top = firedEntries.sort((a, b) => b[1] - a[1])[0];
	const level = top?.[0] ?? "present";
	// `choice` must agree with the margin: the model picking "none" never fires, whatever the residue.
	const fired = normalized.choice !== "none" && margin >= marginThreshold;
	return {rule, choice: normalized.choice, probabilities: probs, confidence: confidenceFor(answer, normalized), margin, fired, level};
}

export interface Stage1Evaluation {
	evaluations: RuleEvaluation[];
	/** Rule keys with no answer in the response; never counted as fired, never emitted. */
	unanswered: string[];
}

export function evaluateStage1(response: DecisionResponse, marginThreshold: number): Stage1Evaluation {
	const evaluations: RuleEvaluation[] = [];
	const unanswered: string[] = [];
	for (const rule of SYSTEM1_RULES) {
		const answer = response.answers?.[rule.key];
		const normalized = answer ? normalizeAnswer(answer) : null;
		// A classification answer must be one of its own options; anything else is unusable.
		const usable = normalized && (rule.kind !== "classification" || normalized.choice in rule.options);
		if (!answer || !normalized || !usable) {
			unanswered.push(rule.key);
			continue;
		}
		evaluations.push(evaluateRule(rule, answer, normalized, marginThreshold));
	}
	return {evaluations, unanswered};
}
