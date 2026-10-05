import type { LevelBandSettings, Severity } from "./config.ts";
import type { QuestionSet } from "./decider.ts";
import { type ScrutinyLevel, scrutinyLevels } from "./lens.ts";

/** What triage chooses for a lens: to skip it, or a {@link ScrutinyLevel} to run it at. */
export type TriageChoice = "skip" | ScrutinyLevel;

/** Every {@link TriageChoice}, from the least look to the most. */
export const triageChoices: readonly TriageChoice[] = ["skip", ...scrutinyLevels];

/** The question set triage asks: one choice question per lens. Its version changes whenever the questions do. */
export const triageQuestionSet: QuestionSet = { name: "triage", version: "1" };

function rank(choice: TriageChoice): number {
	return triageChoices.indexOf(choice);
}

/**
 * The levels policy lets triage choose for a lens: at least `floor` and at most `ceiling`. The default band is
 * `quick` to `deep`, so triage never switches off a lens policy runs; only a floor of `skip` lets it.
 */
export class LevelBand {
	readonly floor: TriageChoice;
	readonly ceiling: ScrutinyLevel;

	private constructor(floor: TriageChoice, ceiling: ScrutinyLevel) {
		this.floor = floor;
		// Where the ends cross, the floor wins: a floor is policy saying how hard a lens must look.
		this.ceiling = rank(floor) > rank(ceiling) ? (floor as ScrutinyLevel) : ceiling;
	}

	/** The band one path's settings set, each end they leave out at the default's. */
	static of(settings: LevelBandSettings | undefined): LevelBand {
		return new LevelBand(settings?.floor ?? "quick", settings?.ceiling ?? "deep");
	}

	/**
	 * The band over several paths' bands, such as those of every file a lens reviews: the highest floor and the lowest
	 * ceiling, and where they cross, the floor. The default band when `bands` is empty.
	 */
	static across(bands: readonly LevelBand[]): LevelBand {
		if (bands.length === 0) return LevelBand.of(undefined);
		const floor = bands.map((band) => band.floor).reduce((high, each) => (rank(each) > rank(high) ? each : high));
		const ceiling = bands.map((band) => band.ceiling).reduce((low, each) => (rank(each) < rank(low) ? each : low));
		return new LevelBand(floor, ceiling);
	}

	/** The levels of `levels` inside the band, in their order. */
	holds(levels: readonly ScrutinyLevel[]): ScrutinyLevel[] {
		return levels.filter((level) => rank(level) >= rank(this.floor) && rank(level) <= rank(this.ceiling));
	}

	/**
	 * `choice` held to the band, then moved to the nearest of `levels`, the higher on a tie. A choice of `skip` the floor
	 * allows stays `skip`. `levels` are the ones a lens may run at inside the band, so the result is never below the
	 * floor; throws a `RangeError` when it is empty and the choice is not `skip`, since the lens then has nowhere to run.
	 */
	bound(choice: TriageChoice, levels: readonly ScrutinyLevel[]): TriageChoice {
		const held =
			rank(choice) < rank(this.floor) ? this.floor : rank(choice) > rank(this.ceiling) ? this.ceiling : choice;
		if (held === "skip") return held;
		const within = this.holds(levels);
		if (within.length === 0) throw new RangeError(`no level between ${this.floor} and ${this.ceiling} can run`);
		return nearest(held, within);
	}

	/** The next of `declared` above `level` that the ceiling allows, or `undefined` when the ceiling stops it. */
	above(level: ScrutinyLevel, declared: readonly ScrutinyLevel[]): ScrutinyLevel | undefined {
		return declared
			.filter((each) => rank(each) > rank(level) && rank(each) <= rank(this.ceiling))
			.sort((a, b) => rank(a) - rank(b))[0];
	}
}

function nearest(target: ScrutinyLevel, levels: readonly ScrutinyLevel[]): ScrutinyLevel {
	const distance = (level: ScrutinyLevel) => Math.abs(rank(level) - rank(target));
	return levels.reduce((best, level) =>
		distance(level) < distance(best) || (distance(level) === distance(best) && rank(level) > rank(best))
			? level
			: best,
	);
}

/** Why a lens run at `quick` runs again at the next level: a finding at or above the rule's severity, or a budget's end. */
export type EscalationTrigger =
	| { readonly kind: "severity"; readonly severity: Severity }
	| { readonly kind: "budget"; readonly budget: "tokens" | "tools" };

/** What one lens run did, as the escalation rule reads it. */
export interface EscalationEvidence {
	readonly level: ScrutinyLevel;
	/** The severity of each finding the run reported. */
	readonly severities: readonly Severity[];
	/** The budget that ended the run's conversation, if one did. */
	readonly budgetEnded?: "tokens" | "tools";
}

const severityOrder: readonly Severity[] = ["P0", "P1", "P2", "P3", "nit"];

/**
 * The one mechanical escalation: a lens at `quick` that reports a finding at or above `escalateAt` runs again at the
 * next level, and so does one a budget ended before it reported anything, since a quick look that ran out found
 * nothing because it stopped. A run at any other level never escalates.
 */
export class EscalationRule {
	readonly escalateAt: Severity;

	constructor(escalateAt: Severity) {
		this.escalateAt = escalateAt;
	}

	/** Why `run` should run again at the next level, or `undefined` when it should not. */
	trigger(run: EscalationEvidence): EscalationTrigger | undefined {
		if (run.level !== "quick") return undefined;
		const severest = [...run.severities].sort((a, b) => severityOrder.indexOf(a) - severityOrder.indexOf(b))[0];
		if (severest !== undefined && severityOrder.indexOf(severest) <= severityOrder.indexOf(this.escalateAt)) {
			return { kind: "severity", severity: severest };
		}
		if (run.budgetEnded !== undefined && run.severities.length === 0)
			return { kind: "budget", budget: run.budgetEnded };
		return undefined;
	}

	/**
	 * A note for the check record of a lens that escalated from `from` to `to`, or that would have and stopped at `from`
	 * when `to` is `undefined`: at its ceiling, or for `cap`, the reason given.
	 */
	describe(trigger: EscalationTrigger, from: ScrutinyLevel, to: ScrutinyLevel | undefined, cap?: string): string {
		const why =
			trigger.kind === "severity"
				? `it reported a ${trigger.severity} finding, at or above ${this.escalateAt}`
				: `its ${trigger.budget} budget ended it before it reported anything`;
		if (to !== undefined) return `escalated from ${from} to ${to}: at ${from} ${why}`;
		return `escalation capped at ${from}, ${cap ?? "its ceiling"}: at ${from} ${why}`;
	}
}
