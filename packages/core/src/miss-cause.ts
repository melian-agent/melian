/**
 * Melian's first read of why a round missed a valid external finding, in the order the reading tries them. It is
 * computed from the round's own records each time a comparison is read, so a later rule can change it, and it never
 * stands in for the reason a person gave.
 */
export const missCauses = [
	"not covered",
	"cut short",
	"never shown",
	"seen, not reported",
	"reported, refuted",
	"reported, not matched",
	"no record",
] as const;

/** One of {@link missCauses}. */
export type MissCauseName = (typeof missCauses)[number];

/**
 * A lens run whose stored coverage held the miss's file: its lens as `name@version` and level, its stage and
 * conversation, how it ended (`completed`, `failed`, or the `tokens` or `tools` budget that cut it, among others), whether
 * its prompt carried the file's diff whole, and the miss's lines `read_file` delivered to it.
 */
export type MissCauseRun = {
	lens: string;
	level: string;
	role?: "planner" | "prober";
	stage: string;
	conversation: number;
	ended: string;
	shownWhole: boolean;
	read: [number, number][];
};

/** A lens claim at the miss's file on lines overlapping its own: its ID, the finding that holds it, and the verifier's verdict. */
export type MissCauseSighting = {
	id: string;
	finding: string;
	check: string;
	rule: string;
	verification: "confirmed" | "plausible" | "refuted" | "unverified";
	lowered?: true;
};

/** A miss's first read and the facts it rests on, as IDs and numbers, never text. */
export type MissCauseRecord = {
	firstRead: MissCauseName;
	runs: MissCauseRun[];
	sightings: MissCauseSighting[];
};
