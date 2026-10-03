// Direct dependencies stay pinned to exact versions, in every workspace package.
// A range here silently widens what CI installs; AGENTS.md treats dependency changes as reviewed code.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const fields = ["dependencies", "devDependencies", "optionalDependencies"];
const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function readManifests(root) {
	const read = (path) => ({ path, json: JSON.parse(readFileSync(join(root, path), "utf8")) });
	const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
		.map((entry) => read(join("packages", entry.name, "package.json")));
	return { root: read("package.json"), packages };
}

// "*" is how one workspace package depends on another; npm links it locally. For any other name it means
// "whatever the registry has", so it is allowed only for names that belong to this workspace.
export function findUnpinned({ root, packages }) {
	const workspaceNames = new Set(packages.map((manifest) => manifest.json.name));
	const problems = [];
	for (const { path, json } of [root, ...packages]) {
		for (const field of fields) {
			for (const [name, version] of Object.entries(json[field] ?? {})) {
				if (version === "*" && workspaceNames.has(name)) continue;
				if (!exact.test(version))
					problems.push(`${path}: ${field}.${name} is "${version}", expected an exact version`);
			}
		}
	}
	return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const problems = findUnpinned(readManifests("."));
	if (problems.length > 0) {
		console.error(problems.join("\n"));
		process.exit(1);
	}
}
