// Dependencies named in install/run commands and PEP 723 inline script metadata. Skills rarely
// ship manifests (vettd#1168: under 1% of public skills); the packages they use are mostly named
// in prose or scripts as `pip install x`, `npx y`, `uvx z`.

import {parse as parseToml} from "smol-toml";

import {dependency, EXACT_VERSION, parsePep508, type Dependency, type Ecosystem} from "./purl.js";

// Text up to a shell separator, comment, quote-close or code-span end.
const ARGS = String.raw`([^;&|\x60)#\n"']+)`;

interface Installer {
	pattern: RegExp;
	ecosystem: Ecosystem;
	/** Runners execute one package (the rest are its arguments); installers take a list. */
	firstOnly: boolean;
}

const INSTALLERS: Installer[] = [
	{pattern: new RegExp(String.raw`\b(?:python3? -m pip|pip3?|uv pip|uv tool|pipx)\s+install\s+` + ARGS, "g"), ecosystem: "pypi", firstOnly: false},
	{pattern: new RegExp(String.raw`\b(?:uv|poetry)\s+add\s+` + ARGS, "g"), ecosystem: "pypi", firstOnly: false},
	{pattern: new RegExp(String.raw`\b(?:uvx|pipx run)\s+` + ARGS, "g"), ecosystem: "pypi", firstOnly: true},
	{pattern: new RegExp(String.raw`\b(?:npx|bunx|pnpx|pnpm dlx)\s+` + ARGS, "g"), ecosystem: "npm", firstOnly: true},
	{pattern: new RegExp(String.raw`\b(?:npm (?:i|install|add)|pnpm (?:add|i|install)|yarn (?:global )?add|bun (?:add|i|install))\s+` + ARGS, "g"), ecosystem: "npm", firstOnly: false},
	{pattern: new RegExp(String.raw`\bcargo install\s+` + ARGS, "g"), ecosystem: "cargo", firstOnly: false},
	{pattern: new RegExp(String.raw`\bgo install\s+` + ARGS, "g"), ecosystem: "golang", firstOnly: true},
	{pattern: new RegExp(String.raw`\bgem install\s+` + ARGS, "g"), ecosystem: "gem", firstOnly: false},
];

// Flags whose next token is a value, not a package.
const VALUE_FLAGS = new Set(["-r", "-c", "-e", "-i", "--index-url", "--extra-index-url", "--registry", "--python", "--target", "--prefix"]);
// Flags whose next token IS the package (uvx --from pkg cmd, npx -p pkg cmd).
const PACKAGE_FLAGS = new Set(["--from", "--with", "-p", "--package"]);
// Flags whose next token is the version for the preceding package. cargo/gem only: for pip, -v is verbose.
const VERSION_FLAGS = new Set(["--version", "-v"]);
const VERSION_FLAG_ECOSYSTEMS = new Set<Ecosystem>(["cargo", "gem"]);

function parseToken(ecosystem: Ecosystem, token: string): Dependency | null {
	// uvx accepts `name@version` as well as PEP 508.
	if (ecosystem === "pypi") return parsePep508(token.replace(/^([A-Za-z0-9._-]+)@(\d)/, "$1==$2"));
	if (ecosystem === "golang") {
		const [path, version] = token.split("@");
		return dependency("golang", path.replace(/\/\.\.\.$/, ""), version && version !== "latest" ? version : null);
	}
	// npm/cargo use name@version; npm scopes start with @, so split on the last @ after index 0.
	const at = token.lastIndexOf("@");
	const [name, version] = at > 0 ? [token.slice(0, at), token.slice(at + 1)] : [token, null];
	return dependency(ecosystem, name, version !== null && EXACT_VERSION.test(version) ? version : null);
}

function parseArgs(installer: Installer, args: string): Dependency[] {
	const deps: Dependency[] = [];
	const tokens = args.trim().split(/\s+/);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (PACKAGE_FLAGS.has(token)) {
			const dep = tokens[i + 1] ? parseToken(installer.ecosystem, tokens[++i]) : null;
			if (dep) deps.push(dep);
			if (installer.firstOnly) break;
			continue;
		}
		if (VERSION_FLAGS.has(token) && VERSION_FLAG_ECOSYSTEMS.has(installer.ecosystem) && deps.length > 0) {
			const v = tokens[++i] ?? "";
			const last = deps[deps.length - 1];
			if (EXACT_VERSION.test(v)) deps[deps.length - 1] = {...last, version: v};
			continue;
		}
		if (VALUE_FLAGS.has(token)) i++;
		if (token.startsWith("-")) continue;
		// Paths, URLs and archives are local or non-registry sources.
		if (/^[.~/]|:\/\/|\.(whl|tar\.gz|tgz|zip)$/.test(token)) {
			if (installer.firstOnly) break;
			continue;
		}
		const dep = parseToken(installer.ecosystem, token);
		if (dep) deps.push(dep);
		if (installer.firstOnly) break;
	}
	return deps;
}

/** PEP 723 `# /// script` blocks: the `dependencies` array is PEP 508. */
function parseInlineScriptMetadata(content: string): Dependency[] {
	const deps: Dependency[] = [];
	for (const block of content.matchAll(/^# \/\/\/ script\s*$([\s\S]*?)^# \/\/\/\s*$/gm)) {
		const toml = block[1].split("\n").map((l) => l.replace(/^# ?/, "")).join("\n");
		try {
			const doc = parseToml(toml) as Record<string, unknown>;
			const reqs = Array.isArray(doc.dependencies) ? doc.dependencies : [];
			for (const req of reqs) {
				const dep = typeof req === "string" ? parsePep508(req) : null;
				if (dep) deps.push(dep);
			}
		} catch {
			// Malformed metadata block: nothing declared we can trust.
		}
	}
	return deps;
}

export function parseCommands(content: string): Dependency[] {
	const deps = parseInlineScriptMetadata(content);
	for (const installer of INSTALLERS) {
		for (const match of content.matchAll(installer.pattern)) deps.push(...parseArgs(installer, match[1]));
	}
	return deps;
}
