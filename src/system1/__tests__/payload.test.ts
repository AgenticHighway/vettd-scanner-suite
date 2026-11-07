import {describe, it, expect} from "vitest";

import {buildPayload, skillNameFromPayload} from "../payload.js";
import {redactSecrets} from "../redact.js";

const SKILL_MD = "---\nname: demo-skill\ndescription: A demo.\n---\n# Demo\n";

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

describe("redactSecrets", () => {
	it("replaces each known secret shape with its typed placeholder", () => {
		const text = [
			`gh = "ghp_${"a".repeat(36)}"`,
			`ant = "sk-ant-${"b".repeat(30)}"`,
			`aws = "AKIA${"C".repeat(16)}"`,
			`slack = "xoxb-${"1".repeat(12)}"`,
			"-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
			`password: "hunter2hunter2"`,
		].join("\n");
		const {text: out, counts} = redactSecrets(text);
		expect(out).not.toMatch(/ghp_a|sk-ant-b|AKIAC|xoxb-1|abc\n|hunter2/);
		expect(counts).toEqual({"github-token": 1, "anthropic-key": 1, "aws-key": 1, "slack-token": 1, "private-key": 1, "secret-value": 1});
		// The key name stays readable: the model can still judge that a credential is hardcoded.
		expect(out).toContain('password: "[REDACTED:secret-value]"');
	});

	it("leaves ordinary code and short values alone", () => {
		const code = 'token = os.environ["API_TOKEN"]\npassword = "x"\nprint("hello")';
		expect(redactSecrets(code)).toEqual({text: code, counts: {}});
	});
});
