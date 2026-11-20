import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
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

// A directory's place beneath the install root, with `/` between its parts on every platform.
const placed = (root: string, directory: string) => relative(root, directory).split(sep).join("/");

const beneath = (root: string, directory: string) => {
	const path = relative(root, directory);
	return !path.startsWith("..") && !isAbsolute(path);
};

// Every installed copy beneath `roots` as Node resolves each, one `place name@version` line apiece, and one
// `place links place` line for each link Node resolves through, sorted. A place is relative to the install root, the
// deepest real directory every copy's outermost `node_modules` sits in, so the layout, which fixes what every import
// reaches, is the key. A link out of the install leaves it unidentified, and lands in `outside`. The decision of
// 2026-11-20 says what it leaves out.
function walk(roots: readonly PackageRoot[]): { lines: string[]; outside: string[] } {
	const lines = new Set<string>();
	const walked = new Set<string>();
	const copies: { directory: string; line: string }[] = [];
	const links: { from: string; to?: string }[] = [];
	const outside: string[] = [];
	const folders: string[][] = [];
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
		const modules = found.indexOf("node_modules");
		let manifest: Manifest;
		let prefix: string;
		try {
			path = realpathSync(path);
			prefix = modules < 0 ? "" : realpathSync(found.slice(0, modules).join(sep) || sep);
			manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
		} catch {
			throw new InstalledPackagesError(`Melian cannot read the installed package ${name}, which ${wanted} needs.`);
		}
		if (manifest.name !== name || typeof manifest.version !== "string")
			throw new InstalledPackagesError(`Melian cannot read the installed package ${name}, which ${wanted} needs.`);
		if ((manifest.os !== undefined || manifest.cpu !== undefined) && range === manifest.version) return;
		if (modules < 0)
			throw new InstalledPackagesError(
				`Melian cannot key the installed package ${name}, which ${wanted} needs: it is not beneath the install's node_modules.`,
			);
		const self = `${name}@${manifest.version}`;
		const at = join(prefix, ...found.slice(modules));
		const directory = dirname(path);
		if (!beneath(prefix, directory)) {
			links.push({ from: at });
			outside.push(self);
			return;
		}
		if (at !== directory) links.push({ from: at, to: directory });
		folders.push(prefix.split(sep));
		if (walked.has(path)) return;
		walked.add(path);
		copies.push({ directory, line: self });
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
	const [first = [], ...rest] = folders;
	let depth = 0;
	while (depth < first.length && rest.every((folder) => folder[depth] === first[depth])) depth++;
	const installRoot = first.slice(0, depth).join(sep);
	for (const copy of copies) lines.add(`${placed(installRoot, copy.directory)} ${copy.line}`);
	for (const link of links)
		lines.add(
			`${placed(installRoot, link.from)} links ${link.to === undefined ? "outside the install" : placed(installRoot, link.to)}`,
		);
	return { lines: [...lines].sort(), outside: [...new Set(outside)].sort() };
}

export function installedPackages(roots: readonly PackageRoot[]): string[] {
	return walk(roots).lines;
}

// The releases beneath `roots` that Node reaches through a link out of the install, which leave it unidentified.
export function packagesOutsideInstall(roots: readonly PackageRoot[]): string[] {
	return walk(roots).outside;
}

// Drawn once a process, so a digest over an unidentified install matches no digest another process wrote.
const unidentified = randomUUID();

export function installedPackagesDigest(roots: readonly PackageRoot[]): string {
	const { lines, outside } = walk(roots);
	const hash = createHash("sha256").update(lines.map((line) => `${line}\n`).join(""));
	if (outside.length > 0) hash.update(`unidentified ${unidentified}\n`);
	return hash.digest("hex");
}
