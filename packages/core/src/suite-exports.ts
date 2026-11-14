import { posix } from "node:path";
import { canonicalPath } from "./findings.ts";
import { SourceError, type SourceReader } from "./source.ts";

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

async function testingExport(source: SourceReader, dir: string): Promise<Answer> {
	const manifest = await readManifest(source, `${dir}/package.json`, `${dir}/package.json`);
	if ("refused" in manifest) return manifest;
	const target = (manifest.value as { exports?: { "./testing"?: { "@melian-agent/source"?: unknown } } } | null)
		?.exports?.["./testing"]?.["@melian-agent/source"];
	if (typeof target !== "string")
		return { refused: `${dir}/package.json maps no ./testing export under @melian-agent/source` };
	const file = posix.join(dir, target);
	return file.startsWith(`${dir}/`)
		? { file }
		: { refused: `${dir}'s ./testing export, ${target}, leaves the package` };
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

async function workspaceFolders(source: SourceReader): Promise<string[] | { refused: string }> {
	const root = await readManifest(source, "package.json", "the root package.json");
	if ("refused" in root) return root;
	const patterns = (root.value as { workspaces?: unknown } | null)?.workspaces;
	if (!Array.isArray(patterns) || !patterns.every((pattern) => typeof pattern === "string"))
		return { refused: "the root package.json lists no workspaces" };
	const folders: string[] = [];
	for (const pattern of patterns) {
		const parent = pattern.endsWith("/*") ? pattern.slice(0, -2) : undefined;
		if (!readable(parent ?? pattern))
			return { refused: `the root package.json's workspace pattern ${pattern} is not one Melian reads` };
		if (parent === undefined) {
			folders.push(pattern);
			continue;
		}
		let entries: Awaited<ReturnType<SourceReader["list"]>>;
		try {
			entries = await source.list(parent);
		} catch (error) {
			return { refused: `cannot read the workspace folder ${parent}: ${cause(error)}` };
		}
		if (entries === undefined) return { refused: `the workspace folder ${parent} does not exist` };
		for (const entry of entries) if (entry.kind === "directory") folders.push(`${parent}/${entry.name}`);
	}
	return folders;
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

	/** Reads the root `package.json`'s `workspaces`, then each workspace package's `exports`, from `source`. */
	static async read(source: SourceReader): Promise<SuiteExports> {
		const folders = await workspaceFolders(source);
		if (!Array.isArray(folders)) return new SuiteExports(new Map(), folders.refused);
		const answers = new Map<string, Answer>();
		for (const folder of folders) answers.set(folder, await testingExport(source, folder));
		return new SuiteExports(answers);
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
