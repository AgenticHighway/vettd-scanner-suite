// The one literal connector: OpenRouter's Decisions API serving `typesafe/jev-1.13`. It owns the
// wire format (typed questions in, probability distributions out) and the API key; nothing about
// rules, trust or Vettd's output shapes lives here. See ../system1/ for the scanner.

import type {System1ScannerConfig} from "../config/schema.js";
import {logger} from "../logger.js";
import type {System1Rule} from "../system1/rules.js";
import {
	AGGREGATE_VERDICTS,
	type AggregateEvidence,
	type AggregateResult,
	type AggregateVerdict,
	type DecisionConnector,
	type DecisionResponse,
} from "../system1/types.js";

const MODULE = "external-scanners.system1";

const VERDICT_QUESTION = (rulesChecked: number) =>
	({
		type: "choice",
		instructions: `Given ONLY these confirmed rule findings (already filtered to a clear signal out of ${rulesChecked} checks -- not the raw skill package), what is the overall severity of the most serious concern?`,
		criteria: {
			SAFE: "No security or policy concerns found; the skill behaves as described.",
			LOW: "Minor issues only: missing optional metadata (e.g. allowed-tools) or minor documentation gaps.",
			MEDIUM: "Moderate concerns: social engineering, suspicious patterns, or an actual declared tool-restriction violation.",
			HIGH: "Serious issues: prompt injection in SKILL.md, credential theft, or tool poisoning.",
			CRITICAL:
				"Immediate threats: data exfiltration to an external server, command injection (eval/exec), or hardcoded credentials.",
		},
	}) as const;

function questionFor(rule: System1Rule): Record<string, unknown> {
	if (rule.kind === "score") return {type: "score", instructions: rule.instructions, criteria: rule.levels};
	if (rule.kind === "classification") return {type: "choice", instructions: rule.instructions, criteria: rule.options};
	return {type: "choice", instructions: rule.instructions, criteria: {none: rule.none, present: rule.present}};
}

export function buildRulesRequest(model: string, skillName: string, payload: string, rules: readonly System1Rule[]): unknown {
	return {
		model,
		state: {skill_name: skillName, skill_payload: payload},
		questions: Object.fromEntries(rules.map((rule) => [rule.key, questionFor(rule)])),
	};
}

export function buildAggregateRequest(model: string, skillName: string, evidence: AggregateEvidence[], rulesChecked: number): unknown {
	return {
		model,
		state: {
			skill_name: skillName,
			confirmed_findings: evidence,
			rules_checked: rulesChecked,
			rules_fired: evidence.length,
		},
		questions: {verdict: VERDICT_QUESTION(rulesChecked)},
	};
}

export function parseVerdict(response: DecisionResponse): AggregateVerdict | null {
	const choice = response.answers?.verdict?.choice;
	return (AGGREGATE_VERDICTS as readonly string[]).includes(choice ?? "") ? (choice as AggregateVerdict) : null;
}

async function decide(body: unknown, cfg: System1ScannerConfig, apiKey: string): Promise<DecisionResponse> {
	const res = await fetch(cfg.endpoint, {
		method: "POST",
		headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(cfg.timeoutMs),
	});
	if (!res.ok) {
		logger.error({module: MODULE, status: res.status}, "decision API HTTP error response");
		throw new Error(`decision api http ${res.status}`);
	}
	const parsed = (await res.json()) as DecisionResponse;
	if (typeof parsed?.answers !== "object" || parsed.answers === null) {
		throw new Error("decision api response has no answers object");
	}
	return parsed;
}

export function createOpenRouterConnector(cfg: System1ScannerConfig): DecisionConnector {
	const key = () => process.env.OPENROUTER_API_KEY;
	return {
		model: cfg.model,
		available: () => !!key(),
		async askRules(skillName, payload, rules) {
			const apiKey = key();
			if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
			return decide(buildRulesRequest(cfg.model, skillName, payload, rules), cfg, apiKey);
		},
		async aggregate(skillName, evidence, rulesChecked): Promise<AggregateResult> {
			const apiKey = key();
			if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
			const response = await decide(buildAggregateRequest(cfg.model, skillName, evidence, rulesChecked), cfg, apiKey);
			return {
				verdict: parseVerdict(response),
				answer: response.answers.verdict ?? null,
				usage: response.usage ?? null,
				cost: response.usage?.cost ?? 0,
			};
		},
	};
}
