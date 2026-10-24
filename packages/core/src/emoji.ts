import type { Resolution, Severity } from "./config.ts";
import type { Verification } from "./verification.ts";

/**
 * A word and the emoji that marks it, as [the findings guideline](../../../docs/guidelines/findings.md#emojis) pairs
 * them. The emoji always sits beside its word, so a plain rendering keeps the word and loses nothing else.
 */
export class Mark {
	readonly emoji: string | undefined;
	readonly word: string;

	constructor(emoji: string | undefined, word: string) {
		this.emoji = emoji;
		this.word = word;
	}

	/** The word, after its emoji when `emoji` is set and the mark has one. */
	show(emoji: boolean): string {
		return emoji && this.emoji !== undefined ? `${this.emoji} ${this.word}` : this.word;
	}

	/**
	 * The mark for the check `check` names, as a status line shows it: its row in the table, or for a lens with no row
	 * the lens's `declared` emoji, else the magnifying glass, beside its name. A guardrail names the guardrail its
	 * `rule` falls under. A check the table does not know shows its name alone.
	 */
	static check(check: string, rule: string, declared?: string): Mark {
		if (check === "guardrails") {
			const guardrail = rule.split("/")[1];
			return guardrail === undefined ? checkMarks.guardrails : new Mark(guardrails, `Guardrails: ${guardrail}`);
		}
		if (Object.hasOwn(checkMarks, check)) return checkMarks[check]!;
		if (check.startsWith("lens.")) return new Mark(declared ?? lensFallback, check.slice("lens.".length));
		return new Mark(undefined, check);
	}
}

const guardrails = "\u{1F6A6}"; // VERTICAL TRAFFIC LIGHT
const lensFallback = "\u{1F50E}"; // RIGHT-POINTING MAGNIFYING GLASS

/** Each severity's mark: one shape in falling heat. */
export const severityMarks: Readonly<Record<Severity, Mark>> = {
	P0: new Mark("\u{1F534}", "P0"), // LARGE RED CIRCLE
	P1: new Mark("\u{1F7E0}", "P1"), // LARGE ORANGE CIRCLE
	P2: new Mark("\u{1F7E1}", "P2"), // LARGE YELLOW CIRCLE
	P3: new Mark("\u{1F535}", "P3"), // LARGE BLUE CIRCLE
	nit: new Mark("\u{26AA}", "nit"), // MEDIUM WHITE CIRCLE
};

/** Each resolution's mark, as policy decided it. A silent finding is never shown, so its mark has no emoji. */
export const resolutionMarks: Readonly<Record<Resolution, Mark>> = {
	block: new Mark("\u{26D4}", "Blocks merge"), // NO ENTRY
	acknowledge: new Mark("\u{270B}", "Needs acknowledgement"), // RAISED HAND
	advisory: new Mark("\u{1F4AC}", "Advisory"), // SPEECH BALLOON
	silent: new Mark(undefined, "Silent"),
};

/** The verifier's outcome for a finding: its verdict, or `unverified` for a lens finding no verifier judged. */
export const verifierMarks: Readonly<Record<Verification["verdict"] | "unverified", Mark>> = {
	confirmed: new Mark("\u{2705}", "Verifier confirmed"), // WHITE HEAVY CHECK MARK
	plausible: new Mark("\u{26A0}\u{FE0F}", "Verifier plausible"), // WARNING SIGN
	unverified: new Mark("\u{2754}", "Not verified"), // WHITE QUESTION MARK ORNAMENT
	refuted: new Mark("\u{2716}\u{FE0F}", "Refuted"), // HEAVY MULTIPLICATION X
};

/** A review's outcome, and a finding's after its review. */
export const outcomeMarks = {
	passed: new Mark("\u{1F7E9}", "Passed"), // LARGE GREEN SQUARE
	fixed: new Mark("\u{1F527}", "Fixed"), // WRENCH
	dismissed: new Mark("\u{1F5C2}\u{FE0F}", "Dismissed"), // CARD INDEX DIVIDERS
	notReviewed: new Mark("\u{1F6A7}", "Not reviewed"), // CONSTRUCTION SIGN
} as const satisfies Readonly<Record<string, Mark>>;

/** The verifier's own mark, which leads the line that gives its reason. */
export const verifierMark = new Mark("\u{2696}\u{FE0F}", "Verifier"); // SCALES

/** Each check the table names, by the name a finding's `source.check` gives it. */
export const checkMarks: Readonly<Record<string, Mark>> = {
	"lens.correctness": new Mark("\u{1F3AF}", "Correctness"), // DIRECT HIT
	"lens.contracts": new Mark("\u{1F91D}", "Contracts"), // HANDSHAKE
	"lens.trust-boundary": new Mark("\u{1F6E1}\u{FE0F}", "Trust boundary"), // SHIELD
	"lens.removed-behaviour": new Mark("\u{2702}\u{FE0F}", "Removed behaviour"), // BLACK SCISSORS
	"lens.tests": new Mark("\u{1F9EA}", "Tests"), // TEST TUBE
	"lens.conventions": new Mark("\u{1F4CF}", "Conventions"), // STRAIGHT RULER
	"lens.design": new Mark("\u{1F4D0}", "Design"), // TRIANGULAR RULER
	"lens.durability": new Mark("\u{1F4BE}", "Durability"), // FLOPPY DISK
	"static.biome": new Mark("\u{1F9F9}", "Biome"), // BROOM
	"static.tsc": new Mark("\u{1F9E9}", "tsc"), // JIGSAW PUZZLE PIECE
	"static.enola": new Mark("\u{1F578}\u{FE0F}", "Enola"), // SPIDER WEB
	"static.mutation": new Mark("\u{1F9EC}", "Mutation"), // DNA DOUBLE HELIX
	guardrails: new Mark(guardrails, "Guardrails"),
};

/** Every emoji the table uses, which no lens may declare as its own. */
export const tableEmojis: ReadonlySet<string> = new Set(
	[
		...Object.values(severityMarks),
		...Object.values(resolutionMarks),
		...Object.values(verifierMarks),
		...Object.values(outcomeMarks),
		...Object.values(checkMarks),
		verifierMark,
	]
		.flatMap((mark) => (mark.emoji === undefined ? [] : [mark.emoji]))
		.concat(lensFallback),
);
