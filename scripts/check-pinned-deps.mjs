// Direct dependencies stay pinned to exact versions, in every workspace package.
// A range here silently widens what CI installs; AGENTS.md treats dependency changes as reviewed code.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const manifests = ["package.json", ...readdirSync("packages").map((name) => join("packages", name, "package.json"))];
const fields = ["dependencies", "devDependencies", "optionalDependencies"];
const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const problems = [];

for (const manifest of manifests) {
	const json = JSON.parse(readFileSync(manifest, "utf8"));
	for (const field of fields) {
		for (const [name, version] of Object.entries(json[field] ?? {})) {
			if (version.startsWith("workspace:") || version === "*") continue;
			if (!exact.test(version))
				problems.push(`${manifest}: ${field}.${name} is "${version}", expected an exact version`);
		}
	}
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	process.exit(1);
}
