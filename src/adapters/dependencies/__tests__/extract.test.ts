import {describe, expect, it} from "vitest";

import {extractDependencies} from "../index.js";

function extract(files: Record<string, string>) {
	return extractDependencies(new Map(Object.entries(files)));
}

// Skills rarely ship manifests; most dependencies are named in commands (vettd#1168). Every
// identity extracted here may leave our network, so the "never extracted" cases matter as much as
// the positive ones.
describe("extractDependencies", () => {
	describe("lockfiles give exact versions", () => {
		it("reads package-lock.json v3 and drops non-registry and linked entries", () => {
			const lock = JSON.stringify({
				packages: {
					"": {name: "root"},
					"node_modules/lodash": {version: "4.17.21", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz"},
					"node_modules/a/node_modules/@scope/b": {version: "1.0.0"},
					"node_modules/internal": {version: "2.0.0", resolved: "https://npm.acme.internal/internal-2.0.0.tgz"},
					"node_modules/local": {version: "0.0.1", link: true},
				},
			});
			expect(extract({"package-lock.json": lock}).purls.sort()).toEqual(["pkg:npm/%40scope/b@1.0.0", "pkg:npm/lodash@4.17.21"]);
		});

		it("reads pnpm-lock.yaml v9 package keys", () => {
			const lock = "lockfileVersion: '9.0'\n\npackages:\n\n  '@types/node@20.1.0':\n    resolution: {}\n\n  zod@3.22.4(peer@1.0.0):\n    resolution: {}\n\nsnapshots:\n  ignored@9.9.9: {}\n";
			expect(extract({"pnpm-lock.yaml": lock}).purls.sort()).toEqual(["pkg:npm/%40types/node@20.1.0", "pkg:npm/zod@3.22.4"]);
		});

		it("reads yarn.lock v1 and berry, skipping workspace entries", () => {
			const v1 = '"left-pad@^1.0.0", left-pad@~1.3.0:\n  version "1.3.0"\n\nmine@workspace:.:\n  version "0.0.0"\n';
			const berry = '"chalk@npm:^5.0.0":\n  version: 5.3.0\n';
			expect(extract({"a/yarn.lock": v1, "b/yarn.lock": berry}).purls.sort()).toEqual(["pkg:npm/chalk@5.3.0", "pkg:npm/left-pad@1.3.0"]);
		});

		it("reads uv.lock and poetry.lock, keeping only PyPI sources", () => {
			const uv = '[[package]]\nname = "Requests"\nversion = "2.31.0"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "mine"\nversion = "0.1.0"\nsource = { editable = "." }\n';
			const poetry = '[[package]]\nname = "pydantic_core"\nversion = "2.14.6"\n';
			expect(extract({"uv.lock": uv, "poetry.lock": poetry}).purls.sort()).toEqual(["pkg:pypi/pydantic-core@2.14.6", "pkg:pypi/requests@2.31.0"]);
		});

		it("reads Cargo.lock crates.io packages only", () => {
			const lock = '[[package]]\nname = "serde"\nversion = "1.0.193"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "my-app"\nversion = "0.1.0"\n';
			expect(extract({"Cargo.lock": lock}).purls).toEqual(["pkg:cargo/serde@1.0.193"]);
		});

		it("reads Gemfile.lock GEM specs and ignores GIT sections", () => {
			const lock = "GIT\n  remote: https://github.com/x/y\n  specs:\n    private (0.1.0)\n\nGEM\n  remote: https://rubygems.org/\n  specs:\n    rack (3.0.8)\n";
			expect(extract({"Gemfile.lock": lock}).purls).toEqual(["pkg:gem/rack@3.0.8"]);
		});
	});

	describe("manifests", () => {
		it("never extracts file:, git, alias or workspace specs from package.json", () => {
			const pkg = JSON.stringify({dependencies: {a: "file:../a", b: "github:x/b", c: "npm:d@1.0.0", e: "workspace:*", f: "1.2.3"}});
			const result = extract({"package.json": pkg});
			expect(result.purls).toEqual(["pkg:npm/f@1.2.3"]);
			expect(result.unversioned).toEqual([]);
		});

		it("reads pyproject PEP 621 and poetry dependencies", () => {
			const toml = '[project]\ndependencies = ["httpx==0.27.0", "rich>=13"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nclick = "8.1.7"\nlocal = { path = "../local" }\n';
			const result = extract({"pyproject.toml": toml});
			expect(result.purls.sort()).toEqual(["pkg:pypi/click@8.1.7", "pkg:pypi/httpx@0.27.0"]);
			expect(result.unversioned.map((d) => d.name)).toEqual(["rich"]);
		});

		it("skips options, paths and URLs in requirements.txt", () => {
			const req = "-r base.txt\n-e .\n./vendor/pkg\npkg @ https://x/pkg.whl\nflask==3.0.0  # web\n";
			expect(extract({"requirements.txt": req}).purls).toEqual(["pkg:pypi/flask@3.0.0"]);
		});
	});

	describe("commands", () => {
		it("extracts the runner package, not its arguments", () => {
			const md = "Run `npx -y @modelcontextprotocol/server-filesystem@0.6.2 /tmp` then `uvx ruff@0.4.1 check .`";
			expect(extract({"SKILL.md": md}).purls.sort()).toEqual([
				"pkg:npm/%40modelcontextprotocol/server-filesystem@0.6.2",
				"pkg:pypi/ruff@0.4.1",
			]);
		});

		it("extracts every package from an installer and skips flags, paths and URLs", () => {
			const sh = "pip install -q --index-url https://x requests==2.31.0 ./local.whl git+https://x/y numpy\n";
			const result = extract({"scripts/setup.sh": sh});
			expect(result.purls).toEqual(["pkg:pypi/requests@2.31.0"]);
			expect(result.unversioned.map((d) => d.name)).toEqual(["numpy"]);
		});

		it("reads uvx --from and cargo --version", () => {
			const md = "uvx --from mcp-server-git==0.6.0 mcp-server-git\ncargo install ripgrep --version 14.1.0";
			expect(extract({"README.md": md}).purls.sort()).toEqual(["pkg:cargo/ripgrep@14.1.0", "pkg:pypi/mcp-server-git@0.6.0"]);
		});

		it("reads PEP 723 inline script metadata", () => {
			const py = '# /// script\n# dependencies = ["pypdf==4.2.0", "pillow"]\n# ///\nimport pypdf\n';
			const result = extract({"scripts/run.py": py});
			expect(result.purls).toEqual(["pkg:pypi/pypdf@4.2.0"]);
			expect(result.unversioned.map((d) => d.name)).toEqual(["pillow"]);
		});

		it("does not report a bare command as unversioned when a lockfile pins it", () => {
			const lock = JSON.stringify({packages: {"node_modules/tsx": {version: "4.7.0"}}});
			const result = extract({"package-lock.json": lock, "SKILL.md": "npx tsx main.ts"});
			expect(result.purls).toEqual(["pkg:npm/tsx@4.7.0"]);
			expect(result.unversioned).toEqual([]);
		});

		it("ignores manifest scripts and prose without installer commands", () => {
			const pkg = JSON.stringify({scripts: {start: "npx some-tool"}});
			expect(extract({"package.json": pkg, "SKILL.md": "Use pip to manage packages."})).toEqual({purls: [], unversioned: []});
		});
	});
});
