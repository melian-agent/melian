import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	type ComparisonEntry,
	ComparisonError,
	ComparisonExport,
	ComparisonSet,
	type ExternalImporter,
	Lens,
	LensError,
	type StoredComparisonAdjudication,
	visibleText,
} from "@melian-agent/core";
import { coderabbitLogin, ReviewThreadImporter } from "@melian-agent/github";
import {
	CompareHarness,
	ComparisonReader,
	backgroundContext as context,
	FileImporter,
	type ImportedSource,
	readVerdict,
	revisionKey,
} from "@melian-agent/pipeline";
import { gitAuthor, type Io, StoredReview, shellQuote, short } from "./commands.ts";
import { idleModels, isScripted } from "./models.ts";
import { CliError, git, openStorage, stateDirectory, storagePath } from "./repository.ts";
import { gitHubAccess, parseTarget } from "./target.ts";

// Where `melian compare --from` imports from: a pull request's review threads by one login, or a reviewer's file.
export type ImportSource =
	| { readonly kind: "github"; readonly login: string }
	| { readonly kind: "file"; readonly path: string };

// Reads a `--from` value: `github`, `github:<login>`, or `file:<path>`; `undefined` for anything else.
export function parseImportSource(value: string): ImportSource | undefined {
	if (value === "github") return { kind: "github", login: coderabbitLogin };
	if (value.startsWith("github:") && value.length > "github:".length) {
		return { kind: "github", login: value.slice("github:".length) };
	}
	if (value.startsWith("file:") && value.length > "file:".length)
		return { kind: "file", path: value.slice("file:".length) };
	return undefined;
}

async function openComparison(io: Io, argument: string, requireReview = true) {
	const stored = await StoredReview.open(io, argument);
	const { changeset } = stored;
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, isScripted(io.env));
	if (!existsSync(path)) throw stored.missing();
	const harness = await CompareHarness.open(await openStorage(path), idleModels(io.env));
	const reviewed = await harness.reviewed(changeset.revision).catch(async (error: unknown) => {
		await harness.close(context);
		throw error;
	});
	if (requireReview && !reviewed) {
		await harness.close(context);
		throw stored.missing();
	}
	return { stored, harness };
}

// Every source is read before anything is written, so a source that fails records nothing.
export async function compare(io: Io, argument: string, sources: readonly ImportSource[]): Promise<number> {
	const target = parseTarget(argument);
	const { stored, harness } = await openComparison(io, argument);
	const { changeset } = stored;
	const { revision } = changeset;
	try {
		const importers: ExternalImporter[] = [];
		for (const source of sources) {
			if (source.kind === "file") {
				importers.push(await FileImporter.open(source.path, { cwd: io.cwd, repoRoot: changeset.repoRoot }));
				continue;
			}
			if (target.kind !== "pullRequest") {
				throw new CliError(`--from github reads a pull request's threads; name it as "#12", not a range`);
			}
			const access = await gitHubAccess(io.cwd, io.env);
			importers.push(ReviewThreadImporter.open({ ...access, pullRequest: target.number, login: source.login }));
		}
		const read: ImportedSource[] = [];
		for (const importer of importers) {
			const imported = await importer.import();
			if (imported.head !== undefined && imported.head !== revision.head) {
				throw new CliError(
					`pull request ${argument} is at ${short(imported.head)} now, and Melian's review is of ${short(revision.head)}; run melian review ${shellQuote(argument)} first`,
				);
			}
			read.push({ source: importer.source, imported });
		}
		const comparison = await harness.importFindings(
			{ ...revision, target: argument },
			read,
			new Date().toISOString(),
		);
		for (const { source, imported } of read) {
			const bodies = imported.skippedBodies === 1 ? "1 review body" : `${imported.skippedBodies} review bodies`;
			const skipped = imported.skippedBodies > 0 ? `, skipping ${bodies} without a thread` : "";
			const stored = comparison.importsBySource()[source]?.ids.length ?? 0;
			io.stdout(`Imported ${stored} from ${visibleText(source)}${skipped}.\n`);
		}
		const root = (await harness.harness.root(context)).id;
		const verdict = await readVerdict(harness.harness, root, revisionKey(revision), context);
		const external = comparison.externalFindings().length;
		const melian = comparison.melianFindings().length;
		io.stdout(
			`Compared ${external} external ${external === 1 ? "finding" : "findings"} with Melian's ${melian} at ${short(revision.head)}.\n`,
		);
		const skippedBodies = read.reduce((sum, each) => sum + each.imported.skippedBodies, 0);
		io.stdout(comparison.render(verdict, skippedBodies));
		return 0;
	} finally {
		await harness.close(context);
	}
}

export async function matchByHand(
	io: Io,
	argument: string,
	pair: { readonly external: string; readonly melian: string },
	matched: boolean,
): Promise<number> {
	const { stored, harness } = await openComparison(io, argument);
	const { revision, repoRoot } = stored.changeset;
	try {
		const hand = { by: await gitAuthor(repoRoot, "matched a finding by hand"), at: new Date().toISOString() };
		const comparison = await (matched
			? harness.match(revision, pair, hand)
			: harness.unmatch(revision, pair, hand)
		).catch((error: unknown) => {
			if (!(error instanceof ComparisonError)) throw error;
			throw new CliError(`${error.message}; melian compare ${shellQuote(argument)} lists the findings`);
		});
		io.stdout(
			`${matched ? "Matched" : "Unmatched"} ${pair.external} ${matched ? "with" : "from"} ${pair.melian} as ${visibleText(hand.by)}.\n`,
		);
		if (!matched && comparison.needsReason(pair.external))
			io.stdout(`Finding ${pair.external} is pending until re-adjudicated with a miss reason.\n`);
		const root = (await harness.harness.root(context)).id;
		const verdict = await readVerdict(harness.harness, root, revisionKey(revision), context);
		io.stdout(comparison.render(verdict));
		return 0;
	} finally {
		await harness.close(context);
	}
}

export async function adjudicateComparison(
	io: Io,
	argument: string,
	id: string,
	fields: Omit<StoredComparisonAdjudication, "by" | "at">,
): Promise<number> {
	const { stored, harness } = await openComparison(io, argument, false);
	try {
		if (fields.golden !== undefined && fields.golden !== "none") {
			try {
				const lenses = await Lens.load(stored.changeset.repoRoot, { kind: "worktree" }, []);
				if (!lenses.some((lens) => lens.name === fields.golden))
					io.stdout(
						`Warning: Melian knows no lens ${visibleText(fields.golden)}; golden debt will still target it.\n`,
					);
			} catch (error) {
				if (!(error instanceof LensError)) throw error;
				io.stdout(`Warning: could not read lenses: ${visibleText(error.message)}\n`);
			}
		}
		const by = await gitAuthor(stored.changeset.repoRoot, "adjudicated a comparison finding");
		const comparison = await harness.adjudicate({ ...stored.changeset.revision, target: argument }, id, {
			...fields,
			by,
			at: new Date().toISOString(),
		});
		io.stdout(`Adjudicated ${id} as ${fields.verdict} by ${visibleText(by)}.\n`);
		if (fields.verdict === "noise") {
			if (comparison.melianFindings().includes(id))
				io.stdout("This does not dismiss the Melian finding; melian dismiss records a dismissal.\n");
		}
		return 0;
	} finally {
		await harness.close(context);
	}
}

class StoredComparisons {
	readonly comparisons: ComparisonSet;

	private constructor(comparisons: ComparisonSet) {
		this.comparisons = comparisons;
	}

	static async read(io: Io): Promise<StoredComparisons> {
		const repoRoot = await git(io.cwd, ["rev-parse", "--show-toplevel"]);
		const directory = join(await stateDirectory(repoRoot, io.env), ...(isScripted(io.env) ? ["scripted"] : []));
		const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return [];
			throw new CliError(`cannot read comparisons at ${directory}: ${error.message}`);
		});
		const entries: ComparisonEntry[] = [];
		for (const name of names.filter((name) => /^(range|pull)-[0-9a-f]{16}\.sqlite$/.test(name)).sort()) {
			const storage = await openStorage(join(directory, name));
			try {
				entries.push(...(await new ComparisonReader(storage).read(name.slice(0, -".sqlite".length))));
			} finally {
				await storage.close(context);
			}
		}
		return new StoredComparisons(new ComparisonSet(entries));
	}
}

export async function comparisonStats(
	io: Io,
	options: { readonly since?: string; readonly last?: number },
): Promise<number> {
	const { comparisons } = await StoredComparisons.read(io);
	io.stdout(comparisons.renderStats(options));
	return 0;
}

export async function comparisonBacklog(io: Io, markdown: boolean): Promise<number> {
	const { comparisons } = await StoredComparisons.read(io);
	io.stdout(comparisons.renderBacklog(markdown));
	return 0;
}

export async function exportComparison(
	io: Io,
	argument: string,
	options: { readonly out?: string; readonly json: boolean },
): Promise<number> {
	const stored = await StoredReview.open(io, argument);
	const path = await storagePath(stored.changeset.repoRoot, stored.changeset.id, io.env, isScripted(io.env));
	if (!existsSync(path))
		throw new CliError(`no comparison recorded; run melian compare ${shellQuote(argument)} first`);
	const storage = await openStorage(path);
	try {
		const entries = await new ComparisonReader(storage).read(stored.changeset.id);
		if (entries.length === 0)
			throw new CliError(`no comparison recorded; run melian compare ${shellQuote(argument)} first`);
		const remote = await git(stored.changeset.repoRoot, ["remote", "get-url", "origin"]).catch(() => "");
		const repository =
			/^(?:git@github\.com:|https:\/\/github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
				remote,
			)?.[1];
		const url =
			repository !== undefined && /^#\d+$/.test(argument)
				? `https://github.com/${repository}/pull/${argument.slice(1)}`
				: undefined;
		const record = new ComparisonExport(entries, argument, url);
		const output = options.json ? record.renderJson() : record.render();
		if (options.out === undefined) io.stdout(output);
		else {
			const path = resolve(io.cwd, options.out);
			await writeFile(path, output, "utf8");
			io.stdout(`Exported comparison to ${visibleText(path)}.\n`);
		}
		return 0;
	} finally {
		await storage.close(context);
	}
}
