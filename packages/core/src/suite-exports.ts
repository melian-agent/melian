import { canonicalPath } from "./findings.ts";
import { git } from "./git.ts";
import { openSource, SourceError, type SourceReader } from "./source.ts";

const manifestBytes = 1024 * 1024;

type Answer = { file: string } | { refused: string };

function cause(error: unknown): string {
	if (error instanceof SourceError || error instanceof SyntaxError) return error.message;
	throw error;
}

function manifestOf(dir: string): string {
	return dir === "" ? "package.json" : `${dir}/package.json`;
}

async function readManifest(source: SourceReader, name: string): Promise<{ value: unknown } | { refused: string }> {
	try {
		const text = await source.readText(name, manifestBytes);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Node is the authority on what ./testing resolves to. It is not run here, since that needs head-written files on the
// reviewer's disk, so this accepts only a target with one possible reading, the source condition first, and fails closed.
async function testingExport(source: SourceReader, dir: string): Promise<Answer> {
	const name = manifestOf(dir);
	const manifest = await readManifest(source, name);
	if ("refused" in manifest) return manifest;
	const exports = (manifest.value as { exports?: unknown } | null)?.exports;
	const conditions = isRecord(exports) ? exports["./testing"] : undefined;
	const target = isRecord(conditions) ? conditions["@melian-agent/source"] : undefined;
	if (!isRecord(exports) || !isRecord(conditions) || typeof target !== "string")
		return { refused: `${name} maps no ./testing export under @melian-agent/source` };
	const odd = Object.keys(exports).find((key) => (key !== "." && !key.startsWith("./")) || key.includes("*"));
	if (odd !== undefined)
		return { refused: `${name}'s exports hold ${JSON.stringify(odd)}, which Melian does not resolve` };
	const first = Object.keys(conditions)[0];
	if (first !== "@melian-agent/source")
		return {
			refused: `${name} lists ${first} before @melian-agent/source under ./testing, and Melian accepts the source condition only as the first key`,
		};
	const file = packageFile(target);
	if (file === undefined)
		return {
			refused: `${name} maps ./testing to ${JSON.stringify(target)}, which is not a plain relative path inside the package`,
		};
	return { file: dir === "" ? file : `${dir}/${file}` };
}

/**
 * Whether each file of a mutation inventory's `suite` rows is the file its package exports as `./testing` under the
 * `@melian-agent/source` condition. A row's package is the nearest directory above its file that holds a
 * `package.json`, so the rows, never what the head writes in a manifest, bound what is read.
 */
export class SuiteExports {
	readonly #refusals: ReadonlyMap<string, string | undefined>;

	private constructor(refusals: ReadonlyMap<string, string | undefined>) {
		this.#refusals = refusals;
	}

	/** Decides each of `files` from `source`, reading one manifest per package and nothing when `files` is empty. */
	static async read(source: SourceReader, files: readonly string[]): Promise<SuiteExports> {
		const kinds = new Map<string, ReturnType<SourceReader["exists"]>>();
		const answers = new Map<string, Promise<Answer>>();
		const refusals = new Map<string, string | undefined>();
		for (const file of files) {
			if (refusals.has(file)) continue;
			let canonical: string | undefined;
			try {
				canonical = canonicalPath(file);
			} catch {}
			if (canonical !== file) {
				refusals.set(file, `${file} is not a path inside the repository`);
				continue;
			}
			const segments = file.split("/");
			let dir: string | undefined;
			for (let depth = segments.length - 1; depth >= 0; depth--) {
				const candidate = segments.slice(0, depth).join("/");
				if (!kinds.has(candidate)) kinds.set(candidate, source.exists(manifestOf(candidate)));
				if ((await kinds.get(candidate)) !== undefined) {
					dir = candidate;
					break;
				}
			}
			if (dir === undefined) {
				refusals.set(file, `no package.json sits above ${file}`);
				continue;
			}
			if (!answers.has(dir)) answers.set(dir, testingExport(source, dir));
			const answer = await answers.get(dir)!;
			refusals.set(
				file,
				"refused" in answer
					? answer.refused
					: answer.file === file
						? undefined
						: `${file} is not ${manifestOf(dir)}'s ./testing export, ${answer.file}`,
			);
		}
		return new SuiteExports(refusals);
	}

	/** Decides `files` at `commit` of the repository holding `directory`, never from its working copy. */
	static async at(directory: string, commit: string, files: readonly string[]): Promise<SuiteExports> {
		if (files.length === 0) return new SuiteExports(new Map());
		const refused = (reason: string) => new SuiteExports(new Map(files.map((file) => [file, reason])));
		const top = await git(directory, ["rev-parse", "--show-toplevel"]).catch((error: Error) => ({
			code: 1,
			stdout: "",
			stderr: error.message,
		}));
		if (top.code !== 0) return refused(`cannot read the exports at ${commit}: ${top.stderr.trim()}`);
		let source: SourceReader;
		try {
			source = await openSource(top.stdout.trim(), { kind: "revision", commit });
		} catch (error) {
			return refused(`cannot read the exports at ${commit}: ${cause(error)}`);
		}
		return SuiteExports.read(source, files);
	}

	/** Why a `suite` claim on a mutant in `file` is refused, or `undefined` when `file` is its package's `./testing` export. */
	refusal(file: string): string | undefined {
		return this.#refusals.has(file)
			? this.#refusals.get(file)
			: `${file} was not checked against any package's exports`;
	}
}
