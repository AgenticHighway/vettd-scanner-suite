import {describe, it, expect, vi, beforeEach} from "vitest";

import type {JevScannerConfig} from "../../config/schema.js";
import type {ScannerInput} from "../../contract/scanner.js";
import {
	type JevAnswer,
	type JevResponse,
	buildPayload,
	buildStage2Request,
	createJevScanner,
	evaluateStage1,
	runVerdictFor,
	skillNameFromPayload,
} from "../jev.js";
import {JEV_RULES} from "../jev-rules.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Fixtures (local to this file; never shared, per the data-integrity rules) ────────────────

const CFG: JevScannerConfig = {
	enabled: true,
	model: "typesafe/jev-test",
	endpoint: "https://example.test/decisions",
	timeoutMs: 1000,
	marginThreshold: 0.5,
	maxPayloadChars: 10_000,
};

function input(files: Record<string, string>): ScannerInput {
	return {textFiles: new Map(Object.entries(files)), allPaths: Object.keys(files)};
}

const SKILL_MD = "---\nname: demo-skill\ndescription: A demo.\n---\n# Demo\n";

/** A stage-1 answer: fired with probability `pFired`, otherwise none. */
function answer(pFired: number, choice?: string): JevAnswer {
	return {
		type: "choice",
		choice: choice ?? (pFired >= 0.5 ? "present" : "none"),
		probabilities: {none: 1 - pFired, present: pFired},
		confidence: 0.9,
	};
}

/** All 39 rules answered "none" (p=0.97), with per-rule overrides. */
function stage1Response(overrides: Record<string, JevAnswer> = {}, cost = 0.00003): JevResponse {
	const answers: Record<string, JevAnswer> = {};
	for (const rule of JEV_RULES) {
		answers[rule.key] =
			rule.kind === "score"
				? {type: "score", score: 0, legend: {"0": "none", "1": "mild", "2": "strong"}, probabilities: {"0": 0.97, "1": 0.02, "2": 0.01}, confidence: 0.9}
				: answer(0.03);
	}
	return {answers: {...answers, ...overrides}, usage: {input_tokens: 800, output_tokens: 0, cost}};
}

function stage2Response(choice: string, cost = 0.00001): JevResponse {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("jev rule table", () => {
	// The demo's 39 questions are jev's wire input; a dropped or duplicated row silently changes what
	// is being asked, and stage 2's "rules_checked" would then lie.
	it("holds exactly 39 unique rules", () => {
		expect(JEV_RULES).toHaveLength(39);
		expect(new Set(JEV_RULES.map((r) => r.key)).size).toBe(39);
	});

	// Every route:"signal" rule reuses a ruleId vettd already registered. Minting new ids here would
	// freeze unsettled names, so the set is pinned and any addition is a conscious decision.
	it("routes only three rules to already-registered signal rules", () => {
		const signalRules = JEV_RULES.filter((r) => r.route.type === "signal");
		expect(signalRules.map((r) => r.key).sort()).toEqual([
			"missing_referenced_file",
			"overbroad_description",
			"unpinned_dependencies",
		]);
	});
});

describe("buildPayload", () => {
	it("sends SKILL.md first, then scripts and manifests, and leaves references out", () => {
		const p = buildPayload(
			new Map([
				["scripts/run.py", "print(1)"],
				["references/guide.md", "long reference"],
				["SKILL.md", SKILL_MD],
				["requirements.txt", "requests"],
			]),
			10_000,
		);
		expect(p.includedPaths).toEqual(["SKILL.md", "requirements.txt", "scripts/run.py"]);
		expect(p.text.startsWith("### FILE: SKILL.md\n")).toBe(true);
		expect(p.text).not.toContain("long reference");
		expect(p.truncated).toBe(false);
	});

	// Truncation must be visible: a silent cut would let an incomplete read look like a clean SAFE.
	it("cuts at the character cap and reports what was dropped", () => {
		const p = buildPayload(
			new Map([
				["SKILL.md", "x".repeat(60)],
				["a.py", "y".repeat(500)],
				["b.py", "z".repeat(500)],
			]),
			200,
		);
		expect(p.text.length).toBeLessThanOrEqual(200 + 4);
		expect(p.truncated).toBe(true);
		expect(p.omittedPaths).toContain("b.py");
	});

	it("prefers the shallowest SKILL.md", () => {
		const p = buildPayload(new Map([["nested/deep/SKILL.md", "deep"], ["SKILL.md", "top"]]), 10_000);
		expect(p.includedPaths[0]).toBe("SKILL.md");
	});
});

describe("skillNameFromPayload", () => {
	it("reads the frontmatter name and falls back to unknown", () => {
		expect(skillNameFromPayload(new Map([["SKILL.md", SKILL_MD]]))).toBe("demo-skill");
		expect(skillNameFromPayload(new Map([["a.py", "x"]]))).toBe("unknown");
	});
});

describe("evaluateStage1 margin filter", () => {
	// The whole point of stage 2 being conditioned on "clear signal": a 55/45 plurality is a coin
	// flip and must not be presented to the aggregate call as a confirmed finding.
	it("does not fire a bare plurality but fires a decisive answer", () => {
		const res = stage1Response({prompt_injection: answer(0.55), data_exfiltration: answer(0.97)});
		const {evaluations} = evaluateStage1(res, 0.5);
		const fired = evaluations.filter((e) => e.fired).map((e) => e.rule.key);
		expect(fired).toEqual(["data_exfiltration"]);
	});

	// Guards the inverse disagreement: probabilities can leave residue on "present" while jev's
	// chosen answer is "none". The chosen answer wins.
	it("never fires when jev's own choice is none", () => {
		const res = stage1Response({prompt_injection: answer(0.9, "none")});
		const {evaluations} = evaluateStage1(res, 0.5);
		expect(evaluations.find((e) => e.rule.key === "prompt_injection")?.fired).toBe(false);
	});

	it("scores the graded rule by non-none mass and picks the winning level", () => {
		const res = stage1Response({
			unbounded_autonomy: {
				type: "score",
				choice: "strong",
				probabilities: {none: 0.05, mild: 0.15, strong: 0.8},
				confidence: 0.9,
			},
		});
		const e = evaluateStage1(res, 0.5).evaluations.find((x) => x.rule.key === "unbounded_autonomy");
		expect(e?.fired).toBe(true);
		expect(e?.level).toBe("strong");
	});

	// Observed against the live API (jev-1.13): a score answer has no `choice`; it carries a numeric
	// `score`, a `legend`, and index-keyed probabilities. Reading only `choice` left this rule
	// permanently "unanswered" in both live runs, silently dropping the one graded rule.
	it("reads a live-API score answer (score + legend, index-keyed probabilities)", () => {
		const res = stage1Response({
			unbounded_autonomy: {
				type: "score",
				score: 2,
				legend: {"0": "none", "1": "mild", "2": "strong"},
				probabilities: {"0": 0, "1": 0, "2": 1},
				confidence: 1,
			} as JevAnswer,
		});
		const {evaluations, unanswered} = evaluateStage1(res, 0.5);
		expect(unanswered).toEqual([]);
		const e = evaluations.find((x) => x.rule.key === "unbounded_autonomy");
		expect(e).toMatchObject({fired: true, level: "strong", choice: "strong"});
		expect(e?.probabilities).toEqual({none: 0, mild: 0, strong: 1});
	});

	// The live API's `score` is the probability-weighted expected level, so a mostly-"none" answer
	// carries a fraction like 0.02, not an index. The first live run read it as an index and left
	// the rule unanswered for every real skill except an extreme one.
	it("takes the level from the probabilities, not from the fractional score", () => {
		const res = stage1Response({
			unbounded_autonomy: {
				type: "score",
				score: 0.02,
				legend: {"0": "none", "1": "mild", "2": "strong"},
				probabilities: {"0": 0.98, "1": 0.02, "2": 0},
				confidence: 0.96,
			} as JevAnswer,
		});
		const {evaluations, unanswered} = evaluateStage1(res, 0.5);
		expect(unanswered).toEqual([]);
		expect(evaluations.find((x) => x.rule.key === "unbounded_autonomy")).toMatchObject({choice: "none", fired: false});
	});

	it("treats a score answer with no usable legend or probabilities as unanswered", () => {
		const res = stage1Response({
			unbounded_autonomy: {type: "score", score: 9, legend: {"0": "none"}, probabilities: {"7": 1}, confidence: 1} as JevAnswer,
		});
		expect(evaluateStage1(res, 0.5).unanswered).toEqual(["unbounded_autonomy"]);
	});

	it("records unanswered rules instead of treating them as fired or clean", () => {
		const res = stage1Response();
		delete res.answers.typosquatting;
		const {evaluations, unanswered} = evaluateStage1(res, 0.5);
		expect(unanswered).toEqual(["typosquatting"]);
		expect(evaluations).toHaveLength(38);
	});
});

describe("stage 2 request", () => {
	it("carries only the fired rules with their sections, never the skill text", () => {
		const res = stage1Response({prompt_injection: answer(0.97)});
		const fired = evaluateStage1(res, 0.5).evaluations.filter((e) => e.fired);
		const body = buildStage2Request("m", "demo-skill", fired) as {state: Record<string, unknown>};
		expect(body.state.rules_checked).toBe(39);
		expect(body.state.rules_fired).toBe(1);
		expect(body.state.confirmed_findings).toEqual([
			{rule: "prompt_injection", section: "SS2", finding: "a prompt-injection attempt in SKILL.md"},
		]);
		expect(body.state).not.toHaveProperty("skill_payload");
	});
});

describe("runVerdictFor", () => {
	// vettd's pass/warn/fail has no LOW/MEDIUM distinction; LOW is minor metadata gaps so it must not
	// read as a clean pass, and only HIGH/CRITICAL are fail-worthy.
	it("maps the five-step scale onto pass/warn/fail", () => {
		expect(runVerdictFor("SAFE")).toBe("pass");
		expect(runVerdictFor("LOW")).toBe("warn");
		expect(runVerdictFor("MEDIUM")).toBe("warn");
		expect(runVerdictFor("HIGH")).toBe("fail");
		expect(runVerdictFor("CRITICAL")).toBe("fail");
	});
});

describe("jev scanner", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		vi.unstubAllEnvs();
	});

	describe("availability", () => {
		it("is unavailable without OPENROUTER_API_KEY, and scan() skips rather than fails", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "");
			const scanner = createJevScanner(CFG);
			expect(await scanner.available()).toBe(false);
			const out = await scanner.scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("skipped");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("skips when there is nothing to analyze", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			const out = await createJevScanner(CFG).scan(input({"notes.txt": "hello"}));
			expect(out.run.status).toBe("skipped");
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("clean skill", () => {
		// Nothing fired means SAFE by construction; paying for an aggregate call over an empty
		// evidence list would add cost and a chance to hallucinate a concern.
		it("makes one call, no findings, verdict pass", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(stage1Response());
			const out = await createJevScanner(CFG).scan(input({"SKILL.md": SKILL_MD}));
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(out.run.status).toBe("success");
			expect(out.run.verdict).toBe("pass");
			expect(out.findings).toEqual([]);
			expect(out.signals).toBeUndefined();
			const raw = out.run.rawReport as {stage2: {skipped: boolean}; jevVerdict: string};
			expect(raw.stage2.skipped).toBe(true);
			expect(raw.jevVerdict).toBe("SAFE");
		});
	});

	describe("malicious skill", () => {
		async function run() {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(
				stage1Response({
					prompt_injection: answer(0.97),
					data_exfiltration: answer(0.97),
					unpinned_dependencies: answer(0.97),
				}),
			);
			mockJson(stage2Response("CRITICAL"));
			return createJevScanner(CFG).scan(input({"SKILL.md": SKILL_MD, "run.py": "import requests"}));
		}

		it("emits findings for safety rules and a signal for the reused dependency rule", async () => {
			const out = await run();
			expect(out.findings.map((f) => f.ruleId).sort()).toEqual(["data_exfiltration", "prompt_injection"]);
			for (const f of out.findings) {
				expect(f.source).toBe("jev");
				expect(f.category).toBe("security");
				// JEV judges the whole text, so no file location may be invented for it.
				expect(f.filepath).toBeUndefined();
			}
			expect(out.signals).toHaveLength(1);
			expect(out.signals?.[0]).toMatchObject({
				dataCategory: "compatibility",
				sourceClass: "scan",
				ruleId: "compatibility/unpinned-dependencies",
				source: "jev",
				severity: "low",
				derivation: "inferred",
				confidence: 0.9,
			});
		});

		// Readers scan many findings at once: a short description plus the raw numbers, which are
		// kept visible for now so the margin can be judged from the UI.
		it("writes short details: a one-line summary, then margin and confidence", async () => {
			const out = await run();
			const pi = out.findings.find((f) => f.ruleId === "prompt_injection");
			expect(pi?.detail).toBe("Tries to override prior instructions. Margin 0.94, confidence 0.90.");
			for (const item of [...out.findings, ...(out.signals ?? [])]) {
				expect(item.detail?.length).toBeLessThanOrEqual(90);
				expect(item.detail).not.toContain("\u2014");
			}
		});

		it("uses the aggregate verdict for the run and counts severities from findings", async () => {
			const out = await run();
			expect(out.run.verdict).toBe("fail");
			expect(out.run.criticalCount).toBe(1); // data_exfiltration
			expect(out.run.highCount).toBe(1); // prompt_injection
			expect(out.run.findingCount).toBe(2);
		});

		// The raw answers are the false-positive analysis material: every rule, fired or not.
		it("keeps every answer with its probabilities and the total cost in rawReport", async () => {
			const out = await run();
			const raw = out.run.rawReport as {
				stage1: {answers: Record<string, {fired: boolean; probabilities: unknown}>};
				totalCost: number;
			};
			expect(Object.keys(raw.stage1.answers)).toHaveLength(39);
			expect(raw.stage1.answers.prompt_injection.fired).toBe(true);
			expect(raw.stage1.answers.safety_bypass.fired).toBe(false);
			expect(raw.stage1.answers.safety_bypass.probabilities).toEqual({none: 0.97, present: 0.03});
			expect(raw.totalCost).toBeCloseTo(0.00004, 8);
		});

		it("sends the model, bearer key, and all 39 questions in the first call", async () => {
			await run();
			const [url, init] = mockFetch.mock.calls[0];
			expect(url).toBe(CFG.endpoint);
			expect(init.headers.Authorization).toBe("Bearer k");
			const body = bodyOfCall(0);
			expect(Object.keys(body.questions)).toHaveLength(39);
			expect(body.state.skill_name).toBe("demo-skill");
			expect(String(body.state.skill_payload)).toContain("### FILE: run.py");
		});
	});

	describe("failure handling", () => {
		it("marks the run errored on an HTTP failure and emits nothing", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockFetch.mockResolvedValueOnce({ok: false, status: 402, json: async () => ({})} as unknown as Response);
			const out = await createJevScanner(CFG).scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("errored");
			expect(out.run.error).toContain("402");
			expect(out.findings).toEqual([]);
		});

		it("marks the run timeout on an aborted request", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockFetch.mockRejectedValueOnce(Object.assign(new Error("timed out"), {name: "TimeoutError"}));
			const out = await createJevScanner(CFG).scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("timeout");
		});

		it("errors when jev answers none of the questions", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson({answers: {}});
			const out = await createJevScanner(CFG).scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("errored");
		});

		// Stage 1 already produced real findings; losing the aggregate must not throw them away,
		// nor be mistaken for a clean skill.
		it("keeps stage-1 findings and derives the verdict from them when stage 2 fails", async () => {
			vi.stubEnv("OPENROUTER_API_KEY", "k");
			mockJson(stage1Response({data_exfiltration: answer(0.97)}));
			mockFetch.mockResolvedValueOnce({ok: false, status: 500, json: async () => ({})} as unknown as Response);
			const out = await createJevScanner(CFG).scan(input({"SKILL.md": SKILL_MD}));
			expect(out.run.status).toBe("success");
			expect(out.findings).toHaveLength(1);
			expect(out.run.verdict).toBe("fail");
			expect((out.run.rawReport as {stage2: {error: string}}).stage2.error).toContain("500");
		});
	});
});
