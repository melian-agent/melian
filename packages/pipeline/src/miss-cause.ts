import {
	type ExternalFinding,
	type Finding,
	lensCovers,
	type MissCauseName,
	type MissCauseRecord,
	type MissCauseRun,
	type MissCauseSighting,
	type Revision,
	VerificationState,
} from "@melian-agent/core";
import type { Stage } from "./telemetry.ts";

type Ranges = readonly (readonly [number, number])[];

/**
 * The lines of one file a miss names at a round's head, or the whole file when it names none, and the one rule for
 * whether a lens run saw them: its prompt carried the file's diff whole and a head-side hunk holds one of the ranges, or
 * `read_file` delivered it a line of one of them, or any line of the file for a miss with no ranges.
 */
export class MissLines {
	readonly file: string;
	readonly ranges: Ranges | undefined;
	// Whether the round's diff shows the lines to a prompt that carries the file whole.
	private readonly diffShows: boolean;

	private constructor(file: string, ranges: Ranges | undefined, diffShows: boolean) {
		this.file = file;
		this.ranges = ranges;
		this.diffShows = diffShows;
	}

	/**
	 * The lines `ranges` of `file`, or the whole file, in the diff of `revision`. Without the revision a prompt that
	 * carried the file whole is not known to have shown a range, so only `read_file` can see one.
	 */
	static of(file: string, ranges?: Ranges, revision?: Revision): MissLines {
		const diffShows = ranges === undefined || (revision?.shows(file, ranges) ?? false);
		return new MissLines(
			file,
			ranges === undefined ? undefined : ranges.map(([first, last]) => [first, last]),
			diffShows,
		);
	}

	/** Whether `stage` is a lens run, other than a prober, whose stored coverage holds the file. */
	covers(stage: Stage): boolean {
		return (
			stage.name === "melian.lens" &&
			stage.role !== "prober" &&
			stage.coverage !== undefined &&
			lensCovers(stage.coverage, this.file)
		);
	}

	/** Whether `stage`'s prompt carried the file's diff whole. */
	shownWhole(stage: Stage): boolean {
		return stage.shown?.includes(this.file) ?? false;
	}

	/** Whether `stage` saw the lines: shown them in the file's whole diff, or delivered one by `read_file`. */
	saw(stage: Stage): boolean {
		return (
			(this.diffShows && this.shownWhole(stage)) ||
			(stage.read?.some(
				(read) =>
					read.path === this.file &&
					(this.ranges === undefined ||
						read.ranges.some(([start, end]) =>
							this.ranges!.some(([first, last]) => start <= last && end >= first),
						)),
			) ??
				false)
		);
	}

	/** The lines `read_file` delivered to `stage` of the file, cut to the ranges when there are any. */
	delivered(stage: Stage): [number, number][] {
		const read = (stage.read ?? []).filter((each) => each.path === this.file).flatMap((each) => each.ranges);
		if (this.ranges === undefined) return read.map(([start, end]) => [start, end]);
		return read.flatMap(([start, end]) =>
			this.ranges!.flatMap(([first, last]): [number, number][] =>
				start <= last && end >= first ? [[Math.max(start, first), Math.min(end, last)]] : [],
			),
		);
	}

	/** The findings a lens reported at the file on lines overlapping the ranges, or anywhere in it when there are none. */
	sighted(findings: readonly Finding[]): Finding[] {
		return findings.filter((finding) => {
			const [start, end] = finding.lines();
			return (
				finding.properties.path === this.file &&
				finding.properties.source.check.startsWith("lens.") &&
				(this.ranges === undefined || this.ranges.some(([first, last]) => start <= last && end >= first))
			);
		});
	}
}

/**
 * Melian's first read of why a round missed a valid external finding, with the facts it rests on: each lens run whose
 * coverage held the file, and each lens claim at the file overlapping the finding's lines. It reads the round's own
 * records each time, so a later rule can read the same miss differently. It is never a person's reason.
 */
export class MissCause {
	readonly firstRead: MissCauseName;
	readonly runs: readonly MissCauseRun[];
	readonly sightings: readonly MissCauseSighting[];

	private constructor(firstRead: MissCauseName, runs: MissCauseRun[], sightings: MissCauseSighting[]) {
		this.firstRead = firstRead;
		this.runs = runs;
		this.sightings = sightings;
	}

	/**
	 * The first read of `finding`, a valid miss of a round whose verdict holds `findings`. `run` is the round's own
	 * telemetry and diff; without it, the round left no record here. A finding with no file has no cause. A finding with
	 * no line at the head, or none GitHub still places, is read against the whole file.
	 */
	static of(
		finding: ExternalFinding,
		findings: readonly Finding[],
		run?: { readonly stages: readonly Stage[]; readonly revision: Revision },
	): MissCause | undefined {
		if (finding.file === undefined) return undefined;
		const site = finding.site();
		const lines = MissLines.of(
			site?.file ?? finding.file,
			site === undefined ? undefined : [[site.start, site.end]],
			run?.revision,
		);
		const covering = (run?.stages ?? []).filter((stage) => stage.conversation !== undefined && lines.covers(stage));
		const runs = covering.map((stage): MissCauseRun => {
			const [lens = "", version = "", level = ""] = stage.subject.split("@");
			return {
				lens: `${lens}@${version}`,
				level,
				...(stage.role === undefined ? {} : { role: stage.role }),
				stage: stage.id,
				conversation: stage.conversation!,
				ended: stage.ended ?? stage.outcome,
				shownWhole: lines.shownWhole(stage),
				read: lines.delivered(stage),
			};
		});
		const seen = new Set<string>();
		const sightings = lines.sighted(findings).flatMap((sighted) => {
			const claims = VerificationState.from(sighted).claims;
			return (claims.length === 0 ? [sighted.claimAs()] : claims).flatMap((claim): MissCauseSighting[] => {
				const key = JSON.stringify([claim.id, claim.source.check, claim.source.version]);
				if (seen.has(key)) return [];
				seen.add(key);
				return [
					{
						id: claim.id,
						finding: sighted.id,
						check: claim.source.check,
						rule: claim.ruleId,
						verification: claim.verification?.verdict ?? "unverified",
						...(claim.verification?.lowered === undefined ? {} : { lowered: true as const }),
					},
				];
			});
		});
		return new MissCause(MissCause.read(run?.stages, covering, lines, sightings), runs, sightings);
	}

	// The first cause in the order the plan's table lists them whose condition holds.
	private static read(
		stages: readonly Stage[] | undefined,
		covering: readonly Stage[],
		lines: MissLines,
		sightings: readonly MissCauseSighting[],
	): MissCauseName {
		// A round an older Melian ran records no lens prompt's files, so nothing says what its lenses were shown.
		const lensRuns = (stages ?? []).filter(
			(stage) => stage.name === "melian.lens" && stage.conversation !== undefined,
		);
		if (stages === undefined || (lensRuns.length > 0 && lensRuns.every((stage) => stage.shown === undefined)))
			return "no record";
		if (sightings.length > 0)
			return sightings.every((sighting) => sighting.verification === "refuted")
				? "reported, refuted"
				: "reported, not matched";
		if (covering.length === 0) return "not covered";
		if (covering.some((stage) => lines.saw(stage))) return "seen, not reported";
		return covering.some((stage) => stage.outcome === "completed") ? "never shown" : "cut short";
	}

	toJSON(): MissCauseRecord {
		return {
			firstRead: this.firstRead,
			runs: this.runs.map((run) => structuredClone(run)),
			sightings: this.sightings.map((sighting) => ({ ...sighting })),
		};
	}
}
