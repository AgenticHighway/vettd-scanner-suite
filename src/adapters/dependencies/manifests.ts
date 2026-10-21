// Manifest parsers: declared dependencies, exact version only when the manifest pins one.

import {parse as parseToml} from "smol-toml";

import {dependency, EXACT_VERSION, parsePep508, type Dependency} from "./purl.js";

function compact(deps: (Dependency | null)[]): Dependency[] {
	return deps.filter((d): d is Dependency => d !== null);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseJson(content: string): Record<string, unknown> {
	try {
		return asRecord(JSON.parse(content));
	} catch {
		return {};
	}
}

function parseTomlSafe(content: string): Record<string, unknown> {
	try {
		return asRecord(parseToml(content));
	} catch {
		return {};
	}
}

export function parsePackageJson(content: string): Dependency[] {
	const obj = parseJson(content);
	const deps = {...asRecord(obj.dependencies), ...asRecord(obj.devDependencies)};
	return compact(
		Object.entries(deps).map(([name, spec]) => {
			// file:, link:, workspace:, git and URL specs, npm: aliases and user/repo shorthands
			// never name a public registry package.
			if (typeof spec !== "string" || /[:/]/.test(spec)) return null;
			return dependency("npm", name, EXACT_VERSION.test(spec) ? spec : null);
		}),
	);
}

export function parseRequirementsTxt(content: string): Dependency[] {
	return compact(
		content.split("\n").map((raw) => {
			const line = raw.split(" #")[0].trim();
			// Options (-r, -e, --index-url), local paths and comments are not packages.
			if (line === "" || /^[-#.\/]/.test(line)) return null;
			return parsePep508(line);
		}),
	);
}

export function parsePyprojectToml(content: string): Dependency[] {
	const doc = parseTomlSafe(content);
	const project = asRecord(doc.project);
	const pep621 = Array.isArray(project.dependencies) ? project.dependencies : [];
	const poetry = asRecord(asRecord(asRecord(doc.tool).poetry).dependencies);
	return compact([
		...pep621.map((req) => (typeof req === "string" ? parsePep508(req) : null)),
		...Object.entries(poetry).map(([name, spec]) => {
			// Tables are path/git/url sources (or extras); the python entry is the interpreter.
			if (name === "python" || typeof spec !== "string") return null;
			const pin = spec.replace(/^==?/, "");
			return dependency("pypi", name, EXACT_VERSION.test(pin) ? pin : null);
		}),
	]);
}

export function parseGoMod(content: string): Dependency[] {
	const deps: (Dependency | null)[] = [];
	let inRequire = false;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "require (") inRequire = true;
		else if (inRequire && trimmed === ")") inRequire = false;
		else {
			const match = inRequire
				? trimmed.match(/^(\S+)\s+(v[0-9]\S*)/)
				: trimmed.match(/^require\s+(\S+)\s+(v[0-9]\S*)/);
			if (match) deps.push(dependency("golang", match[1], match[2]));
		}
	}
	return compact(deps);
}

export function parseCargoToml(content: string): Dependency[] {
	const doc = parseTomlSafe(content);
	const deps = {...asRecord(doc.dependencies), ...asRecord(doc["dev-dependencies"])};
	return compact(
		Object.entries(deps).map(([name, spec]) => {
			// Tables carry path/git sources or features; only plain version strings are registry deps.
			if (typeof spec !== "string") return null;
			return dependency("cargo", name, spec.replace(/^=/, ""));
		}),
	);
}

export function parseGemfile(content: string): Dependency[] {
	return compact(
		content.split("\n").map((line) => {
			const match = line.match(/^\s*gem\s+["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?/);
			// git:/path:/github: options mean a non-registry source.
			if (!match || /\b(git|path|github)\s*:/.test(line)) return null;
			const version = match[2]?.replace(/^=\s*/, "") ?? null;
			return dependency("gem", match[1], version !== null && EXACT_VERSION.test(version) ? version : null);
		}),
	);
}
