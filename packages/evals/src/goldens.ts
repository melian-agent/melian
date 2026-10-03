import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	causeSchema,
	createFindingsLog,
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

/**
 * The JSON Schema of one expected finding: Martian's golden comment (`comment`, `severity`, `category`), so Martian's
 * judge reads it unchanged, plus the fields Melian matches on (`file`, `rule`) and checks (`cause`).
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
		cause: causeSchema,
	},
	strict,
);

/** The JSON Schema of a golden's `expected.json`, in Martian's per-pull-request shape. */
export const expectedSchema = Type.Object(
	{ pr_title: text, url: Type.Optional(text), comments: Type.Array(goldenCommentSchema) },
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
			return {
				name,
				directory: root,
				expected: readJson<Expected>(join(root, "expected.json"), expectedSchema),
				script: readJson<Script>(join(root, "script.json"), scriptSchema),
			};
		});
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

/**
 * Builds a golden's repository in a temporary directory: `base/` committed on `main`, with the golden's `melian.yaml`
 * when it has one, then `head/` replacing the tree on `feature`. The caller deletes `repo`.
 */
export function buildGoldenRepository(golden: Golden): { repo: string; base: string; head: string } {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), `melian-golden-${golden.name}-`)));
	git(repo, "init", "--quiet", "--initial-branch=main");
	cpSync(join(golden.directory, "base"), repo, { recursive: true });
	if (existsSync(join(golden.directory, "melian.yaml")))
		cpSync(join(golden.directory, "melian.yaml"), join(repo, "melian.yaml"));
	git(repo, "add", "--all");
	git(repo, "commit", "--quiet", "-m", "base");
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "checkout", "--quiet", "-b", "feature");
	for (const entry of readdirSync(repo))
		if (entry !== ".git" && entry !== "melian.yaml") rmSync(join(repo, entry), { recursive: true });
	cpSync(join(golden.directory, "head"), repo, { recursive: true });
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
			/** `provider/model-id` for every tier the golden's `melian.yaml` leaves unrouted. */
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
		const harness = await openReviewHarness(createMemoryStorage(), models, { retry: mode.kind !== "scripted" });
		try {
			const review = { harness, changeset, config, lenses, standards, models, policy: source };
			const { findings } = await reviewChangeset(review);
			const rendered = renderFindingsTerminal(createFindingsLog([...findings]));
			return { golden, findings, rendered, toolMismatches };
		} finally {
			await harness.close(backgroundContext);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

/** How well one review matched its golden. A finding matches an expected one with the same file and rule. */
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

function key(file: string, rule: string): string {
	return `${file}\0${rule}`;
}

/**
 * Scores one review against its golden, matching on file and rule. Each expected finding counts as found once: a
 * second reported finding matching the same expectation is a false positive, since it is the same defect reported twice.
 */
export function scoreGolden(golden: Golden, findings: readonly Finding[]): GoldenScore {
	const expected = new Set(golden.expected.comments.map((comment) => key(comment.file, comment.rule)));
	const reported = findings.map((finding) =>
		key(finding.properties.path ?? finding.locations[0]!.physicalLocation.artifactLocation.uri, finding.ruleId),
	);
	const truePositives = new Set(reported.filter((each) => expected.has(each))).size;
	const found = [...expected].filter((each) => reported.includes(each)).length;
	return {
		golden: golden.name,
		expected: expected.size,
		reported: reported.length,
		truePositives,
		found,
		precision: reported.length === 0 ? 1 : truePositives / reported.length,
		recall: expected.size === 0 ? 1 : found / expected.size,
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
