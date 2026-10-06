import { existsSync } from "node:fs";
import { ComparisonError, type ExternalImporter, visibleText } from "@melian-agent/core";
import { coderabbitLogin, ReviewThreadImporter } from "@melian-agent/github";
import {
	CompareHarness,
	backgroundContext as context,
	FileImporter,
	type ImportedSource,
	readVerdict,
	revisionKey,
} from "@melian-agent/pipeline";
import { gitAuthor, type Io, StoredReview, shellQuote, short } from "./commands.ts";
import { idleModels, isScripted } from "./models.ts";
import { CliError, openStorage, storagePath } from "./repository.ts";
import { gitHubAccess, parseTarget } from "./target.ts";

export type ImportSource =
	| { readonly kind: "github"; readonly login: string }
	| { readonly kind: "file"; readonly path: string };

export function parseImportSource(value: string): ImportSource | undefined {
	if (value === "github") return { kind: "github", login: coderabbitLogin };
	if (value.startsWith("github:") && value.length > "github:".length) {
		return { kind: "github", login: value.slice("github:".length) };
	}
	if (value.startsWith("file:") && value.length > "file:".length)
		return { kind: "file", path: value.slice("file:".length) };
	return undefined;
}

async function openComparison(io: Io, argument: string) {
	const stored = await StoredReview.open(io, argument);
	const { changeset } = stored;
	const path = await storagePath(changeset.repoRoot, changeset.id, io.env, isScripted(io.env));
	if (!existsSync(path)) throw stored.missing();
	const harness = await CompareHarness.open(await openStorage(path), idleModels(io.env));
	const reviewed = await harness.reviewed(changeset.revision).catch(async (error: unknown) => {
		await harness.close(context);
		throw error;
	});
	if (!reviewed) {
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
		const comparison = await harness.importFindings(revision, read, new Date().toISOString());
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
		const skippedBodies = Object.values(comparison.importsBySource()).reduce(
			(sum, each) => sum + each.skippedBodies,
			0,
		);
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
		const root = (await harness.harness.root(context)).id;
		const verdict = await readVerdict(harness.harness, root, revisionKey(revision), context);
		io.stdout(comparison.render(verdict));
		return 0;
	} finally {
		await harness.close(context);
	}
}
