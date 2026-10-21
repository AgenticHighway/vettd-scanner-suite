// Dependency extraction for third-party lookups (vettd#1168). Pure: text in, identities out.

import {parseCommands} from "./commands.js";
import {parseCargoLock, parseGemfileLock, parsePackageLock, parsePnpmLock, parsePythonLock, parseYarnLock} from "./lockfiles.js";
import {parseCargoToml, parseGemfile, parseGoMod, parsePackageJson, parsePyprojectToml, parseRequirementsTxt} from "./manifests.js";
import {dependencyKey, toPurl, type Dependency} from "./purl.js";

export type {Dependency} from "./purl.js";

const FILE_PARSERS: Record<string, (content: string) => Dependency[]> = {
	"package.json": parsePackageJson,
	"requirements.txt": parseRequirementsTxt,
	"pyproject.toml": parsePyprojectToml,
	"go.mod": parseGoMod,
	"Cargo.toml": parseCargoToml,
	Gemfile: parseGemfile,
	"package-lock.json": parsePackageLock,
	"pnpm-lock.yaml": parsePnpmLock,
	"yarn.lock": parseYarnLock,
	"poetry.lock": parsePythonLock,
	"uv.lock": parsePythonLock,
	"Cargo.lock": parseCargoLock,
	"Gemfile.lock": parseGemfileLock,
};

export interface ExtractedDependencies {
	/** Deduplicated PURLs for every dependency with an exact version. */
	purls: string[];
	/** Dependencies found with no exact version anywhere (ranges, tags, bare names). Not looked up. */
	unversioned: Dependency[];
}

export function extractDependencies(textFiles: Map<string, string>): ExtractedDependencies {
	const all: Dependency[] = [];
	for (const [filePath, content] of textFiles) {
		const parser = FILE_PARSERS[filePath.split("/").pop() ?? filePath];
		// Manifests and lockfiles are parsed structurally; every other text file may name
		// packages in install/run commands.
		all.push(...(parser ? parser(content) : parseCommands(content)));
	}

	const purls = new Set<string>();
	const versioned = new Set<string>();
	for (const dep of all) {
		const purl = toPurl(dep);
		if (purl === null) continue;
		purls.add(purl);
		versioned.add(dependencyKey(dep));
	}
	// A bare `npx foo` next to a lockfile pin of foo is already covered by the pin.
	const unversioned = new Map<string, Dependency>();
	for (const dep of all) {
		const key = dependencyKey(dep);
		if (dep.version === null && !versioned.has(key)) unversioned.set(key, dep);
	}
	return {purls: [...purls], unversioned: [...unversioned.values()]};
}
