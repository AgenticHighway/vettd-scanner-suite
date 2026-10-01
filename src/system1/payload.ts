// What System 1 reads: the shallowest SKILL.md first, then scripts and dependency manifests in
// path order, each as `### FILE: <path>`, capped at a character budget.

const SCRIPT_EXTENSIONS = new Set([
	"py", "js", "mjs", "cjs", "ts", "sh", "bash", "zsh", "rb", "go", "rs", "ps1", "pl", "php", "java", "lua",
]);
// Dependency manifests: the provenance and typosquatting rules have nothing to read without them.
const MANIFEST_BASENAMES = new Set([
	"package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "Gemfile.lock",
]);

function basename(path: string): string {
	return path.split("/").pop() ?? path;
}

function isSkillMd(path: string): boolean {
	return basename(path).toLowerCase() === "skill.md";
}

function isPayloadFile(path: string): boolean {
	const base = basename(path);
	if (MANIFEST_BASENAMES.has(base)) return true;
	const dot = base.lastIndexOf(".");
	return dot > 0 && SCRIPT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

export interface Payload {
	text: string;
	includedPaths: string[];
	/** Eligible files dropped (or cut short) to stay under the character cap. */
	omittedPaths: string[];
	truncated: boolean;
}

/**
 * References and assets are deliberately not sent (cost, and parity with the demo). Stops at
 * `maxChars`, cutting the file that crosses the cap. Truncation is a coverage gap: a skill whose
 * risky content sits beyond the cap is not seen.
 */
export function buildPayload(textFiles: Map<string, string>, maxChars: number): Payload {
	const skillMds = [...textFiles.keys()]
		.filter(isSkillMd)
		.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
	const others = [...textFiles.keys()].filter((p) => !isSkillMd(p) && isPayloadFile(p)).sort();
	const ordered = [...skillMds.slice(0, 1), ...others];

	const sections: string[] = [];
	const includedPaths: string[] = [];
	const omittedPaths: string[] = [];
	let used = 0;
	let truncated = false;
	for (const path of ordered) {
		const remaining = maxChars - used;
		if (remaining <= 0) {
			omittedPaths.push(path);
			truncated = true;
			continue;
		}
		const header = `### FILE: ${path}\n`;
		const content = textFiles.get(path) ?? "";
		let section = header + content;
		if (section.length > remaining) {
			section = section.slice(0, remaining);
			omittedPaths.push(path);
			truncated = true;
		}
		sections.push(section);
		includedPaths.push(path);
		used += section.length + 2; // "\n\n" separator
	}
	return {text: sections.join("\n\n"), includedPaths, omittedPaths, truncated};
}

export function skillNameFromPayload(textFiles: Map<string, string>): string {
	const skillMdPath = [...textFiles.keys()].find(isSkillMd);
	const content = skillMdPath ? (textFiles.get(skillMdPath) ?? "") : "";
	const match = content.match(/^---\s*\n[\s\S]*?^name:\s*["']?([^\n"']+?)["']?\s*$/m);
	return match?.[1]?.trim() || "unknown";
}
