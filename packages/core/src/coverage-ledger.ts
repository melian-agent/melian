import type { CheckRecord, CheckStatus } from "./adjudication.ts";
import { coverageCheck } from "./config.ts";
import {
	countRanges,
	type LineRanges,
	type LinesByPath,
	subtractRanges,
	type UnitField,
	type UnitKind,
	unionRanges,
	unitFields,
} from "./coverage-units.ts";
import type { ScrutinyLevel } from "./lens.ts";
import { visibleText } from "./render.ts";
import { type TriageChoice, triageChoices } from "./triage.ts";

/**
 * The coverage producer this build writes as: its name and the version of its mapping and delivery rules. A record
 * another algorithm wrote is void for the coverage it carries, since its rules may count what these do not.
 */
export const coverageProducer = { name: "melian.coverage", algorithm: 1 } as const;

/** Whose leave a round ran the head's code under: a writer's pushed head, the reviewer's `--trust-head`, or none. */
export type CoverageLeave = "writer" | "reviewer" | "none";

/**
 * Changed lines and file units, the shape both a check's needs and a segment of its coverage take: added lines by
 * head path, removed lines by base path, and file units by path with the fields that apply or were delivered.
 */
export type StoredCoverageLines = {
	head: LinesByPath;
	base: LinesByPath;
	units: Record<string, UnitField[]>;
};

/** What one round covered for one check, in the coordinates of the head the record is at. */
export type StoredCoverageSegment = StoredCoverageLines & {
	// The round that delivered it, which a carried segment keeps across heads; absent for the record's own round.
	round?: string;
	// The level a lens ran at; a whole-range check has none.
	level?: ScrutinyLevel;
};

/** Why coverage did not carry from the last decided round: for every check, for one lens, or for some files. */
export type StoredCoverageVoid = {
	reason: string;
	lens?: string;
	files?: string[];
};

/** One check's coverage at the record's head: what it must cover there, and what rounds covered. */
export type StoredCheckCoverage = {
	kind: "lens" | "range";
	// A lens's version and the standards paths its run recorded; absent paths mean none were recorded.
	version?: string;
	standards?: string[];
	// The check's record in this round, `absent` when the round recorded none.
	status: CheckStatus | "absent";
	// A skip the review allowed, such as a lens triage skipped as its floor allows.
	leave?: boolean;
	reason?: string;
	// A lens's required level by path, the band's floor there.
	required: Record<string, TriageChoice>;
	needs: StoredCoverageLines;
	covered: StoredCoverageSegment[];
	// Lines the prompt's size limit left out this round, owed until a read delivers them.
	omitted?: StoredCoverageLines;
	// The paths a `melian/injection-attempt` finding sits in at this head, which no lens covers until a round rereads them.
	injected?: string[];
};

/** One round's ledger record, as the `melian.coverage` document stores it under the round's ID. */
export type StoredCoverageRecord = {
	producer: { name: string; algorithm: number };
	round: string;
	base: string;
	head: string;
	tier: string;
	policy: string;
	source: "revision" | "worktree" | "unknown";
	melian: string;
	leave: CoverageLeave;
	// Why the record covers nothing, such as a fork's head.
	refused?: string;
	// The last decided round whose coverage this record carried, after the voids.
	carriedFrom?: string;
	voids: StoredCoverageVoid[];
	// Each file unit at the record's head by path, with what makes it one.
	units: Record<string, UnitKind>;
	checks: Record<string, StoredCheckCoverage>;
};

/** One stretch of what a check has not covered, with why. */
export interface LedgerGap {
	readonly check: string;
	readonly file: string;
	readonly revision?: "base";
	readonly lines: LineRanges;
	readonly unit?: UnitKind;
	readonly fields?: readonly UnitField[];
	readonly reason: string;
	// Set when the round's own record of the check did not run, which the verdict already names.
	readonly own?: true;
}

/** The coverage section of a review, as `melian findings` and `melian review` print it and JSON carries it. */
export interface CoverageSummary {
	readonly complete: boolean;
	readonly rounds: readonly string[];
	readonly gaps: readonly LedgerGap[];
	readonly dismissed: readonly StoredGapDismissal[];
}

/** Lines of one file on one side, as a publication stores them. */
export type PublishedLines = { file: string; revision?: "base"; lines: LineRanges };

/** One gap as a publication stores and renders it. */
export type PublishedGap = {
	check: string;
	file: string;
	revision?: "base";
	lines: LineRanges;
	unit?: UnitKind;
	reason: string;
};

/**
 * What a published round says of coverage: whether the diff is covered and by which rounds, how many changed lines the
 * round's own lenses reviewed of all they must, and the first gaps, with a count of the rest.
 */
export type PublishedCoverage = {
	complete: boolean;
	round: string;
	rounds: string[];
	reviewed: { lines: number; of: number; files: PublishedLines[]; more: number };
	gaps: PublishedGap[];
	more: number;
	dismissed: number;
};

// A publication lists this many gaps, and this many reviewed files, and counts the rest, so the review body and the
// ledger stay bounded.
const publishedGaps = 20;

/**
 * A maintainer's dismissal of a coverage gap: the check and the lines it answers, on the head side or the base, with who
 * dismissed it, when and why. It answers that check on those lines alone, and the lines stay uncovered.
 */
export type StoredGapDismissal = {
	check: string;
	file: string;
	revision?: "base";
	lines: LineRanges;
	reason: string;
	by: string;
	at: string;
};

function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function spans(lines: LineRanges): string {
	return `lines ${lines.map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`)).join(", ")}`;
}

function within(lines: LineRanges, set: LineRanges): LineRanges {
	return subtractRanges(lines, subtractRanges(lines, set));
}

function rank(choice: TriageChoice): number {
	return triageChoices.indexOf(choice);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One round's coverage record: for each check the tier names, what it must cover at the record's head and which rounds
 * covered it, with the voids that kept earlier coverage from carrying. It decides gaps; it reads no store and no git.
 */
export class CoverageRecord {
	readonly stored: StoredCoverageRecord;
	readonly dismissed: readonly StoredGapDismissal[];

	private constructor(stored: StoredCoverageRecord, dismissed: readonly StoredGapDismissal[]) {
		this.stored = stored;
		this.dismissed = dismissed;
	}

	/** The record a stored one describes, with the maintainer's dismissals of its gaps at the record's head. */
	static from(stored: StoredCoverageRecord, dismissed: readonly StoredGapDismissal[] = []): CoverageRecord {
		return new CoverageRecord(structuredClone(stored), structuredClone(dismissed));
	}

	/** Whether this build's coverage producer wrote the record, so its coverage counts. */
	current(): boolean {
		return (
			this.stored.producer.name === coverageProducer.name &&
			this.stored.producer.algorithm === coverageProducer.algorithm
		);
	}

	/** What each check has not covered at the record's head, by check, then file, then side. */
	gaps(): LedgerGap[] {
		return this.#gaps().flatMap((gap) => {
			if (gap.lines.length === 0) return [gap];
			const answered = this.dismissed
				.filter(
					(each) =>
						each.check === gap.check &&
						each.file === gap.file &&
						(each.revision ?? "head") === (gap.revision ?? "head"),
				)
				.reduce<LineRanges>((all, each) => unionRanges(all, each.lines), []);
			const left = subtractRanges(gap.lines, answered);
			return left.length === 0 ? [] : [{ ...gap, lines: left }];
		});
	}

	/** Every gap before the maintainer's dismissals answer any. */
	#gaps(): LedgerGap[] {
		const gaps: LedgerGap[] = [];
		for (const [check, coverage] of Object.entries(this.stored.checks).sort(([a], [b]) => byCodeUnit(a, b))) {
			for (const side of ["head", "base"] as const) {
				for (const [file, needed] of Object.entries(coverage.needs[side]).sort(([a], [b]) => byCodeUnit(a, b))) {
					const left = subtractRanges(needed, this.#covered(coverage, side, file));
					if (left.length === 0) continue;
					const at = side === "base" ? { revision: "base" as const } : {};
					const own = this.#ownFault(coverage);
					if (own !== undefined) {
						gaps.push({ check, file, ...at, lines: left, reason: own, ...this.#own() });
						continue;
					}
					const fault = this.#voidReason(check, file);
					if (fault !== undefined) {
						gaps.push({ check, file, ...at, lines: left, reason: fault });
						continue;
					}
					const low = within(left, this.#covered(coverage, side, file, false));
					if (low.length > 0)
						gaps.push({
							check,
							file,
							...at,
							lines: low,
							reason: `covered below the ${coverage.required[file] ?? "careful"} level its paths require`,
						});
					const unread = subtractRanges(left, low);
					const owed = within(unread, coverage.omitted?.[side][file] ?? []);
					if (owed.length > 0)
						gaps.push({ check, file, ...at, lines: owed, reason: "too large for the prompt; lines still owed" });
					const rest = subtractRanges(unread, owed);
					if (rest.length > 0) gaps.push({ check, file, ...at, lines: rest, reason: "never delivered" });
				}
			}
			for (const [file, fields] of Object.entries(coverage.needs.units).sort(([a], [b]) => byCodeUnit(a, b))) {
				const delivered = new Set(
					coverage.covered
						.filter((segment) => this.#counts(coverage, segment, file))
						.flatMap((each) => each.units[file] ?? []),
				);
				const missing = unitFields.filter((field) => fields.includes(field) && !delivered.has(field));
				if (missing.length === 0) continue;
				const own = this.#ownFault(coverage);
				const fault = own ?? this.#voidReason(check, file);
				gaps.push({
					check,
					file,
					lines: [],
					...(this.stored.units[file] === undefined ? {} : { unit: this.stored.units[file] }),
					fields: missing,
					reason:
						fault ?? (delivered.size === 0 ? "never delivered" : `fields not delivered: ${missing.join(", ")}`),
					...(own === undefined ? {} : this.#own()),
				});
			}
		}
		return gaps;
	}

	/** Whether every check has covered everything it must at the record's head. */
	complete(): boolean {
		return this.current() && this.gaps().length === 0;
	}

	/** The rounds whose coverage this record holds, in round order; none for a refused record, which holds none. */
	rounds(): string[] {
		if (this.stored.refused !== undefined) return [];
		const rounds = new Set(
			Object.values(this.stored.checks).flatMap((coverage) =>
				coverage.covered.map((segment) => segment.round ?? this.stored.round),
			),
		);
		return [...rounds].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || byCodeUnit(a, b));
	}

	/** The section's JSON: complete, the rounds that cover the diff, and every gap. */
	summary(): CoverageSummary {
		const stale = !this.current();
		const gaps = stale
			? [
					{
						check: "review.coverage",
						file: "",
						lines: [],
						reason: `recorded by coverage algorithm ${this.stored.producer.algorithm}, not ${coverageProducer.algorithm}, so it counts for nothing`,
					},
				]
			: this.gaps();
		return { complete: gaps.length === 0, rounds: stale ? [] : this.rounds(), gaps, dismissed: [...this.dismissed] };
	}

	/** What a publication of this record's round says of coverage, with its gaps bounded. */
	published(): PublishedCoverage {
		const { complete, rounds, gaps, dismissed } = this.summary();
		const listed = gaps.slice(0, publishedGaps).map(
			({ check, file, revision, lines, unit, reason }): PublishedGap => ({
				check,
				file,
				...(revision === undefined ? {} : { revision }),
				lines: structuredClone(lines) as LineRanges,
				...(unit === undefined ? {} : { unit }),
				reason,
			}),
		);
		return {
			complete,
			round: this.stored.round,
			rounds: [...rounds],
			reviewed: this.#reviewed(),
			gaps: listed,
			more: gaps.length - listed.length,
			dismissed: dismissed.length,
		};
	}

	// The changed lines this round's own lens runs delivered, of all its lenses must cover, and the files they sit in.
	#reviewed(): PublishedCoverage["reviewed"] {
		const own = { head: {} as LinesByPath, base: {} as LinesByPath };
		const needed = { head: {} as LinesByPath, base: {} as LinesByPath };
		if (!this.current() || this.stored.refused !== undefined) return { lines: 0, of: 0, files: [], more: 0 };
		for (const coverage of Object.values(this.stored.checks)) {
			if (coverage.kind !== "lens") continue;
			const segments = coverage.covered.filter(
				(segment) => segment.round === undefined || segment.round === this.stored.round,
			);
			for (const side of ["head", "base"] as const) {
				for (const [file, lines] of Object.entries(coverage.needs[side])) {
					needed[side][file] = unionRanges(needed[side][file] ?? [], lines);
					const delivered = segments.reduce<LineRanges>(
						(all, segment) => unionRanges(all, segment[side][file] ?? []),
						[],
					);
					own[side][file] = unionRanges(own[side][file] ?? [], within(lines, delivered));
				}
			}
		}
		const total = (lines: { head: LinesByPath; base: LinesByPath }) =>
			[...Object.values(lines.head), ...Object.values(lines.base)].reduce(
				(sum, ranges) => sum + countRanges(ranges),
				0,
			);
		const files = (["head", "base"] as const).flatMap((side) =>
			Object.entries(own[side])
				.filter(([, ranges]) => ranges.length > 0)
				.sort(([a], [b]) => byCodeUnit(a, b))
				.map(
					([file, lines]): PublishedLines => ({ file, ...(side === "base" ? { revision: "base" } : {}), lines }),
				),
		);
		return {
			lines: total(own),
			of: total(needed),
			files: files.slice(0, publishedGaps),
			more: Math.max(0, files.length - publishedGaps),
		};
	}

	/**
	 * The `review.coverage` record this record puts in a round's manifest: `ran` when every check covered everything it
	 * must, and otherwise skipped without leave, naming the gaps, which leaves the review not reviewed. A check whose own
	 * record did not run names itself in the verdict, so the reason only points at it; five other gaps are named, with a
	 * count of the rest.
	 */
	checkRecord(): CheckRecord {
		const { complete, gaps } = this.summary();
		if (complete) return { name: coverageCheck, status: "ran" };
		const unrun = [...new Set(gaps.filter((gap) => gap.own === true).map((gap) => gap.check))];
		const rest = [
			...new Set(
				gaps
					.filter((gap) => gap.own !== true)
					.map((gap) => `${gap.check}${gap.file === "" ? "" : ` ${visibleText(gap.file)}`}: ${gap.reason}`),
			),
		];
		const said = unrun.length === 1 ? "its record says" : "their records say";
		const parts = [
			...(unrun.length === 0 ? [] : [`${unrun.join(", ")} did not cover the diff, as ${said}`]),
			...rest.slice(0, 5),
			...(rest.length > 5 ? [`and ${rest.length - 5} more gaps`] : []),
		];
		return { name: coverageCheck, status: "skipped", reason: `coverage is incomplete: ${parts.join("; ")}` };
	}

	/** The `Coverage` section for a terminal. Paths pass through `visibleText`. */
	render(): string {
		const { complete, rounds, gaps, dismissed } = this.summary();
		const answered = dismissed.map(
			(each) =>
				`  ${each.check}  ${visibleText(each.file)}${each.revision === "base" ? " (base)" : ""} ${spans(each.lines)}: ${visibleText(each.reason)} (${visibleText(each.by)})\n`,
		);
		const apart = answered.length === 0 ? "" : `Dismissed gaps:\n${answered.join("")}`;
		if (complete) return `Coverage: complete, from ${rounds.join(", ")}.\n${apart}`;
		const lines = gaps.map((gap) => {
			const where = gap.file === "" ? "" : `${visibleText(gap.file)}${gap.revision === "base" ? " (base)" : ""}`;
			const what =
				gap.lines.length > 0
					? ` ${plural(
							gap.lines.reduce((sum, [first, last]) => sum + last - first + 1, 0),
							"line",
						)} at ${gap.lines
							.map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`))
							.join(", ")}`
					: gap.unit === undefined
						? ""
						: ` (${gap.unit})`;
			return `  ${gap.check}${where === "" ? "" : `  ${where}`}${what}: ${gap.reason}\n`;
		});
		return `Coverage: incomplete${rounds.length === 0 ? "" : `, partly from ${rounds.join(", ")}`}.\n${lines.join("")}${apart}`;
	}

	// Lines of `file` that segments at or above the file's required level cover, or that any segment covers.
	#covered(coverage: StoredCheckCoverage, side: "head" | "base", file: string, level = true): LineRanges {
		return coverage.covered
			.filter((segment) => !level || this.#counts(coverage, segment, file))
			.reduce<LineRanges>((all, segment) => unionRanges(all, segment[side][file] ?? []), []);
	}

	// Whether a segment counts for `file`: the record is not refused, a lens's run was at or above the file's required
	// level, and no injection attempt sits in the file.
	#counts(coverage: StoredCheckCoverage, segment: StoredCoverageSegment, file: string): boolean {
		if (this.stored.refused !== undefined) return false;
		if (coverage.kind === "range") return true;
		if (coverage.injected?.includes(file)) return false;
		const required = coverage.required[file] ?? "careful";
		return segment.level !== undefined && rank(segment.level) >= rank(required);
	}

	// Why this round's own record covers nothing, when it does not.
	#ownFault(coverage: StoredCheckCoverage): string | undefined {
		// A record not yet written names no round of its own.
		const round = this.stored.round === "" ? "this round" : this.stored.round;
		if (this.stored.refused !== undefined) return this.stored.refused;
		switch (coverage.status) {
			case "ran":
				return undefined;
			case "ended":
				return `${coverage.kind === "lens" ? "lens" : "check"} ended at its budget in ${round}`;
			case "failed":
				return `failed in ${round}${coverage.reason === undefined ? "" : `: ${coverage.reason}`}`;
			case "provisional":
				return `provisional in ${round}, so its results rest on an earlier head`;
			case "skipped":
				return coverage.leave === true
					? undefined
					: `skipped without leave in ${round}${coverage.reason === undefined ? "" : `: ${coverage.reason}`}`;
			default:
				return `did not run in ${round}`;
		}
	}

	// A refused record's gaps are the record's own, not a check's that did not run.
	#own(): { own?: true } {
		return this.stored.refused === undefined ? { own: true } : {};
	}

	#voidReason(check: string, file: string): string | undefined {
		if (this.stored.checks[check]!.injected?.includes(file))
			return "a melian/injection-attempt finding sits in the file, so no lens covers it until a round rereads it";
		return this.stored.voids.find(
			(each) =>
				(each.lens === undefined || `lens.${each.lens}` === check) &&
				(each.files === undefined || each.files.includes(file)),
		)?.reason;
	}
}
