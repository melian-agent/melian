import type { CheckStatus } from "./adjudication.ts";
import {
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
}

/** The coverage section of a review, as `melian findings` and `melian review` print it and JSON carries it. */
export interface CoverageSummary {
	readonly complete: boolean;
	readonly rounds: readonly string[];
	readonly gaps: readonly LedgerGap[];
}

function byCodeUnit(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
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

	private constructor(stored: StoredCoverageRecord) {
		this.stored = stored;
	}

	/** The record a stored one describes. */
	static from(stored: StoredCoverageRecord): CoverageRecord {
		return new CoverageRecord(structuredClone(stored));
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
		const gaps: LedgerGap[] = [];
		for (const [check, coverage] of Object.entries(this.stored.checks).sort(([a], [b]) => byCodeUnit(a, b))) {
			for (const side of ["head", "base"] as const) {
				for (const [file, needed] of Object.entries(coverage.needs[side]).sort(([a], [b]) => byCodeUnit(a, b))) {
					const left = subtractRanges(needed, this.#covered(coverage, side, file));
					if (left.length === 0) continue;
					const at = side === "base" ? { revision: "base" as const } : {};
					const fault = this.#ownFault(coverage) ?? this.#voidReason(check, file);
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
				const fault = this.#ownFault(coverage) ?? this.#voidReason(check, file);
				gaps.push({
					check,
					file,
					lines: [],
					...(this.stored.units[file] === undefined ? {} : { unit: this.stored.units[file] }),
					fields: missing,
					reason:
						fault ?? (delivered.size === 0 ? "never delivered" : `fields not delivered: ${missing.join(", ")}`),
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
		return { complete: gaps.length === 0, rounds: stale ? [] : this.rounds(), gaps };
	}

	/** The `Coverage` section for a terminal. Paths pass through `visibleText`. */
	render(): string {
		const { complete, rounds, gaps } = this.summary();
		if (complete) return `Coverage: complete, from ${rounds.join(", ")}.\n`;
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
		return `Coverage: incomplete${rounds.length === 0 ? "" : `, partly from ${rounds.join(", ")}`}.\n${lines.join("")}`;
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
		const round = this.stored.round;
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

	#voidReason(check: string, file: string): string | undefined {
		if (this.stored.checks[check]?.injected?.includes(file))
			return "a melian/injection-attempt finding sits in the file, so no lens covers it until a round rereads it";
		return this.stored.voids.find(
			(each) =>
				(each.lens === undefined || `lens.${each.lens}` === check) &&
				(each.files === undefined || each.files.includes(file)),
		)?.reason;
	}
}
