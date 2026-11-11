// Locating fired safety findings (vettd#1229). The decision API says whether a rule fires, never
// where, so the location is inferred: re-ask the fired rule on smaller regions of the text it fired
// on and follow the region that keeps it firing.
//
//   0. SKILL.md alone. A rule that fires there is narrowed over SKILL.md's lines.
//   1. Otherwise, the other files of the part where it fired, split into two overlapping halves
//      (SKILL.md kept as context, so instructions-versus-code rules still fire), down to one file,
//      or to the smallest set neither half of which fires on its own.
//   2. That file's lines, halved the same way, down to `targetLines`.
//
// Rules waiting on the same region are asked in one call. Locating never changes whether a rule
// fired; a failure, the call cap or the time budget only leaves a finding less precisely located.

import type {System1LocateConfig} from "../config/schema.js";
import {evaluateRules, type RuleEvaluation} from "./evaluate.js";
import type {Payload, PayloadSection} from "./payload.js";
import type {System1Rule} from "./rules.js";
import {type DecisionConnector, type DecisionUsage, errorCode} from "./types.js";

export type LocationMethod = "skill-md" | "narrowed" | "file-set";

export interface FindingLocation {
	/** Absent for "file-set": no single file carries the evidence, so naming one would mislead. */
	filepath?: string;
	lineStart?: number;
	lineEnd?: number;
	/** The fired answer's confidence on the reported region. */
	confidence: number;
	method: LocationMethod;
	/** The call cap, time budget or an error stopped narrowing early. */
	partial?: boolean;
	/** method "file-set": every file the evidence spans. */
	files?: string[];
}

/** No single smaller region keeps the rule firing: the evidence is spread across the skill. */
export interface SpreadLocation {
	scope: "skill";
}

export type LocateOutcome = FindingLocation | SpreadLocation;

export interface LocateTarget {
	evaluation: RuleEvaluation;
	/** Index of the payload part the rule fired on (the part `mergeParts` chose). */
	part: number;
}

export interface LocateAsk {
	region: string;
	rules: string[];
	answers: Record<string, {choice: string; probabilities: Record<string, number>; margin: number; fired: boolean}>;
	usage: DecisionUsage | null;
	ms: number;
	error?: string;
}

export interface LocateReport {
	outcomes: Map<string, LocateOutcome>;
	asks: LocateAsk[];
	usage: DecisionUsage;
	/** Why locating stopped before every finding finished, if it did. */
	stopped?: "max_calls" | "budget";
}

interface FileView {
	path: string;
	lines: string[];
	startLine: number;
	isSkillMd: boolean;
}

interface Region {
	key: string;
	label: string;
	text: string;
}

type Stage = "skill-md" | "files" | "lines" | "done";

interface Job {
	rule: System1Rule;
	stage: Stage;
	head: PayloadSection | null;
	items: PayloadSection[];
	view: FileView | null;
	lo: number;
	hi: number;
	confidence: number;
	asked: Region[];
	outcome?: LocateOutcome;
}

export interface LocateDeps {
	connector: DecisionConnector;
	skillName: string;
	marginThreshold: number;
	config: System1LocateConfig;
}

const sectionText = (s: PayloadSection) => `${s.header}\n${s.body}`;

function linesOf(body: string): string[] {
	const lines = body.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Two overlapping halves of [lo, hi), each strictly smaller than it for any range of 2 or more. */
export function halves(lo: number, hi: number): [[number, number], [number, number]] {
	const n = hi - lo;
	const half = Math.ceil(n / 2);
	const overlap = Math.floor(n * 0.1);
	return [
		[lo, Math.min(hi, lo + half + overlap)],
		[Math.max(lo, hi - half - overlap), hi],
	];
}

/** SKILL.md as one view: its head plus every continuation piece that follows on without a gap. */
export function skillMdView(payload: Payload): FileView | null {
	const head = payload.parts[0]?.sections[0];
	if (!head || (head.path.split("/").pop() ?? "").toLowerCase() !== "skill.md") return null;
	const pieces = payload.parts
		.flatMap((p) => p.sections)
		.filter((s) => s.path === head.path && s !== head && s.header.includes("(continued"))
		.sort((a, b) => a.startLine - b.startLine);
	let text = head.body;
	for (const piece of pieces) {
		if (piece.startLine !== text.split("\n").length) break;
		text += piece.body;
	}
	return {path: head.path, lines: linesOf(text), startLine: 1, isSkillMd: true};
}

function filesRegion(head: PayloadSection | null, items: PayloadSection[]): Region {
	const label = items.map((s) => (s.startLine > 1 ? `${s.path}@${s.startLine}` : s.path)).join(", ");
	return {key: `files:${label}`, label, text: [...(head ? [head] : []), ...items].map(sectionText).join("\n\n")};
}

function linesRegion(head: PayloadSection | null, view: FileView, lo: number, hi: number): Region {
	const a = view.startLine + lo;
	const b = view.startLine + hi - 1;
	const label = `${view.path}:${a}-${b}`;
	const body = `### FILE: ${view.path} (lines ${a}-${b})\n${view.lines.slice(lo, hi).join("\n")}`;
	return {key: `lines:${label}`, label, text: head && !view.isSkillMd ? `${sectionText(head)}\n\n${body}` : body};
}

function sectionView(s: PayloadSection): FileView {
	return {path: s.path, lines: linesOf(s.body), startLine: s.startLine, isSkillMd: false};
}

function lineOutcome(job: Job, partial: boolean): FindingLocation {
	const view = job.view as FileView;
	return {
		filepath: view.path,
		lineStart: view.startLine + job.lo,
		lineEnd: view.startLine + job.hi - 1,
		confidence: job.confidence,
		method: view.isSkillMd ? "skill-md" : "narrowed",
		...(partial ? {partial} : {}),
	};
}

/** Where a job stands if it stops now. Null when it has learned nothing usable. */
function settle(job: Job, partial: boolean): LocateOutcome | undefined {
	if (job.stage === "lines") return lineOutcome(job, partial);
	if (job.stage !== "files" || job.hi - job.lo >= job.items.length) return undefined;
	const files = [...new Set(job.items.slice(job.lo, job.hi).map((s) => s.path))];
	return {
		...(files.length === 1 ? {filepath: files[0]} : {files}),
		confidence: job.confidence,
		method: files.length === 1 ? "narrowed" : "file-set",
		...(partial ? {partial} : {}),
	};
}

function finish(job: Job, outcome: LocateOutcome | undefined): void {
	job.stage = "done";
	job.outcome = outcome;
}

function startLines(job: Job, view: FileView, confidence: number, targetLines: number): void {
	job.stage = "lines";
	job.view = view;
	job.lo = 0;
	job.hi = view.lines.length;
	job.confidence = confidence;
	if (job.hi - job.lo <= targetLines) finish(job, lineOutcome(job, false));
}

function startFiles(job: Job, targetLines: number): void {
	if (job.items.length === 0) return finish(job, undefined);
	if (job.items.length === 1) return startLines(job, sectionView(job.items[0]), job.confidence, targetLines);
	job.stage = "files";
	job.lo = 0;
	job.hi = job.items.length;
}

/** The regions a job needs answered next. */
function regionsFor(job: Job, skillMd: FileView | null): Region[] {
	if (job.stage === "skill-md") return [linesRegion(null, skillMd as FileView, 0, (skillMd as FileView).lines.length)];
	const [[aLo, aHi], [bLo, bHi]] = halves(job.lo, job.hi);
	if (job.stage === "files") return [filesRegion(job.head, job.items.slice(aLo, aHi)), filesRegion(job.head, job.items.slice(bLo, bHi))];
	return [linesRegion(job.head, job.view as FileView, aLo, aHi), linesRegion(job.head, job.view as FileView, bLo, bHi)];
}

type Answers = Map<string, Map<string, RuleEvaluation> | null>;

/** Moves a job one step on its regions' answers. */
function advance(job: Job, answers: Answers, skillMd: FileView | null, targetLines: number): void {
	const results = job.asked.map((r) => answers.get(r.key));
	if (results.some((r) => r === null)) return finish(job, settle(job, true));
	const evals = results.map((r) => r?.get(job.rule.key));
	if (job.stage === "skill-md") {
		const e = evals[0];
		if (e?.fired) return startLines(job, skillMd as FileView, e.confidence, targetLines);
		return startFiles(job, targetLines);
	}
	const fired = evals
		.map((e, i) => ({e, range: halves(job.lo, job.hi)[i]}))
		.filter((x): x is {e: RuleEvaluation; range: [number, number]} => !!x.e?.fired)
		.sort((x, y) => y.e.margin - x.e.margin)[0];
	if (!fired) {
		// Neither half fires alone: the evidence needs both, so the current range is the answer.
		const whole = job.stage === "files" && job.hi - job.lo >= job.items.length;
		return finish(job, whole ? {scope: "skill"} : settle(job, false));
	}
	[job.lo, job.hi] = fired.range;
	job.confidence = fired.e.confidence;
	if (job.stage === "files" && job.hi - job.lo === 1) return startLines(job, sectionView(job.items[job.lo]), job.confidence, targetLines);
	if (job.stage === "lines" && job.hi - job.lo <= targetLines) finish(job, lineOutcome(job, false));
}

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
	const out: T[] = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++;
			out[i] = await tasks[i]();
		}
	};
	await Promise.all(Array.from({length: Math.min(size, tasks.length)}, worker));
	return out;
}

function addUsage(sum: DecisionUsage, u: DecisionUsage | undefined): void {
	sum.input_tokens = (sum.input_tokens ?? 0) + (u?.input_tokens ?? 0);
	sum.output_tokens = (sum.output_tokens ?? 0) + (u?.output_tokens ?? 0);
	sum.cost = (sum.cost ?? 0) + (u?.cost ?? 0);
}

async function ask(deps: LocateDeps, region: Region, rules: System1Rule[], signal: AbortSignal, report: LocateReport) {
	const started = Date.now();
	try {
		const response = await deps.connector.askRules(deps.skillName, region.text, rules, signal);
		const {evaluations} = evaluateRules(response, rules, deps.marginThreshold);
		addUsage(report.usage, response.usage);
		report.asks.push({
			region: region.label,
			rules: rules.map((r) => r.key),
			answers: Object.fromEntries(evaluations.map((e) => [e.rule.key, {choice: e.choice, probabilities: e.probabilities, margin: e.margin, fired: e.fired}])),
			usage: response.usage ?? null,
			ms: Date.now() - started,
		});
		return new Map(evaluations.map((e) => [e.rule.key, e]));
	} catch (err) {
		report.asks.push({region: region.label, rules: rules.map((r) => r.key), answers: {}, usage: null, ms: Date.now() - started, error: errorCode(err)});
		return null;
	}
}

function newJob(target: LocateTarget, payload: Payload, skillMd: FileView | null, targetLines: number): Job {
	const part = payload.parts[target.part];
	const head = skillMd && part.sections[0]?.path === skillMd.path ? part.sections[0] : null;
	const items = part.sections.filter((s) => s.path !== skillMd?.path);
	const job: Job = {rule: target.evaluation.rule, stage: "skill-md", head, items, view: null, lo: 0, hi: 0, confidence: target.evaluation.confidence, asked: []};
	if (!skillMd) startFiles(job, targetLines);
	return job;
}

/** One round: every active job's regions, deduplicated, each asked once for all rules waiting on it. */
async function round(jobs: Job[], deps: LocateDeps, skillMd: FileView | null, signal: AbortSignal, report: LocateReport): Promise<Answers> {
	const byKey = new Map<string, {region: Region; rules: System1Rule[]}>();
	for (const job of jobs) {
		job.asked = regionsFor(job, skillMd);
		for (const region of job.asked) {
			const entry = byKey.get(region.key) ?? {region, rules: []};
			if (!entry.rules.includes(job.rule)) entry.rules.push(job.rule);
			byKey.set(region.key, entry);
		}
	}
	const entries = [...byKey.values()];
	const results = await pool(entries.map((e) => () => ask(deps, e.region, e.rules, signal, report)), deps.config.concurrency);
	return new Map(entries.map((e, i) => [e.region.key, results[i]]));
}

export async function locateFindings(targets: LocateTarget[], payload: Payload, deps: LocateDeps): Promise<LocateReport> {
	const report: LocateReport = {outcomes: new Map(), asks: [], usage: {}};
	const {targetLines, maxCalls, budgetMs} = deps.config;
	const skillMd = skillMdView(payload);
	const jobs = targets.map((t) => newJob(t, payload, skillMd, targetLines));
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), budgetMs);
	try {
		for (let active = jobs.filter((j) => j.stage !== "done"); active.length > 0; active = jobs.filter((j) => j.stage !== "done")) {
			const needed = new Set(active.flatMap((j) => regionsFor(j, skillMd).map((r) => r.key))).size;
			const stop = controller.signal.aborted ? "budget" : report.asks.length + needed > maxCalls ? "max_calls" : null;
			if (stop) {
				report.stopped = stop;
				for (const job of active) finish(job, settle(job, true));
				break;
			}
			const answers = await round(active, deps, skillMd, controller.signal, report);
			for (const job of active) advance(job, answers, skillMd, targetLines);
		}
	} finally {
		clearTimeout(timer);
	}
	if (!report.stopped && controller.signal.aborted) report.stopped = "budget";
	for (const job of jobs) if (job.outcome) report.outcomes.set(job.rule.key, job.outcome);
	return report;
}
