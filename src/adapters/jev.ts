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
	type DecisionAnswer,
	type DecisionConnector,
	DecisionError,
	type DecisionResponse,
	type DecisionUsage,
} from "../system1/types.js";

const MODULE = "external-scanners.system1";

// Pinned, not configurable: the bearer key must never be redirectable by config.
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";

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

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// Only validated, typed fields survive: nothing the provider echoes back as free text is kept.
function cleanUsage(usage: unknown): DecisionUsage | undefined {
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	return {input_tokens: num(u.input_tokens), output_tokens: num(u.output_tokens), cost: num(u.cost)};
}

function cleanAnswer(answer: unknown): DecisionAnswer | null {
	if (typeof answer !== "object" || answer === null) return null;
	const a = answer as Record<string, unknown>;
	const probabilities: Record<string, number> = {};
	if (typeof a.probabilities === "object" && a.probabilities !== null) {
		for (const [k, v] of Object.entries(a.probabilities)) {
			const n = num(v);
			if (n !== undefined) probabilities[k.slice(0, 64)] = n;
		}
	}
	const legend: Record<string, string> = {};
	if (typeof a.legend === "object" && a.legend !== null) {
		for (const [k, v] of Object.entries(a.legend)) if (typeof v === "string") legend[k.slice(0, 64)] = v.slice(0, 200);
	}
	return {
		...(typeof a.type === "string" ? {type: a.type.slice(0, 16)} : {}),
		...(typeof a.choice === "string" ? {choice: a.choice.slice(0, 64)} : {}),
		...(num(a.score) !== undefined ? {score: num(a.score)} : {}),
		...(Object.keys(legend).length > 0 ? {legend} : {}),
		probabilities,
		confidence: num(a.confidence) ?? 0,
	};
}

function cleanResponse(raw: unknown): DecisionResponse {
	const r = raw as {model?: unknown; answers?: unknown; usage?: unknown} | null;
	if (typeof r?.answers !== "object" || r.answers === null) throw new DecisionError("protocol");
	const answers: Record<string, DecisionAnswer> = {};
	for (const [key, value] of Object.entries(r.answers)) {
		const answer = cleanAnswer(value);
		if (answer) answers[key.slice(0, 64)] = answer;
	}
	return {
		...(typeof r.model === "string" ? {model: r.model.slice(0, 100)} : {}),
		answers,
		...(cleanUsage(r.usage) ? {usage: cleanUsage(r.usage)} : {}),
	};
}

async function decide(body: unknown, cfg: System1ScannerConfig, apiKey: string): Promise<DecisionResponse> {
	let res: Response;
	try {
		res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
			body: JSON.stringify(body),
			// A redirect would carry the Authorization header to another host.
			redirect: "error",
			signal: AbortSignal.timeout(cfg.timeoutMs),
		});
	} catch (err) {
		throw new DecisionError(err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network");
	}
	if (!res.ok) {
		logger.error({module: MODULE, status: res.status}, "decision API HTTP error response");
		throw new DecisionError("http_error", res.status);
	}
	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		throw new DecisionError("protocol");
	}
	return cleanResponse(parsed);
}

export function createOpenRouterConnector(cfg: System1ScannerConfig): DecisionConnector {
	const key = () => process.env.OPENROUTER_API_KEY;
	return {
		model: cfg.model,
		available: () => !!key(),
		async askRules(skillName, payload, rules) {
			const apiKey = key();
			if (!apiKey) throw new DecisionError("no_key");
			return decide(buildRulesRequest(cfg.model, skillName, payload, rules), cfg, apiKey);
		},
		async aggregate(skillName, evidence, rulesChecked): Promise<AggregateResult> {
			const apiKey = key();
			if (!apiKey) throw new DecisionError("no_key");
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
