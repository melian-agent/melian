import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type PackageRoot = { readonly name: string; readonly from: string; readonly by: string };

type Manifest = {
	name?: unknown;
	version?: unknown;
	os?: unknown;
	cpu?: unknown;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};

export class InstalledPackagesError extends Error {
	readonly code = "installed-packages";
	constructor(message: string) {
		super(message);
		this.name = "InstalledPackagesError";
	}
}

// Every installed copy beneath `roots` as Node resolves each, one `place name@version` line apiece, sorted: `place` is
// its real directory relative to the outermost `node_modules` the first root was found in, so the layout, which fixes
// what every import reaches, is the key. The decision of 2026-11-20 sets out what it leaves out and why.
export function installedPackages(roots: readonly PackageRoot[]): string[] {
	const lines = new Set<string>();
	const walked = new Set<string>();
	let installRoot: string | undefined;
	type Kind = "required" | "peer" | "optional";
	const visit = (name: string, from: string, wanted: string, kind: Kind, range?: string) => {
		if (name.startsWith("@types/")) return;
		let path: string | undefined;
		try {
			path = findPackageJSON(name, from);
		} catch {
			path = undefined;
		}
		if (path === undefined) {
			if (kind === "optional") return;
			if (kind === "peer") {
				lines.add(`${name} absent, a peer of ${wanted}`);
				return;
			}
			throw new InstalledPackagesError(`Melian cannot find the installed package ${name}, which ${wanted} needs.`);
		}
		const found = dirname(path).split(sep);
		let manifest: Manifest;
		try {
			path = realpathSync(path);
			manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
		} catch {
			throw new InstalledPackagesError(`Melian cannot read the installed package ${name}, which ${wanted} needs.`);
		}
		if (manifest.name !== name || typeof manifest.version !== "string")
			throw new InstalledPackagesError(`Melian cannot read the installed package ${name}, which ${wanted} needs.`);
		if ((manifest.os !== undefined || manifest.cpu !== undefined) && range === manifest.version) return;
		if (walked.has(path)) return;
		walked.add(path);
		installRoot ??= found.slice(0, found.indexOf("node_modules")).join(sep);
		const place = relative(installRoot, dirname(path));
		if (!found.includes("node_modules") || place.startsWith("..") || isAbsolute(place))
			throw new InstalledPackagesError(
				`Melian cannot key the installed package ${name}, which ${wanted} needs: it is not beneath the install's node_modules.`,
			);
		const self = `${name}@${manifest.version}`;
		lines.add(`${place.split(sep).join("/")} ${self}`);
		const here = pathToFileURL(path).href;
		const kinds = new Map<string, [Kind, string]>();
		for (const [dependency, wants] of Object.entries(manifest.optionalDependencies ?? {}))
			kinds.set(dependency, ["optional", wants]);
		for (const [dependency, wants] of Object.entries(manifest.peerDependencies ?? {}))
			kinds.set(dependency, ["peer", wants]);
		for (const [dependency, wants] of Object.entries(manifest.dependencies ?? {}))
			kinds.set(dependency, ["required", wants]);
		for (const [dependency, [how, wants]] of kinds) visit(dependency, here, self, how, wants);
	};
	for (const root of roots) visit(root.name, root.from, root.by, "required");
	return [...lines].sort();
}

export function installedPackagesDigest(roots: readonly PackageRoot[]): string {
	return createHash("sha256")
		.update(
			installedPackages(roots)
				.map((line) => `${line}\n`)
				.join(""),
		)
		.digest("hex");
}
