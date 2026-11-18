import {
	type Changeset,
	checksOfTier,
	configLookup,
	Lens,
	type LensSelection,
	LevelBand,
	type MelianConfig,
	type RepositorySource,
	type ScrutinyLevel,
	type TierLenses,
} from "@melian-agent/core";

/** A lens a change calls for: what it covers, including the head path of each file it covers by its old path. */
export interface CoveringLens extends LensSelection {
	/** The head path of each file the lens covers only by its old path. */
	readonly moved: readonly string[];
	/** The changed files it reviews: `files`, then `moved`. */
	readonly covers: readonly string[];
}

/**
 * The lenses a tier's review selects for a changeset, and the band of levels each one's covered paths set. The review
 * builds its selection here, and a reader that checks a round's account builds the same selection for `TierAccount`.
 */
export class ChangeLenses {
	/** Every lens the caller loaded, selected or not. */
	readonly loaded: readonly Lens[];
	/** The lenses selected for the change, in selection order. */
	readonly covering: readonly CoveringLens[];
	readonly #bands: ReadonlyMap<Lens, LevelBand>;

	private constructor(
		loaded: readonly Lens[],
		covering: readonly CoveringLens[],
		bands: ReadonlyMap<Lens, LevelBand>,
	) {
		this.loaded = loaded;
		this.covering = covering;
		this.#bands = bands;
	}

	/**
	 * The lenses of `tier` that `changeset`'s paths, a file's old path among them, call for under `config`. Each band
	 * comes from the `melian.yaml` nearest each covered path at `policy`, or from `config` alone without one, with
	 * `floor` as the floor no file sets. The review passes `careful` for a head it does not trust and an uncalibrated
	 * decider, and `quick` otherwise; neither is `skip`, so a reader checking which skips an account allows may pass
	 * either.
	 */
	static async read(options: {
		readonly changeset: Changeset;
		readonly lenses: readonly Lens[];
		readonly config: MelianConfig;
		readonly tier: string;
		readonly policy?: RepositorySource;
		readonly floor: ScrutinyLevel;
	}): Promise<ChangeLenses> {
		const { changeset, lenses, config, policy, floor } = options;
		const named = new Set(
			checksOfTier(config, options.tier)
				.filter((name) => name.startsWith("lens."))
				.map((name) => name.slice("lens.".length)),
		);
		const selected = Lens.select(
			lenses.filter((lens) => named.has(lens.name)),
			config,
			changeset.revision.paths(),
		);
		// A lens selected through a file's old path covers its head path for this review, so it can report what it moved.
		const covering = selected.map((selection) => {
			const { files } = selection;
			const moved = changeset.revision.files
				.filter((file) => file.oldPath !== undefined && files.includes(file.oldPath) && !files.includes(file.path))
				.map((file) => file.path);
			return { ...selection, moved, covers: [...files, ...moved] };
		});
		const lookup = policy === undefined ? undefined : configLookup(changeset.repoRoot, policy);
		const bands = new Map<Lens, LevelBand>();
		for (const { lens, covers } of covering) {
			const configs = lookup === undefined ? [config] : await Promise.all(covers.map((path) => lookup(path)));
			const settings = configs.map((each) =>
				Object.hasOwn(each.lenses, lens.name) ? each.lenses[lens.name] : undefined,
			);
			bands.set(lens, LevelBand.across(settings.map((each) => LevelBand.of(each?.level, floor))));
		}
		return new ChangeLenses(lenses, covering, bands);
	}

	/** The band of levels `lens`'s covered paths set; it must be a selected lens. */
	band(lens: Lens): LevelBand {
		const band = this.#bands.get(lens);
		if (band === undefined) throw new RangeError(`lens ${lens.name} is not selected for the change`);
		return band;
	}

	/** The lenses as `TierAccount.of` takes them. */
	tierLenses(): TierLenses {
		return {
			loaded: this.loaded.map((lens) => lens.name),
			selected: this.covering.map(({ lens, covers }) => ({ name: lens.name, covers, band: this.band(lens) })),
		};
	}
}
