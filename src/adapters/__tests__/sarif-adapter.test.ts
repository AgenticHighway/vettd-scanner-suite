import {describe, it, expect} from "vitest";
import {sarifToFindings} from "../sarif-adapter.js";

function makeSarif(results: unknown[], rules: unknown[] = []) {
	return {
		version: "2.1.0",
		runs: [
			{
				tool: {driver: {name: "skill-scanner", rules}},
				results,
			},
		],
	};
}

function makeRule(id: string, opts: {short?: string; name?: string; tags?: string[]} = {}) {
	return {
		id,
		name: opts.name ?? id,
		shortDescription: {text: opts.short ?? `Short: ${id}`},
		properties: {tags: opts.tags ?? []},
	};
}

function makeResult(
	ruleId: string,
	opts: {
		level?: string;
		message?: string;
		uri?: string;
		line?: number;
		ruleIndex?: number;
	} = {}
) {
	return {
		ruleId,
		...(opts.ruleIndex != null ? {ruleIndex: opts.ruleIndex} : {}),
		level: opts.level ?? "warning",
		message: {text: opts.message ?? "test finding"},
		...(opts.uri
			? {
					locations: [
						{
							physicalLocation: {
								artifactLocation: {uri: opts.uri},
								region: {startLine: opts.line ?? 1},
							},
						},
					],
				}
			: {}),
	};
}

describe("sarifToFindings", () => {
	it("returns [] for empty SARIF ({})", () => {
		expect(sarifToFindings({})).toEqual([]);
	});

	it("returns [] for null", () => {
		expect(sarifToFindings(null)).toEqual([]);
	});

	it("returns [] for a string", () => {
		expect(sarifToFindings("garbage")).toEqual([]);
	});

	it("returns [] for a number", () => {
		expect(sarifToFindings(42)).toEqual([]);
	});

	it("returns [] for SARIF with no runs", () => {
		expect(sarifToFindings({version: "2.1.0"})).toEqual([]);
	});

	it("maps a single error-level result to severity fail", () => {
		const sarif = makeSarif(
			[makeResult("RULE_1", {level: "error", message: "critical issue"})],
			[makeRule("RULE_1", {short: "Critical Rule", tags: ["security"]})]
		);
		const findings = sarifToFindings(sarif);
		expect(findings).toHaveLength(1);
		expect(findings[0].severity).toBe("critical");
		expect(findings[0].category).toBe("security");
		expect(findings[0].label).toBe("Critical Rule");
		expect(findings[0].source).toBe("cisco");
		expect(findings[0].ruleId).toBe("RULE_1");
	});

	it("prefers result.properties.severity over SARIF level", () => {
		// Cisco emits CRITICAL/HIGH/MEDIUM/LOW in properties — use it instead of
		// the level field which conflates CRITICAL and HIGH into "error".
		const result = {
			...makeResult("RULE_1", {level: "error"}),
			properties: {severity: "HIGH"},
		};
		const sarif = makeSarif([result], [makeRule("RULE_1")]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.severity).toBe("high");
	});

	it("falls back to level map when properties.severity is absent", () => {
		const sarif = makeSarif([makeResult("RULE_1", {level: "error"})]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.severity).toBe("critical");
	});

	it("falls back to level map when properties.severity is an unrecognised string", () => {
		const result = {
			...makeResult("RULE_1", {level: "warning"}),
			properties: {severity: "UNKNOWN_TIER"},
		};
		const sarif = makeSarif([result]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.severity).toBe("medium");
	});

	it("maps all five properties severity values correctly", () => {
		const cases: [string, string][] = [
			["CRITICAL", "critical"],
			["HIGH", "high"],
			["MEDIUM", "medium"],
			["LOW", "low"],
			["INFO", "info"],
		];
		for (const [prop, expected] of cases) {
			const result = {
				...makeResult("R", {level: "error"}),
				properties: {severity: prop},
			};
			const [finding] = sarifToFindings(makeSarif([result]));
			expect(finding.severity, `properties.severity="${prop}"`).toBe(expected);
		}
	});

	it("populates filepath from SARIF location uri", () => {
		const sarif = makeSarif(
			[makeResult("RULE_1", {level: "error", uri: "src/main.py", line: 42})],
			[makeRule("RULE_1")]
		);
		const [finding] = sarifToFindings(sarif);
		expect(finding.filepath).toBe("src/main.py");
	});

	it("leaves filepath absent when SARIF result has no location", () => {
		const sarif = makeSarif([makeResult("RULE_1", {level: "warning"})]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.filepath).toBeUndefined();
	});

	it("maps warning level to warn", () => {
		const sarif = makeSarif([makeResult("RULE_W", {level: "warning"})]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.severity).toBe("medium");
	});

	it("maps note level to info", () => {
		const sarif = makeSarif([makeResult("RULE_N", {level: "note"})]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.severity).toBe("info");
	});

	it("maps none level to info", () => {
		const sarif = makeSarif([makeResult("RULE_N", {level: "none"})]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.severity).toBe("info");
	});

	it("defaults to warn when level is missing", () => {
		const result = {ruleId: "RULE_X", message: {text: "x"}};
		const sarif = makeSarif([result]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.severity).toBe("medium");
	});

	it("maps unknown tag to default category security", () => {
		const sarif = makeSarif(
			[makeResult("RULE_1")],
			[makeRule("RULE_1", {tags: ["completely-unknown-tag"]})]
		);
		const [finding] = sarifToFindings(sarif);
		expect(finding.category).toBe("security");
	});

	it("maps known tags to correct categories", () => {
		const cases: [string, AssetFindingCategory][] = [
			["security", "security"],
			["prompt-injection", "security"],
			["supply-chain", "security"],
			["best-practice", "best-practices"],
			["best-practices", "best-practices"],
			["structure", "structure"],
			["description", "description"],
			["scripts", "scripts"],
			["evals", "evals"],
		];
		for (const [tag, expected] of cases) {
			const sarif = makeSarif(
				[makeResult("R")],
				[makeRule("R", {tags: [tag]})]
			);
			const [finding] = sarifToFindings(sarif);
			expect(finding.category, `tag "${tag}"`).toBe(expected);
		}
	});

	it("falls back to label from rule.name when shortDescription is missing", () => {
		const sarif = makeSarif(
			[makeResult("RULE_1")],
			[{id: "RULE_1", name: "MyRuleName"}]
		);
		const [finding] = sarifToFindings(sarif);
		expect(finding.label).toBe("MyRuleName");
	});

	it("falls back to ruleId as label when no rule metadata exists", () => {
		const sarif = makeSarif([makeResult("RULE_ORPHAN")]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.label).toBe("RULE_ORPHAN");
	});

	it("resolves rule by ruleIndex when ruleId lookup fails", () => {
		const rules = [makeRule("INDEXED_RULE", {short: "Indexed"})];
		const result = {ruleIndex: 0, level: "error", message: {text: "x"}};
		const sarif = makeSarif([result], rules);
		const [finding] = sarifToFindings(sarif);
		expect(finding.label).toBe("Indexed");
		// ruleId falls back to rule.id when result.ruleId is absent
		expect(finding.ruleId).toBe("INDEXED_RULE");
	});

	it("prepends file:line to detail when physicalLocation is present", () => {
		const sarif = makeSarif([
			makeResult("R", {message: "msg", uri: "SKILL.md", line: 15}),
		]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.detail).toBe("SKILL.md:15 — msg");
	});

	it("prepends file without line when region is absent", () => {
		const result = {
			ruleId: "R",
			level: "warning",
			message: {text: "msg"},
			locations: [{physicalLocation: {artifactLocation: {uri: "SKILL.md"}}}],
		};
		const sarif = makeSarif([result]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.detail).toBe("SKILL.md — msg");
	});

	it("uses bare message when no location present", () => {
		const sarif = makeSarif([makeResult("R", {message: "bare message"})]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.detail).toBe("bare message");
	});

	it("truncates detail longer than MAX_DETAIL_LENGTH (4096)", () => {
		const longMessage = "x".repeat(10_000);
		const sarif = makeSarif([makeResult("R", {message: longMessage})]);
		const [finding] = sarifToFindings(sarif);
		expect(finding.detail.length).toBeLessThanOrEqual(4096);
	});

	it("flattens results from multiple runs", () => {
		const sarif = {
			runs: [
				{tool: {driver: {rules: []}}, results: [makeResult("R1", {level: "error"})]},
				{tool: {driver: {rules: []}}, results: [makeResult("R2", {level: "note"})]},
			],
		};
		const findings = sarifToFindings(sarif);
		expect(findings).toHaveLength(2);
		expect(findings[0].ruleId).toBe("R1");
		expect(findings[1].ruleId).toBe("R2");
	});

	it("returns [] without throwing on structurally broken SARIF", () => {
		const broken = {runs: [{tool: null, results: "not-an-array"}]};
		expect(() => sarifToFindings(broken)).not.toThrow();
		expect(sarifToFindings(broken)).toEqual([]);
	});

	it("handles empty results array", () => {
		const sarif = makeSarif([]);
		expect(sarifToFindings(sarif)).toEqual([]);
	});

	it("sets source to cisco on all findings", () => {
		const sarif = makeSarif([makeResult("R1"), makeResult("R2")]);
		const findings = sarifToFindings(sarif);
		for (const f of findings) {
			expect(f.source).toBe("cisco");
		}
	});
});

// Used only for the tag-mapping test type annotation
type AssetFindingCategory =
	| "structure"
	| "security"
	| "best-practices"
	| "description"
	| "scripts"
	| "evals";
