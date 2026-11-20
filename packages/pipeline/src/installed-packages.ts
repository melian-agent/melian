import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";

/** A package a producer's code imports: its name, the file or manifest Node resolves it from, and who imports it. */
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

/** Why Melian cannot say which installed packages a producer runs, naming the package it could not read. */
export class InstalledPackagesError extends Error {
	readonly code = "installed-packages";
	constructor(message: string) {
		super(message);
		this.name = "InstalledPackagesError";
	}
}

/**
 * Every installed package beneath `roots`, as Node resolves each, one `name@version` line apiece, sorted. A declared
 * peer that does not resolve is a line too, so an optional peer that appears moves the list. Left out: `@types/*`,
 * which never runs; a package whose manifest declares `os` or `cpu`, a platform build its parent's version stands for;
 * and an optional dependency that does not resolve, which npm skips for a platform it refuses. A root, or a dependency,
 * that does not resolve to a readable manifest of its own name fails, naming it.
 */
export function installedPackages(roots: readonly PackageRoot[]): string[] {
	const lines = new Set<string>();
	const visited = new Set<string>();
	const visit = (name: string, from: string, wanted: string, kind: "required" | "peer" | "optional") => {
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
		if (visited.has(path)) return;
		visited.add(path);
		let manifest: Manifest;
		try {
			manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
		} catch {
			throw new InstalledPackagesError(`Melian cannot read the installed package ${name}, which ${wanted} needs.`);
		}
		if (manifest.name !== name || typeof manifest.version !== "string")
			throw new InstalledPackagesError(`Melian cannot read the installed package ${name}, which ${wanted} needs.`);
		if (manifest.os !== undefined || manifest.cpu !== undefined) return;
		const self = `${name}@${manifest.version}`;
		lines.add(self);
		const here = pathToFileURL(path).href;
		const kinds = new Map<string, "required" | "peer" | "optional">();
		for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) kinds.set(dependency, "optional");
		for (const dependency of Object.keys(manifest.peerDependencies ?? {})) kinds.set(dependency, "peer");
		for (const dependency of Object.keys(manifest.dependencies ?? {})) kinds.set(dependency, "required");
		for (const [dependency, how] of kinds) visit(dependency, here, self, how);
	};
	for (const root of roots) visit(root.name, root.from, root.by, "required");
	return [...lines].sort();
}

/** A SHA-256 over `installedPackages(roots)`, each line ended by a newline: the digest a request key holds. */
export function installedPackagesDigest(roots: readonly PackageRoot[]): string {
	return createHash("sha256")
		.update(
			installedPackages(roots)
				.map((line) => `${line}\n`)
				.join(""),
		)
		.digest("hex");
}
