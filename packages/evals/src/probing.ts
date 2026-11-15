import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import {
	Changeset,
	type Finding,
	type FindingSource,
	Lens,
	type LensLevels,
	type LensTier,
	lensTierSchema,
	type MelianConfig,
	parseModelReference,
	VerificationState,
	visibleText,
} from "@melian-agent/core";
import { type ProbeAvailability, type ReviewModels, StageTelemetry, type WriterTrust } from "@melian-agent/pipeline";
import Type, { type Static } from "typebox";
import Value from "typebox/value";
import {
	type Golden,
	type GoldenRun,
	type GoldenScore,
	type LiveGoldenMode,
	type ProbingRoute,
	type RangeRun,
	type ReviewTarget,
	scoreCorpus,
	scoreGolden,
	selectGoldens,
} from "./goldens.ts";
import { attempt, shownOutput } from "./live-output.ts";
import { GoldenRunError } from "./run-error.ts";
import { EvalThinking } from "./thinking.ts";

type Print = (line: string) => void;

const probingLens = "trust-boundary";
const probingCheck = `lens.${probingLens}`;

/** The goldens a probing measurement scores: those named for `trust-boundary`'s level that probes. */
export const probingGoldenPrefix = "trust-boundary-probe-";

/**
 * One combination a probing measurement runs: a planner's model on `trust-boundary`'s own route and a prober's on
 * `proberTier`, or, without a prober, the level without probes on the planner's model.
 */
export class ProbingCombination implements ProbingRoute {
	readonly label: string;
	readonly planner: string;
	readonly prober: string | undefined;
	readonly proberTier: LensTier;

	private constructor(label: string, planner: string, prober: string | undefined, proberTier: LensTier) {
		this.label = label;
		this.planner = planner;
		this.prober = prober;
		this.proberTier = proberTier;
	}

	/** Parses `label=planner>prober`, or `label=model` for the level without probes. */
	static parse(entry: string, proberTier: LensTier): ProbingCombination {
		const match = /^([a-z0-9][a-z0-9-]*)\s*=(.+)$/.exec(entry.trim());
		if (match === null)
			throw new Error(
				`MELIAN_EVAL_PROBE_ROUTES needs label=planner>prober or label=model entries; invalid entry ${visibleText(JSON.stringify(entry))}`,
			);
		const models = match[2]!.split(">");
		if (models.length > 2)
			throw new Error(
				`MELIAN_EVAL_PROBE_ROUTES entry ${match[1]} names more than two models; a model ID cannot hold ">"`,
			);
		const [planner, prober] = models.map((model) => {
			const { provider, modelId } = parseModelReference(model, probingLens, `MELIAN_EVAL_PROBE_ROUTES ${match[1]}`);
			return `${provider}/${modelId}`;
		});
		return new ProbingCombination(match[1]!, planner!, prober, proberTier);
	}

	get probes(): boolean {
		return this.prober !== undefined;
	}

	routed(config: MelianConfig, lenses: readonly Lens[]): { config: MelianConfig; lenses: readonly Lens[] } {
		const own = Object.hasOwn(config.lenses, probingLens) ? config.lenses[probingLens] : undefined;
		// Each route keeps its tier's reasoning level, so a pair runs as it would ship.
		const route = (model: string, tier: LensTier) => {
			const thinking = config.models[tier]?.thinking;
			return { model, ...(thinking === undefined ? {} : { thinking }) };
		};
		const routedConfig: MelianConfig = {
			...config,
			lenses: { ...config.lenses, [probingLens]: { ...own, route: route(this.planner, "heavy") } },
			models:
				this.prober === undefined
					? config.models
					: { ...config.models, [this.proberTier]: route(this.prober, this.proberTier) },
		};
		const routedLenses = lenses.map((lens) => {
			if (lens.name !== probingLens) return lens;
			const levels = Object.fromEntries(
				Object.entries(lens.levels).map(([level, settings]) => {
					// No committed level probes until this measurement picks its routes, so `deep` is the level measured.
					const probing = settings.probe ?? (level === "deep" ? {} : undefined);
					if (probing === undefined) return [level, settings];
					const { probe: _, ...rest } = settings;
					return [
						level,
						this.prober === undefined ? rest : { ...rest, probe: { ...probing, prober: this.proberTier } },
					];
				}),
			) as LensLevels;
			return Lens.from({ ...lens.toJSON(), levels });
		});
		return { config: routedConfig, lenses: routedLenses };
	}

	toJSON(): { label: string; planner: string; prober?: string; proberTier?: LensTier } {
		return {
			label: this.label,
			planner: this.planner,
			...(this.prober === undefined ? {} : { prober: this.prober, proberTier: this.proberTier }),
		};
	}
}

const missSchema = Type.Object(
	{
		name: Type.String({ minLength: 1 }),
		repo: Type.String({ minLength: 1 }),
		base: Type.String({ minLength: 1 }),
		head: Type.String({ minLength: 1 }),
		file: Type.String({ minLength: 1 }),
		rule: Type.String({ minLength: 1 }),
		fix: Type.Optional(Type.String({ minLength: 1 })),
		lines: Type.Optional(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])),
	},
	{ additionalProperties: false },
);
const missesSchema = Type.Array(missSchema, { minItems: 1 });

/**
 * Where a miss's defect sits, which decides whether a finding answers it: the lines a misses file names, the lines its
 * fix changed, or only its file and rule, which leaves a hit for the reader to adjudicate.
 */
export type MissLocation =
	| { readonly by: "lines"; readonly ranges: readonly (readonly [number, number])[] }
	| { readonly by: "fix"; readonly fixCommit: string; readonly ranges: readonly (readonly [number, number])[] }
	| { readonly by: "file and rule" };

/**
 * A `trust-boundary` sighting at a miss's file under its rule, as the results file shows it for adjudication: its lines
 * and words are the ones `sightedBy`, that lens at one of its levels, reported, whichever claim speaks for its defect.
 */
export interface MissFinding {
	readonly id: string;
	readonly lines: readonly [number, number];
	readonly headline: string;
	readonly failureScenario?: string;
	readonly sightedBy: FindingSource;
	/** For a hit on a fix of several hunks in the miss's file, the hunks it overlaps, for the reader to adjudicate. */
	readonly hunks?: readonly (readonly [number, number])[];
}

/**
 * What a review found of a miss: the findings that answer it, and those at its file under its rule beside its lines.
 * A fix of several hunks in the file may repair more than the miss, so a hit on one is `fix hunks`, left to the reader
 * as a hit by file and rule is.
 */
export type MissMatch =
	| {
			readonly matched: "lines" | "file and rule";
			readonly hits: readonly MissFinding[];
			readonly near: readonly MissFinding[];
	  }
	| {
			readonly matched: "fix hunks";
			readonly hunks: readonly (readonly [number, number])[];
			readonly hits: readonly MissFinding[];
			readonly near: readonly MissFinding[];
	  };

/** A `needs-execution` miss: a finding a review missed in a range of a clone, which only running code would catch. */
export class Miss {
	readonly name: string;
	readonly repo: string;
	readonly base: string;
	readonly head: string;
	readonly file: string;
	readonly rule: string;
	readonly fix?: string;
	readonly lines?: readonly [number, number];

	private constructor(fields: Static<typeof missSchema>) {
		this.name = fields.name;
		this.repo = fields.repo;
		this.base = fields.base;
		this.head = fields.head;
		this.file = fields.file;
		this.rule = fields.rule;
		this.fix = fields.fix;
		this.lines = fields.lines;
	}

	/**
	 * Reads a misses file: a JSON array of `{ name, repo, base, head, file, rule, fix?, lines? }`, where `fix` names the
	 * commit that fixed the miss and `lines` is the first and last line of its defect at the head.
	 */
	static load(path: string): Miss[] {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!Value.Check(missesSchema, parsed) || parsed.some(({ lines }) => lines !== undefined && lines[0] > lines[1]))
			throw new Error(
				`${path} must be a JSON array of misses, each { name, repo, base, head, file, rule, fix?, lines? }`,
			);
		return parsed.map((fields) => new Miss(fields));
	}

	/**
	 * Where the miss's defect sits: its own `lines`, or else the old side of each hunk its fix's diff from the head makes
	 * in its file, a pure insertion widened to the lines around it. Throws when the fix changes nothing in the file.
	 */
	async locate(): Promise<MissLocation> {
		if (this.lines !== undefined) return { by: "lines", ranges: [this.lines] };
		if (this.fix === undefined) return { by: "file and rule" };
		const fixCommit = this.commit(this.fix);
		const { revision } = await Changeset.resolve(this.repo, {
			base: this.headCommit(),
			head: fixCommit,
			mode: "twoDot",
		});
		const hunks = revision.files
			.filter((file) => (file.oldPath ?? file.path) === this.file)
			.flatMap((file) => file.hunks);
		if (hunks.length === 0) throw new Error(`${this.name}: its fix ${fixCommit} changes nothing in ${this.file}`);
		const ranges = hunks.map(({ oldStart, oldLines }): [number, number] =>
			oldLines === 0 ? [Math.max(oldStart, 1), oldStart + 1] : [oldStart, oldStart + oldLines - 1],
		);
		return { by: "fix", fixCommit, ranges };
	}

	/** The commit the head names in the clone, which is what a trust decision vouches for. */
	headCommit(): string {
		return this.commit(this.head);
	}

	private commit(name: string): string {
		return execFileSync("git", ["-C", this.repo, "rev-parse", "--verify", "--end-of-options", `${name}^{commit}`], {
			encoding: "utf8",
		}).trim();
	}

	/**
	 * The range to review, between the commits its base and head resolve to now, so every pass reviews the same code:
	 * `trust-boundary` alone, every level its `deep`, under the base's policy. Its head is the reviewer's own only when
	 * `trust` vouches for its commit.
	 */
	target(trust: ProbeTrust): ReviewTarget & { readonly head: string } {
		const base = this.commit(this.base);
		const head = this.headCommit();
		const writer: WriterTrust = trust.vouches(head)
			? { trusted: true, by: "reviewer" }
			: { trusted: false, detail: `this invocation does not vouch for ${head}` };
		return {
			repo: this.repo,
			base,
			head,
			range: `${base}...${head}`,
			writer,
			sightingsOf: probingCheck,
			scope: (config, lenses) => ({
				config: {
					...config,
					tiers: { ...config.tiers, full: [probingCheck] },
					stages: { ...config.stages, "pull-request": "full" },
				},
				lenses: lenses.map((lens) => {
					if (lens.name !== probingLens) return lens;
					// Whichever level the review picks probes: routing adds a prober only to a level that probes, or to `deep`.
					const deep = lens.level("deep");
					const probing = { ...deep, probe: deep.probe ?? {} };
					return Lens.from({ ...lens.toJSON(), levels: { quick: probing, careful: probing, deep: probing } });
				}),
			}),
		};
	}

	/**
	 * What a review found of the miss, scored on `trust-boundary`'s own sightings, since a merged finding keeps only its
	 * speaker's lines. A sighting answers the miss when the verdict holds its claim, by ID, unrefuted, and it sits at the
	 * miss's file under its rule and overlaps its lines; with no lines, file and rule alone decide. Throws when the
	 * sightings and the verdict's claims disagree, which leaves the miss unscored rather than missed.
	 */
	match(run: Pick<RangeRun, "findings" | "sightings">, location: MissLocation): MissMatch {
		const { sightings } = run;
		if (sightings === undefined)
			throw new Error(`${this.name}: its review returned no ${probingCheck} sightings to score`);
		const unrefuted = new Map<string, boolean>();
		for (const finding of run.findings)
			for (const claim of VerificationState.from(finding).claims)
				if (claim.source.check === probingCheck)
					unrefuted.set(claim.id, unrefuted.get(claim.id) === true || claim.verification?.verdict !== "refuted");
		for (const sighting of sightings)
			if (!unrefuted.has(sighting.id))
				throw new Error(
					`${this.name}: ${probingCheck} sighted ${sighting.id}, which the verdict holds no claim for`,
				);
		const sighted = new Set(sightings.map((sighting) => sighting.id));
		for (const id of unrefuted.keys())
			if (!sighted.has(id))
				throw new Error(
					`${this.name}: the verdict holds a ${probingCheck} claim ${id} that the lens never sighted`,
				);
		const shown = (sighting: Finding): MissFinding => ({
			id: sighting.id,
			lines: sighting.lines(),
			headline: sighting.headline().headline,
			failureScenario: sighting.properties.failureScenario,
			sightedBy: sighting.properties.source,
		});
		const claims = sightings.filter(
			(sighting) =>
				unrefuted.get(sighting.id) === true &&
				sighting.ruleId === this.rule &&
				(sighting.properties.path ?? sighting.locations[0]!.physicalLocation.artifactLocation.uri) === this.file,
		);
		if (location.by === "file and rule") return { matched: "file and rule", hits: claims.map(shown), near: [] };
		const overlapped = (finding: Finding) => {
			const [start, end] = finding.lines();
			return location.ranges.filter(([first, last]) => first <= end && start <= last);
		};
		const near = claims.filter((finding) => overlapped(finding).length === 0).map(shown);
		const hits = claims.filter((finding) => overlapped(finding).length > 0);
		if (location.by === "fix" && location.ranges.length > 1)
			return {
				matched: "fix hunks",
				hunks: location.ranges,
				hits: hits.map((finding) => ({ ...shown(finding), hunks: overlapped(finding) })),
				near,
			};
		return { matched: "lines", hits: hits.map(shown), near };
	}
}

/** The heads an invocation vouches for, by commit, so a miss's probes run only on code the reviewer has read. */
export class ProbeTrust {
	private readonly commits: ReadonlySet<string>;

	private constructor(commits: ReadonlySet<string>) {
		this.commits = commits;
	}

	/** Parses MELIAN_EVAL_PROBE_TRUST: full commit IDs, separated by commas. */
	static parse(value = ""): ProbeTrust {
		const commits = value
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "");
		const invalid = commits.find((commit) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit));
		if (invalid !== undefined)
			throw new Error(
				`MELIAN_EVAL_PROBE_TRUST needs full commit IDs; invalid entry ${visibleText(JSON.stringify(invalid))}`,
			);
		return new ProbeTrust(new Set(commits));
	}

	vouches(commit: string): boolean {
		return this.commits.has(commit);
	}
}

/** Which corpus a probing measurement runs. */
export type ProbingSet = "goldens" | "misses" | "all";

/** A probing measurement's settings, parsed from the environment as `live.ts` parses its own. */
export class ProbingSettings {
	readonly combinations: readonly ProbingCombination[];
	readonly passes: number;
	readonly set: ProbingSet;
	readonly thinking: EvalThinking;
	readonly model: string | undefined;
	readonly verifierModel: string;
	readonly golden: string | undefined;
	readonly misses: string | undefined;
	readonly trust: ProbeTrust;
	readonly out: string | undefined;

	private constructor(fields: {
		combinations: readonly ProbingCombination[];
		passes: number;
		set: ProbingSet;
		thinking: EvalThinking;
		model: string | undefined;
		verifierModel: string;
		golden: string | undefined;
		misses: string | undefined;
		trust: ProbeTrust;
		out: string | undefined;
	}) {
		this.combinations = fields.combinations;
		this.passes = fields.passes;
		this.set = fields.set;
		this.thinking = fields.thinking;
		this.model = fields.model;
		this.verifierModel = fields.verifierModel;
		this.golden = fields.golden;
		this.misses = fields.misses;
		this.trust = fields.trust;
		this.out = fields.out;
	}

	/** Parses the settings, throwing on any malformed one, before anything reaches a provider. */
	static parse(env: NodeJS.ProcessEnv): ProbingSettings {
		const thinking = EvalThinking.parse(env.MELIAN_EVAL_THINKING);
		const tier = env.MELIAN_EVAL_PROBER_TIER || "medium";
		if (!Value.Check(lensTierSchema, tier))
			throw new Error(
				`MELIAN_EVAL_PROBER_TIER must be light, medium or heavy, not ${visibleText(JSON.stringify(tier))}`,
			);
		const combinations = (env.MELIAN_EVAL_PROBE_ROUTES ?? "")
			.split(";")
			.filter((entry) => entry.trim() !== "")
			.map((entry) => ProbingCombination.parse(entry, tier));
		if (combinations.length === 0) throw new Error("MELIAN_EVAL_PROBE_ROUTES names no combination");
		const labels = combinations.map(({ label }) => label);
		const repeated = labels.find((label, index) => labels.indexOf(label) !== index);
		if (repeated !== undefined) throw new Error(`MELIAN_EVAL_PROBE_ROUTES repeats the label ${repeated}`);
		const passes = Number(env.MELIAN_EVAL_PROBE_PASSES ?? "3");
		if (!Number.isInteger(passes) || passes < 1) throw new Error("MELIAN_EVAL_PROBE_PASSES must be 1 or more");
		const verifier = env.MELIAN_EVAL_VERIFIER_MODEL ?? "";
		const { provider, modelId } = parseModelReference(verifier, "verifier", "MELIAN_EVAL_VERIFIER_MODEL");
		const misses = env.MELIAN_EVAL_MISSES || undefined;
		const set = env.MELIAN_EVAL_PROBE_SET || (misses === undefined ? "goldens" : "all");
		if (set !== "goldens" && set !== "misses" && set !== "all")
			throw new Error(
				`MELIAN_EVAL_PROBE_SET must be goldens, misses or all, not ${visibleText(JSON.stringify(set))}`,
			);
		if (set !== "goldens" && misses === undefined)
			throw new Error(`MELIAN_EVAL_PROBE_SET=${set} needs MELIAN_EVAL_MISSES`);
		const model = env.MELIAN_EVAL_MODEL || undefined;
		if (model !== undefined) parseModelReference(model, "every tier", "MELIAN_EVAL_MODEL");
		return new ProbingSettings({
			combinations,
			passes,
			set,
			thinking,
			model,
			verifierModel: `${provider}/${modelId}`,
			golden: env.MELIAN_EVAL_GOLDEN || undefined,
			misses,
			trust: ProbeTrust.parse(env.MELIAN_EVAL_PROBE_TRUST),
			out: env.MELIAN_EVAL_PROBE_OUT || undefined,
		});
	}

	get probes(): boolean {
		return this.combinations.some((combination) => combination.probes);
	}

	mode(models: ReviewModels, combination: ProbingCombination): LiveGoldenMode {
		return {
			kind: "live",
			models,
			thinking: this.thinking,
			verifierModel: this.verifierModel,
			probing: combination,
			...(this.model === undefined ? {} : { model: this.model }),
		};
	}
}

/**
 * One review of one pass: its golden's score or whether it found its miss, or why it had neither; the notes its lenses
 * recorded; the other lens checks that ran on the prober's tier; and its telemetry, whose prober stages hold the attacks
 * planned, each probe's outcome and the skips. A review that failed has telemetry only when it got as far as a review.
 */
export interface ProbingReview {
	readonly name: string;
	readonly kind: "golden" | "miss";
	readonly score?: GoldenScore;
	readonly found?: boolean;
	readonly matched?: MissMatch["matched"];
	readonly hits?: MissMatch["hits"];
	readonly near?: MissMatch["near"];
	/** For a miss located by a fix of several hunks in its file, those hunks. */
	readonly hunks?: readonly (readonly [number, number])[];
	readonly error?: string;
	readonly notes: RangeRun["notes"];
	readonly sharedProberTier: readonly string[];
	readonly spend?: string;
	readonly telemetry?: ReturnType<StageTelemetry["toJSON"]>;
}

/** What one pass of one combination scored. A score is absent when a review of its corpus had none. */
export interface ProbingPass {
	readonly goldens?: { readonly precision: number; readonly recall: number };
	readonly misses?: { readonly found: number; readonly total: number };
	readonly failed: readonly string[];
	readonly reviews: readonly ProbingReview[];
}

/** What one combination scored over every pass. Its worst and mean are absent unless every review had a score. */
export interface ProbingCombinationResult {
	readonly combination: ReturnType<ProbingCombination["toJSON"]>;
	readonly passes: readonly ProbingPass[];
	readonly worst?: ProbingSummary;
	readonly mean?: ProbingSummary;
	readonly spend: string;
	/** The other lens checks that ran on the prober's tier, and so on the prober's model, in any pass. */
	readonly sharedProberTier: readonly string[];
}

export interface ProbingSummary {
	readonly precision?: number;
	readonly recall?: number;
	readonly missRecall?: number;
}

/** The runners a measurement calls, so a test can stand in for providers and clones. */
export interface ProbingRunners {
	readonly availability: () => Promise<ProbeAvailability>;
	readonly models: () => Promise<ReviewModels>;
	readonly goldens: () => Golden[];
	readonly golden: (golden: Golden, mode: LiveGoldenMode) => Promise<GoldenRun>;
	readonly range: (target: ReviewTarget, mode: LiveGoldenMode) => Promise<RangeRun>;
}

const fixed = (value: number) => value.toFixed(2);

function summary(passes: readonly ProbingPass[], pick: (values: readonly number[]) => number): ProbingSummary {
	const goldens = passes.flatMap((pass) => (pass.goldens === undefined ? [] : [pass.goldens]));
	const misses = passes.flatMap((pass) => (pass.misses === undefined ? [] : [pass.misses]));
	return {
		...(goldens.length === 0
			? {}
			: {
					precision: pick(goldens.map(({ precision }) => precision)),
					recall: pick(goldens.map(({ recall }) => recall)),
				}),
		...(misses.length === 0 ? {} : { missRecall: pick(misses.map(({ found, total }) => found / total)) }),
	};
}

function rendered(label: string, values: ProbingSummary): string {
	const parts = [
		...(values.precision === undefined ? [] : [`precision ${fixed(values.precision)}`]),
		...(values.recall === undefined ? [] : [`recall ${fixed(values.recall)}`]),
		...(values.missRecall === undefined ? [] : [`miss recall ${fixed(values.missRecall)}`]),
	];
	return `${label} ${parts.join(", ")}`;
}

/**
 * Runs each combination over the selected corpus `passes` times, printing a line for each review with the notes its
 * lenses recorded, such as the attacks the planner planned and the probes that ran. Fails before any provider on a
 * setting the run cannot honour. Returns the exit status: 0 when every review scored, 1 when one did not, 2 when the
 * run never started.
 */
export async function measureProbing(
	env: NodeJS.ProcessEnv,
	runners: ProbingRunners,
	print: Print,
	printError: Print,
): Promise<0 | 1 | 2> {
	let settings: ProbingSettings;
	let goldens: Golden[];
	let misses: { miss: Miss; target: ReviewTarget & { readonly head: string }; location: MissLocation }[];
	let save: (complete: boolean, results: readonly ProbingCombinationResult[]) => void;
	try {
		settings = ProbingSettings.parse(env);
		const probing = runners.goldens().filter((golden) => golden.name.startsWith(probingGoldenPrefix) && golden.live);
		goldens = settings.set === "misses" ? [] : selectGoldens(probing, settings.golden);
		misses =
			settings.set === "goldens"
				? []
				: await Promise.all(
						Miss.load(settings.misses!).map(async (miss) => ({
							miss,
							target: miss.target(settings.trust),
							location: await miss.locate(),
						})),
					);
		const unvouched = misses.filter(({ target }) => !target.writer.trusted).map(({ miss }) => miss.name);
		if (settings.probes && unvouched.length > 0)
			throw new Error(
				`MELIAN_EVAL_PROBE_TRUST does not vouch for the heads of ${unvouched.join(", ")}, so their probes cannot run`,
			);
		if (settings.probes) {
			const availability = await runners.availability();
			if (!availability.available) throw new Error(`Probes cannot run on this host: ${availability.reason}`);
		}
		const checkout = (...args: string[]) =>
			execFileSync("git", ["-C", import.meta.dirname, ...args], { encoding: "utf8" }).trim();
		const measured = {
			version: 1,
			commit: checkout("rev-parse", "HEAD"),
			clean: checkout("status", "--porcelain") === "",
			verifier: settings.verifierModel,
			passes: settings.passes,
			misses: misses.map(({ miss, target, location }) => ({
				name: miss.name,
				repo: miss.repo,
				base: miss.base,
				head: miss.head,
				file: miss.file,
				rule: miss.rule,
				fix: miss.fix,
				lines: miss.lines,
				baseCommit: target.base,
				headCommit: target.head,
				location,
			})),
		};
		// Written whole through a rename after each pass, so a cut run leaves the passes it finished, never a torn file.
		save = (complete, results) => {
			if (settings.out === undefined) return;
			const written = `${settings.out}.${process.pid}.tmp`;
			writeFileSync(written, `${JSON.stringify({ ...measured, complete, results }, null, 2)}\n`);
			renameSync(written, settings.out);
		};
		save(false, []);
	} catch (error) {
		printError(visibleText(error instanceof Error ? error.message : String(error)));
		return 2;
	}
	const models = await runners.models();
	const results: ProbingCombinationResult[] = [];
	for (const combination of settings.combinations) {
		const mode = settings.mode(models, combination);
		print(
			visibleText(
				combination.prober === undefined
					? `${combination.label}: ${combination.planner}, without probes`
					: `${combination.label}: planner ${combination.planner}, prober ${combination.prober} on the ${combination.proberTier} tier`,
			),
		);
		const telemetry: StageTelemetry[] = [];
		const shared = new Set<string>();
		const passes: ProbingPass[] = [];
		const summarised = (): ProbingCombinationResult => ({
			combination: combination.toJSON(),
			passes: [...passes],
			...(passes.length === settings.passes && passes.every((pass) => pass.failed.length === 0)
				? {
						worst: summary(passes, (values) => Math.min(...values)),
						mean: summary(passes, (values) => values.reduce((sum, value) => sum + value, 0) / values.length),
					}
				: {}),
			spend: new StageTelemetry(
				combination.label,
				telemetry.flatMap(({ stages }) => stages),
			).spend(),
			sharedProberTier: [...shared].sort(),
		});
		for (let pass = 1; pass <= settings.passes; pass += 1) {
			const failed: string[] = [];
			const scores = [];
			const reviews: ProbingReview[] = [];
			const record = (
				run: RangeRun,
				line: string,
				review: Pick<ProbingReview, "name" | "kind" | "score" | "found" | "matched" | "hits" | "near" | "hunks">,
			) => {
				telemetry.push(run.telemetry);
				const sharing = Object.entries(run.tiers)
					.filter(
						([check, tier]) =>
							combination.prober !== undefined && check !== probingCheck && tier === combination.proberTier,
					)
					.map(([check]) => check)
					.sort();
				for (const check of sharing) shared.add(check);
				reviews.push({
					...review,
					notes: run.notes,
					sharedProberTier: sharing,
					spend: run.telemetry.spend(),
					telemetry: run.telemetry.toJSON(),
				});
				print(visibleText(`${line}, ${run.telemetry.spend()}`));
				for (const { reason, checks } of run.notes) print(visibleText(`    ${checks.join(", ")}: ${reason}`));
				for (const shown of shownOutput(run.rendered, env)) print(shown);
			};
			const tried = async <Run>(name: string, kind: ProbingReview["kind"], run: () => Promise<Run>) =>
				attempt(`${combination.label} pass ${pass} ${name}`, run, print, (error) => {
					const ran = error instanceof GoldenRunError ? error.telemetry : undefined;
					if (ran !== undefined) telemetry.push(ran);
					failed.push(name);
					reviews.push({
						name,
						kind,
						error: error instanceof Error ? error.message : String(error),
						notes: [],
						sharedProberTier: [],
						...(ran === undefined ? {} : { spend: ran.spend(), telemetry: ran.toJSON() }),
					});
				});
			for (const golden of goldens) {
				const run = await tried(golden.name, "golden", () => runners.golden(golden, mode));
				if (run === undefined) continue;
				const score = scoreGolden(golden, run.findings);
				scores.push(score);
				record(
					run,
					`${combination.label} pass ${pass} ${golden.name}: precision ${fixed(score.precision)}, recall ${fixed(score.recall)} (${score.reported} reported, ${score.expected} expected)`,
					{ name: golden.name, kind: "golden", score },
				);
			}
			let found = 0;
			for (const { miss, target, location } of misses) {
				const scored = await tried(miss.name, "miss", async () => {
					const run = await runners.range(target, mode);
					try {
						return { run, match: miss.match(run, location) };
					} catch (error) {
						throw new GoldenRunError(error, run.telemetry);
					}
				});
				if (scored === undefined) continue;
				const { run, match } = scored;
				const hit = match.hits.length > 0;
				if (hit) found += 1;
				const span = (ranges: readonly (readonly [number, number])[]) =>
					ranges.map(([first, last]) => `${first}-${last}`).join(", ");
				const said = !hit
					? "missed"
					: match.matched === "fix hunks"
						? `found, unadjudicated: the fix changed ${match.hunks.length} hunks in ${miss.file} (${span(match.hunks)}), and the hits overlap ${span(match.hunks.filter((hunk) => match.hits.some((each) => each.hunks?.includes(hunk))))}`
						: match.matched === "lines"
							? "found"
							: "found, unadjudicated: matched by file and rule alone";
				record(run, `${combination.label} pass ${pass} ${miss.name}: ${said}`, {
					name: miss.name,
					kind: "miss",
					found: hit,
					...match,
				});
			}
			passes.push({
				...(goldens.length === 0 || failed.some((name) => goldens.some((golden) => golden.name === name))
					? {}
					: { goldens: scoreCorpus(scores) }),
				...(misses.length === 0 || failed.some((name) => misses.some(({ miss }) => miss.name === name))
					? {}
					: { misses: { found, total: misses.length } }),
				failed,
				reviews,
			});
			save(false, [...results, summarised()]);
		}
		const result = summarised();
		results.push(result);
		print(
			visibleText(
				result.worst === undefined || result.mean === undefined
					? `${combination.label}: no score, ${passes.flatMap((pass) => pass.failed).length} reviews had none, ${result.spend}`
					: `${combination.label}: ${rendered("worst", result.worst)}; ${rendered("mean", result.mean)}; ${result.spend}`,
			),
		);
		if (combination.prober !== undefined)
			print(
				visibleText(
					`${combination.label}: other lens checks on the prober's ${combination.proberTier} tier: ${result.sharedProberTier.join(", ") || "none"}`,
				),
			);
	}
	save(true, results);
	return results.every((result) => result.worst !== undefined) ? 0 : 1;
}
