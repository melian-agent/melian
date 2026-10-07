import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Changeset,
	defaultConfig,
	Lens,
	LevelBand,
	parseModelReference,
	type QuestionSet,
	type ScrutinyLevel,
	scrutinyLevels,
	type TextModel,
	triageQuestionSet,
} from "@melian-agent/core";
import { FallbackDecider } from "@melian-agent/decisions";
import {
	backgroundContext,
	createMemoryStorage,
	openReviewHarness,
	ReviewError,
	type ReviewModels,
	RouteTextModel,
	readRecordedDecision,
	reviewChangeset,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { buildGoldenRepository } from "./goldens.ts";

const strict = { additionalProperties: false } as const;
const level = Type.Union(scrutinyLevels.map((each) => Type.Literal(each)));
const expectedSchema = Type.Object(
	{
		title: Type.String({ minLength: 1 }),
		// The level each lens should look at this change with: what the maintainer judges its concern calls for.
		levels: Type.Record(Type.String({ minLength: 1 }), level, { minProperties: 1 }),
	},
	strict,
);
const scriptSchema = Type.Object(
	{
		// A lens's name to the probability the scripted model gives each level.
		answers: Type.Record(Type.String({ minLength: 1 }), Type.Record(Type.String(), Type.Number({ minimum: 0 }))),
	},
	strict,
);

/** A change, the level each lens should look at it with, and the answers a scripted model gives. */
export interface TriageGolden {
	readonly name: string;
	readonly directory: string;
	readonly expected: Static<typeof expectedSchema>;
	readonly script: Static<typeof scriptSchema>;
}

/** The corpus of changes whose right triage level is known, apart from the lens corpus. */
export const triageDirectory = fileURLToPath(new URL("../triage/", import.meta.url));

function readJson<T>(path: string, schema: TSchema): T {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	const error = [...Value.Errors(schema, value)][0];
	if (error !== undefined) throw new Error(`${path}: ${error.instancePath || "(top level)"} ${error.message}`);
	return value as T;
}

/** Loads the triage corpus in name order. Throws for a script that leaves a lens of `expected.json` unanswered. */
export function loadTriageGoldens(directory: string = triageDirectory): TriageGolden[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const root = join(directory, name);
			const expected = readJson<TriageGolden["expected"]>(join(root, "expected.json"), expectedSchema);
			const script = readJson<TriageGolden["script"]>(join(root, "script.json"), scriptSchema);
			for (const lens of Object.keys(expected.levels)) {
				if (script.answers[lens] === undefined) throw new Error(`${name}: script.json gives ${lens} no answer`);
			}
			return { name, directory: root, expected, script };
		});
}

/** How a triage golden is run: a scripted model answers, or a real one does. Either way the fallback decider asks. */
export type TriageMode =
	| { readonly kind: "scripted" }
	| { readonly kind: "live"; readonly models: ReviewModels; readonly model: string };

/** What the fallback decider chose for each lens of a golden, in one pass. */
export type TriageChosen = Readonly<Record<string, string>>;

// A scripted model answers the questions the request asks, from the golden's script, and throws for one it has no
// answer for, so a request that asks the wrong question fails here, not as a canned reply.
function scriptedModel(golden: TriageGolden): TextModel {
	return {
		name: "scripted/triage",
		answer: async (request) => {
			const asked = [...request.prompt.matchAll(/^### (.+)$/gm)].map((match) => match[1]!);
			return {
				answers: asked.map((question) => {
					const answer = golden.script.answers[question];
					if (answer === undefined) throw new Error(`${golden.name}: the script has no answer for ${question}`);
					return {
						question,
						probabilities: Object.entries(answer).map(([option, probability]) => ({ option, probability })),
					};
				}),
			};
		},
	};
}

/**
 * Reviews a golden's change under the fallback decider, `passes` times over, each on storage of its own, and returns
 * what the decider chose for each lens in each pass. The lenses run on a fake model that answers "Done.", so only the
 * decider's model spends tokens in a live run; the choice read is the decider's own, before the lens's band holds it.
 */
export async function runTriageGolden(golden: TriageGolden, mode: TriageMode, passes = 1): Promise<TriageChosen[]> {
	const { repo, base } = buildGoldenRepository(golden);
	try {
		const source = { kind: "revision" as const, commit: base };
		const changeset = await Changeset.resolve(repo, "main...feature");
		const wanted = Object.keys(golden.expected.levels);
		const lenses = (await Lens.load(repo, source, changeset.revision.paths())).filter((lens) =>
			wanted.includes(lens.name),
		);
		const text =
			mode.kind === "scripted"
				? scriptedModel(golden)
				: await RouteTextModel.create(mode.models, [parseModelReference(mode.model, "light")]);
		if (text === undefined) throw new Error(`${mode.kind === "live" ? mode.model : "the model"} has no credentials`);
		const chosen: TriageChosen[] = [];
		for (let pass = 0; pass < passes; pass++) {
			const fake = createFakeModels({ provider: "triage-eval", models: [{ id: "lens" }] });
			scriptConversations(
				fake,
				lenses.map((lens) => ({ match: lens.instructions, replies: [fauxAssistantMessage("Done.")] })),
			);
			const route = `${fake.ref("lens").provider}/lens`;
			const decider = new FallbackDecider(text);
			const reviewHarness = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false, decider });
			try {
				await reviewChangeset({
					harness: reviewHarness,
					checks: [],
					changeset,
					lenses,
					standards: [],
					models: fake.review,
					decider,
					policy: { kind: "worktree" },
					config: {
						...defaultConfig,
						tiers: { full: lenses.map((lens) => `lens.${lens.name}`) },
						stages: { "pull-request": "full" },
						models: { light: { model: route }, medium: { model: route }, heavy: { model: route } },
					},
				}).catch((error: unknown) => {
					if (!(error instanceof ReviewError)) throw error;
				});
				const root = await reviewHarness.harness.root(backgroundContext);
				const recorded = await readRecordedDecision(
					reviewHarness.harness,
					root.id,
					revisionKey(changeset.revision),
					triageQuestionSet.name,
					backgroundContext,
				);
				if (mode.kind === "live" && recorded?.decision === undefined)
					throw new Error(
						`${golden.name}: the decider gave no decision, so the run measures nothing: ${recorded?.failure ?? "none was recorded"}`,
					);
				chosen.push(
					Object.fromEntries(wanted.map((lens) => [lens, recorded?.decision?.chosen(lens) ?? "unanswered"])),
				);
			} finally {
				await reviewHarness.close(backgroundContext);
			}
		}
		return chosen;
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

/** One lens's choice on one golden in one pass, beside the level it should have been. */
export interface TriageChoice {
	readonly golden: string;
	readonly lens: string;
	readonly expected: ScrutinyLevel;
	readonly chosen: string;
}

const looks = ["skip", ...scrutinyLevels];

/** The comparison of two measurements of the triage questions: whether the later one chooses better. */
export interface TriageComparison {
	readonly verdict: "better" | "worse" | "same" | "incomparable";
	readonly lines: readonly string[];
}

/** The stored shape of {@link TriageResults}. */
export interface StoredTriageResults {
	readonly questionSet: QuestionSet;
	readonly fingerprint: string;
	readonly model: string;
	readonly goldens: readonly string[];
	readonly passes: number;
	readonly choices: readonly TriageChoice[];
}

// Measures that print the same at two decimals, as the comparison's lines do, are not ordered.
const comparisonTolerance = 0.005;

/**
 * A measurement of the triage questions: what the fallback decider chose against the right level, over every golden
 * and pass. A choice off by a level costs one, and one the decider never gave costs the widest distance.
 */
export class TriageResults {
	readonly questionSet: QuestionSet;
	readonly fingerprint: string;
	readonly model: string;
	readonly goldens: readonly string[];
	readonly passes: number;
	readonly choices: readonly TriageChoice[];

	private constructor(stored: StoredTriageResults) {
		this.questionSet = stored.questionSet;
		this.fingerprint = stored.fingerprint;
		this.model = stored.model;
		this.goldens = stored.goldens ?? [];
		this.passes = stored.passes;
		this.choices = stored.choices;
	}

	/** Measures `chosen`, each golden's passes, against the goldens' right levels. */
	static measure(
		goldens: readonly TriageGolden[],
		chosen: Readonly<Record<string, readonly TriageChosen[]>>,
		measured: { readonly model: string; readonly fingerprint: string },
	): TriageResults {
		const choices = goldens.flatMap((golden) =>
			(chosen[golden.name] ?? []).flatMap((pass) =>
				Object.entries(golden.expected.levels).map(([lens, expected]) => ({
					golden: golden.name,
					lens,
					expected,
					chosen: pass[lens] ?? "unanswered",
				})),
			),
		);
		const passes = Math.max(0, ...goldens.map((golden) => chosen[golden.name]?.length ?? 0));
		const names = goldens.map((golden) => golden.name).sort();
		return new TriageResults({ questionSet: triageQuestionSet, passes, choices, goldens: names, ...measured });
	}

	/** Reads a measurement `toJSON` wrote. */
	static parse(text: string): TriageResults {
		return new TriageResults(JSON.parse(text) as StoredTriageResults);
	}

	toJSON(): StoredTriageResults {
		const { questionSet, fingerprint, model, goldens, passes, choices } = this;
		return { questionSet, fingerprint, model, goldens, passes, choices };
	}

	// How far a choice is from the right level, in levels; a choice the decider never gave is as far as it can be.
	static distance(choice: TriageChoice): number {
		const at = looks.indexOf(choice.chosen);
		return at === -1 ? looks.length - 1 : Math.abs(at - looks.indexOf(choice.expected));
	}

	/** The share of choices at exactly the right level. */
	exact(): number {
		return this.choices.length === 0
			? 0
			: this.choices.filter((choice) => choice.chosen === choice.expected).length / this.choices.length;
	}

	/** The mean number of levels a choice is off by. */
	meanDistance(): number {
		return this.choices.length === 0
			? 0
			: this.choices.reduce((sum, choice) => sum + TriageResults.distance(choice), 0) / this.choices.length;
	}

	/** The choices below the right level, which let a change through with less of a look than it needed. */
	under(): number {
		return this.choices.filter((choice) => {
			const at = looks.indexOf(choice.chosen);
			return at !== -1 && at < looks.indexOf(choice.expected);
		}).length;
	}

	/** One line a person reads, then a line for each choice that missed. */
	render(): string {
		const misses = this.choices
			.filter((choice) => choice.chosen !== choice.expected)
			.map((choice) => `  ${choice.golden} / ${choice.lens}: chose ${choice.chosen}, should be ${choice.expected}`);
		return [
			`triage ${this.questionSet.name} v${this.questionSet.version} on ${this.model}, ${this.passes} pass${this.passes === 1 ? "" : "es"}: exact ${this.exact().toFixed(2)}, mean distance ${this.meanDistance().toFixed(2)}, ${this.under()} under`,
			...misses,
		].join("\n");
	}

	// A difference within the tolerance, up to float error, is none.
	private static settle(difference: number): number {
		return Math.abs(difference) <= comparisonTolerance + 1e-12 ? 0 : difference;
	}

	/**
	 * Whether this measurement chooses better than `baseline`: a lower mean distance is better, and at the same distance
	 * a higher exact share, each read within a small tolerance. Refuses, as incomparable, a baseline measured with
	 * another decider model or golden set. Says so when the questions changed without their version, which the question
	 * set's version exists to prevent, and when the version moved but the questions did not.
	 */
	compare(baseline: TriageResults): TriageComparison {
		const lines = [
			`version ${baseline.questionSet.version} -> ${this.questionSet.version}`,
			`mean distance ${baseline.meanDistance().toFixed(2)} -> ${this.meanDistance().toFixed(2)}`,
			`exact ${baseline.exact().toFixed(2)} -> ${this.exact().toFixed(2)}`,
			`under ${baseline.under()} -> ${this.under()}`,
		];
		const sameVersion = baseline.questionSet.version === this.questionSet.version;
		const sameQuestions = baseline.fingerprint === this.fingerprint;
		if (sameVersion && !sameQuestions) lines.push("the questions changed and their version did not");
		if (!sameVersion && sameQuestions) lines.push("the version changed and the questions did not");
		if (baseline.model !== this.model) {
			lines.push(`incomparable: the decider model differs, ${baseline.model} -> ${this.model}`);
			return { verdict: "incomparable", lines };
		}
		if (baseline.goldens.join("\n") !== this.goldens.join("\n")) {
			lines.push(
				`incomparable: the golden set differs, ${baseline.goldens.join(", ") || "none recorded"} -> ${this.goldens.join(", ") || "none recorded"}`,
			);
			return { verdict: "incomparable", lines };
		}
		const distance = TriageResults.settle(this.meanDistance() - baseline.meanDistance());
		const exact = TriageResults.settle(this.exact() - baseline.exact());
		const verdict =
			distance < 0 ? "better" : distance > 0 ? "worse" : exact > 0 ? "better" : exact < 0 ? "worse" : "same";
		return { verdict, lines };
	}
}

/** The questions triage asks of a set of lenses, which the question set's version stands for. */
export class TriageQuestions {
	readonly rendered: string;

	private constructor(rendered: string) {
		this.rendered = rendered;
	}

	/** Every lens's question over its declared levels, once with a floor of `skip` and once without. */
	static of(lenses: readonly Lens[]): TriageQuestions {
		const rendered = [...lenses]
			.sort((a, b) => a.name.localeCompare(b.name))
			.flatMap((lens) =>
				[LevelBand.of(undefined), LevelBand.of({ floor: "skip" })].map((band) => {
					const question = lens.triageQuestion(band, lens.declaredLevels());
					return JSON.stringify([question.id, question.text, question.options]);
				}),
			)
			.join("\n");
		return new TriageQuestions(rendered);
	}

	/** The questions of the lenses Melian ships, read from a repository built beside `golden`'s change. */
	static async shipped(golden: TriageGolden): Promise<TriageQuestions> {
		const { repo, base } = buildGoldenRepository(golden);
		try {
			return TriageQuestions.of(await Lens.load(repo, { kind: "revision", commit: base }, ["."]));
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}

	/** A hash of the questions, which changes whenever their wording or options do. */
	fingerprint(): string {
		return createHash("sha256").update(this.rendered).digest("hex").slice(0, 16);
	}
}
