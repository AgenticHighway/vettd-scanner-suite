// Package identity helpers shared by every dependency parser. Pure, no I/O.
//
// Data minimisation (vettd#1168): only identities that look like plain public-registry package
// names are ever produced. Anything else (paths, URLs, git refs, aliases) is dropped at parse
// time and never reaches a third-party lookup.

export type Ecosystem = "npm" | "pypi" | "golang" | "cargo" | "gem";

/** One declared dependency. `version` is null when only a range, tag, or nothing was declared. */
export interface Dependency {
	ecosystem: Ecosystem;
	name: string;
	version: string | null;
}

const NAME_PATTERNS: Record<Ecosystem, RegExp> = {
	npm: /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/i,
	pypi: /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/,
	golang: /^[a-z0-9.-]+\.[a-z]{2,}(\/[A-Za-z0-9._~-]+)+$/i,
	cargo: /^[A-Za-z0-9_-]+$/,
	gem: /^[A-Za-z0-9_.-]+$/,
};

const VERSION_PATTERN = /^v?[0-9][A-Za-z0-9.+_-]*$/;

/** Exact semver-ish version: digits.digits[.digits][-pre][+build]. Ranges and tags fail. */
export const EXACT_VERSION = /^v?\d+(\.\d+){1,3}([-+][A-Za-z0-9.+_-]+)?$/;

/** PEP 503 normalisation; PURL requires it for pypi names. */
function normalizeName(ecosystem: Ecosystem, name: string): string {
	return ecosystem === "pypi" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name;
}

/** Builds a Dependency, or null when the name or version is not a plain registry identity. */
export function dependency(ecosystem: Ecosystem, name: string, version: string | null): Dependency | null {
	if (!NAME_PATTERNS[ecosystem].test(name)) return null;
	const exact = version !== null && VERSION_PATTERN.test(version) ? version : null;
	return {ecosystem, name: normalizeName(ecosystem, name), version: exact};
}

export function dependencyKey(dep: Dependency): string {
	return `${dep.ecosystem}:${dep.name}`;
}

/** PURL for a versioned dependency, or null when there is no exact version to look up. */
export function toPurl(dep: Dependency): string | null {
	if (dep.version === null) return null;
	// Scoped npm packages: only the leading @ is percent-encoded per the PURL spec.
	const name = dep.ecosystem === "npm" ? dep.name.replace(/^@/, "%40") : dep.name;
	return `pkg:${dep.ecosystem}/${name}@${dep.version}`;
}

/** PEP 508 requirement string → Dependency. Only `==` pins count as a version; URLs are dropped. */
export function parsePep508(requirement: string): Dependency | null {
	const spec = requirement.split(";")[0].trim();
	if (spec.includes("@") || spec.includes("://")) return null;
	const match = spec.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/);
	if (!match) return null;
	const pin = match[3].trim().match(/^===?\s*([^\s,]+)$/);
	return dependency("pypi", match[1], pin ? pin[1] : null);
}
