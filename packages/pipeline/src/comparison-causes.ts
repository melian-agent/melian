import { Changeset, ChangesetError, type ComparisonEntry, type MissCauseRecord } from "@melian-agent/core";
import { backgroundContext, type Context, type Storage } from "./harness.ts";
import { MissCause } from "./miss-cause.ts";
import { type Round, RoundReader } from "./rounds.ts";
import { TelemetryReader } from "./telemetry.ts";

/**
 * Melian's first read of each valid miss of a changeset's comparisons, from each round's own telemetry in a storage and
 * its diff in a clone. It lives apart from the comparison reader so the adjudication never reaches the telemetry.
 */
export class ComparisonCauses {
	private readonly storage: Storage;
	private readonly repo: string;

	private constructor(storage: Storage, repo: string) {
		this.storage = storage;
		this.repo = repo;
	}

	/** Reads over `storage`, which the caller keeps and closes, with each round's commits in the clone at `repo`. */
	static open(storage: Storage, repo: string): ComparisonCauses {
		return new ComparisonCauses(storage, repo);
	}

	/**
	 * `entries`, read from this storage for `changeset`, with every attributed entry carrying `causes`: the first read of
	 * each valid miss by its external finding's ID. A round this storage holds no run of, or whose commits the clone
	 * lacks, reads `no record`. Unattributed entries are returned as they are, and a storage with no attributed entry is
	 * not read at all.
	 */
	async read(
		entries: readonly ComparisonEntry[],
		changeset: string,
		context: Context = backgroundContext,
	): Promise<ComparisonEntry[]> {
		if (entries.every((entry) => entry.unattributed !== undefined)) return [...entries];
		const rounds = await new RoundReader(this.storage).read(changeset, context);
		const caused: ComparisonEntry[] = [];
		for (const entry of entries)
			caused.push(entry.unattributed === undefined ? await this.caused(entry, rounds, context) : entry);
		return caused;
	}

	private async caused(entry: ComparisonEntry, rounds: readonly Round[], context: Context): Promise<ComparisonEntry> {
		const { comparison, verdict } = entry;
		const misses = comparison.validMisses();
		const causes: Record<string, MissCauseRecord> = {};
		if (misses.length === 0 || verdict === undefined) return { ...entry, causes };
		const round = rounds.find((each) => each.id === entry.round);
		const telemetry =
			round === undefined ? undefined : await TelemetryReader.open(this.storage).round(round, context);
		const revision =
			round === undefined || telemetry === undefined
				? undefined
				: await Changeset.resolve(this.repo, {
						base: round.stored.base,
						head: round.stored.head,
						mode: "twoDot",
					}).then(
						(changeset) => changeset.revision,
						(error: unknown) => {
							if (error instanceof ChangesetError) return undefined;
							throw error;
						},
					);
		const run =
			telemetry === undefined || revision === undefined ? undefined : { stages: telemetry.stages, revision };
		for (const finding of misses) {
			const cause = MissCause.of(finding, verdict.all(), run);
			if (cause !== undefined) causes[finding.id] = cause.toJSON();
		}
		return { ...entry, causes };
	}
}
