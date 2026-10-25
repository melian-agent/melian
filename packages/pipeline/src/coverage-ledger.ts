import { createHash } from "node:crypto";
import {
	type ChangedFile,
	type Changeset,
	type CheckRecord,
	type CoverageLeave,
	CoverageRecord,
	type CoverageSummary,
	coverageCheck,
	coverageProducer,
	type Finding,
	HeadMove,
	injectionAttemptRuleId,
	type LineRanges,
	type LinesByPath,
	type MelianConfig,
	type RepositorySource,
	Revision,
	rangesOf,
	type ScrutinyLevel,
	type StoredCheckCoverage,
	type StoredCoverageLines,
	type StoredCoverageRecord,
	type StoredCoverageSegment,
	type StoredCoverageVoid,
	subtractRanges,
	type TriageChoice,
	type UnitField,
	unionRanges,
} from "@melian-agent/core";
import { readFindings } from "./findings.ts";
import { type Context, type ConversationId, defineDoc, type Harness, type Tx } from "./harness.ts";
import { ReviewTranscript } from "./review-coverage.ts";
import { RoundsDocument, RoundWriter } from "./rounds.ts";

/** Each decided round's coverage record, keyed by the round's ID in the changeset's storage. */
export type CoverageState = { records: Record<string, StoredCoverageRecord> };

export const CoverageDocument = defineDoc<CoverageState>({
	kind: "melian.coverage",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ records: {} }),
});

/** The Melian build that writes a coverage record, for diagnosis; it voids nothing. `test/coverage-ledger.test.ts` keeps it in step. */
export const melianVersion = "0.0.0";

/** What a lens's prompt delivered, as the lens task's input records it. */
export interface LensDelivery {
	readonly hunks: Readonly<Record<string, readonly number[]>>;
	readonly fields: Readonly<Record<string, readonly UnitField[]>>;
	readonly omitted: readonly string[];
}

/** One lens a round selected, as the ledger reads it: the run that stood for it, its record, and what it reached. */
export interface LedgerLens {
	readonly name: string;
	readonly version: string;
	// The paths the lens covers, a renamed file's under both of its paths.
	readonly covers: readonly string[];
	// The required level at each covered path, the band's floor there.
	readonly required: Readonly<Record<string, TriageChoice>>;
	readonly record?: CheckRecord;
	readonly level?: ScrutinyLevel;
	readonly delivered?: LensDelivery;
	readonly conversation?: ConversationId;
	readonly standards?: readonly string[];
}

/** Everything a decided round tells the ledger about itself. */
export interface LedgerRound {
	readonly changeset: Changeset;
	readonly config: MelianConfig;
	readonly tier: string;
	readonly policy?: RepositorySource;
	readonly leave: CoverageLeave;
	// Why the round may record no coverage, such as a fork's head.
	readonly refused?: string;
	readonly lenses: readonly LedgerLens[];
	// Every record of a check that is not a lens, the verifier's included.
	readonly checks: readonly CheckRecord[];
	readonly manifest: readonly string[];
	readonly allowSkip: readonly string[];
	readonly nonce: string;
	readonly findings: readonly Finding[];
	// A `--cold` round, which carries nothing from earlier rounds.
	readonly cold?: boolean;
	// Every tool pin, which the policy fingerprint holds.
	readonly tools: unknown;
}

const standardsNames = new Set(["agents.md", "claude.md"]);

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.filter((key) => (value as Record<string, unknown>)[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

function emptyLines(): StoredCoverageLines {
	return { head: {}, base: {}, units: {} };
}

function addLines(into: LinesByPath, path: string, ranges: LineRanges): void {
	if (ranges.length === 0) return;
	into[path] = unionRanges(into[path] ?? [], ranges);
}

function count(lines: LinesByPath): number {
	return Object.values(lines).reduce((sum, ranges) => sum + ranges.reduce((all, [a, b]) => all + b - a + 1, 0), 0);
}

// The lines a hunk index set covers in `file`, on each side.
function hunkLines(file: ChangedFile, indexes: readonly number[]): { head: LineRanges; base: LineRanges } {
	const hunks = file.hunks.filter((hunk) => indexes.includes(hunk.index));
	return {
		head: unionRanges(
			hunks.filter((hunk) => hunk.newLines > 0).map((hunk) => [hunk.newStart, hunk.newStart + hunk.newLines - 1]),
			[],
		),
		base: unionRanges(
			hunks.filter((hunk) => hunk.oldLines > 0).map((hunk) => [hunk.oldStart, hunk.oldStart + hunk.oldLines - 1]),
			[],
		),
	};
}

/**
 * The coverage ledger of one changeset's storage: it writes a decided round's record, carrying the last decided
 * round's coverage across the voids, and reads a round's record back.
 */
export class CoverageLedger {
	readonly harness: Harness;
	readonly root: ConversationId;

	constructor(harness: Harness, root: ConversationId) {
		this.harness = harness;
		this.root = root;
	}

	/**
	 * What the round about to run finds at intake: the last decided round's coverage carried to this head, and what
	 * each selected lens has left to cover. Read before any lens runs, so the delta is fixed in the round's input.
	 */
	async intake(round: LedgerRound, context: Context): Promise<CoverageIntake> {
		const record = await this.compute(round, context);
		return new CoverageIntake(record, await this.#prior(context));
	}

	/**
	 * The coverage record of the round `round` describes, before it has a round ID: what each check must cover at the
	 * head, what the round's own runs delivered, and what carries from the last decided round, by mint order.
	 */
	async compute(round: LedgerRound, context: Context): Promise<StoredCoverageRecord> {
		return this.#record("", round, await this.#prior(context), context);
	}

	/**
	 * Writes `record` as the coverage record of the round the adjudication task `adjudication` decided, once: a repeat
	 * review that attaches to the round keeps the first record. Returns the round's ID, or `undefined` when no round
	 * holds the task.
	 */
	async write(record: StoredCoverageRecord, adjudication: number, context: Context): Promise<string | undefined> {
		const rounds =
			(await this.harness.snapshot(RoundsDocument, this.root, context)) ?? RoundsDocument.definition.initial();
		const own = Object.entries(rounds.items).find(([, each]) => each.tasks.includes(adjudication));
		if (own === undefined) return undefined;
		const [id] = own;
		const root = await this.harness.root(context);
		await root.commit(async (tx: Tx) => {
			const document = await tx.doc(CoverageDocument, this.root);
			if (document.records[id] !== undefined) return;
			document.records[id] = { ...structuredClone(record), round: id };
			await new RoundWriter(tx, this.root).cover(adjudication);
		}, context);
		return id;
	}

	/** The coverage record of round `id`, a local round ID such as `r2`, or `undefined` when it wrote none. */
	async read(id: string, context: Context): Promise<CoverageRecord | undefined> {
		const stored = (await this.harness.snapshot(CoverageDocument, this.root, context))?.records[id];
		return stored === undefined ? undefined : CoverageRecord.from(stored);
	}

	/**
	 * The `Coverage` section for the current round at `revision`, a {@link Revision.key}: its summary for JSON and its
	 * text for a terminal. A round that wrote no record covers nothing, and says so.
	 */
	async section(revision: string, context: Context): Promise<{ summary: CoverageSummary; text: string }> {
		const id = (await this.harness.snapshot(RoundsDocument, this.root, context))?.current[revision];
		const record = id === undefined ? undefined : await this.read(id, context);
		if (record !== undefined) return { summary: record.summary(), text: record.render() };
		const reason = `${id ?? "this review"} recorded no coverage, so it covers nothing`;
		return {
			summary: { complete: false, rounds: [], gaps: [{ check: coverageCheck, file: "", lines: [], reason }] },
			text: `Coverage: incomplete.\n  ${coverageCheck}: ${reason}\n`,
		};
	}

	// The last decided round by mint order that wrote a record. A round that is still running has no verdict, so a round
	// about to run never reads itself, and an earlier round decided after a later one does not stand.
	async #prior(context: Context): Promise<StoredCoverageRecord | undefined> {
		const rounds = (await this.harness.snapshot(RoundsDocument, this.root, context))?.items ?? {};
		const records = (await this.harness.snapshot(CoverageDocument, this.root, context))?.records ?? {};
		const order = (key: string) => Number(key.slice(1));
		const minted = Object.entries(rounds)
			.filter(([, each]) => each.mintedAt !== undefined)
			.sort(
				([a, left], [b, right]) => Date.parse(left.mintedAt!) - Date.parse(right.mintedAt!) || order(a) - order(b),
			);
		const decided = minted.filter(([key, each]) => each.verdict !== undefined && records[key] !== undefined).at(-1);
		return decided === undefined ? undefined : records[decided[0]];
	}

	async #record(
		id: string,
		round: LedgerRound,
		prior: StoredCoverageRecord | undefined,
		context: Context,
	): Promise<StoredCoverageRecord> {
		const { revision } = round.changeset;
		const changed = revision.changedLines();
		const units = revision.fileUnits();
		const policy = createHash("sha256")
			.update(canonical({ config: round.config, source: round.policy ?? null, tools: round.tools }))
			.digest("hex")
			.slice(0, 16);
		const injected = [
			...new Set(
				round.findings
					.filter((finding) => finding.ruleId === injectionAttemptRuleId)
					.map((finding) => finding.properties.path),
			),
		].sort();
		const checks: Record<string, StoredCheckCoverage> = {};
		const allNeeds: StoredCoverageLines = {
			head: structuredClone(changed.head),
			base: structuredClone(changed.base),
			units: Object.fromEntries(units.map((unit) => [unit.path, [...unit.fields]])),
		};
		for (const lens of round.lenses) {
			const needs = emptyLines();
			const required: Record<string, TriageChoice> = {};
			for (const file of revision.files) {
				if (!lens.covers.includes(file.path) && !(file.oldPath !== undefined && lens.covers.includes(file.oldPath)))
					continue;
				const basePath = file.oldPath ?? file.path;
				const headLevel = lens.required[file.path] ?? lens.required[basePath] ?? "careful";
				const baseLevel = lens.required[basePath] ?? headLevel;
				if (headLevel !== "skip") {
					required[file.path] = headLevel;
					addLines(needs.head, file.path, changed.head[file.path] ?? []);
					const unit = units.find((each) => each.path === file.path);
					if (unit !== undefined) needs.units[file.path] = [...unit.fields];
				}
				if (baseLevel !== "skip") {
					required[basePath] = baseLevel;
					addLines(needs.base, basePath, changed.base[basePath] ?? []);
				}
			}
			const status = lens.record?.status ?? "absent";
			const leave = status === "skipped" && round.allowSkip.includes(`lens.${lens.name}`);
			const covered: StoredCoverageSegment[] = [];
			const omitted = emptyLines();
			if (status === "ran" && lens.level !== undefined) {
				const own = await this.#delivered(round, lens, context);
				covered.push({ level: lens.level, ...own });
			}
			for (const path of lens.delivered?.omitted ?? []) {
				const file = revision.files.find((each) => each.path === path);
				if (file === undefined) continue;
				const rendered = lens.delivered?.hunks[path] ?? [];
				const lines = hunkLines(
					file,
					file.hunks.filter((hunk) => !rendered.includes(hunk.index)).map((hunk) => hunk.index),
				);
				addLines(omitted.head, file.path, lines.head);
				addLines(omitted.base, file.oldPath ?? file.path, lines.base);
			}
			checks[`lens.${lens.name}`] = {
				kind: "lens",
				version: lens.version,
				...(lens.standards === undefined ? {} : { standards: [...lens.standards] }),
				status,
				...(leave ? { leave: true } : {}),
				...(lens.record?.reason === undefined ? {} : { reason: lens.record.reason }),
				required,
				needs,
				covered,
				...(count(omitted.head) + count(omitted.base) > 0 ? { omitted } : {}),
				...(injected.length > 0 ? { injected } : {}),
			};
		}
		for (const record of round.checks) {
			if (record.name.startsWith("lens.") || !round.manifest.includes(record.name)) continue;
			const leave = record.status === "skipped" && round.allowSkip.includes(record.name);
			checks[record.name] = {
				kind: "range",
				status: record.status,
				...(leave ? { leave: true } : {}),
				...(record.reason === undefined ? {} : { reason: record.reason }),
				required: {},
				needs: structuredClone(allNeeds),
				covered: record.status === "ran" || leave ? [structuredClone(allNeeds)] : [],
			};
		}
		const { voids, carried } =
			round.cold === true
				? { voids: [{ reason: "a cold round reviews the whole diff from nothing" }], carried: {} }
				: await this.#carry(round, prior, policy, checks, context);
		for (const [check, segments] of Object.entries(carried)) checks[check]?.covered.push(...segments);
		return {
			producer: { ...coverageProducer },
			round: id,
			base: revision.base,
			head: revision.head,
			tier: round.tier,
			policy,
			source: round.policy?.kind ?? "unknown",
			melian: melianVersion,
			leave: round.leave,
			...(round.refused === undefined ? {} : { refused: round.refused }),
			...(prior === undefined ? {} : { carriedFrom: prior.round }),
			voids,
			units: Object.fromEntries(units.map((unit) => [unit.path, unit.kind])),
			checks,
		};
	}

	// What a lens's own run delivered: the hunks its prompt rendered, the file fields its blocks named, and the lines its
	// reads returned, at the head or the base.
	async #delivered(round: LedgerRound, lens: LedgerLens, context: Context): Promise<StoredCoverageLines> {
		const { revision } = round.changeset;
		const lines = emptyLines();
		for (const [path, indexes] of Object.entries(lens.delivered?.hunks ?? {})) {
			const file = revision.files.find((each) => each.path === path);
			if (file === undefined) continue;
			const rendered = hunkLines(file, indexes);
			addLines(lines.head, file.path, rendered.head);
			addLines(lines.base, file.oldPath ?? file.path, rendered.base);
		}
		for (const [path, fields] of Object.entries(lens.delivered?.fields ?? {})) lines.units[path] = [...fields];
		if (lens.conversation !== undefined) {
			const conversation = await this.harness.conversation(lens.conversation, context);
			if (conversation !== undefined) {
				const transcript = await ReviewTranscript.read(
					conversation,
					context,
					lens.name,
					revision.paths(),
					round.nonce,
				);
				const changed = revision.changedLines();
				for (const read of transcript.reads()) {
					const side = read.revision === "base" ? "base" : "head";
					const wanted = changed[side][read.path];
					if (wanted === undefined) continue;
					const got = rangesOf(read.lines);
					addLines(lines[side], read.path, subtractRanges(wanted, subtractRanges(wanted, got)));
				}
			}
		}
		return lines;
	}

	// The last decided round's lens coverage, mapped to this head, less what the voids take.
	async #carry(
		round: LedgerRound,
		prior: StoredCoverageRecord | undefined,
		policy: string,
		checks: Record<string, StoredCheckCoverage>,
		context: Context,
	): Promise<{ voids: StoredCoverageVoid[]; carried: Record<string, StoredCoverageSegment[]> }> {
		if (prior === undefined) return { voids: [], carried: {} };
		const { revision, repoRoot } = round.changeset;
		const since = prior.round;
		const all = (reason: string) => ({ voids: [{ reason }], carried: {} });
		if (prior.producer.name !== coverageProducer.name || prior.producer.algorithm !== coverageProducer.algorithm)
			return all(
				`${since} was recorded by coverage algorithm ${prior.producer.algorithm}, so nothing carries from it`,
			);
		if (prior.refused !== undefined) return all(`${since} recorded no coverage: ${prior.refused}`);
		if (prior.base !== revision.base) return all(`the base changed since ${since}`);
		if (prior.tier !== round.tier) return all(`the tier changed since ${since}`);
		if (prior.policy !== policy) return all(`the policy changed since ${since}`);
		const move = await HeadMove.read(repoRoot, prior.head, revision.head);
		if (move.kind !== "moved") return all(move.reason(since));
		const map = move.revision!;
		const voids: StoredCoverageVoid[] = [];
		const stored = map.policyFiles.filter((path) => !standardsNames.has(path.split("/").at(-1)!.toLowerCase()));
		if (stored.length > 0) return all(`${stored[0]} changed since ${since}`);
		const delta = count(map.changedLines().head) + count(map.changedLines().base);
		const whole = count(revision.changedLines().head) + count(revision.changedLines().base);
		const bound = round.config.review.delta.maxLines;
		if (delta > bound) return all(`${delta} lines changed since ${since}, past the bound of ${bound}`);
		if (delta * 2 > whole) return all(`${delta} lines changed since ${since}, over half the diff's ${whole}`);
		const changedPaths = map.paths();
		const carried: Record<string, StoredCoverageSegment[]> = {};
		for (const [check, coverage] of Object.entries(prior.checks)) {
			if (coverage.kind !== "lens") continue;
			const lens = check.slice("lens.".length);
			const now = checks[check];
			if (now === undefined) continue;
			if (now.version !== coverage.version) {
				voids.push({ reason: `${check} changed version since ${since}`, lens });
				continue;
			}
			const standards = coverage.standards;
			const standard = changedPaths.find((path) =>
				standards === undefined || standards.length === 0
					? standardsNames.has(path.split("/").at(-1)!.toLowerCase())
					: standards.includes(path),
			);
			if (standard !== undefined) {
				voids.push({ reason: `${standard} changed since ${since}, a standard ${check} reads`, lens });
				continue;
			}
			// A file an injection attempt sat in was covered by no lens there, so nothing of it carries.
			const injected = new Set(coverage.injected ?? []);
			carried[check] = coverage.covered
				.filter((segment) => segment.level !== undefined)
				.map((segment) => this.#mapped(segment, since, map, injected));
		}
		// Every finding the prior round sighted must be sighted at this head, or dismissed, for its lines to stay covered.
		const sighted = new Set(round.findings.map((finding) => finding.id));
		const before = await readFindings(this.harness, this.root, Revision.key(prior), context);
		const unsettled = before.filter(
			(finding) => finding.properties.status !== "dismissed" && !sighted.has(finding.id),
		);
		const lost = emptyLines();
		for (const finding of unsettled) {
			const [first, last] = finding.lines();
			const locations = [
				{ file: finding.properties.path, startLine: first, endLine: last, revision: "head" },
				...finding.claims().flatMap((claim) => claim.evidence ?? []),
			];
			for (const location of locations) {
				const end = location.endLine ?? location.startLine;
				if (location.revision === "base") {
					addLines(lost.base, location.file, [[location.startLine, end]]);
					continue;
				}
				const moved: Record<string, number[]> = {};
				for (let line = location.startLine; line <= end; line++) {
					const to = map.mapLine(location.file, line);
					if (to === undefined) continue;
					moved[to.path] = [...(moved[to.path] ?? []), to.line];
				}
				for (const [path, lines] of Object.entries(moved)) addLines(lost.head, path, rangesOf(lines));
			}
		}
		const files = [...new Set([...Object.keys(lost.head), ...Object.keys(lost.base)])].sort();
		if (files.length > 0) {
			voids.push({ reason: `a finding ${since} raised has no sighting at this head`, files });
			for (const segments of Object.values(carried))
				for (const segment of segments)
					for (const side of ["head", "base"] as const)
						for (const [path, lines] of Object.entries(lost[side]))
							if (segment[side][path] !== undefined)
								segment[side][path] = subtractRanges(segment[side][path]!, lines);
		}
		return { voids, carried };
	}

	// A segment of the prior round's record in this head's coordinates: added lines moved by the hunks between the two
	// heads, removed lines as they were, since the base is the same, and file units the move left alone.
	#mapped(
		segment: StoredCoverageSegment,
		since: string,
		map: Revision,
		injected: ReadonlySet<string>,
	): StoredCoverageSegment {
		const head: LinesByPath = {};
		for (const [path, ranges] of Object.entries(segment.head)) {
			if (injected.has(path)) continue;
			const moved: Record<string, number[]> = {};
			for (const [first, last] of ranges)
				for (let line = first; line <= last; line++) {
					const to = map.mapLine(path, line);
					if (to === undefined) continue;
					moved[to.path] = [...(moved[to.path] ?? []), to.line];
				}
			for (const [to, lines] of Object.entries(moved)) addLines(head, to, rangesOf(lines));
		}
		const units = Object.fromEntries(
			Object.entries(segment.units).filter(([path]) => !map.lists(path) && !injected.has(path)),
		);
		const base = Object.fromEntries(Object.entries(segment.base).filter(([path]) => !injected.has(path)));
		return {
			round: segment.round ?? since,
			...(segment.level === undefined ? {} : { level: segment.level }),
			head,
			base: structuredClone(segment.base),
			units,
		};
	}
}

/**
 * A round's intake: the coverage record it would hold before any lens runs, which says what each lens has left to
 * cover, and the last decided round it carried from.
 */
export class CoverageIntake {
	readonly record: CoverageRecord;
	readonly prior?: StoredCoverageRecord;

	constructor(record: StoredCoverageRecord, prior: StoredCoverageRecord | undefined) {
		this.record = CoverageRecord.from(record);
		if (prior !== undefined) this.prior = prior;
	}

	/** Whether any earlier coverage carried, so the round reviews a delta rather than the whole diff. */
	carries(): boolean {
		return Object.values(this.record.stored.checks).some(
			(check) => check.kind === "lens" && check.covered.some((segment) => segment.round !== undefined),
		);
	}

	/** What lens `name` has left to cover at this head: its gaps' lines on each side and its file units' missing fields. */
	delta(name: string): StoredCoverageLines {
		const delta = emptyLines();
		for (const gap of this.record.gaps()) {
			if (gap.check !== `lens.${name}`) continue;
			if (gap.fields !== undefined) delta.units[gap.file] = [...gap.fields];
			else addLines(gap.revision === "base" ? delta.base : delta.head, gap.file, gap.lines);
		}
		return delta;
	}

	/** Whether lens `name` has nothing left to cover. */
	empty(name: string): boolean {
		const delta = this.delta(name);
		return count(delta.head) + count(delta.base) + Object.keys(delta.units).length === 0;
	}

	/** The level lens `name` ran at in the round this one carried from, when that round's own run covered anything. */
	level(name: string): ScrutinyLevel | undefined {
		return this.prior?.checks[`lens.${name}`]?.covered.find((segment) => segment.round === undefined)?.level;
	}
}
