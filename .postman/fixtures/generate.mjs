// Regenerates the committed Postman fixture zips from the hardcoded skill
// content below. Run manually after editing this file:
//   node .postman/fixtures/generate.mjs
import {writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import JSZip from "jszip";

const here = path.dirname(fileURLToPath(import.meta.url));

async function buildZip(files) {
	const zip = new JSZip();
	for (const [p, content] of Object.entries(files)) zip.file(p, content);
	return zip.generateAsync({type: "nodebuffer"});
}

const minimalSkill = {
	"SKILL.md": `---
name: example-minimal-skill
description: Minimal example skill used to smoke-test the scanner suite's upload endpoint.
version: 1.0.0
---

# Example Minimal Skill

A minimal, single-file skill fixture for Postman smoke tests.
`,
};

const fullSkill = {
	"SKILL.md": `---
name: example-full-skill
description: Example skill with scripts and references, used to smoke-test the scanner suite's upload endpoint.
version: 1.0.0
allowed-tools: ["bash", "python"]
---

# Example Full Skill

Demonstrates a more realistic skill layout: frontmatter, a couple of helper
scripts, and reference docs. Used purely as Postman fixture content — it does
not perform any real action.

## Usage

Run \`scripts/run.sh\` to execute the skill's main entry point. See
\`references/usage.md\` for details.
`,
	"scripts/run.sh": `#!/usr/bin/env bash
set -euo pipefail
echo "example-full-skill: hello from run.sh"
`,
	"scripts/helper.py": `"""Small helper used by the example skill fixture."""


def greet(name: str) -> str:
    return f"hello, {name}"


if __name__ == "__main__":
    print(greet("world"))
`,
	"references/usage.md": `# Usage

1. Invoke \`scripts/run.sh\` from the skill root.
2. Optionally call \`scripts/helper.py\` for the greeting helper.
`,
	"references/api-notes.md": `# API Notes

This skill fixture makes no network calls and has no external dependencies.
It exists solely as realistic zip content for API smoke tests.
`,
};

const targets = [
	["minimal-skill.zip", minimalSkill],
	["full-skill.zip", fullSkill],
];

for (const [name, files] of targets) {
	const buf = await buildZip(files);
	await writeFile(path.join(here, name), buf);
	console.log(`wrote ${name} (${buf.length} bytes)`);
}
