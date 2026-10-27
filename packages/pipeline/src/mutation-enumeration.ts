import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	Changeset,
	gitOutput,
	type MutationAdapterIdentity,
	MutationInventory,
	type MutationInventoryV2,
	mutationUnmutated,
	openSource,
	type RepositorySource,
} from "@melian-agent/core";
import { MutationTargets, productionWithExtensions } from "./mutation-paths.ts";
import { mutationInstallation } from "./mutation-static.ts";

/** Committed source and changed line ranges passed to an enumerator, never executed. */
export interface MutationFile {
	readonly name: string;
	readonly content: string;
	readonly ranges: readonly (readonly [number, number])[];
}

type EnumeratedMutant = {
	file: string;
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
	mutatorName: string;
	replacement: string;
	status: "generated" | "ignored";
	ignoredBy?: "config" | "comment";
	statusReason?: string;
};

/** A language's enumeration contract. Verification operations join it in the next build. */
export interface MutationAdapter {
	readonly identity: MutationAdapterIdentity;
	readonly applies: "switch" | "text";
	readonly enumerationRequiresBuild: boolean;
	enumerate(files: readonly MutationFile[], excludedMutations: readonly string[]): Promise<EnumeratedMutant[]>;
}

/** Failure to enumerate committed source, distinct from a failed mutation test. */
export class MutationEnumerationError extends Error {
	readonly code: "instrumenter" | "policy" | "unsupported" | "limit";
	constructor(code: MutationEnumerationError["code"], message: string) {
		super(message);
		this.name = "MutationEnumerationError";
		this.code = code;
	}
}

/** Stryker's TypeScript and JavaScript enumerator, isolated from the revision's Babel configuration. */
export class TypeScriptMutationAdapter implements MutationAdapter {
	readonly identity: MutationAdapterIdentity;
	readonly applies = "switch";
	readonly enumerationRequiresBuild = false;
	readonly source: "checkout" | "melian";
	readonly #module: string;
	private constructor(module: string, toolVersion: string, source: "checkout" | "melian") {
		this.#module = module;
		this.identity = { name: "typescript", version: "1", toolVersion, source };
		this.source = source;
	}

	static async open(repoRoot: string): Promise<TypeScriptMutationAdapter> {
		let tracked: string;
		try {
			tracked = await gitOutput(repoRoot, ["ls-files", "--", "node_modules"]);
		} catch {
			throw new MutationEnumerationError(
				"instrumenter",
				"cannot establish whether git tracks the installed instrumenter",
			);
		}
		const trackedInstall = tracked !== "";
		const root = await realpath(repoRoot);
		const install = join(root, "node_modules");
		for (const [from, source] of [
			[join(repoRoot, "package.json"), "checkout"],
			[import.meta.url, "melian"],
		] as const) {
			if (source === "checkout" && trackedInstall) continue;
			const require = createRequire(from);
			try {
				const module = await realpath(require.resolve("@stryker-mutator/instrumenter"));
				if (source === "checkout" && !inside(install, module)) continue;
				if (inside(root, module) && (!inside(install, module) || trackedInstall)) continue;
				if (
					source === "melian" &&
					!ancestorInstalls(fileURLToPath(import.meta.url)).some((directory) => inside(directory, module))
				)
					continue;
				if (!(await safeDependencies(module, root, install, trackedInstall))) continue;
				const { version } = JSON.parse(
					await readFile(require.resolve("@stryker-mutator/instrumenter/package.json"), "utf8"),
				) as { version: string };
				return new TypeScriptMutationAdapter(module, version, source);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
			}
		}
		throw new MutationEnumerationError(
			"instrumenter",
			"Stryker's instrumenter is unavailable; reinstall Melian's dependencies",
		);
	}

	async enumerate(files: readonly MutationFile[], excludedMutations: readonly string[]): Promise<EnumeratedMutant[]> {
		const scratch = await mkdtemp(join(tmpdir(), `melian-enumerate-${process.pid}-`));
		try {
			// Babel stops .babelrc discovery at the nearest package boundary.
			await writeFile(join(scratch, "package.json"), "{}");
			const script = `import { readFileSync } from 'node:fs';
import { Instrumenter } from ${JSON.stringify(pathToFileURL(this.#module).href)};
const logger = {debug(){}, info(){}, warn(){}, error(){}, trace(){}, isDebugEnabled:()=>false};
const {files, excludedMutations} = JSON.parse(readFileSync(0, 'utf8'));
const {mutants} = await new Instrumenter(logger).instrument(files, {plugins:null, ignorers:[], excludedMutations});
console.log(JSON.stringify(mutants));`;
			const input = JSON.stringify({
				files: files.map((file) => ({
					name: file.name,
					content: file.content,
					mutate: file.ranges.map(([first, last]) => ({
						start: { line: first - 1, column: 0 },
						end: { line: last - 1, column: Number.MAX_SAFE_INTEGER },
					})),
				})),
				excludedMutations,
			});
			const output = await new Promise<string>((resolve, reject) => {
				const child = execFile(
					process.execPath,
					["--input-type=module", "--eval", script],
					{
						cwd: scratch,
						maxBuffer: 64 * 1024 * 1024,
						timeout: 120_000,
						// Node preload flags can load repository code before the isolated parser starts.
						env: { PATH: process.env.PATH, LANG: "C.UTF-8" },
					},
					(error, stdout, stderr) => {
						if (error)
							reject(
								new MutationEnumerationError("instrumenter", `enumeration failed: ${stderr || error.message}`),
							);
						else resolve(stdout);
					},
				);
				child.stdin!.on("error", () => {});
				child.stdin!.end(input);
			});
			const mutants = JSON.parse(output) as {
				fileName: string;
				location: { start: { line: number; column: number }; end: { line: number; column: number } };
				mutatorName: string;
				replacement: string;
				status?: string;
				statusReason?: string;
			}[];
			return mutants.map((mutant) => ({
				file: mutant.fileName,
				line: mutant.location.start.line + 1,
				column: mutant.location.start.column,
				endLine: mutant.location.end.line + 1,
				endColumn: mutant.location.end.column,
				mutatorName: mutant.mutatorName,
				replacement: mutant.replacement,
				status: mutant.status === "Ignored" ? "ignored" : "generated",
				...(mutant.status === "Ignored"
					? ({ ignoredBy: excludedMutations.includes(mutant.mutatorName) ? "config" : "comment" } as const)
					: {}),
				...(mutant.statusReason === undefined ? {} : { statusReason: mutant.statusReason }),
			}));
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	}
}

const javascript = /\.[cm]?[jt]sx?$/;
export function inside(root: string, path: string): boolean {
	const distance = relative(root, path);
	return distance !== ".." && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

export function ancestorInstalls(from: string): string[] {
	const paths: string[] = [];
	for (let directory = dirname(from); ; directory = dirname(directory)) {
		paths.push(join(directory, "node_modules"));
		if (dirname(directory) === directory) return paths;
	}
}

async function safeDependencies(module: string, root: string, install: string, tracked: boolean): Promise<boolean> {
	const pending = [module];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const entry = pending.pop()!;
		let manifest = entry.endsWith("package.json") ? entry : join(dirname(entry), "package.json");
		let text: string;
		for (;;) {
			try {
				text = await readFile(manifest, "utf8");
				break;
			} catch (error) {
				if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				const directory = dirname(dirname(manifest));
				if (directory === dirname(manifest)) throw error;
				manifest = join(directory, "package.json");
			}
		}
		manifest = await realpath(manifest);
		if (visited.has(manifest)) continue;
		visited.add(manifest);
		if (inside(root, manifest) && (!inside(install, manifest) || tracked)) return false;
		const metadata = JSON.parse(text) as {
			dependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};
		const require = createRequire(manifest);
		const required = Object.keys(metadata.dependencies ?? {});
		const names = new Set([
			...required,
			...Object.keys(metadata.optionalDependencies ?? {}),
			...Object.keys(metadata.peerDependencies ?? {}),
		]);
		for (const name of names) {
			let found = false;
			for (const directory of require.resolve.paths(name) ?? []) {
				const candidate = join(directory, name, "package.json");
				try {
					pending.push(await realpath(candidate));
					found = true;
					break;
				} catch (error) {
					if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				}
			}
			if (!found && required.includes(name)) return false;
		}
	}
	return true;
}

const sourceExtension = /(?:^|\/)[^/]+\.[^/.]+$/;
const dataExtension =
	/\.(?:md|markdown|txt|rst|adoc|json|yaml|yml|toml|xml|csv|tsv|lock|map|svg|png|jpe?g|gif|webp|ico|pdf|snap|tgz|zip|gz|sum)$/i;

/** Enumerates a resolved revision under one host-selected policy source. */
export class MutationEnumeration {
	readonly #changeset: Changeset;
	readonly #policy: RepositorySource;
	readonly #target?: string;
	private constructor(changeset: Changeset, policy: RepositorySource, target?: string) {
		this.#changeset = changeset;
		this.#policy = policy;
		this.#target = target;
	}

	static async open(
		cwd: string,
		range: string,
		options: { policy?: RepositorySource; target?: string } = {},
	): Promise<MutationEnumeration> {
		const changeset = await Changeset.resolve(cwd, range);
		return new MutationEnumeration(
			changeset,
			options.policy ?? { kind: "revision", commit: changeset.revision.base },
			options.target,
		);
	}

	async list(options: { limit?: number; all?: boolean } = {}): Promise<MutationInventory<MutationInventoryV2>> {
		const limit = options.all ? Number.MAX_SAFE_INTEGER : (options.limit ?? 200);
		if (!Number.isSafeInteger(limit) || limit < 0)
			throw new MutationEnumerationError("limit", "limit must be a non-negative safe integer");
		const { repoRoot, revision } = this.#changeset;
		const targets = MutationTargets.select(
			revision,
			(path) => productionWithExtensions(path, javascript),
			mutationUnmutated,
		);
		const unmutated = targets.unmutated.map(({ path, why }) => ({ file: path, reason: why }));
		const changedPaths = new Set([
			...Object.keys(revision.diffLines()),
			...revision.files
				.filter((file) => file.status !== "deleted" && (file.binary || file.percentEncoded))
				.map((file) => file.path),
		]);
		const unknown = [...changedPaths].filter(
			(path) =>
				productionWithExtensions(path, /.*/) &&
				(sourceExtension.test(path) ||
					revision.files.some((file) => file.path === path && file.newKind === "executable")) &&
				!javascript.test(path) &&
				!dataExtension.test(path),
		);
		if (!targets.judges && unknown.length > 0)
			throw new MutationEnumerationError("unsupported", `no mutation adapter handles ${unknown.join(", ")}`);
		unmutated.push(...unknown.map((file) => ({ file, reason: "no mutation adapter handles this language" })));
		const source = await openSource(repoRoot, { kind: "revision", commit: revision.head });
		const files: MutationFile[] = [];
		for (const [name, ranges] of Object.entries(targets.changed)) {
			const content = await source.readText(name, 16 * 1024 * 1024);
			if (content === undefined)
				throw new MutationEnumerationError("instrumenter", `committed source ${name} is missing`);
			files.push({ name, content, ranges });
		}
		const policy = await openSource(repoRoot, this.#policy);
		const text = await policy.readText("stryker.config.json", 1024 * 1024);
		let excluded: string[] = [];
		if (text !== undefined) {
			try {
				const config = JSON.parse(text);
				excluded = config.mutator?.excludedMutations ?? [];
				if (!Array.isArray(excluded) || excluded.some((name) => typeof name !== "string"))
					throw new Error("excludedMutations must be an array of names");
			} catch (error) {
				throw new MutationEnumerationError("policy", `cannot read mutation policy: ${(error as Error).message}`);
			}
		}
		const adapter = files.length === 0 ? undefined : await TypeScriptMutationAdapter.open(repoRoot);
		const rows = adapter === undefined ? [] : await adapter.enumerate(files, excluded);
		return MutationInventory.create({
			range: {
				base: revision.base,
				head: revision.head,
				...(this.#target === undefined ? {} : { target: this.#target }),
			},
			adapters: adapter === undefined ? [] : [adapter.identity],
			installation: createHash("sha256")
				.update(
					JSON.stringify({
						installation: mutationInstallation(repoRoot),
						platform: process.platform,
						arch: process.arch,
					}),
				)
				.digest("hex"),
			mutants: rows.slice(0, limit),
			total: rows.length,
			omitted: Math.max(0, rows.length - limit),
			unmutated,
		});
	}
}
