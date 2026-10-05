import { existsSync } from "node:fs";
import {
	type Comparison,
	ComparisonError,
	type ExternalFinding,
	type ExternalImporter,
	type Verdict,
	visibleText,
} from "@melian-agent/core";
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

/** Where `melian compare --from` imports from: a pull request's review threads by one login, or a reviewer's file. */
export type ImportSource =
	| { readonly kind: "github"; readonly login: string }
	| { readonly kind: "file"; readonly path: string };

/** Reads a `--from` value: `github`, `github:<login>`, or `file:<path>`. `undefined` for anything else. */
export function parseImportSource(value: string): ImportSource | undefined {
	if (value === "github") return { kind: "github", login: coderabbitLogin };
	if (value.startsWith("github:") && value.length > "github:".length) {
		return { kind: "github", login: value.slice("github:".length) };
	}
	if (value.startsWith("file:") && value.length > "file:".length)
		return { kind: "file", path: value.slice("file:".length) };
	return undefined;
}

// The comparison's storage for the stored review `argument` names, opened only when the review exists: a comparison
// with no review runs nothing.
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

function where(finding: ExternalFinding): string {
	if (finding.file === undefined) return "(no file)";
	const file = visibleText(finding.file);
	if (finding.line === undefined) return `${file} (no line)`;
	const lines =
		finding.endLine === undefined || finding.endLine === finding.line
			? `${finding.line}`
			: `${finding.line}-${finding.endLine}`;
	const note = finding.outdated ? " (outdated)" : finding.revision === "base" ? " (base)" : "";
	return `${file}:${lines}${note}`;
}

function reviewerOf(finding: ExternalFinding): string {
	const { name, login } = finding.reviewer;
	return visibleText(name === "human" && login !== undefined ? login : name);
}

// The counts, then each finding nothing matched, by ID, so a maintainer can match one by hand.
function summary(comparison: Comparison, verdict: Verdict | undefined, skippedBodies?: number): string {
	const groups = comparison.groups();
	const matched = groups.filter((group) => group.external.length > 0 && group.melian.length > 0).length;
	const externalOnly = groups.filter((group) => group.melian.length === 0);
	const melianOnly = groups.filter((group) => group.external.length === 0).flatMap((group) => group.melian);
	const skipped = skippedBodies === undefined ? "" : ` Skipped review bodies: ${skippedBodies}.`;
	const out = [
		`Matched: ${matched}. External only: ${externalOnly.length}. Melian only: ${melianOnly.length}.${skipped}\n`,
	];
	if (externalOnly.length > 0) {
		out.push("External only:\n");
		for (const group of externalOnly) {
			for (const finding of group.external) {
				out.push(`  ${finding.id}  ${reviewerOf(finding)}  ${where(finding)}  ${visibleText(finding.title)}\n`);
			}
		}
	}
	if (melianOnly.length > 0) {
		out.push("Melian only:\n");
		const findings = new Map((verdict?.all() ?? []).map((finding) => [finding.id, finding]));
		for (const id of melianOnly) {
			const finding = findings.get(id);
			if (finding === undefined) {
				out.push(`  ${id}\n`);
				continue;
			}
			const [start, end] = finding.lines();
			const lines = start === end ? `${start}` : `${start}-${end}`;
			out.push(
				`  ${id}  ${finding.properties.severity} ${visibleText(finding.ruleId)}  ${visibleText(finding.properties.path)}:${lines}\n`,
			);
		}
	}
	return out.join("");
}

/**
 * `melian compare`: imports each source's findings, matches them against the stored review of the target's head, records
 * the comparison in the changeset's storage, and prints the counts. Every import runs before anything is written, so a
 * source that fails records nothing.
 */
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
		const skippedBodies = read.reduce((sum, each) => sum + each.imported.skippedBodies, 0);
		io.stdout(summary(comparison, verdict, skippedBodies));
		return 0;
	} finally {
		await harness.close(context);
	}
}

/**
 * `melian compare match` and `melian compare unmatch`: records, as the git author, that an external finding and a
 * Melian finding are one defect, or are not, overriding the match by site.
 */
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
		io.stdout(summary(comparison, verdict));
		return 0;
	} finally {
		await harness.close(context);
	}
}
