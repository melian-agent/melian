import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";

// The version the root manifest of package `name`, as resolved from `from`, gives. It fails closed when that manifest
// names another package, as one installed under an alias does, or gives no version.
export function installedVersion(name: string, from: string): string {
	const path = findPackageJSON(name, from);
	const manifest = path === undefined ? undefined : JSON.parse(readFileSync(path, "utf8"));
	if (manifest?.name !== name || typeof manifest.version !== "string")
		throw new Error(`Melian cannot read the installed version of ${name}.`);
	return manifest.version;
}
