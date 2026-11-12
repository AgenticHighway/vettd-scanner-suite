import {describe, expect, it, vi} from "vitest";

import type {AssetFinding} from "../../contract/asset-finding.js";
import type {ScannerInput} from "../../contract/scanner.js";
import {DecisionError, type DecisionConnector, type DecisionResponse} from "../../system1/types.js";
import {createSystem1Reviewer} from "../system1-reviewer.js";
import type {ReviewTarget} from "../types.js";

const CFG = {enabled: true, model: "test-model", timeoutMs: 1000, marginThreshold: 0.5, partChars: 400_000, maxParts: 25, locate: {enabled: false, targetLines: 30, maxCalls: 60, concurrency: 1, budgetMs: 1000}};

const input: ScannerInput = {
	textFiles: new Map([
		["SKILL.md", "---\nname: test\n---\n# Test\ndo the thing"],
		["scripts/run.sh", Array.from({length: 100}, (_, i) => `echo ${i}`).join("\n")],
	]),
	allPaths: ["SKILL.md", "scripts/run.sh"],
};

function target(key: number, overrides: Partial<AssetFinding> = {}): ReviewTarget {
	const finding = {category: "security", label: "Use of eval()", detail: "Detected in scripts/run.sh:50 — `eval $INPUT`", severity: "high", source: "vettd", ruleId: "VTD-0017", filepath: "scripts/run.sh", ...overrides} as AssetFinding;
	return {key, finding, location: {filepath: "scripts/run.sh", lineStart: 50, lineEnd: 50}};
}

function responseFor(entries: Record<string, Record<string, number>>, model = "test-model"): DecisionResponse {
	const answers: DecisionResponse["answers"] = {};
	for (const [key, probabilities] of Object.entries(entries)) {
		const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
		answers[key] = {probabilities, choice, confidence: probabilities[choice]};
	}
	return {model, answers};
}

function mockConnector(handler: (payload: string, rules: string[]) => DecisionResponse | Promise<DecisionResponse>): DecisionConnector {
	return {
		model: "test-model",
		available: () => true,
		askRules: async (_skill: string, payload: string, rules: readonly import("../../system1/rules.js").System1Rule[], _signal?: AbortSignal) => handler(payload, rules.map((r) => r.key)),
		aggregate: async () => {throw new Error("unused");},
	} as unknown as DecisionConnector;
}

const OPTS = {config: {contextLines: 40, maxCalls: 60, maxFindings: 50, budgetMs: 60_000}};

describe("createSystem1Reviewer", () => {
	it("maps a valid answer pair to a reviewed entry with verdict, probabilities and severity", async () => {
		const connector = mockConnector((payload, keys) => {
			expect(keys.sort()).toEqual(["f0_severity", "f0_validity", "f0_validity2"]);
			expect(payload).toContain("### FILE: scripts/run.sh"); // region framing
			expect(payload).toContain("### SKILL:"); // skill identity rides along (amendment 10)
			return responseFor({f0_validity: {real: 0.9, not_executed: 0.07, not_applicable: 0.03}, f0_validity2: {real: 0.85, not_executed: 0.1, not_applicable: 0.05}, f0_severity: {critical: 0.1, high: 0.85, medium: 0.04, low: 0.01}});
		});
		const reviewer = createSystem1Reviewer(CFG, connector);
		const {entries, report} = await reviewer.review(input, [target(0)], OPTS);
		expect(entries[0]).toMatchObject({
			reviewer: "system1",
			status: "reviewed",
			verdict: "real",
			choice: "real",
			confidence: 0.9,
			severity: {choice: "high", confidence: 0.85},
			model: "test-model",
		});
		expect(entries[0].context).toEqual({filepath: "scripts/run.sh", lineStart: 50, lineEnd: 50});
		expect(report.calls).toHaveLength(1);
	});

	it("agreement of both validity questions on not_executed yields a not_real verdict", async () => {
		const connector = mockConnector(() => responseFor({f0_validity: {real: 0.1, not_executed: 0.6, not_applicable: 0.3}, f0_validity2: {real: 0.05, not_executed: 0.8, not_applicable: 0.15}, f0_severity: {critical: 0, high: 0, medium: 0, low: 1}}));
		const {entries} = await createSystem1Reviewer(CFG, connector).review(input, [target(0)], OPTS);
		expect(entries[0]).toMatchObject({verdict: "not_real"});
		// Confidence for not_real is the min of the two questions' not_executed mass (amendment 11).
		expect(entries[0].confidence ?? 0).toBeCloseTo(0.6, 6);
		expect(entries[0].probabilities).toEqual({real: 0.1, not_executed: 0.6, not_applicable: 0.3});
	});

	it("disagreement between the two validity questions keeps the verdict real", async () => {
		const connector = mockConnector(() => responseFor({f0_validity: {real: 0.1, not_executed: 0.6, not_applicable: 0.3}, f0_validity2: {real: 0.7, not_executed: 0.2, not_applicable: 0.1}, f0_severity: {critical: 0, high: 1, medium: 0, low: 0}}));
		const {entries} = await createSystem1Reviewer(CFG, connector).review(input, [target(0)], OPTS);
		expect(entries[0]).toMatchObject({verdict: "real"});
	});

	// The boundary fixtures (fp-check round 4): a directing docstring is never demoted on
	// question disagreement — the two-question gate is the spec'd behavior, not a bug.
	it("a directing docstring finding is kept when the two questions disagree", async () => {
		const connector = mockConnector(() => responseFor({f0_validity: {real: 0.9, not_executed: 0.08, not_applicable: 0.02}, f0_validity2: {real: 0.04, not_executed: 0.96, not_applicable: 0}, f0_severity: {critical: 0.7, high: 0.2, medium: 0.1, low: 0}}));
		const {entries} = await createSystem1Reviewer(CFG, connector).review(input, [target(0)], OPTS);
		expect(entries[0]).toMatchObject({status: "reviewed", verdict: "real", choice: "real", choice2: "not_executed"});
		expect(entries[0].probabilities2).toEqual({real: 0.04, not_executed: 0.96, not_applicable: 0});
	});

	it("a comment or printed usage hint is demoted only when both questions agree it is inert", async () => {
		const connector = mockConnector(() => responseFor({f0_validity: {real: 0.03, not_executed: 0.96, not_applicable: 0.01}, f0_validity2: {real: 0.05, not_executed: 0.94, not_applicable: 0.01}, f0_severity: {critical: 0, high: 0, medium: 0, low: 1}}));
		const {entries} = await createSystem1Reviewer(CFG, connector).review(input, [target(0)], OPTS);
		expect(entries[0]).toMatchObject({verdict: "not_real"});
		expect(entries[0].confidence ?? 0).toBeCloseTo(0.94, 6);
	});

	it("an unanswered or invalid option fail-closes the entry", async () => {
		const connector = mockConnector(() => ({model: "test-model", answers: {f0_validity: {probabilities: {real: 1}, choice: "maybe", confidence: 1}, f0_validity2: {probabilities: {real: 1}, choice: "real", confidence: 1}, f0_severity: {probabilities: {high: 1}, choice: "high", confidence: 1}}}));
		const {entries} = await createSystem1Reviewer(CFG, connector).review(input, [target(0)], OPTS);
		expect(entries[0]).toMatchObject({status: "failed", reason: "unanswered"});
	});

	it("a failed call stamps failed with the mapped reason and never changes the finding", async () => {
		const connector = mockConnector(() => {
			throw new DecisionError("http_error", 500);
		});
		const {entries, report} = await createSystem1Reviewer(CFG, connector).review(input, [target(0)], OPTS);
		expect(entries[0]).toMatchObject({status: "failed", reason: "http_error"});
		expect(report.calls[0].error).toBe("http_error");
	});

	it("the finding cap keeps the highest-severity findings and stamps the rest not_run cap", async () => {
		const asked: number[] = [];
		const connector = mockConnector((_p, keys) => {
			asked.push(...keys.filter((k) => k.endsWith("_validity")).map((k) => Number(k.slice(1, k.indexOf("_")))));
			return responseFor({});
		});
		const targets = [
			target(0, {severity: "medium"}),
			target(1, {severity: "critical"}),
			target(2, {severity: "high"}),
		];
		const {entries} = await createSystem1Reviewer(CFG, connector).review(input, targets, {...OPTS, config: {...OPTS.config, maxFindings: 2}});
		expect(asked.sort()).toEqual([1, 2]); // critical + high asked, medium stamped cap
		expect(entries[0]).toMatchObject({status: "not_run", reason: "cap"});
		expect(entries.filter((e) => e.status === "failed").length).toBe(2); // answered unusably, but asked
	});

	it("groups findings sharing a region into one call", async () => {
		let calls = 0;
		const connector = mockConnector(() => {
			calls++;
			return responseFor({});
		});
		const sameRegion = [target(0), target(1)];
		const otherFile = target(2, {detail: "Detected in SKILL.md:1 — `x`", filepath: "SKILL.md", ruleId: "VTD-0064"});
		otherFile.location = {filepath: "SKILL.md", lineStart: 1, lineEnd: 1};
		const {report} = await createSystem1Reviewer(CFG, connector).review(input, [...sameRegion, otherFile], OPTS);
		expect(calls).toBe(2); // one per region
		expect(report.calls.map((c) => c.targets)).toEqual([[0, 1], [2]]);
	});

	it("the question quotes the matched snippet and labels it untrusted", async () => {
		let seen = "";
		const connector: DecisionConnector = {
			model: "test-model",
			available: () => true,
			askRules: async (_s: string, _p: string, rules: readonly import("../../system1/rules.js").System1Rule[]) => {
				seen = rules.find((r) => r.key === "f0_validity")?.prompt.instructions ?? "";
				return responseFor({});
			},
			aggregate: async () => {
				throw new Error("unused");
			},
		} as unknown as DecisionConnector;
		await createSystem1Reviewer(CFG, connector).review(input, [target(0)], OPTS);
		expect(seen).toContain("`eval $INPUT`");
		expect(seen).toContain("untrusted skill content");
	});

	it("skill-scope findings are judged against part 1 of the payload", async () => {
		let payload = "";
		const connector = mockConnector((p) => {
			payload = p;
			return responseFor({f0_validity: {real: 1, not_executed: 0, not_applicable: 0}, f0_validity2: {real: 1, not_executed: 0, not_applicable: 0}, f0_severity: {critical: 0, high: 1, medium: 0, low: 0}});
		});
		const t = target(0);
		t.location = {scope: "skill"};
		const {entries} = await createSystem1Reviewer(CFG, connector).review(input, [t], OPTS);
		expect(payload).toContain("### FILE: SKILL.md");
		expect(entries[0].context).toEqual({scope: "skill"});
	});

	it("the time budget stamps remaining groups not_run budget", async () => {
		const connector = mockConnector(async () => {
			await new Promise((r) => setTimeout(r, 30));
			return responseFor({});
		});
		const targets = [target(0), target(1, {detail: "Detected in SKILL.md:1 — `y`", filepath: "SKILL.md", ruleId: "VTD-0064", severity: "critical", label: "Prompt override"})];
		targets[1].location = {filepath: "SKILL.md", lineStart: 1, lineEnd: 1};
		const {entries, report} = await createSystem1Reviewer(CFG, connector).review(input, targets, {...OPTS, config: {...OPTS.config, budgetMs: 1}});
		expect(report.stopped).toBeTruthy();
		expect(entries.some((e) => e.status === "not_run")).toBe(true);
	});

	it("unavailable reports no key at construction-time available()", () => {
		const reviewer = createSystem1Reviewer(CFG, {...mockConnector(() => responseFor({})), available: () => false});
		expect(reviewer.available()).toBe(false);
	});
});
