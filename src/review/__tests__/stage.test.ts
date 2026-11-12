import {describe, expect, it, vi} from "vitest";

import type {AssetFinding} from "../../contract/asset-finding.js";
import type {ScannerInput, ScannerOutput} from "../../contract/scanner.js";
import {DEFAULT_REVIEW_OPTS, runReviewers} from "../stage.js";
import type {FindingReviewer, ReviewEntry, ReviewOutcome} from "../types.js";

const input: ScannerInput = {textFiles: new Map([["SKILL.md", "---\nname: t\n---\ninstructions"]]), allPaths: ["SKILL.md"]};

function finding(severity: "critical" | "high" | "medium" | "low", overrides: Record<string, unknown> = {}): AssetFinding {
	return {category: "security", label: "test finding", detail: "Detected in SKILL.md:1 — `x`", severity, source: "vettd", ruleId: "VTD-0017", filepath: "SKILL.md", ...overrides} as AssetFinding;
}

function result(findings: AssetFinding[]): ScannerOutput {
	return {findings, run: {source: "vettd", status: "success", findingCount: findings.length, criticalCount: 0, highCount: 0, scannedAt: new Date()}};
}

const system1Result = (): ScannerOutput => ({
	findings: [],
	run: {source: "system1", status: "success", findingCount: 0, criticalCount: 0, highCount: 0, rawReport: {stage1: {}}, scannedAt: new Date()},
});

function reviewer(overrides: Partial<FindingReviewer> & {id?: string} = {}): FindingReviewer {
	return {
		id: "system1",
		available: () => true,
		review: async () => ({entries: [], report: {calls: [], usage: {}}}),
		...overrides,
	} as FindingReviewer;
}

const opts = DEFAULT_REVIEW_OPTS;

describe("runReviewers", () => {
	it("an excluded reviewer stamps not_run on eligible findings and sends nothing", async () => {
		const review = vi.fn(async () => ({entries: [], report: {calls: [], usage: {}}}) as unknown as ReviewOutcome);
		const r = reviewer({review});
		const f = finding("medium");
		const results = [result([f])];
		await runReviewers([r], input, results, opts, ["system1"]);
		expect(f.payload?.reviews).toEqual([{reviewer: "system1", status: "not_run", reason: "excluded"}]);
		expect(review).not.toHaveBeenCalled();
	});

	it("an unavailable reviewer stamps not_run unavailable", async () => {
		const f = finding("medium");
		const results = [result([f])];
		await runReviewers([reviewer({available: () => false})], input, results, opts, []);
		expect(f.payload?.reviews).toEqual([{reviewer: "system1", status: "not_run", reason: "unavailable"}]);
	});

	it("an exempt finding is never asked about and gets an exempt entry", async () => {
		const review = vi.fn(async () => ({entries: [], report: {calls: [], usage: {}}}) as unknown as ReviewOutcome);
		const secret = finding("critical", {ruleId: "VTD-0002", detail: "Detected in SKILL.md:1 — redacted"});
		const ordinary = finding("medium");
		const results = [result([secret, ordinary])];
		const r = reviewer({review: async (_i, targets) => {
			expect(targets.map((t) => t.finding)).toEqual([ordinary]);
			const entries: ReviewEntry[] = targets.map(() => ({reviewer: "system1", status: "reviewed", verdict: "real"}));
			return {entries, report: {calls: [], usage: {}}};
		}});
		await runReviewers([r], input, results, opts, []);
		expect(secret.payload?.reviews).toEqual([{reviewer: "system1", status: "exempt"}]);
		expect((ordinary.payload?.reviews as ReviewEntry[])[0]).toMatchObject({status: "reviewed", verdict: "real"});
	});

	it("a failed review never changes a finding: a crashed reviewer stamps failed and the severity is untouched", async () => {
		const f = finding("high");
		const results = [result([f]), system1Result()];
		const r = reviewer({review: async () => {
			throw new Error("exploded");
		}});
		await runReviewers([r], input, results, opts, []);
		expect(f.severity).toBe("high");
		expect(f.payload?.reviews).toEqual([{reviewer: "system1", status: "failed", reason: "internal"}]);
	});

	it("the reviewer's report lands on its own run's rawReport.review", async () => {
		const f = finding("medium");
		const sys = system1Result();
		const results = [result([f]), sys];
		const r = reviewer({review: async () => ({entries: [{reviewer: "system1", status: "reviewed"}], report: {calls: [{region: "skill", targets: [0], usage: null, ms: 5}], usage: {}}})});
		await runReviewers([r], input, results, opts, []);
		expect((sys.run.rawReport as {review: unknown}).review).toMatchObject({calls: [{region: "skill"}]});
	});

	it("a reviewer returning a mismatched entry count fail-closes every target", async () => {
		const f = finding("medium");
		const results = [result([f])];
		const r = reviewer({review: async () => ({entries: [], report: {calls: [], usage: {}}})});
		await runReviewers([r], input, results, opts, []);
		expect(f.payload?.reviews).toEqual([{reviewer: "system1", status: "failed", reason: "internal"}]);
	});

	it("out-of-scope and below-floor findings get no entry at all", async () => {
		const system1 = finding("critical", {source: "system1", derivation: "inferred", ruleId: "S1-0009"});
		const low = finding("low");
		const results = [result([system1, low])];
		await runReviewers([reviewer({review: async (_i, targets) => ({entries: targets.map(() => ({reviewer: "system1", status: "reviewed"} as ReviewEntry)), report: {calls: [], usage: {}}})})], input, results, opts, []);
		expect(system1.payload).toBeUndefined();
		expect(low.payload).toBeUndefined();
	});

	it("a hung reviewer is cut off by the stage deadline: findings are stamped within the bound", async () => {
		const f1 = finding("medium");
		const f2 = finding("high");
		const results = [result([f1, f2])];
		let resolveHang: ((outcome: ReviewOutcome) => void) | undefined;
		const hang = new Promise<ReviewOutcome>((resolve) => {
			resolveHang = resolve;
		});
		const bounded = {...opts, stageTimeoutMs: 30};
		const start = Date.now();
		const stage = runReviewers([reviewer({review: () => hang})], input, results, bounded, []);
		await new Promise((r) => setTimeout(r, 80)); // let the deadline fire while the review hangs
		await stage;
		expect(Date.now() - start).toBeLessThan(5_000);
		for (const f of [f1, f2]) {
			expect(f.payload?.reviews).toEqual([{reviewer: "system1", status: "failed", reason: "timeout"}]);
		}
		// A late resolution must not reach the findings: the stage already read them.
		resolveHang?.({entries: [{reviewer: "system1", status: "reviewed", verdict: "not_real"} as ReviewEntry], report: {calls: [], usage: {}}});
		await new Promise((r) => setTimeout(r, 20));
		expect(f1.payload?.reviews).toHaveLength(1);
		expect(f2.payload?.reviews).toHaveLength(1);
	});

	it("a reviewer error leaves every finding byte-identical apart from the stamped entry", async () => {
		const f = finding("high", {detail: "Detected in SKILL.md:1 — `x`", confidence: 0.9, intent: "negligent", chainId: "c1", owaspLlmCategory: "LLM01"});
		f.payload = {model: "m", choice: "present", probabilities: {none: 0.2, present: 0.8}};
		const before = structuredClone({...f, payload: {...f.payload}});
		const results = [result([f])];
		await runReviewers([reviewer({review: async () => {
			throw new Error("exploded");
		}})], input, results, opts, []);
		const after = f as unknown as Record<string, unknown>;
		expect(after.payload).toEqual({...before.payload, reviews: [{reviewer: "system1", status: "failed", reason: "internal"}]});
		const {payload: _payload, ...restAfter} = after;
		const {payload: _payloadBefore, ...restBefore} = before as unknown as Record<string, unknown>;
		expect(restAfter).toEqual(restBefore);
	});
});
