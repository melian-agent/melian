import {
	type Cause,
	type EvidenceLocation,
	normaliseSnippet,
	type Revision,
	readRevisionFile,
	repositoryPath,
	type StoredRescope,
	searchRevision,
	type Verification,
	visibleText,
} from "@melian-agent/core";
import { EnclosingFunctions, enclosingLimits, type HoldingFunction } from "./enclosing-functions.ts";
import type { ReviewState } from "./lens-tools.ts";
import type { ReportVerdictInput } from "./verification-instructions.ts";

type Proposal = NonNullable<ReportVerdictInput["scope"]>;
type Lines = { file: string; line: number; endLine?: number };

/** The finding a re-scope is proposed for, as its lens sighted it. */
export interface ScopedSighting {
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
	readonly cause: Cause;
	readonly evidence: readonly EvidenceLocation[];
}

// Words every line of code holds, which name nothing a trigger reads.
const keywords = new Set(
	"abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface is let new null number object of private protected public readonly return set static string super switch this throw true try type typeof undefined unknown var void while with yield".split(
		" ",
	),
);
const identifier = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

// A test for `word` standing alone in a text, never inside a longer name.
function naming(word: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}_$])${word.replace(/[$]/g, "\\$")}(?![\\p{L}\\p{N}_$])`, "u");
}

const plainName = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
const specifierList = /^\s*(?:import|export)\s+\{[^{}]*\}\s*(?:from\s*(["'])[^"']*\1)?\s*;?\s*$/;

// Whether a line names `symbol` in a way that could give it another name: anything but a call or a declaration with
// its parameters, or a place in an import or export list that does not rename it.
function aliases(line: string, symbol: string): boolean {
	const listed = specifierList.test(line);
	for (const match of line.matchAll(new RegExp(naming(symbol), "gu"))) {
		const after = line.slice(match.index + symbol.length);
		// A class is declared by its name alone, and its constructor is the function that holds the lines.
		if (/(?:^|[^\p{L}\p{N}_$])class\s+$/u.test(line.slice(0, match.index))) continue;
		if (/^\s*(?:<[^<>()]*>)?\s*\(/.test(after)) continue;
		if (listed && !/^\s+as\b/.test(after)) continue;
		return true;
	}
	return false;
}

function where({ file, line, endLine = line }: Lines): string {
	return `${visibleText(file)}:${line}${endLine === line ? "" : `-${endLine}`}`;
}

/**
 * A verifier's proposal that a finding is `pre-existing`, checked by Melian against the diff, git's rename map, and
 * the compiler: rules (a) to (d) of the decision that lets the verifier set scope. Whatever Melian cannot check is a
 * refusal, and a refused proposal leaves the finding the scope location gave it.
 */
export class ScopeProposal {
	/** Why Melian refuses the proposal, each reason naming its rule. Empty when every check held. */
	readonly refusals: readonly string[];
	readonly #from: StoredRescope["from"] | undefined;

	private constructor(refusals: readonly string[], from?: StoredRescope["from"]) {
		this.refusals = refusals;
		this.#from = from;
	}

	/** The re-scope a verification record stores, with the verifier's `reason`; `undefined` for a refused proposal. */
	accepted(reason: string): StoredRescope | undefined {
		return this.#from === undefined || this.refusals.length > 0 ? undefined : { from: this.#from, reason };
	}

	/** Reads the files the proposal names and runs every check. Throws for a path that is not repository-relative. */
	static async read(
		review: ReviewState,
		revision: Revision,
		sighting: ScopedSighting,
		proposal: Proposal,
		verdict: Verification["verdict"],
	): Promise<ScopeProposal> {
		const refusals: string[] = [];
		const refuse = (rule: string, why: string) => refusals.push(`(${rule}) ${why}`);
		if (verdict === "refuted")
			return new ScopeProposal(["a re-scope rides only on a confirmed or plausible verdict"]);
		if (sighting.cause === "pre-existing")
			return new ScopeProposal(["location already reads the finding pre-existing"]);

		for (const location of sighting.evidence) {
			if (revision.changeOverlap(location)?.kind !== "hunk") continue;
			const at = where({ file: location.file, line: location.startLine, endLine: location.endLine });
			refuse("a", `the finding's ${location.role} evidence at ${at} is on a changed line`);
		}

		const text = async (side: "head" | "base", path: string) => {
			const commit = side === "base" ? review.base : review.head;
			// Whatever stops the read, the lines cannot be checked, and a file cut at the limit holds too few of them.
			const file = await readRevisionFile(review.repoRoot, commit, path, enclosingLimits.fileBytes).catch(
				() => undefined,
			);
			return file === undefined || file.truncated ? undefined : file.content;
		};
		const slice = (content: string | undefined, line: number, endLine: number) => {
			const all = content?.split("\n") ?? [];
			// A file's final newline leaves an empty element that is no line.
			if (all.at(-1) === "") all.pop();
			return endLine < line || endLine > all.length ? undefined : all.slice(line - 1, endLine).join("\n");
		};

		const { failing } = proposal;
		const file = repositoryPath(failing.file);
		const endLine = failing.endLine ?? failing.line;
		const changed = review.files.find((each) => each.path === file);
		// A file the head added has no base file under its path, so its base lines cannot be read.
		const basePath = changed?.oldPath ?? file;
		const headText = await text("head", file);
		const baseText = await text("base", basePath);
		const headLines = slice(headText, failing.line, endLine);
		const baseEnd = failing.baseLine + endLine - failing.line;
		const baseLines = slice(baseText, failing.baseLine, baseEnd);
		if (file !== sighting.path || failing.line > sighting.endLine || endLine < sighting.startLine)
			refuse("b", `the failing lines ${where(failing)} lie outside the finding`);
		if (headLines === undefined) refuse("b", `Melian cannot read ${where(failing)} at the head`);
		else if (baseLines === undefined)
			refuse("b", `Melian cannot read the failing lines at the base, at line ${failing.baseLine} of the base file`);
		else if (baseLines !== headLines) refuse("b", "the failing lines at the base differ from the head's");

		const named = [...(proposal.trigger === undefined ? [] : [proposal.trigger]), ...(proposal.path ?? []), failing];
		if (proposal.trigger === undefined) refuse("c", "the proposal names no trigger");
		for (const location of named) {
			const site = { file: repositoryPath(location.file), startLine: location.line, endLine: location.endLine };
			if (revision.untouched(site) === undefined) refuse("c", `${where(location)} is inside a hunk of the diff`);
		}

		const answers = ["newCaller", "removedGuard", "changedTrigger", "copy"] as const;
		for (const name of answers) {
			const { answer, base } = proposal[name];
			const site = { file: repositoryPath(base.file), startLine: base.line, endLine: base.endLine };
			if (answer) refuse("d", `the verifier answered ${name} true`);
			const shown = slice(await text("base", site.file), base.line, base.endLine ?? base.line);
			if (shown === undefined) refuse("d", `Melian cannot read the base lines ${where(base)} given for ${name}`);
			// Lines the change deleted or edited cannot show that the change left something alone.
			if (revision.changeOverlap({ ...site, revision: "base" })?.kind === "hunk")
				refuse("d", `the change deleted or edited the base lines ${where(base)} given for ${name}`);
		}

		// The failing lines, then the trigger and each location on the path that no hunk touches, each with its base twin.
		const spots = [
			{
				at: failing as Lines,
				file,
				basePath,
				headText,
				baseText,
				baseStart: failing.baseLine,
				baseEnd,
				failing: true,
			},
		];
		for (const location of [
			...(proposal.trigger === undefined ? [] : [proposal.trigger]),
			...(proposal.path ?? []),
		]) {
			const path = repositoryPath(location.file);
			const twin = revision.untouched({ file: path, startLine: location.line, endLine: location.endLine });
			if (twin === undefined) continue;
			spots.push({
				at: location,
				file: path,
				basePath: twin.file,
				headText: await text("head", path),
				baseText: await text("base", twin.file),
				baseStart: twin.startLine,
				baseEnd: twin.endLine,
				failing: false,
			});
		}
		const hunks = review.files.flatMap((each) => each.hunks);
		const readable = spots.filter((spot) => spot.headText !== undefined && spot.baseText !== undefined);
		let functions: (HoldingFunction | undefined)[] = [];
		try {
			functions = EnclosingFunctions.around(
				readable.flatMap((spot) => [
					{
						path: spot.file,
						text: spot.headText!,
						startLine: spot.at.line,
						endLine: spot.at.endLine ?? spot.at.line,
					},
					{ path: spot.basePath, text: spot.baseText!, startLine: spot.baseStart, endLine: spot.baseEnd },
				]),
			);
		} catch {
			// The compiler could not start, which reads as a file it does not read.
		}
		// A hunk that only rewords a comment in a function removes no guard and adds no cause.
		const within = (code: ReadonlySet<number>, start: number, count: number) => {
			for (let line = start; line < start + count; line++) if (code.has(line)) return true;
			return false;
		};
		for (const spot of spots) {
			const index = readable.indexOf(spot);
			const atHead = index === -1 ? undefined : functions[index * 2];
			const atBase = index === -1 ? undefined : functions[index * 2 + 1];
			if (atHead === undefined || atBase === undefined) {
				const what = spot.failing ? "the failing lines" : where(spot.at);
				refuse("d", `Melian cannot find the function that holds ${what} with the compiler`);
				continue;
			}
			// A guard may sit in any function between the trigger and the failure, so each is held to the same check.
			const held = spot.failing ? "the failure" : where(spot.at);
			const own = review.files.find((each) => each.path === spot.file)?.hunks ?? [];
			const deleted = own.find((hunk) => within(atBase.code, hunk.oldStart, hunk.oldLines));
			if (deleted !== undefined)
				refuse("d", `a hunk deletes code at base line ${deleted.oldStart}, inside the function that holds ${held}`);
			const added = own.find((hunk) => within(atHead.code, hunk.newStart, hunk.newLines));
			if (added !== undefined)
				refuse("d", `a hunk adds code at line ${added.newStart}, inside the function that holds ${held}`);
			if (!spot.failing) continue;
			const symbol = atHead.name.endsWith(".constructor")
				? atHead.name.slice(0, -".constructor".length)
				: atHead.name.slice(atHead.name.lastIndexOf(".") + 1);
			// A default export is called by whatever name its importer chose, and a computed name by whatever it evaluates to.
			if (symbol === "default" || !plainName.test(symbol)) {
				refuse(
					"d",
					"the failing function is a default export or has a computed name, so Melian cannot name its callers",
				);
				continue;
			}
			const caller = hunks.find((hunk) => naming(symbol).test(hunk.added));
			if (caller !== undefined)
				refuse("d", `a hunk in ${visibleText(caller.file)} adds a line that names ${visibleText(symbol)}`);
			// A caller may reach the function under another name, which no added line would spell. So every line of the
			// head that names it must call it, declare it, or pass it through an import or export list unrenamed.
			const search = { pattern: symbol, attributesFrom: review.base };
			const named = await searchRevision(review.repoRoot, review.head, search);
			const alias = named.matches.find(
				(match) => !(match.path === spot.file && match.line === atHead.startLine) && aliases(match.text, symbol),
			);
			if (named.truncated)
				refuse("d", `Melian cannot list every line of the head that names ${visibleText(symbol)}`);
			else if (alias !== undefined)
				refuse(
					"d",
					`${visibleText(alias.path)}:${alias.line} names ${visibleText(symbol)} without calling it, so a caller may reach it under another name`,
				);
		}

		const triggerText =
			proposal.trigger === undefined
				? undefined
				: slice(
						await text("head", repositoryPath(proposal.trigger.file)),
						proposal.trigger.line,
						proposal.trigger.endLine ?? proposal.trigger.line,
					);
		if (proposal.trigger !== undefined && triggerText === undefined)
			refuse("c", `Melian cannot read the trigger ${where(proposal.trigger)} at the head`);
		const read = [...new Set(triggerText?.match(identifier) ?? [])].filter((word) => !keywords.has(word));
		const flipped = read.flatMap((word) => {
			const names = naming(word);
			const hunk = hunks.find((each) => names.test(each.changes ?? each.added));
			return hunk === undefined ? [] : [{ word, hunk }];
		})[0];
		if (flipped !== undefined)
			refuse(
				"d",
				`a hunk in ${visibleText(flipped.hunk.file)} changes a line that names ${visibleText(flipped.word)}, which the trigger reads`,
			);

		const twin = normaliseSnippet(headLines ?? "");
		const copied = twin === "" ? undefined : hunks.find((hunk) => normaliseSnippet(hunk.added).includes(twin));
		if (copied !== undefined)
			refuse("d", `a hunk in ${visibleText(copied.file)} adds the failing lines, so the head holds a copy`);

		return new ScopeProposal(refusals, sighting.cause);
	}
}
