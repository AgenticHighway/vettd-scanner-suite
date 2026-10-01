import {describe, it, expect, vi, beforeEach} from "vitest";

import {buildAggregateRequest, createOpenRouterConnector} from "../../adapters/jev.js";
import type {System1ScannerConfig} from "../../config/schema.js";
import type {ScannerInput} from "../../contract/scanner.js";
import {evaluateStage1} from "../evaluate.js";
import {SAFETY_RULES, SYSTEM1_RULES} from "../rules.js";
import {createSystem1Scanner, runVerdictFor} from "../scanner.js";
import type {DecisionAnswer, DecisionResponse} from "../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Fixtures (local to this file; never shared, per the data-integrity rules) ────────────────

const CFG: System1ScannerConfig = {
	enabled: true,
	model: "typesafe/jev-test",
	timeoutMs: 1000,
	marginThreshold: 0.5,
	maxPayloadChars: 10_000,
};

function scanner() {
	return createSystem1Scanner(CFG, createOpenRouterConnector(CFG));
}

function input(files: Record<string, string>): ScannerInput {
	return {textFiles: new Map(Object.entries(files)), allPaths: Object.keys(files)};
}

const SKILL_MD = "---\nname: demo-skill\ndescription: A demo.\n---\n# Demo\n";

/** A choice answer: fired with probability `pFired`, otherwise none. */
function answer(pFired: number, choice?: string): DecisionAnswer {
	return {
		type: "choice",
		choice: choice ?? (pFired >= 0.5 ? "present" : "none"),
		probabilities: {none: 1 - pFired, present: pFired},
		confidence: 0.9,
	};
}

/** A classification answer choosing `value` with probability `p`; the rest is spread over the other options. */
function classAnswer(options: string[], value: string, p = 0.9): DecisionAnswer {
	const others = options.filter((o) => o !== value);
	const probabilities: Record<string, number> = {[value]: p};
	for (const o of others) probabilities[o] = (1 - p) / others.length;
	return {type: "choice", choice: value, probabilities, confidence: p};
}

/** Every rule answered quietly (finding rules "none" at 0.97, classifications on an unremarkable value). */
function stage1Response(overrides: Record<string, DecisionAnswer> = {}, cost = 0.00003): DecisionResponse {
	const answers: Record<string, DecisionAnswer> = {};
	for (const rule of SYSTEM1_RULES) {
		if (rule.kind === "score") {
			answers[rule.key] = {type: "score", score: 0, legend: {"0": "none", "1": "mild", "2": "strong"}, probabilities: {"0": 0.97, "1": 0.02, "2": 0.01}, confidence: 0.9};
		} else if (rule.kind === "classification") {
			const options = Object.keys(rule.options);
			const quiet = options.find((o) => !(o in rule.severityByValue)) ?? options[0];
			answers[rule.key] = classAnswer(options, quiet);
		} else {
			answers[rule.key] = answer(0.03);
		}
	}
	return {answers: {...answers, ...overrides}, usage: {input_tokens: 800, output_tokens: 0, cost}};
}

function stage2Response(choice: string, cost = 0.00001): DecisionResponse {
	return {
		answers: {verdict: {type: "choice", choice, probabilities: {[choice]: 1}, confidence: 1}},
		usage: {input_tokens: 300, output_tokens: 0, cost},
	};
}

function mockJson(body: unknown) {
	mockFetch.mockResolvedValueOnce({ok: true, status: 200, json: async () => body} as unknown as Response);
}

function bodyOfCall(n: number): {state: Record<string, unknown>; questions: Record<string, unknown>} {
	return JSON.parse(mockFetch.mock.calls[n][1].body as string);
}

const idOf = (key: string) => SYSTEM1_RULES.find((r) => r.key === key)!.ruleId;

// ─── Rule set ─────────────────────────────────────────────────────────────────

describe("system1 rule set", () => {
	// The safety questions are the model's wire input; a dropped or duplicated row silently changes
	// what is being asked, and the aggregate call's "rules_checked" would then lie.
	it("holds 34 safety questions and unique keys and ids", () => {
		expect(SAFETY_RULES).toHaveLength(34);
		expect(new Set(SYSTEM1_RULES.map((r) => r.key)).size).toBe(SYSTEM1_RULES.length);
		expect(new Set(SYSTEM1_RULES.map((r) => r.ruleId)).size).toBe(SYSTEM1_RULES.length);
	});

	it("gives every safety finding an S1- id and every non-safety rule a category-prefixed id", () => {
		for (const r of SYSTEM1_RULES) {
			if (r.emit === "finding") expect(r.ruleId).toMatch(/^S1-\d{4}$/);
			else expect(r.ruleId.startsWith(`${(r as {dataCategory: string}).dataCategory}/`)).toBe(true);
		}
	});

	// A classification that has no way to say "not there" cannot be emitted every scan: the model
	// would have to invent a value for a thing that does not exist.
	it("gives every classification an absent option and severities only for real options", () => {
		for (const r of SYSTEM1_RULES) {
			if (r.kind !== "classification") continue;
			expect(Object.keys(r.options)).toContain(r.absent);
			for (const value of Object.keys(r.severityByValue)) expect(Object.keys(r.options)).toContain(value);
		}
	});

	// Regex and System 1 are mutually exclusive for non-safety rules: each rule has one owner. These
	// are the ids the regex scanner still emits, so a System 1 rule on one would double-report it.
	it("does not target a rule id the regex scanner still owns", () => {
		const regexOwned = ["reliability/unresolvable-internal-references", "compatibility/unpinned-dependencies"];
		for (const r of SYSTEM1_RULES) expect(regexOwned).not.toContain(r.ruleId);
	});
});

// ─── Evaluation ───────────────────────────────────────────────────────────────

describe("evaluateStage1", () => {
	// The point of the aggregate being conditioned on "clear signal": a 55/45 plurality is a coin
	// flip and must not be presented as a confirmed finding.
	it("does not fire a bare plurality but fires a decisive answer", () => {
		const res = stage1Response({prompt_injection: answer(0.55), data_exfiltration: answer(0.97)});
		const fired = evaluateStage1(res, 0.5).evaluations.filter((e) => e.fired).map((e) => e.rule.key);
		expect(fired).toEqual(["data_exfiltration"]);
	});

	// Probabilities can leave residue on "present" while the model's chosen answer is "none".
	it("never fires when the model's own choice is none", () => {
		const res = stage1Response({prompt_injection: answer(0.9, "none")});
		expect(evaluateStage1(res, 0.5).evaluations.find((e) => e.rule.key === "prompt_injection")?.fired).toBe(false);
	});

	// Observed against the live API: a score answer has no `choice`; it carries a fractional `score`,
	// a `legend`, and index-keyed probabilities. The level comes from the probabilities.
	it("reads a live-API score answer and takes the level from probabilities, not the fractional score", () => {
		const res = stage1Response({
			unbounded_autonomy: {type: "score", score: 1.8, legend: {"0": "none", "1": "mild", "2": "strong"}, probabilities: {"0": 0.1, "1": 0.2, "2": 0.7}, confidence: 0},
		});
		const {evaluations, unanswered} = evaluateStage1(res, 0.5);
		expect(unanswered).toEqual([]);
		expect(evaluations.find((x) => x.rule.key === "unbounded_autonomy")).toMatchObject({fired: true, level: "strong", choice: "strong"});
	});

	// The live API reports confidence 0 on every score answer. Persisted as-is it reads as "no
	// confidence" on a real finding, so it must fall back to the probability of the chosen level.
	it("replaces a reported confidence of 0 with the probability of the choice", () => {
		const res = stage1Response({
			unbounded_autonomy: {type: "score", score: 1.8, legend: {"0": "none", "1": "mild", "2": "strong"}, probabilities: {"0": 0.1, "1": 0.2, "2": 0.7}, confidence: 0},
		});
		const e = evaluateStage1(res, 0.5).evaluations.find((x) => x.rule.key === "unbounded_autonomy");
		expect(e?.confidence).toBe(0.7);
	});

	it("keeps a real reported confidence for choice answers", () => {
		const res = stage1Response({prompt_injection: answer(0.97)});
		expect(evaluateStage1(res, 0.5).evaluations.find((x) => x.rule.key === "prompt_injection")?.confidence).toBe(0.9);
	});

	it("treats a score answer with no usable legend or probabilities as unanswered", () => {
		const res = stage1Response({
			unbounded_autonomy: {type: "score", score: 9, legend: {"0": "none"}, probabilities: {"7": 1}, confidence: 1},
		});
		expect(evaluateStage1(res, 0.5).unanswered).toEqual(["unbounded_autonomy"]);
	});

	// A classification answered with a value outside its own options would persist an invalid value.
	it("treats a classification answer outside its options as unanswered", () => {
		const res = stage1Response({instruction_clarity: classAnswer(["clear", "bogus"], "bogus")});
		expect(evaluateStage1(res, 0.5).unanswered).toEqual(["instruction_clarity"]);
	});

	it("records unanswered rules instead of treating them as fired or clean", () => {
		const res = stage1Response();
		delete res.answers.typosquatting;
		const {evaluations, unanswered} = evaluateStage1(res, 0.5);
		expect(unanswered).toEqual(["typosquatting"]);
		expect(evaluations).toHaveLength(SYSTEM1_RULES.length - 1);
	});
});

describe("aggregate request", () => {
	it("carries only the fired rules, their sections and the checked count, never the skill text", () => {
		const body = buildAggregateRequest("m", "demo-skill", [{rule: "prompt_injection", section: "SS2", finding: "a prompt-injection attempt in SKILL.md"}], SAFETY_RULES.length) as {
			state: Record<string, unknown>;
		};
		expect(body.state.rules_checked).toBe(34);
		expect(body.state.rules_fired).toBe(1);
		expect(body.state).not.toHaveProperty("skill_payload");
	});
});

describe("runVerdictFor", () => {
	// vettd's pass/warn/fail has no LOW/MEDIUM distinction; LOW is minor so it must not read as a
	// clean pass, and only HIGH/CRITICAL are fail-worthy.
	it("maps the five-step scale onto pass/warn/fail", () => {
		expect(runVerdictFor("SAFE")).toBe("pass");
		expect(runVerdictFor("LOW")).toBe("warn");
		expect(runVerdictFor("MEDIUM")).toBe("warn");
		expect(runVerdictFor("HIGH")).toBe("fail");
		expect(runVerdictFor("CRITICAL")).toBe("fail");
	});
});

// ─── Scanner ──────────────────────────────────────────────────────────────────

describe("system1 scanner", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		vi.unstubAllEnvs();
	});

	describe("availability", () => {
		it("is unavailable without OPENROUTER_API_KEY, and scan() skips rather than fails", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "");
			expect(await scanner().available()).toBe(false);
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("skipped");
			expect(out.run.source).toBe("system1");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("skips when there is nothing to analyze", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			expect((await scanner().scan(input({"notes.txt": "hello"}))).run.status).toBe("skipped");
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("clean skill", () => {
		// Nothing fired means SAFE by construction; paying for an aggregate call over an empty
		// evidence list would add cost and a chance to hallucinate a concern.
		it("makes one call, no findings, verdict pass", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(stage1Response());
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(out.run.status).toBe("success");
			expect(out.run.verdict).toBe("pass");
			expect(out.findings).toEqual([]);
			const raw = out.run.rawReport as {stage2: {skipped: boolean}; aggregateVerdict: string};
			expect(raw.stage2.skipped).toBe(true);
			expect(raw.aggregateVerdict).toBe("SAFE");
		});

		// Classifications always emit, one value per rule per scan, so the reader sees what was
		// assessed and not only what went wrong.
		it("still emits every classification, stating derivation, confidence and the value", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(stage1Response());
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			const classRules = SYSTEM1_RULES.filter((r) => r.kind === "classification");
			expect(out.signals).toHaveLength(classRules.length);
			for (const s of out.signals ?? []) {
				expect(s).toMatchObject({sourceClass: "scan", source: "system1", derivation: "inferred", method: CFG.model});
				expect(typeof s.valueText).toBe("string");
				expect(s.confidence).toBeCloseTo(0.9, 5);
				expect(s.severity).toBeUndefined();
			}
		});
	});

	describe("classification polarity", () => {
		// A finding implies a severity but a severity does not imply a finding: a negative value
		// stays ONE classification row and carries a severity, so it shows and grades without a
		// second paired finding row.
		it("sets a severity on a negative value and none on a positive one, never a paired finding", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(
				stage1Response({
					instruction_clarity: classAnswer(["clear", "underspecified", "ambiguous", "contradictory"], "contradictory", 0.85),
					usage_context: classAnswer(["explicit", "implied", "missing"], "explicit", 0.95),
				}),
			);
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			const clarity = out.signals?.find((s) => s.ruleId === "reliability/instruction-clarity");
			const usage = out.signals?.find((s) => s.ruleId === "reliability/usage-context");
			expect(clarity).toMatchObject({valueText: "contradictory", severity: "medium", confidence: 0.85});
			expect(usage?.valueText).toBe("explicit");
			expect(usage?.severity).toBeUndefined();
			expect(out.findings).toEqual([]);
		});
	});

	describe("malicious skill", () => {
		async function run() {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(
				stage1Response({
					prompt_injection: answer(0.97),
					data_exfiltration: answer(0.97),
					undeclared_environment_assumptions: answer(0.97),
				}),
			);
			mockJson(stage2Response("CRITICAL"));
			return scanner().scan(input({"SKILL.md": SKILL_MD, "run.py": "import requests"}));
		}

		it("emits S1- findings for safety rules and a finding-shaped signal for non-safety defects", async () => {
			const out = await run();
			expect(out.findings.map((f) => f.ruleId).sort()).toEqual([idOf("data_exfiltration"), idOf("prompt_injection")].sort());
			for (const f of out.findings) {
				expect(f.source).toBe("system1");
				expect(f.category).toBe("security");
				// The model judges the whole text, so no file location may be invented for it.
				expect(f.filepath).toBeUndefined();
			}
			const env = out.signals?.find((s) => s.ruleId === "compatibility/undeclared-environment-assumptions");
			expect(env).toMatchObject({dataCategory: "compatibility", sourceClass: "scan", source: "system1", severity: "low", derivation: "inferred", confidence: 0.9});
			expect(env?.valueText).toBeUndefined();
		});

		// Readers scan many findings at once: one short human sentence each. The numbers are a row
		// facet, not prose, and the margin stays recoverable from run.rawReport.
		it("writes number-free details: the one-line summary only", async () => {
			const out = await run();
			const pi = out.findings.find((f) => f.ruleId === idOf("prompt_injection"));
			expect(pi?.detail).toBe("Tries to override prior instructions.");
			for (const item of [...out.findings, ...(out.signals ?? [])]) {
				expect(item.detail?.length).toBeLessThanOrEqual(90);
				expect(item.detail).not.toContain("—");
				expect(item.detail).not.toContain("Margin");
				expect(item.label).not.toMatch(/JEV/i);
			}
			for (const f of out.findings) expect(f.detail).not.toMatch(/\d/);
		});

		it("stamps every fired finding with derivation 'inferred' and the answer's confidence", async () => {
			const out = await run();
			for (const f of out.findings) {
				expect(f.derivation).toBe("inferred");
				expect(f.confidence).toBeGreaterThanOrEqual(0);
				expect(f.confidence).toBeLessThanOrEqual(1);
			}
			expect(out.findings[0].confidence).toBe(0.9);
		});

		it("uses the aggregate verdict for the run and counts severities from findings only", async () => {
			const out = await run();
			expect(out.run.verdict).toBe("fail");
			expect(out.run.criticalCount).toBe(1);
			expect(out.run.highCount).toBe(1);
			expect(out.run.findingCount).toBe(2);
		});

		it("keeps every answer with its probabilities and the total cost in rawReport", async () => {
			const out = await run();
			const raw = out.run.rawReport as {
				stage1: {answers: Record<string, {fired: boolean; probabilities: unknown}>};
				totalCost: number;
			};
			expect(Object.keys(raw.stage1.answers)).toHaveLength(SYSTEM1_RULES.length);
			expect(raw.stage1.answers.prompt_injection.fired).toBe(true);
			expect(raw.stage1.answers.safety_bypass.fired).toBe(false);
			expect(raw.stage1.answers.safety_bypass.probabilities).toEqual({none: 0.97, present: 0.03});
			expect(raw.totalCost).toBeCloseTo(0.00004, 8);
		});

		it("sends the model, bearer key, and every question in the first call", async () => {
			await run();
			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
			expect(init.headers.Authorization).toBe("Bearer k");
			// A redirect would forward the bearer key to another host.
			expect(init.redirect).toBe("error");
			const body = bodyOfCall(0);
			expect(Object.keys(body.questions)).toHaveLength(SYSTEM1_RULES.length);
			expect(body.state.skill_name).toBe("demo-skill");
			expect(String(body.state.skill_payload)).toContain("### FILE: run.py");
		});

		// Stage 2 must see only safety findings; a non-safety defect is not a security concern.
		it("hands only the fired safety rules to the aggregate call", async () => {
			await run();
			const evidence = bodyOfCall(1).state.confirmed_findings as {rule: string}[];
			expect(evidence.map((e) => e.rule).sort()).toEqual(["data_exfiltration", "prompt_injection"]);
		});
	});

	describe("non-safety defect alone", () => {
		// With no safety finding the aggregate is skipped, so the run verdict must still reflect a
		// fired non-safety severity rather than reading as a clean pass.
		it("skips the aggregate call and derives a warn from the signal's severity", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(stage1Response({undeclared_environment_assumptions: answer(0.97)}));
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(out.findings).toEqual([]);
			expect(out.run.verdict).toBe("warn");
		});
	});

	describe("failure handling", () => {
		it("marks the run errored on an HTTP failure and emits nothing", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockFetch.mockResolvedValueOnce({ok: false, status: 402, json: async () => ({})} as unknown as Response);
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("errored");
			expect(out.run.error).toBe("http_error 402");
			expect(out.findings).toEqual([]);
		});

		// Persisted errors are controlled codes: an upstream or proxy message can echo a credential.
		it("never persists raw exception text", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "sk-secret-value");
			mockFetch.mockRejectedValueOnce(new Error("proxy said Bearer sk-secret-value"));
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.error).toBe("network");
			expect(JSON.stringify(out)).not.toContain("sk-secret-value");
		});

		// A single answered benign question must not read as "everything clean".
		it("errors when any rule question is unanswered", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			const res = stage1Response({});
			delete (res.answers as Record<string, unknown>).typosquatting;
			mockJson(res);
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("errored");
			expect(out.run.error).toMatch(/answered \d+ of \d+/);
			expect(out.findings).toEqual([]);
		});

		// The provider response is untrusted: free text in it must not reach the persisted rawReport.
		it("drops unvalidated fields from the aggregate answer", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(stage1Response({data_exfiltration: answer(0.97)}));
			mockJson({
				answers: {verdict: {type: "choice", choice: "HIGH", probabilities: {HIGH: 1}, confidence: 1, echo: "leaked-text"}},
				usage: {cost: 0.1, note: "leaked-text"},
			});
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(JSON.stringify(out.run.rawReport)).not.toContain("leaked-text");
			expect((out.run.rawReport as {aggregateVerdict: string}).aggregateVerdict).toBe("HIGH");
		});

		it("marks the run timeout on an aborted request", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockFetch.mockRejectedValueOnce(Object.assign(new Error("timed out"), {name: "TimeoutError"}));
			expect((await scanner().scan(input({"SKILL.md": SKILL_MD}))).run.status).toBe("timeout");
		});

		it("errors when the model answers none of the questions", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson({answers: {}});
			expect((await scanner().scan(input({"SKILL.md": SKILL_MD}))).run.status).toBe("errored");
		});

		// Stage 1 already produced real findings; losing the aggregate must not throw them away,
		// nor be mistaken for a clean skill.
		it("keeps stage-1 findings and derives the verdict from them when the aggregate fails", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(stage1Response({data_exfiltration: answer(0.97)}));
			mockFetch.mockResolvedValueOnce({ok: false, status: 500, json: async () => ({})} as unknown as Response);
			const out = await scanner().scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("success");
			expect(out.findings).toHaveLength(1);
			expect(out.run.verdict).toBe("fail");
			expect((out.run.rawReport as {stage2: {error: string}}).stage2.error).toBe("http_error 500");
		});
	});
});
