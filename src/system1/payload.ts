// What System 1 reads: every text file in the skill, the shallowest SKILL.md first, then scripts and
// dependency manifests, then everything else, each as `### FILE: <path>`. Secrets are replaced with
// typed placeholders before anything is measured or sent.
//
// One model call has a hard input limit (about 250k tokens), so the text is split into parts that
// each fit. SKILL.md opens every part, so judgments that compare instructions with code still have
// the instructions in view. A skill too large for `maxParts` parts is read partially and marked
// truncated; the ceiling exists to bound abuse, not to cut real skills.

import {redactSecrets} from "./redact.js";

const SCRIPT_EXTENSIONS = new Set([
	"py", "js", "mjs", "cjs", "ts", "sh", "bash", "zsh", "rb", "go", "rs", "ps1", "pl", "php", "java", "lua",
]);
const MANIFEST_BASENAMES = new Set([
	"package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "Gemfile.lock",
]);

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

function isSkillMd(path: string): boolean {
	return basename(path).toLowerCase() === "skill.md";
}

/** Scripts and manifests before other files: they carry the behaviour most rules judge. */
function rank(path: string): number {
	const base = basename(path);
	if (MANIFEST_BASENAMES.has(base)) return 0;
	const dot = base.lastIndexOf(".");
	return dot > 0 && SCRIPT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase()) ? 0 : 1;
}

/** A skill has instructions or code to judge; loose notes alone are not a skill. */
export function hasSkillContent(textFiles: Map<string, string>): boolean {
	return [...textFiles.keys()].some((p) => isSkillMd(p) || rank(p) === 0);
}

/** One file, or one piece of a file too large for a part, as sent. */
export interface PayloadSection {
	path: string;
	/** The file's (redacted) text in this section, without its `### FILE` header. */
	body: string;
	/** Line in the original file where `body` starts (1-based); redaction keeps line numbers. */
	startLine: number;
	/** The `### FILE` line that introduced this section. */
	header: string;
}

export interface PayloadPart {
	text: string;
	/** Files (or file pieces) in this part, SKILL.md included. */
	paths: string[];
	/** The sections this part was built from, in order; the SKILL.md head first when there is one. */
	sections: PayloadSection[];
}

/** 1-based line of the character at `index`. */
function lineAt(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

export interface Payload {
	parts: PayloadPart[];
	/** Characters of skill text read, SKILL.md counted once. */
	chars: number;
	includedPaths: string[];
	/** Files not read, or read only in part, because the part ceiling was reached. */
	omittedPaths: string[];
	truncated: boolean;
	/** Secrets replaced before sending, counted by type; never the values. */
	redactions: Record<string, number>;
}

/** Splits text into pieces of at most `size` characters, preferring line boundaries. */
function pieces(text: string, size: number): {text: string; offset: number}[] {
	const out: {text: string; offset: number}[] = [];
	let offset = 0;
	let rest = text;
	while (rest.length > size) {
		const nl = rest.lastIndexOf("\n", size);
		const cut = nl > size / 2 ? nl + 1 : size;
		out.push({text: rest.slice(0, cut), offset});
		offset += cut;
		rest = rest.slice(cut);
	}
	out.push({text: rest, offset});
	return out;
}

export function buildPayload(textFiles: Map<string, string>, partChars: number, maxParts: number): Payload {
	const redactions: Record<string, number> = {};
	const read = (path: string) => redactSecrets(textFiles.get(path) ?? "", redactions).text;
	const skillMdPath = [...textFiles.keys()]
		.filter(isSkillMd)
		.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
	const others = [...textFiles.keys()].filter((p) => p !== skillMdPath).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

	// SKILL.md repeats in every part, so it may take at most a quarter of one; the rest of a very
	// long SKILL.md is read as ordinary pieces.
	const skillMd = skillMdPath ? read(skillMdPath) : "";
	const headBudget = Math.floor(partChars / 4);
	const headSection: PayloadSection | null = skillMdPath
		? {path: skillMdPath, body: skillMd.slice(0, headBudget), startLine: 1, header: `### FILE: ${skillMdPath}`}
		: null;
	const head = headSection ? `${headSection.header}\n${headSection.body}` : "";
	const room = partChars - head.length - 128;
	const sections: (PayloadSection & {text: string})[] = [];
	const add = (path: string, header: string, body: string, startLine: number) =>
		sections.push({path, header, body, startLine, text: `${header}\n${body}`});
	if (skillMdPath && skillMd.length > headBudget) {
		const rest = pieces(skillMd.slice(headBudget), room);
		rest.forEach((t, i) =>
			add(skillMdPath, `### FILE: ${skillMdPath} (continued, piece ${i + 1} of ${rest.length})`, t.text, lineAt(skillMd, headBudget + t.offset)),
		);
	}
	for (const path of others) {
		const content = read(path);
		const chunks = pieces(content, room);
		chunks.forEach((t, i) =>
			add(path, `### FILE: ${path}${chunks.length > 1 ? ` (piece ${i + 1} of ${chunks.length})` : ""}`, t.text, lineAt(content, t.offset)),
		);
	}

	const fresh = (): PayloadPart => ({text: head, paths: skillMdPath ? [skillMdPath] : [], sections: headSection ? [headSection] : []});
	const parts: PayloadPart[] = [];
	let current = fresh();
	let hasBody = head.length > 0;
	const omitted = new Set<string>();
	for (const s of sections) {
		if (hasBody && current.text.length + s.text.length + 2 > partChars && current.text !== head) {
			parts.push(current);
			current = fresh();
		}
		if (parts.length >= maxParts) {
			omitted.add(s.path);
			continue;
		}
		current.text = current.text ? `${current.text}\n\n${s.text}` : s.text;
		if (!current.paths.includes(s.path)) current.paths.push(s.path);
		current.sections.push({path: s.path, header: s.header, body: s.body, startLine: s.startLine});
		hasBody = true;
	}
	if (parts.length < maxParts && current.text.length > 0) parts.push(current);

	const includedPaths = [...new Set(parts.flatMap((p) => p.paths))];
	const chars = parts.reduce((n, p) => n + p.text.length, 0) - head.length * Math.max(0, parts.length - 1);
	return {parts, chars, includedPaths, omittedPaths: [...omitted], truncated: omitted.size > 0, redactions};
}

export function skillNameFromPayload(textFiles: Map<string, string>): string {
	const skillMdPath = [...textFiles.keys()].find(isSkillMd);
	const content = skillMdPath ? (textFiles.get(skillMdPath) ?? "") : "";
	const match = content.match(/^---\s*\n[\s\S]*?^name:\s*["']?([^\n"']+?)["']?\s*$/m);
	return match?.[1]?.trim() || "unknown";
}
