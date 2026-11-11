import {describe, it, expect} from "vitest";

import {buildPayload, skillNameFromPayload} from "../payload.js";
import {redactSecrets} from "../redact.js";

const SKILL_MD = "---\nname: demo-skill\ndescription: A demo.\n---\n# Demo\n";

describe("buildPayload", () => {
	const all = (p: ReturnType<typeof buildPayload>) => p.parts.map((x) => x.text).join("\n");

	// A verdict about a skill is only honest if the whole skill was read, references included.
	it("reads every text file, SKILL.md first, then scripts and manifests, then the rest", () => {
		const p = buildPayload(
			new Map([
				["scripts/run.py", "print(1)"],
				["references/guide.md", "long reference"],
				["SKILL.md", SKILL_MD],
				["requirements.txt", "requests"],
			]),
			10_000,
			25,
		);
		expect(p.parts).toHaveLength(1);
		expect(p.includedPaths).toEqual(["SKILL.md", "requirements.txt", "scripts/run.py", "references/guide.md"]);
		expect(p.parts[0].text.startsWith("### FILE: SKILL.md\n")).toBe(true);
		expect(p.truncated).toBe(false);
	});

	// One call has a hard input limit; a big skill is split, never cut, and every part keeps the
	// instructions in view so behaviour can still be compared with them.
	it("splits a skill larger than one part, repeating SKILL.md in every part and losing nothing", () => {
		const files = new Map([["SKILL.md", "# Demo"], ["a.py", "a\n".repeat(150)], ["b.py", "b\n".repeat(150)], ["c.py", "c\n".repeat(150)]]);
		const p = buildPayload(files, 400, 25);
		expect(p.parts.length).toBeGreaterThan(1);
		for (const part of p.parts) {
			expect(part.text.startsWith("### FILE: SKILL.md\n# Demo")).toBe(true);
			expect(part.text.length).toBeLessThanOrEqual(400);
		}
		for (const ch of ["a", "b", "c"]) expect(all(p).split(`${ch}\n`).length - 1).toBe(150);
		expect(p.truncated).toBe(false);
	});

	it("splits one file too large for a part into labelled pieces", () => {
		const p = buildPayload(new Map([["SKILL.md", "# Demo"], ["big.py", "x = 1\n".repeat(400)]]), 600, 25);
		expect(p.parts.length).toBeGreaterThan(2);
		expect(all(p)).toContain("### FILE: big.py (piece 1 of");
		expect(all(p).split("x = 1\n").length - 1).toBe(400);
	});

	// The part ceiling only bounds abuse; when it is hit the run must say so, never read as clean.
	it("marks the run truncated past the part ceiling and names what was not read", () => {
		const files = new Map([["SKILL.md", "# Demo"], ...Array.from({length: 10}, (_, i) => [`f${i}.py`, "y".repeat(300)] as [string, string])]);
		const p = buildPayload(files, 400, 3);
		expect(p.parts).toHaveLength(3);
		expect(p.truncated).toBe(true);
		expect(p.omittedPaths).toContain("f9.py");
	});

	// System 1 reports a finding's lines against the original file; a piece that forgot where it
	// started would put every finding in a large file at the wrong line.
	it("records the original line each section starts at, including later pieces of a split file", () => {
		const big = Array.from({length: 400}, (_, i) => `line ${i + 1}`).join("\n");
		const p = buildPayload(new Map([["SKILL.md", "# Demo"], ["big.py", big]]), 600, 25);
		const pieces = p.parts.flatMap((part) => part.sections).filter((s) => s.path === "big.py");
		expect(pieces.length).toBeGreaterThan(2);
		for (const s of pieces) expect(s.body.split("\n")[0]).toBe(`line ${s.startLine}`);
		expect(p.parts[0].sections[0]).toMatchObject({path: "SKILL.md", startLine: 1});
	});

	it("prefers the shallowest SKILL.md", () => {
		const p = buildPayload(new Map([["nested/deep/SKILL.md", "deep"], ["SKILL.md", "top"]]), 10_000, 25);
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

	// A multi-line key collapsing to one line would shift every later line, so located findings
	// would point at the wrong place in the original file.
	it("keeps the line count of what it replaces", () => {
		const text = "a\n-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----\nafter";
		const out = redactSecrets(text).text;
		expect(out.split("\n")).toHaveLength(text.split("\n").length);
		expect(out.split("\n")[5]).toBe("after");
	});

	it("leaves ordinary code and short values alone", () => {
		const code = 'token = os.environ["API_TOKEN"]\npassword = "x"\nprint("hello")';
		expect(redactSecrets(code)).toEqual({text: code, counts: {}});
	});
});
