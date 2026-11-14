import { canonicalPath } from "./findings.ts";
import { openSource, SourceError, type SourceReader } from "./source.ts";

const manifestBytes = 1024 * 1024;

type Answer = { file: string } | { refused: string };

function cause(error: unknown): string {
	if (error instanceof SourceError || error instanceof SyntaxError) return error.message;
	throw error;
}

async function readManifest(
	source: SourceReader,
	path: string,
	name: string,
): Promise<{ value: unknown } | { refused: string }> {
	let text: string | undefined;
	try {
		text = await source.readText(path, manifestBytes);
		if (text === undefined) return { refused: `${name} does not exist` };
		return { value: JSON.parse(text) };
	} catch (error) {
		return { refused: `cannot read ${name}: ${cause(error)}` };
	}
}

// A target of "./" and plain segments has one reading, in Node and in git; any other character could read two ways.
function packageFile(target: string): string | undefined {
	const rest = /^\.\/((?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+)$/.exec(target)?.[1];
	return rest?.split("/").every((segment) => ![".", "..", "node_modules"].includes(segment.toLowerCase()))
		? rest
		: undefined;
}

// Node is the authority on what ./testing resolves to. It is not run here, since that needs head-written files on the
// reviewer's disk, so this accepts only a target with one possible reading, the source condition first, and fails closed.
async function testingExport(source: SourceReader, dir: string): Promise<Answer> {
	const manifest = await readManifest(source, `${dir}/package.json`, `${dir}/package.json`);
	if ("refused" in manifest) return manifest;
	const exports = (manifest.value as { exports?: unknown } | null)?.exports;
	const conditions = isRecord(exports) ? exports["./testing"] : undefined;
	const target = isRecord(conditions) ? conditions["@melian-agent/source"] : undefined;
	if (!isRecord(exports) || !isRecord(conditions) || typeof target !== "string")
		return { refused: `${dir}/package.json maps no ./testing export under @melian-agent/source` };
	const odd = Object.keys(exports).find((key) => (key !== "." && !key.startsWith("./")) || key.includes("*"));
	if (odd !== undefined)
		return { refused: `${dir}/package.json's exports hold ${JSON.stringify(odd)}, which Melian does not resolve` };
	const first = Object.keys(conditions)[0];
	if (first !== "@melian-agent/source")
		return {
			refused: `${dir}/package.json lists ${first} before @melian-agent/source under ./testing, and Melian accepts the source condition only as the first key`,
		};
	const file = packageFile(target);
	return file === undefined
		? {
				refused: `${dir}/package.json maps ./testing to ${JSON.stringify(target)}, which is not a plain relative path inside the package`,
			}
		: { file: `${dir}/${file}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A source reads only repository-relative paths it was handed already checked, so a pattern must be one already.
function readable(folder: string): boolean {
	if (/[*?[\]{}!]/.test(folder)) return false;
	try {
		return canonicalPath(folder) === folder;
	} catch {
		return false;
	}
}

// Reads only the folders and manifests that `files` sit beneath, so the inventory, never the head, bounds the reading.
async function workspacePackages(
	source: SourceReader,
	files: readonly string[],
): Promise<Map<string, Answer> | { refused: string }> {
	const holds = (folder: string) => files.some((file) => file.startsWith(`${folder}/`));
	const root = await readManifest(source, "package.json", "the root package.json");
	if ("refused" in root) return root;
	const patterns = (root.value as { workspaces?: unknown } | null)?.workspaces;
	if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string"))
		return { refused: "the root package.json lists no workspaces" };
	const packages = new Map<string, Answer>();
	for (const pattern of patterns) {
		const parent = pattern.endsWith("/*") ? pattern.slice(0, -2) : undefined;
		if (!readable(parent ?? pattern))
			return { refused: `the root package.json's workspace pattern ${pattern} is not one Melian reads` };
		if (parent === undefined) {
			if (holds(pattern)) packages.set(pattern, await testingExport(source, pattern));
			continue;
		}
		if (!holds(parent)) continue;
		let entries: Awaited<ReturnType<SourceReader["list"]>>;
		try {
			entries = await source.list(parent);
		} catch (error) {
			return { refused: `cannot read the workspace folder ${parent}: ${cause(error)}` };
		}
		if (entries === undefined) return { refused: `the workspace folder ${parent} does not exist` };
		for (const entry of entries) {
			const folder = `${parent}/${entry.name}`;
			if (entry.kind === "directory" && holds(folder)) packages.set(folder, await testingExport(source, folder));
		}
	}
	return packages;
}

/**
 * The file each workspace package exports as `./testing` under the `@melian-agent/source` condition, which is where a
 * `suite` claim in a mutation inventory may stand. A package's own `exports` say what other packages import, so this
 * reads them rather than guess from a file's name, and refuses rather than guess when they cannot be read.
 */
export class SuiteExports {
	readonly #folders: ReadonlyMap<string, Answer>;
	readonly #refused: string | undefined;

	private constructor(folders: ReadonlyMap<string, Answer>, refused?: string) {
		this.#folders = folders;
		this.#refused = refused;
	}

	/**
	 * Reads, from `source`, the root `package.json`'s `workspaces`, then the `exports` of each workspace package that one
	 * of `files` sits in, and nothing at all when `files` is empty.
	 */
	static async read(source: SourceReader, files: readonly string[]): Promise<SuiteExports> {
		if (files.length === 0) return new SuiteExports(new Map());
		const packages = await workspacePackages(source, files);
		return "refused" in packages ? new SuiteExports(new Map(), packages.refused) : new SuiteExports(packages);
	}

	/** Reads the exports `files` need at `commit` of the repository at `repoRoot`, never its working copy. */
	static async at(repoRoot: string, commit: string, files: readonly string[]): Promise<SuiteExports> {
		if (files.length === 0) return new SuiteExports(new Map());
		let source: SourceReader;
		try {
			source = await openSource(repoRoot, { kind: "revision", commit });
		} catch (error) {
			return new SuiteExports(new Map(), `cannot read the exports at ${commit}: ${cause(error)}`);
		}
		return SuiteExports.read(source, files);
	}

	/** Why a `suite` claim on a mutant in `file` is refused, or `undefined` when `file` is a package's `./testing` export. */
	refusal(file: string): string | undefined {
		if (this.#refused !== undefined) return this.#refused;
		const folder = [...this.#folders.keys()].find((name) => file.startsWith(`${name}/`));
		if (folder === undefined) return `${file} is in no workspace package`;
		const answer = this.#folders.get(folder)!;
		if ("refused" in answer) return answer.refused;
		return answer.file === file ? undefined : `${file} is not ${folder}'s ./testing export, ${answer.file}`;
	}
}
