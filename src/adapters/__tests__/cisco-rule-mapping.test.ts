import {describe, it, expect} from "vitest";
import {mapCiscoRuleId} from "../cisco-rule-mapping.js";

describe("mapCiscoRuleId", () => {
	it("maps a known Cisco ruleId to its VTD equivalent", () => {
		// ATR_2026_00154 is CRON_PERSISTENCE → VTD-0048 (direct match)
		expect(mapCiscoRuleId("ATR_2026_00154")).toBe("VTD-0048");
	});

	it("maps a prompt-injection rule to PROMPT_INSTRUCTION_OVERRIDE", () => {
		// ATR_2026_00001 is direct prompt injection → VTD-0064
		expect(mapCiscoRuleId("ATR_2026_00001")).toBe("VTD-0064");
	});

	it("maps a jailbreak-persona rule to JAILBREAK_PERSONA", () => {
		// ATR_2026_00273 is DAN/DUDE/STAN → VTD-0068
		expect(mapCiscoRuleId("ATR_2026_00273")).toBe("VTD-0068");
	});

	it("passes through an unmapped ATR ruleId unchanged", () => {
		// ATR_2026_00030 (cross-agent impersonation) is runtime-only, no VTD analog
		expect(mapCiscoRuleId("ATR_2026_00030")).toBe("ATR_2026_00030");
	});

	it("passes through a python_generated ruleId with no VTD mapping", () => {
		// CROSS_SKILL_DATA_RELAY requires multi-skill context — unmapped
		expect(mapCiscoRuleId("CROSS_SKILL_DATA_RELAY")).toBe("CROSS_SKILL_DATA_RELAY");
	});

	it("passes through a completely unknown ruleId unchanged", () => {
		expect(mapCiscoRuleId("TOTALLY_UNKNOWN_RULE_999")).toBe("TOTALLY_UNKNOWN_RULE_999");
	});

	it("maps a unicode-injection rule to HIDDEN_UNICODE_CHARACTER", () => {
		// ATR_2026_00129 Unicode Tag characters → VTD-0081
		expect(mapCiscoRuleId("ATR_2026_00129")).toBe("VTD-0081");
	});

	it("maps a credential-exfiltration chain rule to CREDENTIAL_EXFILTRATION_CHAIN", () => {
		// ATR_2026_00149 compound exfiltration → VTD-0089
		expect(mapCiscoRuleId("ATR_2026_00149")).toBe("VTD-0089");
	});

	it("maps BEHAVIOR_CREDENTIAL_FILE_ACCESS to a credential-file-access rule", () => {
		expect(mapCiscoRuleId("BEHAVIOR_CREDENTIAL_FILE_ACCESS")).toBe("VTD-0005");
	});

	it("maps COMPOUND_FETCH_EXECUTE to MALICIOUS_ACTIVITY_CHAIN", () => {
		expect(mapCiscoRuleId("COMPOUND_FETCH_EXECUTE")).toBe("VTD-0090");
	});
});
