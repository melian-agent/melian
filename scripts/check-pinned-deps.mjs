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

// A workspace package names another at that package's own version, which npm links locally, so a published release
// fixes which release of each Melian package it runs; the code versions it records cover only that release's source.
export function findUnpinned({ root, packages }) {
	const workspaceVersions = new Map(packages.map((manifest) => [manifest.json.name, manifest.json.version]));
	const problems = [];
	for (const { path, json } of [root, ...packages]) {
		for (const field of fields) {
			for (const [name, version] of Object.entries(json[field] ?? {})) {
				if (workspaceVersions.has(name)) {
					if (version !== workspaceVersions.get(name))
						problems.push(
							`${path}: ${field}.${name} is "${version}", expected ${workspaceVersions.get(name)}, the workspace package's own version`,
						);
				} else if (!exact.test(version))
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
