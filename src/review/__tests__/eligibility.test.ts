import {describe, expect, it} from "vitest";

import {isEligible, secretsExempt, severityAtLeast} from "../eligibility.js";

const base = {category: "security" as const, label: "l", detail: "Detected in a.py:1 — `x`", severity: "medium" as const};
const files = new Map<string, string>([["a.py", "token = \"sk-abcdefghijklmnopqrst\"\n"], ["b.py", "print('hello')\n"]]);

describe("isEligible", () => {
	it("takes regex and Cisco findings of the configured sources", () => {
		expect(isEligible({...base, source: "vettd"}, ["vettd", "cisco"])).toBe(true);
		expect(isEligible({...base, source: "cisco"}, ["vettd", "cisco"])).toBe(true);
	});

	it("excludes other sources and model-inferred findings", () => {
		expect(isEligible({...base, source: "socket"}, ["vettd", "cisco"])).toBe(false);
		expect(isEligible({...base, source: "system1"}, ["vettd", "cisco"])).toBe(false);
		expect(isEligible({...base, source: "vettd", derivation: "inferred"}, ["vettd", "cisco"])).toBe(false);
	});
});

describe("severityAtLeast", () => {
	it("treats the floor as inclusive", () => {
		expect(severityAtLeast("medium", "medium")).toBe(true);
		expect(severityAtLeast("critical", "medium")).toBe(true);
		expect(severityAtLeast("low", "medium")).toBe(false);
		expect(severityAtLeast("info", "medium")).toBe(false);
	});
});

describe("secretsExempt", () => {
	it("exempts the explicit secret rule ids before any content is touched", () => {
		for (const ruleId of ["VTD-0001", "VTD-0002", "VTD-0003", "VTD-0027"]) {
			expect(secretsExempt({...base, ruleId}, {scope: "skill"}, files)).toBe(true);
		}
	});

	it("exempts a finding whose cited line redacts to a placeholder", () => {
		expect(secretsExempt({...base, ruleId: "VTD-0017", filepath: "a.py"}, {filepath: "a.py", lineStart: 1, lineEnd: 1}, files)).toBe(true);
	});

	it("does not exempt ordinary code findings", () => {
		expect(secretsExempt({...base, ruleId: "VTD-0017", filepath: "b.py"}, {filepath: "b.py", lineStart: 1, lineEnd: 1}, files)).toBe(false);
	});
});
