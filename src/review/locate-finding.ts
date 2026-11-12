// Where a finding points, derived purely from the finding row. Neither the Rust engine nor the
// Cisco SARIF adapter carries a line field on the contract, but both write the location into the
// detail prefix: `Detected in <path>:<line>` (vettd) and `<path>:<line> —` (Cisco). File missing
// from the input or unparseable detail degrades to skill scope, which reviews against the whole
// skill — never to "no review".

import type {AssetFinding} from "../contract/asset-finding.js";
import type {ReviewLocation} from "./types.js";

/** `Detected in <path>:<line>` (vettd) and `<path>:<line> —` (Cisco SARIF detail). */
const VTD_PREFIX = /^Detected in (.+?):(\d+)/;
const SARIF_PREFIX = /^(.+?):(\d+) — /;

export interface ParsedLocation {
	filepath: string;
	line: number;
}

/**
 * Parse the cited path and line out of a finding's detail. Returns null when the detail carries
 * no path:line prefix — behavioral and package-level findings legitimately have none.
 */
export function parseDetailLocation(detail: string): ParsedLocation | null {
	const match = VTD_PREFIX.exec(detail) ?? SARIF_PREFIX.exec(detail);
	return match ? {filepath: match[1], line: Number(match[2])} : null;
}

/** The snippet after the location prefix — what the scanner matched, quoted back in the question. */
export function detailSnippet(detail: string): string {
	const stripped = detail.replace(/^Detected in .*?:\d+(?: \(\d+ matches\))? — /, "").replace(/^[^:]+:\d+ — /, "");
	return stripped.trim();
}

/**
 * The location a review reads. Priority: a parsed line on a file we have; else the whole file;
 * else the whole skill. Never null — a finding is always reviewable against something.
 */
export function findingLocation(finding: AssetFinding, textFiles: Map<string, string>): ReviewLocation {
	const parsed = parseDetailLocation(finding.detail ?? "");
	const filepath = parsed?.filepath ?? finding.filepath;
	if (filepath === undefined) return {scope: "skill"};
	const content = textFiles.get(filepath);
	if (content === undefined) return {scope: "skill"};
	const lines = content.split("\n").length;
	if (parsed && parsed.line >= 1 && parsed.line <= lines) {
		return {filepath, lineStart: parsed.line, lineEnd: parsed.line};
	}
	return {filepath, lineStart: 1, lineEnd: lines};
}
