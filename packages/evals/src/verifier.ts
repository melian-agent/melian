import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Changeset,
	defaultConfig,
	Lens,
	Rendering,
	reportFindingInputSchema,
	type Verification,
} from "@melian-agent/core";
import {
	backgroundContext,
	createMemoryStorage,
	openReviewHarness,
	ReviewError,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { buildGoldenRepository, type GoldenMode, goldenEvidenceSchema } from "./goldens.ts";

const strict = { additionalProperties: false } as const;
const verdictSchema = Type.Union([Type.Literal("confirmed"), Type.Literal("plausible"), Type.Literal("refuted")]);
const expectedSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("needs-execution"), Type.Literal("decoy")]),
		verdicts: Type.Array(verdictSchema, { minItems: 1, uniqueItems: true }),
	},
	strict,
);
const scriptSchema = Type.Object(
	{
		verdict: verdictSchema,
		reason: Type.String({ minLength: 1 }),
		correction: Type.Optional(Type.String({ minLength: 1 })),
		evidence: Type.Optional(Type.Array(goldenEvidenceSchema, { minItems: 1 })),
	},
	strict,
);

/** A planted claim and the judgements its verifier must retain or refute. */
export interface VerifierGolden {
	readonly name: string;
	readonly directory: string;
	readonly candidate: Static<typeof reportFindingInputSchema>;
	readonly expected: Static<typeof expectedSchema>;
	readonly script: Static<typeof scriptSchema>;
}

/** The corpus for misses that require execution, separate from the lens corpus. */
export const verifierDirectory = fileURLToPath(new URL("../verifier/", import.meta.url));

function readJson<T>(path: string, schema: TSchema): T {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	const error = [...Value.Errors(schema, value)][0];
	if (error !== undefined) throw new Error(`${path}: ${error.instancePath || "(top level)"} ${error.message}`);
	return value as T;
}

/** Loads the verifier corpus in name order, validating candidates and scripts. */
export function loadVerifierGoldens(directory: string = verifierDirectory): VerifierGolden[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const root = join(directory, name);
			const expected = readJson<VerifierGolden["expected"]>(join(root, "expected.json"), expectedSchema);
			if (
				JSON.stringify(expected.verdicts.slice().sort()) !==
				JSON.stringify(expected.kind === "decoy" ? ["refuted"] : ["confirmed", "plausible"])
			)
				throw new Error(`${name}: expected verdicts must retain real defects and refute decoys`);
			const script = readJson<VerifierGolden["script"]>(join(root, "script.json"), scriptSchema);
			if (script.verdict === "refuted" && script.evidence === undefined)
				throw new Error(`${name}: a refutation needs evidence`);
			return {
				name,
				directory: root,
				expected,
				script,
				candidate: readJson<VerifierGolden["candidate"]>(join(root, "candidate.json"), reportFindingInputSchema),
			};
		});
}

/** One candidate's recorded judgement and review output. */
export interface VerifierRun {
	readonly verification: Verification | undefined;
	readonly rendered: string;
	readonly verifierRequests: number;
}

/** Plants a candidate through a fake finder, then judges it through the pipeline's actual verification task. */
export async function runVerifierGolden(golden: VerifierGolden, mode: GoldenMode): Promise<VerifierRun> {
	const verifierModel = mode.kind === "live" ? (mode.verifierModel ?? mode.model) : undefined;
	if (mode.kind === "live" && verifierModel === undefined)
		throw new Error("Live verifier evals need MELIAN_EVAL_VERIFIER_MODEL or MELIAN_EVAL_MODEL.");
	const { repo, base } = buildGoldenRepository(golden);
	try {
		const source = { kind: "revision" as const, commit: base };
		const changeset = await Changeset.resolve(repo, "main...feature");
		const template = (await Lens.load(repo, source, changeset.revision.paths())).find(
			(lens) => lens.name === "correctness",
		)!;
		const lens = Lens.from({
			...template.toJSON(),
			instructions: "Verifier eval planted finder",
			rules: [{ id: golden.candidate.rule, description: "The planted claim under judgement." }],
		});
		const fake = createFakeModels(
			{ provider: "verifier-eval-finder", models: [{ id: "finder" }, { id: "judge" }] },
			mode.kind === "live" ? mode.models : undefined,
		);
		const finder = fake.ref("finder");
		const judge = fake.ref("judge");
		const marker = "Melian adversarial verifier";
		const requests = scriptConversations(fake, [
			{
				match: lens.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", golden.candidate), { stopReason: "toolUse" }),
					fauxAssistantMessage("Candidate planted."),
				],
			},
			...(mode.kind === "scripted"
				? [
						{
							match: marker,
							replies: [
								(messages: Parameters<typeof scriptVerifier>[0]) =>
									scriptVerifier(
										messages,
										Object.fromEntries(
											[...systemPromptOf(messages).matchAll(/finding ([0-9a-f]+)/g)].map((match) => [
												match[1]!,
												golden.script,
											]),
										),
									),
								(messages: Parameters<typeof scriptVerifier>[0]) => scriptVerifier(messages),
							],
						},
					]
				: []),
		]);
		const reviewHarness = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false });
		try {
			const result = await reviewChangeset({
				harness: reviewHarness.harness,
				changeset,
				lenses: [lens],
				standards: [],
				models: fake.review,
				policy: source,
				config: {
					...defaultConfig,
					tiers: { full: ["lens.correctness"] },
					stages: { "pull-request": "full" },
					models: {
						heavy: { model: `${finder.provider}/${finder.modelId}` },
						verifier: { model: verifierModel ?? `${judge.provider}/${judge.modelId}` },
					},
				},
			}).catch((error: unknown) => {
				if (!(error instanceof ReviewError) || error.code !== "verifierFailed" || error.verdict === undefined)
					throw error;
				return error;
			});
			if (result.findings.length !== 1)
				throw new Error(`${golden.name}: expected one planted finding, got ${result.findings.length}`);
			return {
				verification: result instanceof ReviewError ? undefined : result.findings[0]!.properties.verification,
				rendered: result.verdict!.render(new Rendering({ all: true })),
				verifierRequests: requests[marker]?.length ?? 0,
			};
		} finally {
			await reviewHarness.close(backgroundContext);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

/** A real defect passes only when retained; a decoy passes only when refuted. Missing judgements always fail. */
export function scoreVerifierGolden(
	golden: VerifierGolden,
	run: Pick<VerifierRun, "verification">,
): {
	golden: string;
	kind: VerifierGolden["expected"]["kind"];
	verdict: Verification["verdict"] | undefined;
	passed: boolean;
} {
	const verdict = run.verification?.verdict;
	return {
		golden: golden.name,
		kind: golden.expected.kind,
		verdict,
		passed: verdict !== undefined && golden.expected.verdicts.includes(verdict),
	};
}
