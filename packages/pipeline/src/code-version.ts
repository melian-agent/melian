import { createHash } from "node:crypto";
import { findPackageJSON } from "node:module";
import { moduleHashes, producerModules, producerPackages } from "./code-hashes.ts";
import {
	InstalledPackagesError,
	installedPackagesDigest,
	type PackageRoot,
	packagesOutsideInstall,
} from "./installed-packages.ts";

/**
 * The version of the code that decides `producer`'s result: a SHA-256 over the recorded path and hash of each module its
 * run reaches, read from the recorded table and never from source, which a built package does not ship. The gate's
 * `scripts/code-hashes.test.mjs` fails when the table disagrees with the source. Throws for a producer, or a module, the
 * table does not hold.
 */
export function codeVersion(producer: string): string {
	const modules = Object.hasOwn(producerModules, producer) ? producerModules[producer] : undefined;
	if (modules === undefined) throw new Error(`no code is recorded for the producer ${producer}`);
	const lines = modules.map((path) => {
		const hash = Object.hasOwn(moduleHashes, path) ? moduleHashes[path] : undefined;
		if (hash === undefined) throw new Error(`${producer} reaches ${path}, whose hash is not recorded`);
		return `${path} ${hash}\n`;
	});
	return createHash("sha256").update(lines.join("")).digest("hex");
}

const packagesRead = new Map<string, string>();

/**
 * The digest of every installed package beneath those `producer`'s modules import, each resolved from the manifest of
 * the package that imports it, as Node resolves it when the module loads. The recorded table names the imports, and the
 * gate ties it to what Node resolves. Read once a process, on first use. Throws for a producer the table does not hold,
 * or a package Melian cannot read.
 */
export function packagesVersion(producer: string): string {
	const known = packagesRead.get(producer);
	if (known !== undefined) return known;
	const imports = Object.hasOwn(producerPackages, producer) ? producerPackages[producer] : undefined;
	if (imports === undefined) throw new Error(`no packages are recorded for the producer ${producer}`);
	const digest = installedPackagesDigest(rootsOf(imports));
	packagesRead.set(producer, digest);
	return digest;
}

/**
 * The releases any producer reaches through a link out of Melian's install, such as one `npm link` made, each of which
 * leaves the install unidentified, so no run is reused. Throws for a package Melian cannot read.
 */
export function unidentifiedPackages(): string[] {
	return [
		...new Set(Object.values(producerPackages).flatMap((imports) => packagesOutsideInstall(rootsOf(imports)))),
	].sort();
}

function rootsOf(imports: Readonly<Record<string, readonly string[]>>): PackageRoot[] {
	return Object.entries(imports).flatMap(([by, names]) => {
		let manifest: string | undefined;
		try {
			manifest = findPackageJSON(by, import.meta.url);
		} catch {
			manifest = undefined;
		}
		if (manifest === undefined) throw new InstalledPackagesError(`Melian cannot find its own package ${by}.`);
		return names.map((name) => ({ name, from: manifest, by }));
	});
}
