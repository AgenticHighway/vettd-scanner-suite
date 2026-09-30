// JEV rule scan: a two-stage threat assessment over OpenRouter's Decisions API
// (`typesafe/jev-1.13`). Stage 1 asks one typed question per rule (39) in a single call over the
// skill's SKILL.md + scripts; only rules that clearly fired (probability margin, not a bare
// plurality) go to stage 2, which asks one severity question conditioned on that curated evidence.
//
// Everything here except the two HTTP calls is a pure function so it can be tested without a
// network. Design rationale: vettd docs/spikes/jev-scan-emitter.md.

import type {JevScannerConfig} from "../config/schema.js";
import type {
	AssetFinding,
	AssetSignal,
	ScannerInput,
	ScannerOutput,
	SkillScanner,
} from "../contract/scanner.js";
import {logger} from "../logger.js";
import {JEV_RULES, type JevChoiceRule, type JevRule, type JevScoreRule} from "./jev-rules.js";

const JEV_SOURCE_ID = "jev";
const SCAN_SOURCE_CLASS = "scan";

const VERDICT_QUESTION = {
	type: "choice",
	instructions:
		"Given ONLY these confirmed rule findings (already filtered to a clear signal out of 39 checks -- not the raw skill package), what is the overall severity of the most serious concern?",
	criteria: {
		SAFE: "No security or policy concerns found; the skill behaves as described.",
		LOW: "Minor issues only: missing optional metadata (e.g. allowed-tools) or minor documentation gaps.",
		MEDIUM: "Moderate concerns: social engineering, suspicious patterns, or an actual declared tool-restriction violation.",
		HIGH: "Serious issues: prompt injection in SKILL.md, credential theft, or tool poisoning.",
		CRITICAL:
			"Immediate threats: data exfiltration to an external server, command injection (eval/exec), or hardcoded credentials.",
	},
} as const;

const VERDICTS = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type JevVerdict = (typeof VERDICTS)[number];

// ─── Wire types ───────────────────────────────────────────────────────────────

export interface JevAnswer {
	type?: string;
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
}

interface JevUsage {
	input_tokens?: number;
	output_tokens?: number;
	cost?: number;
}

export interface JevResponse {
	answers: Record<string, JevAnswer>;
	usage?: JevUsage;
}

// ─── Payload ──────────────────────────────────────────────────────────────────

const SCRIPT_EXTENSIONS = new Set([
	"py", "js", "mjs", "cjs", "ts", "sh", "bash", "zsh", "rb", "go", "rs", "ps1", "pl", "php", "java", "lua",
]);
// Dependency manifests: the unpinned / provenance / typosquatting rules have nothing to read without them.
const MANIFEST_BASENAMES = new Set([
	"package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "Gemfile.lock",
]);

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

function isSkillMd(path: string): boolean {
	return basename(path).toLowerCase() === "skill.md";
}

function isPayloadFile(path: string): boolean {
	const base = basename(path);
	if (MANIFEST_BASENAMES.has(base)) return true;
	const dot = base.lastIndexOf(".");
	return dot > 0 && SCRIPT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export interface JevPayload {
	text: string;
	includedPaths: string[];
	/** Eligible files dropped (or cut short) to stay under the character cap. */
	omittedPaths: string[];
	truncated: boolean;
}

/**
 * The text jev reads: the shallowest SKILL.md first, then scripts and dependency manifests in path
 * order, each as `### FILE: <path>`. References and assets are deliberately not sent (cost, and
 * parity with the demo). Stops at `maxChars`, cutting the file that crosses the cap.
 */
export function buildPayload(textFiles: Map<string, string>, maxChars: number): JevPayload {
	const skillMds = [...textFiles.keys()]
		.filter(isSkillMd)
		.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
	const others = [...textFiles.keys()].filter((p) => !isSkillMd(p) && isPayloadFile(p)).sort();
	const ordered = [...skillMds.slice(0, 1), ...others];

	const sections: string[] = [];
	const includedPaths: string[] = [];
	const omittedPaths: string[] = [];
	let used = 0;
	let truncated = false;
	for (const path of ordered) {
		const remaining = maxChars - used;
		if (remaining <= 0) {
			omittedPaths.push(path);
			truncated = true;
			continue;
		}
		const header = `### FILE: ${path}\n`;
		const content = textFiles.get(path) ?? "";
		let section = header + content;
		if (section.length > remaining) {
			section = section.slice(0, remaining);
			omittedPaths.push(path);
			truncated = true;
		}
		sections.push(section);
		includedPaths.push(path);
		used += section.length + 2; // "\n\n" separator
	}
	return {text: sections.join("\n\n"), includedPaths, omittedPaths, truncated};
}

export function skillNameFromPayload(textFiles: Map<string, string>): string {
	const skillMdPath = [...textFiles.keys()].find(isSkillMd);
	const content = skillMdPath ? (textFiles.get(skillMdPath) ?? "") : "";
	const match = content.match(/^---\s*\n[\s\S]*?^name:\s*["']?([^\n"']+?)["']?\s*$/m);
	return match?.[1]?.trim() || "unknown";
}

// ─── Requests ─────────────────────────────────────────────────────────────────

function questionFor(rule: JevRule): Record<string, unknown> {
	if (rule.kind === "score") {
		return {type: "score", instructions: rule.instructions, criteria: rule.levels};
	}
	return {
		type: "choice",
		instructions: rule.instructions,
		criteria: {none: rule.none, present: rule.present},
	};
}

export function buildStage1Request(model: string, skillName: string, payload: string): unknown {
	return {
		model,
		state: {skill_name: skillName, skill_payload: payload},
		questions: Object.fromEntries(JEV_RULES.map((rule) => [rule.key, questionFor(rule)])),
	};
}

// ─── Stage-1 evaluation ───────────────────────────────────────────────────────

export interface RuleEvaluation {
	rule: JevRule;
	choice: string;
	probabilities: Record<string, number>;
	confidence: number;
	/** Non-"none" probability mass minus "none" mass; positive means the rule leans fired. */
	margin: number;
	fired: boolean;
	/** For score rules, the winning non-"none" level; "present" for choice rules. */
	level: string;
}

function evaluateRule(rule: JevRule, answer: JevAnswer, marginThreshold: number): RuleEvaluation {
	const probs = answer.probabilities ?? {};
	const pNone = probs.none ?? 0;
	const firedEntries = Object.entries(probs).filter(([option]) => option !== "none");
	const firedMass = firedEntries.reduce((sum, [, p]) => sum + p, 0);
	const margin = firedMass - pNone;
	const top = firedEntries.sort((a, b) => b[1] - a[1])[0];
	const level = top?.[0] ?? "present";
	// `choice` must agree with the margin: jev picking "none" never fires, whatever the residue.
	const fired = answer.choice !== "none" && margin >= marginThreshold;
	return {
		rule,
		choice: answer.choice,
		probabilities: probs,
		confidence: answer.confidence,
		margin,
		fired,
		level,
	};
}

export interface Stage1Evaluation {
	evaluations: RuleEvaluation[];
	/** Rule keys with no answer in the response; never counted as fired. */
	unanswered: string[];
}

export function evaluateStage1(response: JevResponse, marginThreshold: number): Stage1Evaluation {
	const evaluations: RuleEvaluation[] = [];
	const unanswered: string[] = [];
	for (const rule of JEV_RULES) {
		const answer = response.answers?.[rule.key];
		if (!answer || typeof answer.choice !== "string") {
			unanswered.push(rule.key);
			continue;
		}
		evaluations.push(evaluateRule(rule, answer, marginThreshold));
	}
	return {evaluations, unanswered};
}

// ─── Stage 2 ──────────────────────────────────────────────────────────────────

/** Rule's finding phrase: the criteria sentence minus its "The skill package contains " lead-in. */
function findingText(rule: JevRule): string {
	if (rule.kind === "score") return rule.instructions;
	return rule.present.replace(/^The skill package contains /, "").replace(/\.$/, "");
}

export function buildStage2Request(model: string, skillName: string, fired: RuleEvaluation[]): unknown {
	return {
		model,
		state: {
			skill_name: skillName,
			confirmed_findings: fired.map((e) => ({
				rule: e.rule.key,
				section: e.rule.section,
				finding: findingText(e.rule),
			})),
			rules_checked: JEV_RULES.length,
			rules_fired: fired.length,
		},
		questions: {verdict: VERDICT_QUESTION},
	};
}

export function parseVerdict(response: JevResponse): JevVerdict | null {
	const choice = response.answers?.verdict?.choice;
	return (VERDICTS as readonly string[]).includes(choice ?? "") ? (choice as JevVerdict) : null;
}

/** JEV's five-step scale onto the suite's run verdict: LOW and MEDIUM are warn-worthy, HIGH and CRITICAL fail. */
export function runVerdictFor(verdict: JevVerdict): "pass" | "warn" | "fail" {
	if (verdict === "SAFE") return "pass";
	if (verdict === "LOW" || verdict === "MEDIUM") return "warn";
	return "fail";
}

function verdictFromSeverities(severities: string[]): "pass" | "warn" | "fail" {
	if (severities.some((s) => s === "critical" || s === "high")) return "fail";
	if (severities.some((s) => s === "medium" || s === "low")) return "warn";
	return "pass";
}

// ─── Mapping to findings and signals ──────────────────────────────────────────

function severityFor(rule: JevRule, level: string): AssetFinding["severity"] {
	return rule.kind === "score"
		? ((rule as JevScoreRule).severityByLevel[level] ?? "low")
		: (rule as JevChoiceRule).severity;
}

function detailFor(e: RuleEvaluation, model: string): string {
	const what = findingText(e.rule);
	return (
		`${what.charAt(0).toUpperCase()}${what.slice(1)}. Judged by ${model} over the skill text as a whole ` +
		`(no file location): fired at margin ${e.margin.toFixed(2)}, confidence ${e.confidence.toFixed(2)}.`
	);
}

export function mapFired(
	fired: RuleEvaluation[],
	model: string,
	observedAt: string,
): {findings: AssetFinding[]; signals: AssetSignal[]} {
	const findings: AssetFinding[] = [];
	const signals: AssetSignal[] = [];
	for (const e of fired) {
		const severity = severityFor(e.rule, e.level);
		const label = `JEV: ${e.rule.key.replace(/_/g, " ")}`;
		const detail = detailFor(e, model);
		if (e.rule.route.type === "signal") {
			signals.push({
				dataCategory: e.rule.route.dataCategory,
				sourceClass: SCAN_SOURCE_CLASS,
				ruleId: e.rule.route.ruleId,
				observedAt,
				source: JEV_SOURCE_ID,
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
				source: JEV_SOURCE_ID,
				ruleId: e.rule.key,
			});
		}
	}
	return {findings, signals};
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

async function decide(body: unknown, cfg: JevScannerConfig, apiKey: string): Promise<JevResponse> {
	const res = await fetch(cfg.endpoint, {
		method: "POST",
		headers: {Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json"},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(cfg.timeoutMs),
	});
	if (!res.ok) {
		logger.error({module: "external-scanners.jev", scannerId: JEV_SOURCE_ID, status: res.status}, "JEV HTTP error response");
		throw new Error(`jev http ${res.status}`);
	}
	const parsed = (await res.json()) as JevResponse;
	if (typeof parsed?.answers !== "object" || parsed.answers === null) {
		throw new Error("jev response has no answers object");
	}
	return parsed;
}

// ─── SkillScanner ─────────────────────────────────────────────────────────────

function emptyRun(status: string, startedAt: number, scannedAt: Date, error?: string): ScannerOutput {
	return {
		findings: [],
		run: {
			source: JEV_SOURCE_ID,
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

export function createJevScanner(cfg: JevScannerConfig): SkillScanner {
	return {
		id: JEV_SOURCE_ID,

		async available(): Promise<boolean> {
			return !!process.env.OPENROUTER_API_KEY;
		},

		async scan(input: ScannerInput): Promise<ScannerOutput> {
			const startedAt = Date.now();
			const scannedAt = new Date();
			const apiKey = process.env.OPENROUTER_API_KEY;
			if (!apiKey) return emptyRun("skipped", startedAt, scannedAt, "OPENROUTER_API_KEY is not set");

			const payload = buildPayload(input.textFiles, cfg.maxPayloadChars);
			if (payload.includedPaths.length === 0) {
				return emptyRun("skipped", startedAt, scannedAt, "no SKILL.md or scripts to analyze");
			}
			const skillName = skillNameFromPayload(input.textFiles);
			logger.info({module: "external-scanners.jev", scannerId: JEV_SOURCE_ID, payloadChars: payload.text.length, truncated: payload.truncated}, "jev scanner run started");

			let stage1Response: JevResponse;
			try {
				stage1Response = await decide(buildStage1Request(cfg.model, skillName, payload.text), cfg, apiKey);
			} catch (err) {
				const isTimeout = err instanceof Error && err.name === "TimeoutError";
				logger.error({module: "external-scanners.jev", scannerId: JEV_SOURCE_ID, err}, "jev rule scan failed");
				return emptyRun(isTimeout ? "timeout" : "errored", startedAt, scannedAt, err instanceof Error ? err.message : String(err));
			}

			const {evaluations, unanswered} = evaluateStage1(stage1Response, cfg.marginThreshold);
			if (evaluations.length === 0) {
				return emptyRun("errored", startedAt, scannedAt, "jev answered none of the rule questions");
			}
			const fired = evaluations.filter((e) => e.fired);
			const {findings, signals} = mapFired(fired, cfg.model, scannedAt.toISOString());

			// Stage 2 only earns its call when something fired; zero fired is SAFE by construction.
			let verdict: JevVerdict | null = fired.length === 0 ? "SAFE" : null;
			let stage2: Record<string, unknown> = {skipped: fired.length === 0};
			let stage2Cost = 0;
			if (fired.length > 0) {
				try {
					const stage2Response = await decide(buildStage2Request(cfg.model, skillName, fired), cfg, apiKey);
					verdict = parseVerdict(stage2Response);
					stage2Cost = stage2Response.usage?.cost ?? 0;
					stage2 = {answer: stage2Response.answers.verdict ?? null, usage: stage2Response.usage ?? null};
					if (!verdict) stage2.error = "unrecognized verdict choice";
				} catch (err) {
					stage2 = {error: err instanceof Error ? err.message : String(err)};
					logger.warn({module: "external-scanners.jev", scannerId: JEV_SOURCE_ID, err}, "jev aggregate call failed; deriving verdict from findings");
				}
			}
			const runVerdict = verdict
				? runVerdictFor(verdict)
				: verdictFromSeverities([...findings, ...signals].map((f) => f.severity ?? "info"));

			const duration = Date.now() - startedAt;
			logger.info({module: "external-scanners.jev", scannerId: JEV_SOURCE_ID, status: "success", duration_ms: duration, fired: fired.length}, "jev scanner run completed");

			return {
				findings,
				...(signals.length > 0 ? {signals} : {}),
				run: {
					source: JEV_SOURCE_ID,
					version: cfg.model,
					status: "success",
					verdict: runVerdict,
					findingCount: findings.length,
					criticalCount: findings.filter((f) => f.severity === "critical").length,
					highCount: findings.filter((f) => f.severity === "high").length,
					// Every answer, fired or not, with its probabilities: the material for agreement and
					// false-positive analysis against the other scanners, without a schema change.
					rawReport: {
						model: cfg.model,
						marginThreshold: cfg.marginThreshold,
						jevVerdict: verdict,
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
