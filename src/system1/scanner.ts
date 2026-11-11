// System 1: a model-based scan that judges what regex cannot (intent, scope, clarity). One call per
// part asks every typed question over the skill's text (every text file, split to fit one call); safety findings that clearly fired
// (probability margin, not a bare plurality) go to a second call that returns an overall severity.
// Design record: vettd docs/system1-scanner.md.

import type {System1ScannerConfig} from "../config/schema.js";
import type {ScannerInput, ScannerOutput, SkillScanner} from "../contract/scanner.js";
import {logger} from "../logger.js";
import {evaluateStage1, type RuleEvaluation} from "./evaluate.js";
import {locateFindings, type LocateReport} from "./locate.js";
import {findingText, mapEvaluations} from "./map.js";
import {buildPayload, hasSkillContent, skillNameFromPayload} from "./payload.js";
import {SAFETY_RULES, SYSTEM1_RULES} from "./rules.js";
import {type AggregateVerdict, type DecisionConnector, type DecisionResponse, type DecisionUsage, errorCode, SYSTEM1_SOURCE_ID} from "./types.js";

const MODULE = "external-scanners.system1";

/** The aggregate scale onto the suite's run verdict: LOW and MEDIUM are warn-worthy, HIGH and CRITICAL fail. */
export function runVerdictFor(verdict: AggregateVerdict): "pass" | "warn" | "fail" {
	if (verdict === "SAFE") return "pass";
	if (verdict === "LOW" || verdict === "MEDIUM") return "warn";
	return "fail";
}

function verdictFromSeverities(severities: string[]): "pass" | "warn" | "fail" {
	if (severities.some((s) => s === "critical" || s === "high")) return "fail";
	if (severities.some((s) => s === "medium" || s === "low")) return "warn";
	return "pass";
}

/**
 * One evaluation per rule across parts. A finding rule takes the part where it leans fired most, so
 * it fires if it fires anywhere. A classification judges the instructions, so it takes the first
 * part, which holds SKILL.md.
 */
export function mergeParts(parts: RuleEvaluation[][]): RuleEvaluation[] {
	if (parts.length === 1) return parts[0];
	return parts[0].map((first) => {
		if (first.rule.kind === "classification") return first;
		return parts
			.map((p) => p.find((e) => e.rule.key === first.rule.key) ?? first)
			.reduce((best, e) => (e.margin > best.margin ? e : best));
	});
}

const VERDICT_RANK = {pass: 0, warn: 1, fail: 2} as const;

function capVerdict(v: "pass" | "warn" | "fail", cap: "pass" | "warn" | "fail"): "pass" | "warn" | "fail" {
	return VERDICT_RANK[v] > VERDICT_RANK[cap] ? cap : v;
}

async function aggregate(
	connector: DecisionConnector,
	skillName: string,
	firedSafety: RuleEvaluation[],
): Promise<{verdict: AggregateVerdict | null; stage2: Record<string, unknown>; stage2Cost: number}> {
	if (firedSafety.length === 0) return {verdict: "SAFE", stage2: {skipped: true}, stage2Cost: 0};
	try {
		const result = await connector.aggregate(
			skillName,
			firedSafety.map((e) => ({rule: e.rule.key, section: e.rule.section, finding: findingText(e.rule)})),
			SAFETY_RULES.length,
		);
		const stage2: Record<string, unknown> = {answer: result.answer, usage: result.usage};
		if (!result.verdict) stage2.error = "unrecognized verdict choice";
		return {verdict: result.verdict, stage2, stage2Cost: result.cost};
	} catch (err) {
		const code = errorCode(err);
		logger.warn({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, code}, "system1 aggregate call failed; deriving verdict from findings");
		return {verdict: null, stage2: {error: code}, stage2Cost: 0};
	}
}

/** Every localization ask with its answers, usage and time, so the thresholds can be re-cut offline. */
function localizationReport(r: LocateReport): Record<string, unknown> {
	return {
		calls: r.asks.length,
		usage: r.usage,
		...(r.stopped ? {stopped: r.stopped} : {}),
		outcomes: Object.fromEntries(r.outcomes),
		asks: r.asks,
	};
}

function emptyRun(status: string, startedAt: number, scannedAt: Date, error?: string): ScannerOutput {
	return {
		findings: [],
		run: {
			source: SYSTEM1_SOURCE_ID,
			status,
			findingCount: 0,
			criticalCount: 0,
			highCount: 0,
			...(error ? {error} : {}),
			durationMs: Date.now() - startedAt,
			scannedAt,
		},
	};
}

export function createSystem1Scanner(cfg: System1ScannerConfig, connector: DecisionConnector): SkillScanner {
	return {
		id: SYSTEM1_SOURCE_ID,

		async available(): Promise<boolean> {
			return connector.available();
		},

		async scan(input: ScannerInput): Promise<ScannerOutput> {
			const startedAt = Date.now();
			const scannedAt = new Date();
			if (!connector.available()) return emptyRun("skipped", startedAt, scannedAt, "decision API key is not set");

			if (!hasSkillContent(input.textFiles)) {
				return emptyRun("skipped", startedAt, scannedAt, "no SKILL.md or scripts to analyze");
			}
			const payload = buildPayload(input.textFiles, cfg.partChars, cfg.maxParts);
			const skillName = skillNameFromPayload(input.textFiles);
			logger.info({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, payloadChars: payload.chars, parts: payload.parts.length, truncated: payload.truncated}, "system1 scanner run started");

			// One call per part, in order. Any failed or incomplete part fails the run: a part that was
			// never judged would otherwise read as "nothing found" in it.
			const answered: {response: DecisionResponse; evaluations: RuleEvaluation[]}[] = [];
			for (const [index, part] of payload.parts.entries()) {
				let response: DecisionResponse;
				try {
					response = await connector.askRules(skillName, part.text, SYSTEM1_RULES);
				} catch (err) {
					const code = errorCode(err);
					logger.error({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, code, part: index + 1}, "system1 rule scan failed");
					return emptyRun(code === "timeout" ? "timeout" : "errored", startedAt, scannedAt, code);
				}
				const {evaluations: partEvaluations, unanswered} = evaluateStage1(response, cfg.marginThreshold);
				if (unanswered.length > 0) {
					logger.error({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, unanswered: unanswered.length, part: index + 1}, "system1 answered incompletely");
					return emptyRun("errored", startedAt, scannedAt, `system1 answered ${partEvaluations.length} of ${SYSTEM1_RULES.length} rule questions`);
				}
				answered.push({response, evaluations: partEvaluations});
			}
			const evaluations = mergeParts(answered.map((a) => a.evaluations));
			const stage1Response = answered[0].response;
			const stage1Usage = answered.reduce(
				(sum, a) => ({
					input_tokens: (sum.input_tokens ?? 0) + (a.response.usage?.input_tokens ?? 0),
					output_tokens: (sum.output_tokens ?? 0) + (a.response.usage?.output_tokens ?? 0),
					cost: (sum.cost ?? 0) + (a.response.usage?.cost ?? 0),
				}),
				{} as DecisionUsage,
			);
			// Stage 2 sees only fired safety findings; with none, the aggregate is SAFE by construction.
			// Locating those findings runs beside it: both need only stage 1's answers.
			const firedSafety: RuleEvaluation[] = evaluations.filter((e) => e.fired && e.rule.emit === "finding");
			const locating: Promise<LocateReport | null> =
				cfg.locate.enabled && firedSafety.length > 0
					? locateFindings(
							firedSafety.map((e) => ({evaluation: e, part: Math.max(0, answered.findIndex((a) => a.evaluations.includes(e)))})),
							payload,
							{connector, skillName, marginThreshold: cfg.marginThreshold, config: cfg.locate},
						).catch((err: unknown) => {
							// Locating only adds precision; a bug in it must never cost the run.
							logger.error({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, code: errorCode(err)}, "system1 localization failed");
							return null;
						})
					: Promise.resolve(null);
			const [{verdict, stage2, stage2Cost}, located] = await Promise.all([aggregate(connector, skillName, firedSafety), locating]);
			const {findings, signals} = mapEvaluations(evaluations, cfg.model, scannedAt.toISOString(), located?.outcomes);
			// With no safety finding the aggregate says nothing about defect signals, so derive from
			// findings and finding-shaped signals. Classifications describe the skill rather than
			// report a defect, so their severities grade a category but never the run.
			const defects = signals.filter((s) => s.valueText === undefined);
			const derived = verdictFromSeverities([...findings, ...defects].map((f) => f.severity ?? "info"));
			// The aggregate may judge the whole lower than its parts, never higher: three mediums are
			// not a HIGH, so its verdict is capped at the one the run's own findings support.
			const runVerdict = verdict && firedSafety.length > 0 ? capVerdict(runVerdictFor(verdict), derived) : derived;

			const duration = Date.now() - startedAt;
			logger.info({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, status: "success", duration_ms: duration, fired: evaluations.filter((e) => e.fired).length}, "system1 scanner run completed");

			return {
				findings,
				...(signals.length > 0 ? {signals} : {}),
				run: {
					source: SYSTEM1_SOURCE_ID,
					version: stage1Response.model ?? cfg.model,
					status: "success",
					verdict: runVerdict,
					findingCount: findings.length,
					criticalCount: findings.filter((f) => f.severity === "critical").length,
					highCount: findings.filter((f) => f.severity === "high").length,
					// Every answer, fired or not, with its probabilities: the material for agreement and
					// false-positive analysis against the other scanners, without a schema change.
					rawReport: {
						model: cfg.model,
						modelVersion: stage1Response.model ?? null,
						marginThreshold: cfg.marginThreshold,
						aggregateVerdict: verdict,
						payload: {
							chars: payload.chars,
							parts: payload.parts.map((part, i) => ({paths: part.paths, chars: part.text.length, usage: answered[i]?.response.usage ?? null})),
							includedPaths: payload.includedPaths,
							omittedPaths: payload.omittedPaths,
							truncated: payload.truncated,
							redactions: payload.redactions,
						},
						stage1: {
							usage: stage1Usage,
							unanswered: [],
							answers: Object.fromEntries(
								evaluations.map((e) => [
									e.rule.key,
									{
										choice: e.choice,
										probabilities: e.probabilities,
										confidence: e.confidence,
										margin: e.margin,
										fired: e.fired,
									},
								]),
							),
						},
						stage2,
						...(located ? {localization: localizationReport(located)} : {}),
						totalCost: (stage1Usage.cost ?? 0) + stage2Cost + (located?.usage.cost ?? 0),
					},
					durationMs: duration,
					scannedAt,
				},
			};
		},
	};
}
