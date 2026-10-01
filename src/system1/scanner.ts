// System 1: a model-based scan that judges what regex cannot (intent, scope, clarity). One call
// asks every typed question over the skill's SKILL.md + scripts; safety findings that clearly fired
// (probability margin, not a bare plurality) go to a second call that returns an overall severity.
// Design record: vettd docs/system1-scanner.md.

import type {System1ScannerConfig} from "../config/schema.js";
import type {ScannerInput, ScannerOutput, SkillScanner} from "../contract/scanner.js";
import {logger} from "../logger.js";
import {evaluateStage1, type RuleEvaluation} from "./evaluate.js";
import {findingText, mapEvaluations} from "./map.js";
import {buildPayload, skillNameFromPayload} from "./payload.js";
import {SAFETY_RULES, SYSTEM1_RULES} from "./rules.js";
import {type AggregateVerdict, type DecisionConnector, errorCode, SYSTEM1_SOURCE_ID} from "./types.js";

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

			const payload = buildPayload(input.textFiles, cfg.maxPayloadChars);
			if (payload.includedPaths.length === 0) {
				return emptyRun("skipped", startedAt, scannedAt, "no SKILL.md or scripts to analyze");
			}
			const skillName = skillNameFromPayload(input.textFiles);
			logger.info({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, payloadChars: payload.text.length, truncated: payload.truncated}, "system1 scanner run started");

			let stage1Response;
			try {
				stage1Response = await connector.askRules(skillName, payload.text, SYSTEM1_RULES);
			} catch (err) {
				const code = errorCode(err);
				logger.error({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, code}, "system1 rule scan failed");
				return emptyRun(code === "timeout" ? "timeout" : "errored", startedAt, scannedAt, code);
			}

			const {evaluations, unanswered} = evaluateStage1(stage1Response, cfg.marginThreshold);
			// A partial answer set would read as "nothing found" for the missing rules; fail instead.
			if (unanswered.length > 0) {
				logger.error({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, unanswered: unanswered.length}, "system1 answered incompletely");
				return emptyRun("errored", startedAt, scannedAt, `system1 answered ${evaluations.length} of ${SYSTEM1_RULES.length} rule questions`);
			}
			const {findings, signals} = mapEvaluations(evaluations, cfg.model, scannedAt.toISOString());

			// Stage 2 sees only fired safety findings; with none, the aggregate is SAFE by construction.
			const firedSafety: RuleEvaluation[] = evaluations.filter((e) => e.fired && e.rule.emit === "finding");
			let verdict: AggregateVerdict | null = firedSafety.length === 0 ? "SAFE" : null;
			let stage2: Record<string, unknown> = {skipped: firedSafety.length === 0};
			let stage2Cost = 0;
			if (firedSafety.length > 0) {
				try {
					const result = await connector.aggregate(
						skillName,
						firedSafety.map((e) => ({rule: e.rule.key, section: e.rule.section, finding: findingText(e.rule)})),
						SAFETY_RULES.length,
					);
					verdict = result.verdict;
					stage2Cost = result.cost;
					stage2 = {answer: result.answer, usage: result.usage};
					if (!verdict) stage2.error = "unrecognized verdict choice";
				} catch (err) {
					const code = errorCode(err);
					stage2 = {error: code};
					logger.warn({module: MODULE, scannerId: SYSTEM1_SOURCE_ID, code}, "system1 aggregate call failed; deriving verdict from findings");
				}
			}
			// With no safety finding the aggregate says nothing about severities carried by signals.
			const derived = verdictFromSeverities([...findings, ...signals].map((f) => f.severity ?? "info"));
			const runVerdict = verdict && firedSafety.length > 0 ? runVerdictFor(verdict) : derived;

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
							chars: payload.text.length,
							includedPaths: payload.includedPaths,
							omittedPaths: payload.omittedPaths,
							truncated: payload.truncated,
						},
						stage1: {
							usage: stage1Response.usage ?? null,
							unanswered,
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
						totalCost: (stage1Response.usage?.cost ?? 0) + stage2Cost,
					},
					durationMs: duration,
					scannedAt,
				},
			};
		},
	};
}
