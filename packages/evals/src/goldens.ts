import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	causeSchema,
	createFindingsLog,
	evidenceRevisionSchema,
	evidenceRoleSchema,
	type Finding,
	type LensTier,
	loadConfig,
	loadLenses,
	loadStandards,
	type MelianConfig,
	type ModelRoute,
	type RepositorySource,
	renderFindingsTerminal,
	resolveRange,
} from "@melian-agent/core";
import {
	backgroundContext,
	createMemoryStorage,
	openReviewHarness,
	type ReviewModels,
	reviewChangeset,
} from "@melian-agent/pipeline";
import { createFakeModels, scriptLenses } from "@melian-agent/pipeline/testing";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";

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
 * judge reads it unchanged, plus the fields Melian matches on (`file`, `rule`, and `source`, a check that must be among
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
		rule: text,
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

/** One expected finding. */
export type GoldenComment = Static<typeof goldenCommentSchema>;

/** A golden's `expected.json`. */
export type Expected = Static<typeof expectedSchema>;

/** A golden's `script.json`. */
export type Script = Static<typeof scriptSchema>;

/** One golden: a base and head tree, what a review of the change must find, and the lens replies that find it. */
export interface Golden {
	readonly name: string;
	readonly directory: string;
	readonly expected: Expected;
	readonly script: Script;
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

/** Loads every golden under `directory`, in name order. */
export function loadGoldens(directory: string = goldensDirectory): Golden[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const root = join(directory, name);
			const expected = readJson<Expected>(join(root, "expected.json"), expectedSchema);
			return {
				name,
				directory: root,
				expected,
				script: readJson<Script>(join(root, "script.json"), scriptSchema),
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
	GIT_AUTHOR_NAME: "Melian Evals",
	GIT_AUTHOR_EMAIL: "evals@melian.invalid",
	GIT_COMMITTER_NAME: "Melian Evals",
	GIT_COMMITTER_EMAIL: "evals@melian.invalid",
};

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
}

// `AGENTS.golden.md` is `AGENTS.md`, and `melian.golden.yaml` is `melian.yaml`.
const inert = /\.golden(?=\.[^.]*$)/;

// Copies a golden's tree into `repo`, writing each file stored under an inert name under its live one.
function copyTree(tree: string, repo: string): void {
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
export function buildGoldenRepository(golden: Golden): { repo: string; base: string; head: string } {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), `melian-golden-${golden.name}-`)));
	git(repo, "init", "--quiet", "--initial-branch=main");
	copyTree(join(golden.directory, "base"), repo);
	if (existsSync(join(golden.directory, "melian.golden.yaml")))
		cpSync(join(golden.directory, "melian.golden.yaml"), join(repo, "melian.yaml"));
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "--quiet", "-b", "feature");
	for (const entry of readdirSync(repo))
		if (entry !== ".git" && entry !== "melian.yaml") rmSync(join(repo, entry), { recursive: true });
	copyTree(join(golden.directory, "head"), repo);
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "--allow-empty", "-m", "head");
	return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

/** How a golden is run: on canned replies from its `script.json`, or on real models. */
export type GoldenMode =
	| { readonly kind: "scripted" }
	| {
			readonly kind: "live";
			readonly models: ReviewModels;
			/** `provider/model-id` for every tier the golden's `melian.golden.yaml` leaves unrouted. */
			readonly model?: string;
	  };

/** A golden's review: the findings, and the terminal rendering an author would see. */
export interface GoldenRun {
	readonly golden: Golden;
	readonly findings: readonly Finding[];
	readonly rendered: string;
	/** In a scripted run, each scripted call whose result lacked its `expectToolResult`, described. */
	readonly toolMismatches: readonly string[];
}

const tiers: readonly LensTier[] = ["light", "medium", "heavy"];

function routeEveryTier(config: MelianConfig, model: string, override: boolean): MelianConfig {
	const route: ModelRoute = { model };
	const models = Object.fromEntries(tiers.map((tier) => [tier, override ? route : (config.models[tier] ?? route)]));
	return { ...config, models: { ...config.models, ...models } };
}

/**
 * Reviews a golden's change the way the CLI will: policy, standards, and lenses from the base commit, the range
 * `main...feature`, and every lens the change selects. Scripted runs answer each lens from `script.json` on the fake
 * model; live runs call real providers with the credentials `models` resolves.
 */
export async function runGolden(golden: Golden, mode: GoldenMode): Promise<GoldenRun> {
	const { repo, base } = buildGoldenRepository(golden);
	try {
		const source: RepositorySource = { kind: "revision", commit: base };
		const changeset = await resolveRange(repo, "main...feature");
		const paths = changeset.revision.files.map((file) => file.path);
		const lenses = await loadLenses(repo, source, paths);
		const standards = await loadStandards(repo, source, ".");
		const { config: loaded } = await loadConfig(repo, source, ".");
		let models: ReviewModels;
		let config: MelianConfig;
		const toolMismatches: string[] = [];
		if (mode.kind === "scripted") {
			const fake = createFakeModels({ models: [{ id: "scripted" }] });
			const ref = fake.ref("scripted");
			config = routeEveryTier(loaded, `${ref.provider}/${ref.modelId}`, true);
			models = fake.review;
			scriptLenses(fake, lenses, golden.script, toolMismatches);
		} else {
			config = mode.model === undefined ? loaded : routeEveryTier(loaded, mode.model, false);
			models = mode.models;
		}
		const reviewHarness = await openReviewHarness(createMemoryStorage(), models, { retry: mode.kind !== "scripted" });
		const { harness } = reviewHarness;
		try {
			const review = { harness, changeset, config, lenses, standards, models, policy: source };
			const { findings } = await reviewChangeset(review);
			const rendered = renderFindingsTerminal(createFindingsLog([...findings]));
			return { golden, findings, rendered, toolMismatches };
		} finally {
			await reviewHarness.close(backgroundContext);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

/**
 * How a scripted run's findings differ from what its golden expects in the fields scoring does not match on: each
 * expected finding's cause, failure scenario, and evidence locations, described. A scripted run plays back the
 * golden's replies, so they must agree exactly; a live model's wording never would, and live runs do not check them.
 */
export function scriptedMismatches(golden: Golden, findings: readonly Finding[]): string[] {
	return golden.expected.comments.flatMap((comment) => {
		const name = `${comment.file} ${comment.rule}${comment.source === undefined ? "" : ` from ${comment.source}`}`;
		const found = findings.find((each) => answers(comment, each));
		if (found === undefined) return [`${name}: not reported`];
		const { cause, failureScenario, evidence = [] } = found.properties;
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
 * How well one review matched its golden. A finding matches an expected one with the same file and rule, reported by
 * the expected one's `source` when it names one.
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

// Whether `finding` answers `comment`: the same file and rule, and, when the comment names a source, reported by it.
// One finding merges every lens that sighted the same defect, so only `reportedBy` says which lenses reported it.
function answers(comment: GoldenComment, finding: Finding): boolean {
	const path = finding.properties.path ?? finding.locations[0]!.physicalLocation.artifactLocation.uri;
	if (path !== comment.file || finding.ruleId !== comment.rule) return false;
	if (comment.source === undefined) return true;
	const { reportedBy, source } = finding.properties;
	return (reportedBy ?? (source === undefined ? [] : [source])).some((each) => each.check === comment.source);
}

/**
 * Scores one review against its golden, matching on file and rule, and on the reporting check where an expected
 * finding names its `source`. Each expected finding counts as found once: a second reported finding matching the same
 * expectation is a false positive, since it is the same defect reported twice.
 */
export function scoreGolden(golden: Golden, findings: readonly Finding[]): GoldenScore {
	const expected = [
		...new Map(
			golden.expected.comments.map((comment) => [
				JSON.stringify([comment.file, comment.rule, comment.source]),
				comment,
			]),
		).values(),
	];
	const found = expected.filter((comment) => findings.some((finding) => answers(comment, finding))).length;
	// Pairs findings with expectations so that as many as possible count, each expectation once: with sources, a finding
	// several lenses reported may answer more than one expectation, and the first one it fits may be another's only fit.
	const holder: (number | undefined)[] = expected.map(() => undefined);
	const claim = (index: number, tried: Set<number>): boolean =>
		expected.some((comment, slot) => {
			if (tried.has(slot) || !answers(comment, findings[index]!)) return false;
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
