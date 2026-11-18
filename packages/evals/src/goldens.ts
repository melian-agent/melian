import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ChangedFile,
	Changeset,
	type CheckRecord,
	causeSchema,
	checksOfTier,
	deterministicChecks,
	evaluateGuardrails,
	evidenceRevisionSchema,
	evidenceRoleSchema,
	type Finding,
	type FindingSource,
	FindingsLog,
	Lens,
	type LensTier,
	loadConfig,
	type MelianConfig,
	type MemberClaim,
	type ModelRoute,
	type RepositorySource,
	Revision,
	Standards,
	type Verdict,
	verificationSchema,
} from "@melian-agent/core";
import {
	backgroundContext,
	CallerContext,
	configsFor,
	createMemoryStorage,
	createNodeExecutionEnv,
	openReviewHarness,
	openSqliteStorage,
	type ProberRecord,
	type ReviewModels,
	readFindings,
	reviewChangeset,
	type StageTelemetry,
	type Storage,
	TelemetryReader,
	type WriterTrust,
} from "@melian-agent/pipeline";
import { createFakeModels, scriptLenses, unconfinedSandbox } from "@melian-agent/pipeline/testing";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { parse } from "yaml";
import { GoldenRunError } from "./run-error.ts";
import type { EvalThinking } from "./thinking.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });

/** The JSON Schema of one expected evidence location, in the shape a lens gives it to `report_finding`. */
export const goldenEvidenceSchema = Type.Object(
	{
		file: text,
		line: Type.Integer({ minimum: 1 }),
		endLine: Type.Optional(Type.Integer({ minimum: 1 })),
		role: evidenceRoleSchema,
		revision: Type.Optional(evidenceRevisionSchema),
	},
	strict,
);

/**
 * The JSON Schema of one expected finding: Martian's golden comment (`comment`, `severity`, `category`), so Martian's
 * judge reads it unchanged, plus the fields Melian matches on (`file` or one of `alternativeFiles`, `rule` or one of
 * `alternativeRules`, `lines`, the first and last line a finding must overlap, and `source`, a check that must be among
 * the finding's `reportedBy`, such as `lens.tests`) and those a scripted run checks (`cause`, `failureScenario`,
 * `evidence`).
 */
export const goldenCommentSchema = Type.Object(
	{
		comment: text,
		severity: Type.Union([
			Type.Literal("Critical"),
			Type.Literal("High"),
			Type.Literal("Medium"),
			Type.Literal("Low"),
		]),
		category: text,
		file: text,
		alternativeFiles: Type.Optional(Type.Array(text, { minItems: 1, uniqueItems: true })),
		rule: text,
		alternativeRules: Type.Optional(Type.Array(text, { minItems: 1, uniqueItems: true })),
		lines: Type.Optional(Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })])),
		source: Type.Optional(text),
		cause: causeSchema,
		failureScenario: text,
		evidence: Type.Array(goldenEvidenceSchema, { minItems: 1 }),
	},
	strict,
);

/**
 * The JSON Schema of a golden's `expected.json`, in Martian's per-pull-request shape, plus Melian's `live`: `false`
 * keeps a golden out of live runs, for one whose expectation only the scripted run can meet.
 */
export const expectedSchema = Type.Object(
	{
		pr_title: text,
		url: Type.Optional(text),
		live: Type.Optional(Type.Boolean()),
		comments: Type.Array(goldenCommentSchema),
	},
	strict,
);

const scriptReplySchema = Type.Union([
	Type.Object(
		{
			calls: Type.Array(
				Type.Object(
					{
						name: text,
						arguments: Type.Record(Type.String(), Type.Unknown()),
						// A substring the call's result must contain, so a tool that breaks fails the gate.
						expectToolResult: Type.Optional(text),
					},
					strict,
				),
				{ minItems: 1 },
			),
		},
		strict,
	),
	Type.Object({ text: Type.String() }, strict),
]);

/** The JSON Schema of a golden's `script.json`: each lens's replies, by lens name, for the scripted runner. */
export const scriptSchema = Type.Record(Type.String(), Type.Array(scriptReplySchema));

/**
 * The JSON Schema of a golden's optional `verifier.json`: the scripted verifier's verdict on each finding, by finding
 * ID, with its reason and the evidence that backs it. A finding it leaves out is confirmed.
 */
export const verifierScriptSchema = Type.Record(
	Type.String({ pattern: "^[0-9a-f]{16}$" }),
	Type.Object(
		{
			verdict: verificationSchema.properties.verdict,
			reason: text,
			evidence: Type.Optional(Type.Array(goldenEvidenceSchema, { minItems: 1 })),
		},
		strict,
	),
	strict,
);

/** One expected finding. */
export type GoldenComment = Static<typeof goldenCommentSchema>;

/** A golden's `expected.json`. */
export type Expected = Static<typeof expectedSchema>;

/** A golden's `script.json`. */
export type Script = Static<typeof scriptSchema>;

/** A golden's `verifier.json`. */
export type VerifierVerdicts = Static<typeof verifierScriptSchema>;

/** One golden: a base and head tree, what a review of the change must find, and the lens replies that find it. */
export interface Golden {
	readonly name: string;
	readonly directory: string;
	readonly expected: Expected;
	readonly script: Script;
	/** The scripted verifier's verdicts from `verifier.json`, when the golden has one. */
	readonly verifier?: VerifierVerdicts;
	/** Whether live runs review it: false when its `expected.json` sets `live: false`. Scripted runs review every golden. */
	readonly live: boolean;
}

/** Where the corpus lives: one directory per golden. */
export const goldensDirectory = fileURLToPath(new URL("../goldens/", import.meta.url));

function readJson<T>(file: string, schema: TSchema): T {
	const value: unknown = JSON.parse(readFileSync(file, "utf8"));
	const error = [...Value.Errors(schema, value)][0];
	if (error !== undefined) throw new Error(`${file}: ${error.instancePath || "(top level)"} ${error.message}`);
	return value as T;
}

// The directory under the goldens that holds the resolution goldens, which have a shape of their own.
export const resolutionGoldens = "resolution";

/** Loads every golden under `directory`, in name order, leaving the resolution goldens to their own loader. */
export function loadGoldens(directory: string = goldensDirectory): Golden[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name !== resolutionGoldens)
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const root = join(directory, name);
			const expected = readJson<Expected>(join(root, "expected.json"), expectedSchema);
			const verifier = join(root, "verifier.json");
			return {
				name,
				directory: root,
				expected,
				script: readJson<Script>(join(root, "script.json"), scriptSchema),
				...(existsSync(verifier) ? { verifier: readJson<VerifierVerdicts>(verifier, verifierScriptSchema) } : {}),
				live: expected.live !== false,
			};
		});
}

/**
 * The goldens a live run reviews: all of them, or only the one named `name`. Throws when no golden has that name, or
 * when the named golden sets `live: false`.
 */
export function selectGoldens(goldens: readonly Golden[], name: string | undefined): Golden[] {
	if (name === undefined || name === "") return [...goldens];
	const selected = goldens.filter((golden) => golden.name === name);
	if (selected.length === 0)
		throw new Error(`No golden is named ${name}. Goldens: ${goldens.map((golden) => golden.name).join(", ")}.`);
	if (selected.some((golden) => !golden.live))
		throw new Error(`${name} sets live: false in its expected.json, so it runs scripted only.`);
	return selected;
}

const gitEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_COUNT: "0",
	GIT_AUTHOR_NAME: "Melian Evals",
	GIT_AUTHOR_EMAIL: "evals@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Evals",
	GIT_COMMITTER_EMAIL: "evals@melian.invalid",
};

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
}

// Melian's own repository lenses, read from the checkout the corpus sits in.
const melianLenses = fileURLToPath(new URL("../../../.melian/lenses/", import.meta.url));

// A golden whose policy sets tiers runs Melian's own tier, as a test holds, so its repository gets Melian's repository
// lenses beside the built-ins: the prompts it scores are the ones Melian runs on itself, every hand-off with both sides.
// A lens the golden's tree commits under the same name is its own override, and the checkout's never replaces it.
function addMelianLenses(repo: string): void {
	const policy = join(repo, "melian.yaml");
	const value: unknown = existsSync(policy) ? parse(readFileSync(policy, "utf8")) : undefined;
	if (typeof value !== "object" || value === null || !("tiers" in value)) return;
	for (const name of readdirSync(melianLenses)) {
		const target = join(repo, ".melian/lenses", name, "LENS.md");
		if (existsSync(target)) continue;
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(melianLenses, name, "LENS.md"), target);
	}
}

// `AGENTS.golden.md` is `AGENTS.md`, and `melian.golden.yaml` is `melian.yaml`.
const inert = /\.golden(?=\.[^.]*$)/;

// Copies a golden's tree into `repo`, writing each file stored under an inert name under its live one.
export function copyTree(tree: string, repo: string): void {
	for (const entry of readdirSync(tree, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue;
		const target = join(repo, relative(tree, entry.parentPath), entry.name.replace(inert, ""));
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(entry.parentPath, entry.name), target);
	}
}

/**
 * Builds a golden's repository in a temporary directory: `base/` committed on `main`, with the golden's
 * `melian.golden.yaml` as `melian.yaml` when it has one, then `head/` replacing the tree on `feature`. A golden stores
 * its standards and policy under inert names, such as `AGENTS.golden.md`, so the repository it sits in never reads them
 * as its own; each is written here under its live name, `AGENTS.md`. The caller deletes `repo`.
 */
export function buildGoldenRepository(golden: Pick<Golden, "name" | "directory">): {
	repo: string;
	base: string;
	head: string;
} {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), `melian-golden-${golden.name}-`)));
	git(repo, "init", "--quiet", "--initial-branch=main");
	copyTree(join(golden.directory, "base"), repo);
	if (existsSync(join(golden.directory, "melian.golden.yaml")))
		cpSync(join(golden.directory, "melian.golden.yaml"), join(repo, "melian.yaml"));
	addMelianLenses(repo);
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "--quiet", "-b", "feature");
	return { repo, base, head: commitGoldenTree(repo, join(golden.directory, "head"), "head") };
}

// Replaces the tree of a golden's repository with `tree`, keeping the root `melian.yaml`, and commits it on the
// checked-out branch. Returns the commit.
export function commitGoldenTree(repo: string, tree: string, message: string): string {
	for (const entry of readdirSync(repo))
		if (entry !== ".git" && entry !== "melian.yaml") rmSync(join(repo, entry), { recursive: true });
	copyTree(tree, repo);
	addMelianLenses(repo);
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "--allow-empty", "-m", message);
	return git(repo, "rev-parse", "HEAD");
}

/** How a golden is run: on canned replies from its `script.json`, or on real models. */
export type GoldenMode =
	| {
			readonly kind: "scripted";
			/**
			 * `"unconfined"` runs a probing golden's probes outside any sandbox. Pass it only for the committed corpus, whose
			 * probes are reviewed scripts. Without it, they run in the host's sandbox. A live run's probes come from a model,
			 * so a live mode has no such field.
			 */
			readonly probes?: "unconfined";
	  }
	| {
			readonly kind: "live";
			readonly models: ReviewModels;
			/** `provider/model-id` for every tier the golden's `melian.golden.yaml` leaves unrouted. */
			readonly model?: string;
			/** A separate verifier route for a live run. */
			readonly verifierModel?: string;
			readonly thinking?: EvalThinking;
			/** One combination of a probing measurement, applied after `thinking`. */
			readonly probing?: ProbingRoute;
			/** A new SQLite file to keep the review's store in, so its conversations can be read after it. */
			readonly store?: string;
	  };

/** A live golden mode, the only kind that can review a range outside the corpus. */
export type LiveGoldenMode = Extract<GoldenMode, { kind: "live" }>;

/**
 * Re-routes a run's policy and lenses for one arm a measurement runs, given the change's files. With `graph`, the review
 * opens Enola's graph of the head for its lenses as the CLI does, and fails when the graph cannot be read.
 */
export interface ProbingRoute {
	readonly graph?: true;
	routed(
		config: MelianConfig,
		lenses: readonly Lens[],
		files: readonly ChangedFile[],
	): { config: MelianConfig; lenses: readonly Lens[] };
}

/** A range of a clone to review as a golden is reviewed: its base commit, the range, and whose code its head is. */
export interface ReviewTarget {
	readonly repo: string;
	readonly base: string;
	readonly range: string;
	readonly writer: WriterTrust;
	/** The commit whose policy, standards and lenses review the range, when not its base. */
	readonly policy?: string;
	/** Narrows the base's policy and lenses before the mode routes them. */
	readonly scope?: (
		config: MelianConfig,
		lenses: readonly Lens[],
	) => { config: MelianConfig; lenses: readonly Lens[] };
}

/** A range's review: the findings, the terminal rendering an author would see, and what each lens ran on. */
export interface RangeRun {
	readonly telemetry: StageTelemetry;
	/** Each prober stage's record, by stage ID: model and head text that telemetry leaves out, for a local results file. */
	readonly probers: Readonly<Record<string, ProberRecord>>;
	readonly findings: readonly Finding[];
	readonly rendered: string;
	/** In a scripted run, each scripted call whose result lacked its `expectToolResult`, described. */
	readonly toolMismatches: readonly string[];
	/**
	 * Each distinct note the review's lenses recorded, with the lenses that carry it, such as the attacks a probing lens
	 * planned and probed.
	 */
	readonly notes: readonly { readonly reason: string; readonly checks: readonly string[] }[];
	/** The tier each lens that ran was routed by, by check name. A lens on its own route has none. */
	readonly tiers: Readonly<Record<string, LensTier>>;
	/**
	 * Each lens check's findings at the head as it reported them, a read for each level: its own lines, message and
	 * failure scenario, before the verdict merged them with another check's.
	 */
	readonly sightings: readonly Finding[];
	/** The review's verdict. Its {@link Verdict.all} holds every claim it adjudicated, refuted and dismissed ones too. */
	readonly verdict: Verdict;
}

/** A golden's review. */
export interface GoldenRun extends RangeRun {
	readonly golden: Golden;
}

const tiers: readonly LensTier[] = ["light", "medium", "heavy"];

function routeEveryTier(config: MelianConfig, model: string, override: boolean): MelianConfig {
	const route: ModelRoute = { model };
	const models = Object.fromEntries(
		tiers.map((tier) => {
			const existing = config.models[tier];
			return [
				tier,
				override
					? route
					: existing?.model !== undefined || existing?.accept !== undefined
						? existing
						: { ...existing, model },
			];
		}),
	);
	return { ...config, models: { ...config.models, ...models } };
}

// A golden that expects a `guardrail/` finding also runs the guardrails, under the policy it commits. The others do not:
// the lenses are what they measure, and the default guardrails would add notices on every fixture's package.json.
// Each resolves as adjudication resolves it: under its own path's layers, and a notice under what judged it.
async function guardrailFindings(
	golden: Golden,
	repoRoot: string,
	changeset: Changeset,
	source: RepositorySource,
): Promise<Finding[]> {
	if (!golden.expected.comments.some((comment) => comment.rule.startsWith("guardrail/"))) return [];
	const { findings } = await evaluateGuardrails({ repoRoot, revision: changeset.revision, source });
	const policyFor = await configsFor(repoRoot, source, findings);
	return findings.map((finding) => finding.resolved(policyFor(finding.properties.path, finding.ruleId)));
}

// One read per level, since a read across a check's levels merges sightings of one ID into the most severe one's lines.
async function detached(
	storage: Storage,
	revision: string,
): Promise<{ telemetry: StageTelemetry; probers: Record<string, ProberRecord> }> {
	const reader = TelemetryReader.open(storage);
	const telemetry = await reader.read(revision);
	const probers: Record<string, ProberRecord> = {};
	for (const stage of telemetry.stages) {
		const record = await reader.proberRecord(stage);
		if (record !== undefined) probers[stage.id] = record;
	}
	return { telemetry, probers };
}

export async function sightingsAt(
	reader: Parameters<typeof readFindings>[0],
	root: Parameters<typeof readFindings>[1],
	revision: string,
	check: string,
): Promise<readonly Finding[]> {
	const read = (version?: string) =>
		readFindings(reader, root, revision, backgroundContext, { producers: [{ check, version }], asReported: true });
	const versions = new Set(
		(await read()).flatMap((merged) =>
			(merged.properties.reportedBy ?? [merged.properties.source]).map((source) => source.version),
		),
	);
	return (await Promise.all([...versions].map(read))).flat();
}

/**
 * Reviews a golden's change the way the CLI will: policy, standards, and lenses from the base commit, the range
 * `main...feature`, and every lens the change selects. Scripted runs answer each lens from `script.json` on the fake
 * model; live runs call real providers with the credentials `models` resolves.
 */
export async function runGolden(golden: Golden, mode: GoldenMode): Promise<GoldenRun> {
	const { repo, base } = buildGoldenRepository(golden);
	try {
		// The golden's repository is built here from the corpus, so its head is the reviewer's own.
		const target = { repo, base, range: "main...feature", writer: { trusted: true, by: "reviewer" } } as const;
		return { golden, ...(await reviewTarget(target, mode, golden)) };
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

// Opens Enola's graph of the head over the files the tier's lenses select, as the CLI does, whatever the base's policy
// says of Enola. A graph that cannot be read fails the review: scoring it would measure the arm without its graph.
async function graphOf(
	target: ReviewTarget,
	changeset: Changeset,
	config: MelianConfig,
	lenses: readonly Lens[],
	tier: string,
): Promise<CallerContext> {
	const run = new Set(
		checksOfTier(config, tier)
			.filter((name) => name.startsWith("lens."))
			.map((name) => name.slice(5)),
	);
	const selected = new Set(
		Lens.select(
			lenses.filter((lens) => run.has(lens.name)),
			config,
			changeset.revision.paths(),
		).flatMap((selection) => selection.files),
	);
	const callers = await CallerContext.open(
		{
			env: createNodeExecutionEnv(target.repo),
			repoRoot: target.repo,
			environment: process.env,
			base: changeset.revision.base,
			policyCommit: target.policy ?? target.base,
			commit: changeset.revision.head,
			tool: "enola",
			settings: { ...config.static.enola, enabled: true },
		},
		changeset.revision.files.filter(
			(file) => selected.has(file.path) || (file.oldPath !== undefined && selected.has(file.oldPath)),
		),
		backgroundContext,
		changeset.revision.files.map((file) => file.path),
	);
	if (callers.coverageSource() === undefined)
		throw new Error(
			`The arm needs Enola's graph of the head, which could not be read: ${callers.caveat() ?? "no graph"}`,
		);
	return callers;
}

/**
 * Reviews `target` live as {@link runGolden} reviews a golden: policy, standards, and lenses from its base, the checks a
 * host runs without a model skipped, and no score for a review that is not reviewed or whose probes did not run.
 */
export function runRange(target: ReviewTarget, mode: LiveGoldenMode): Promise<RangeRun> {
	return reviewTarget(target, mode, undefined);
}

async function reviewTarget(target: ReviewTarget, mode: GoldenMode, golden: Golden | undefined): Promise<RangeRun> {
	const { repo } = target;
	const source: RepositorySource = { kind: "revision", commit: target.policy ?? target.base };
	const changeset = await Changeset.resolve(repo, target.range);
	const paths = changeset.revision.paths();
	const standards = await Standards.load(repo, source, paths);
	const scoped = {
		config: (await loadConfig(repo, source, ".")).config,
		lenses: await Lens.load(repo, source, paths),
	};
	const { config: loaded, lenses: loadedLenses } = target.scope?.(scoped.config, scoped.lenses) ?? scoped;
	let lenses = [...loadedLenses];
	let models: ReviewModels;
	let config: MelianConfig;
	const toolMismatches: string[] = [];
	if (mode.kind === "scripted") {
		const fake = createFakeModels({ models: [{ id: "scripted" }] });
		const ref = fake.ref("scripted");
		config = routeEveryTier(loaded, `${ref.provider}/${ref.modelId}`, true);
		config = { ...config, models: { ...config.models, verifier: { model: `${ref.provider}/${ref.modelId}` } } };
		models = fake.review;
		scriptLenses(fake, lenses, { ...golden!.script, verifier: golden!.verifier ?? {} }, toolMismatches);
	} else {
		config = mode.model === undefined ? loaded : routeEveryTier(loaded, mode.model, false);
		const verifier = mode.verifierModel ?? mode.model;
		if (verifier !== undefined)
			config = {
				...config,
				models: { ...config.models, verifier: { model: verifier, thinking: config.models.verifier?.thinking } },
			};
		models = mode.models;
		if (mode.thinking !== undefined) config = mode.thinking.apply(config);
		if (mode.probing !== undefined) {
			const routed = mode.probing.routed(config, lenses, changeset.revision.files);
			config = routed.config;
			lenses = [...routed.lenses];
		}
	}
	// A golden measures its lenses, so the checks a host runs without a model, and only those, skip with leave: a
	// golden's own allowSkip could excuse the lens it measures.
	const tier = config.stages["pull-request"] ?? "full";
	const hostChecks = checksOfTier(config, tier).filter((name) =>
		(deterministicChecks as readonly string[]).includes(name),
	);
	config = { ...config, checks: { allowSkip: hostChecks } };
	const checks = hostChecks.map(
		(name): CheckRecord => ({ name, status: "skipped", reason: "a golden runs its lenses alone" }),
	);
	const callers =
		mode.kind === "live" && mode.probing?.graph ? await graphOf(target, changeset, config, lenses, tier) : undefined;
	if (mode.kind === "live" && mode.store !== undefined && existsSync(mode.store))
		throw new Error(`${mode.store} already holds a store, which this review would resume rather than measure afresh`);
	const storage =
		mode.kind === "live" && mode.store !== undefined ? await openSqliteStorage(mode.store) : createMemoryStorage();
	const reviewHarness = await openReviewHarness(storage, models, {
		retry: mode.kind !== "scripted",
		...(mode.kind === "scripted" && mode.probes === "unconfined" ? { probeSandbox: unconfinedSandbox() } : {}),
	});
	try {
		const review = {
			harness: reviewHarness,
			changeset,
			config,
			lenses,
			standards,
			models,
			policy: source,
			writer: target.writer,
			tier,
			checks,
			...(callers === undefined ? {} : { callers }),
		};
		const reviewed = await reviewChangeset(review);
		const status = reviewed.verdict.reviewStatus();
		if (status.state === "error") throw new Error(status.description);
		// The review records a level's fallback without probes only as this note, and a golden that probes measures probes.
		const unprobed = (reviewed.verdict.ran ?? []).find(({ reason }) => reason?.includes(" ran without probes"));
		if (unprobed !== undefined) throw new Error(`${unprobed.name}: ${unprobed.reason}`);
		const findings = [
			...Object.values(reviewed.verdict.findings).flat(),
			...(golden === undefined ? [] : await guardrailFindings(golden, repo, changeset, source)),
		];
		const root = (await reviewHarness.harness.root(backgroundContext)).id;
		const lensChecks = (reviewed.verdict.ran ?? [])
			.map(({ name }) => name)
			.filter((name) => name.startsWith("lens."));
		const sightings = await Promise.all(
			lensChecks.map((check) => sightingsAt(reviewHarness.harness, root, Revision.key(changeset.revision), check)),
		);
		return {
			findings,
			sightings: sightings.flat(),
			rendered: FindingsLog.of(findings).render(),
			toolMismatches,
			notes: reviewed.verdict.lensNotes(),
			tiers: tiersRun(reviewed.verdict.ran ?? [], lenses, config),
			verdict: reviewed.verdict,
			...(await detached(storage, Revision.key(changeset.revision))),
		};
	} catch (error) {
		const { telemetry, probers } = await detached(storage, Revision.key(changeset.revision));
		throw new GoldenRunError(error, telemetry, probers);
	} finally {
		await reviewHarness.close(backgroundContext);
	}
}

// The tier routes a lens's level as the review routes it without a plan: none for a lens with its own route, else the
// level's tier once configuration has tuned the lens.
function tiersRun(
	ran: readonly CheckRecord[],
	lenses: readonly Lens[],
	config: MelianConfig,
): Record<string, LensTier> {
	const tiers: Record<string, LensTier> = {};
	for (const record of ran) {
		const lens = lenses.find((each) => `lens.${each.name}` === record.name);
		if (lens === undefined || record.level === undefined) continue;
		const settings = Object.hasOwn(config.lenses, lens.name) ? config.lenses[lens.name] : undefined;
		if (settings?.route !== undefined) continue;
		tiers[record.name] = lens.configured(settings).level(record.level).tier;
	}
	return tiers;
}

/**
 * How a scripted run's findings differ from what its golden expects in the fields scoring does not match on: each
 * expected finding's cause, failure scenario, and evidence locations, described. A scripted run plays back the
 * golden's replies, so they must agree exactly; a live model's wording never would, and live runs do not check them.
 */
export function scriptedMismatches(
	golden: Golden,
	findings: readonly Finding[],
	sightings?: readonly Finding[],
): string[] {
	return golden.expected.comments.flatMap((comment) => {
		const name = `${comment.file} ${comment.rule}${comment.source === undefined ? "" : ` from ${comment.source}`}`;
		const found = findings
			.map((finding) => ({ finding, claim: answers(comment, finding, sightings) }))
			.find(({ claim }) => claim !== undefined);
		if (found === undefined) return [`${name}: not reported`];
		const { cause } = found.finding.properties;
		const { failureScenario, evidence = [] } = found.claim!;
		// A guardrail finding has neither a failure scenario nor evidence, so only its cause is held to the golden.
		if (comment.rule.startsWith("guardrail/"))
			return cause === comment.cause ? [] : [`${name}: cause ${cause}, expected ${comment.cause}`];
		const reported = evidence.map(({ file, startLine, endLine, role, revision }) => ({
			file,
			line: startLine,
			...(endLine === undefined ? {} : { endLine }),
			role,
			revision,
		}));
		const expected = comment.evidence.map((location) => ({ ...location, revision: location.revision ?? "head" }));
		return [
			...(cause === comment.cause ? [] : [`${name}: cause ${cause}, expected ${comment.cause}`]),
			...(failureScenario === comment.failureScenario
				? []
				: [
						`${name}: failure scenario ${JSON.stringify(failureScenario)}, expected ${JSON.stringify(comment.failureScenario)}`,
					]),
			...(JSON.stringify(reported) === JSON.stringify(expected)
				? []
				: [`${name}: evidence ${JSON.stringify(reported)}, expected ${JSON.stringify(expected)}`]),
		];
	});
}

/**
 * How well one review matched its golden. A finding matches an expected one at its file or an alternative, under its
 * rule or an alternative, overlapping its `lines` when it names them, and reported by its `source` when it names one.
 */
export interface GoldenScore {
	readonly golden: string;
	readonly expected: number;
	readonly reported: number;
	/** Reported findings that match an expected finding no earlier reported finding matched. */
	readonly truePositives: number;
	/** Expected findings that some reported finding matches. */
	readonly found: number;
	/** `truePositives / reported`; 1 when nothing was reported. */
	readonly precision: number;
	/** `found / expected`; 1 when nothing was expected. */
	readonly recall: number;
}

// What a match reads of an expected finding.
type ExpectedClaim = Pick<
	GoldenComment,
	"file" | "alternativeFiles" | "rule" | "alternativeRules" | "lines" | "source"
>;

function namesRule(comment: ExpectedClaim, rule: string): boolean {
	return rule === comment.rule || (comment.alternativeRules ?? []).includes(rule);
}

function matchesClaim(comment: ExpectedClaim, claim: MemberClaim): boolean {
	return (
		claim.verification?.verdict !== "refuted" &&
		namesRule(comment, claim.ruleId) &&
		(comment.source === undefined || claim.source.check === comment.source)
	);
}

function within(comment: ExpectedClaim, file: string, start: number, end: number): boolean {
	if (![comment.file, ...(comment.alternativeFiles ?? [])].includes(file)) return false;
	return comment.lines === undefined || (comment.lines[0] <= end && start <= comment.lines[1]);
}

// A claim's place is where its own check reported it: a merged finding keeps only its speaker's lines and some of the
// members' evidence, and each place it still holds can belong to another member. A claim of a check that keeps no
// sightings, such as a guardrail, is the finding itself.
function sightedWithin(
	comment: ExpectedClaim,
	finding: Finding,
	sightings: readonly Finding[] | undefined,
): MemberClaim | undefined {
	if (sightings === undefined)
		throw new Error(`an expected ${comment.rule} at lines ${comment.lines!.join("-")} needs the review's sightings`);
	const { reportedBy, source, otherClaims = [] } = finding.properties;
	const key = (id: string, each: FindingSource) => JSON.stringify([id, each.check, each.version]);
	const claims = new Map(otherClaims.map((claim) => [key(claim.id, claim.source), claim]));
	for (const each of reportedBy ?? [source])
		if (!claims.has(key(finding.id, each))) claims.set(key(finding.id, each), finding.claimAs(each));
	const sighted = new Map(sightings.map((sighting) => [key(sighting.id, sighting.properties.source), sighting]));
	return [...claims.values()].find((claim) => {
		if (!matchesClaim(comment, claim)) return false;
		const sighting = claim.source.check.startsWith("lens.") ? sighted.get(key(claim.id, claim.source)) : finding;
		if (sighting === undefined)
			throw new Error(
				`the verdict holds a ${claim.source.check} claim ${claim.id} from ${claim.source.version} that the lens never sighted`,
			);
		const path = sighting.properties.path ?? sighting.locations[0]!.physicalLocation.artifactLocation.uri;
		return within(comment, path, ...sighting.lines());
	});
}

// The claim of a merged defect that supplied the expected rule and source, or none. An expectation with lines is
// answered only at a claim's own sighting, which `sightings` holds.
export function answers(
	comment: ExpectedClaim,
	finding: Finding,
	sightings?: readonly Finding[],
): MemberClaim | undefined {
	if (comment.lines !== undefined) return sightedWithin(comment, finding, sightings);
	const path = finding.properties.path ?? finding.locations[0]!.physicalLocation.artifactLocation.uri;
	if (!within(comment, path, 0, 0)) return undefined;
	const { reportedBy, source, otherClaims = [] } = finding.properties;
	const member = otherClaims.find((claim) => matchesClaim(comment, claim));
	if (member !== undefined) return member;
	if (!namesRule(comment, finding.ruleId)) return undefined;
	const own = finding.claimAs();
	if (own.verification?.verdict === "refuted") return undefined;
	if (comment.source === undefined) return own;
	const speaking = (reportedBy ?? [source]).find(
		(each) =>
			each.check === comment.source &&
			!otherClaims.some((claim) => claim.source.check === each.check && claim.source.version === each.version),
	);
	return speaking === undefined ? undefined : finding.claimAs(speaking);
}

/**
 * Scores adjudicated defects against their expected file and rule alternatives, lines and source. An expected
 * finding names its `source`. Each expected finding counts as found once: a second reported finding matching the same
 * expectation is a false positive, since it is the same defect reported twice. An expectation counts as found when any
 * finding fits it, so no two expectations of a golden may share a file, a rule and a source, and one that names no
 * source shares any: one broad finding would count as found for both, whatever their lines.
 */
export function scoreGolden(golden: Golden, findings: readonly Finding[], sightings?: readonly Finding[]): GoldenScore {
	const expected = [
		...new Map(
			golden.expected.comments.map((comment) => [
				JSON.stringify([
					comment.file,
					comment.alternativeFiles,
					comment.rule,
					comment.alternativeRules,
					comment.lines,
					comment.source,
				]),
				comment,
			]),
		).values(),
	];
	const found = expected.filter((comment) =>
		findings.some((finding) => answers(comment, finding, sightings) !== undefined),
	).length;
	// Pairs findings with expectations so that as many as possible count, each expectation once: with sources, a finding
	// several lenses reported may answer more than one expectation, and the first one it fits may be another's only fit.
	const holder: (number | undefined)[] = expected.map(() => undefined);
	const claim = (index: number, tried: Set<number>): boolean =>
		expected.some((comment, slot) => {
			if (tried.has(slot) || answers(comment, findings[index]!, sightings) === undefined) return false;
			tried.add(slot);
			const held = holder[slot];
			if (held !== undefined && !claim(held, tried)) return false;
			holder[slot] = index;
			return true;
		});
	const truePositives = findings.filter((_, index) => claim(index, new Set())).length;
	return {
		golden: golden.name,
		expected: expected.length,
		reported: findings.length,
		truePositives,
		found,
		precision: findings.length === 0 ? 1 : truePositives / findings.length,
		recall: expected.length === 0 ? 1 : found / expected.length,
	};
}

/** Micro-averaged precision and recall over a corpus. */
export function scoreCorpus(scores: readonly GoldenScore[]): { precision: number; recall: number } {
	const sum = (pick: (score: GoldenScore) => number) => scores.reduce((total, score) => total + pick(score), 0);
	const reported = sum((score) => score.reported);
	const expected = sum((score) => score.expected);
	return {
		precision: reported === 0 ? 1 : sum((score) => score.truePositives) / reported,
		recall: expected === 0 ? 1 : sum((score) => score.found) / expected,
	};
}
