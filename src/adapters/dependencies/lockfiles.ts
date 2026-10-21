// Lockfile parsers: exact resolved versions. Entries resolved from anything other than the public
// registry (git, paths, private registries) are dropped, never sent to a lookup service.

import {parse as parseToml} from "smol-toml";

import {dependency, type Dependency} from "./purl.js";

const NPM_REGISTRIES = ["https://registry.npmjs.org/", "https://registry.yarnpkg.com/"];
const CRATES_SOURCES = ["registry+https://github.com/rust-lang/crates.io-index", "sparse+https://index.crates.io/"];

function compact(deps: (Dependency | null)[]): Dependency[] {
	return deps.filter((d): d is Dependency => d !== null);
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function tomlPackages(content: string): Record<string, unknown>[] {
	try {
		const doc = asRecord(parseToml(content));
		return Array.isArray(doc.package) ? doc.package.map(asRecord) : [];
	} catch {
		return [];
	}
}

export function parsePackageLock(content: string): Dependency[] {
	let doc: Record<string, unknown>;
	try {
		doc = asRecord(JSON.parse(content));
	} catch {
		return [];
	}
	// v2/v3 lockfiles key every installed package by its node_modules path.
	return compact(
		Object.entries(asRecord(doc.packages)).map(([path, raw]) => {
			const entry = asRecord(raw);
			const idx = path.lastIndexOf("node_modules/");
			if (idx === -1 || entry.link === true || typeof entry.version !== "string") return null;
			if (typeof entry.resolved === "string" && !NPM_REGISTRIES.some((r) => (entry.resolved as string).startsWith(r))) {
				return null;
			}
			return dependency("npm", path.slice(idx + "node_modules/".length), entry.version);
		}),
	);
}

export function parsePnpmLock(content: string): Dependency[] {
	const deps: (Dependency | null)[] = [];
	let inPackages = false;
	for (const line of content.split("\n")) {
		if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
		if (!inPackages) continue;
		// v9 `  'name@1.2.3':` / `  name@1.2.3(peer)`; v5/v6 `  /name/1.2.3:` / `  /name@1.2.3:`
		const match = line.match(/^ {2}'?\/?((?:@[^/@\s']+\/)?[^/@\s(':]+)[@/](\d[^\s:('"]*)/);
		if (match) deps.push(dependency("npm", match[1], match[2]));
	}
	return compact(deps);
}

export function parseYarnLock(content: string): Dependency[] {
	const deps: (Dependency | null)[] = [];
	let name: string | null = null;
	for (const line of content.split("\n")) {
		if (/^\S/.test(line)) {
			// Header: `"name@^1", name@~1:` (v1) or `"name@npm:^1":` (berry). First selector names it.
			const selector = line.replace(/:$/, "").split(",")[0].trim().replace(/^"|"$/g, "");
			const at = selector.lastIndexOf("@");
			const spec = selector.slice(at + 1);
			const nonRegistry = /^(file|link|workspace|portal|patch|git|https?|github):/.test(spec) || spec.includes("/");
			name = at > 0 && !nonRegistry ? selector.slice(0, at) : null;
			continue;
		}
		const version = line.match(/^ {2}version:? "?([^"\s]+)"?/);
		if (version && name !== null) {
			deps.push(dependency("npm", name, version[1]));
			name = null;
		}
	}
	return compact(deps);
}

export function parsePythonLock(content: string): Dependency[] {
	return compact(
		tomlPackages(content).map((pkg) => {
			const source = asRecord(pkg.source);
			// poetry.lock: no source table means PyPI. uv.lock: only `registry` sources pointing at PyPI.
			const fromPypi =
				pkg.source === undefined || (typeof source.registry === "string" && source.registry.startsWith("https://pypi.org/"));
			if (!fromPypi || typeof pkg.name !== "string" || typeof pkg.version !== "string") return null;
			return dependency("pypi", pkg.name, pkg.version);
		}),
	);
}

export function parseCargoLock(content: string): Dependency[] {
	return compact(
		tomlPackages(content).map((pkg) => {
			// Workspace members have no source; git/path sources are not crates.io.
			if (typeof pkg.source !== "string" || !CRATES_SOURCES.some((s) => (pkg.source as string).startsWith(s))) return null;
			if (typeof pkg.name !== "string" || typeof pkg.version !== "string") return null;
			return dependency("cargo", pkg.name, pkg.version);
		}),
	);
}

export function parseGemfileLock(content: string): Dependency[] {
	const deps: (Dependency | null)[] = [];
	let section = "";
	let inSpecs = false;
	for (const line of content.split("\n")) {
		if (/^\S/.test(line)) section = line.trim();
		if (line.trimEnd() === "  specs:") {
			inSpecs = true;
			continue;
		}
		if (inSpecs && !/^ {4}/.test(line)) inSpecs = false;
		// GIT and PATH sections list non-registry gems.
		if (!inSpecs || section !== "GEM") continue;
		const match = line.match(/^ {4}([A-Za-z0-9_.-]+) \(([0-9][^)]*)\)$/);
		if (match) deps.push(dependency("gem", match[1], match[2]));
	}
	return compact(deps);
}
