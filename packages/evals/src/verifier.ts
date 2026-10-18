import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Changeset,
	causeSchema,
	defaultConfig,
	Finding,
	type ImportantFinding,
	Lens,
	loadConfig,
	Rendering,
	type ResolvedFinding,
	reportFindingInputSchema,
	resolutionSchema,
	type StoredVerdict,
	severitySchema,
	snippetOccurrence,
	type Verdict,
	type Verification,
} from "@melian-agent/core";
import {
	backgroundContext,
	createMemoryStorage,
	openReviewHarness,
	ReviewError,
	reviewChangeset,
	revisionKey,
	type StageTelemetry,
	TelemetryReader,
	upsertFinding,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
	textOf,
} from "@melian-agent/pipeline/testing";
import Type, { type Static, type TSchema } from "typebox";
import Value from "typebox/value";
import { buildGoldenRepository, commitGoldenTree, type GoldenMode, goldenEvidenceSchema } from "./goldens.ts";
import { GoldenRunError } from "./run-error.ts";

const strict = { additionalProperties: false } as const;
const verdictSchema = Type.Union([Type.Literal("confirmed"), Type.Literal("plausible"), Type.Literal("refuted")]);
const expectedSchema = Type.Object(
	{
		kind: Type.Union([Type.Literal("needs-execution"), Type.Literal("decoy"), Type.Literal("design")]),
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
		expectInstructions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
	},
	strict,
);

const scenarioFile = "scenario.json";
const answerSchema = Type.Union([Type.Literal("yes"), Type.Literal("no"), Type.Literal("unknown")]);
const text = Type.String({ minLength: 1 });
const scenarioReportSchema = Type.Object(
	{
		verdict: verdictSchema,
		reason: text,
		answers: Type.Optional(Type.Object({ code: answerSchema, guard: answerSchema, base: answerSchema }, strict)),
		evidence: Type.Optional(Type.Array(goldenEvidenceSchema, { minItems: 1 })),
		lower: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		// Substrings the call's result must contain, so a fence that stops refusing fails the golden.
		expectResult: Type.Optional(Type.Array(text, { minItems: 1 })),
	},
	strict,
);
const scenarioExpectationSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("passed"), Type.Literal("findings")]),
		blocking: Type.Boolean(),
		severity: severitySchema,
		originalSeverity: Type.Optional(severitySchema),
		cause: causeSchema,
		resolution: resolutionSchema,
		verdict: verdictSchema,
		lowered: Type.Boolean(),
		important: Type.Optional(
			Type.Object(
				{
					state: Type.Union([Type.Literal("new"), Type.Literal("carried")]),
					originalSeverity: severitySchema,
					lifted: Type.Optional(Type.Literal(true)),
				},
				strict,
			),
		),
		rendered: Type.Optional(Type.Array(text, { minItems: 1 })),
		notRendered: Type.Optional(Type.Array(text, { minItems: 1 })),
	},
	strict,
);
const scenarioSchema = Type.Object(
	{
		group: Type.Union([Type.Literal("lowering"), Type.Literal("surfacing"), Type.Literal("conflict")]),
		// A deterministic check's report of the candidate's own lines, planted beside the lens's.
		coReport: Type.Optional(
			Type.Object({ check: text, rule: text, severity: severitySchema, cause: causeSchema }, strict),
		),
		// One `report_verdict` call each, in order, every one for the candidate's single claim.
		reports: Type.Array(scenarioReportSchema, { minItems: 1 }),
		// Also run with the reports in the opposite order, and expect the same.
		bothOrders: Type.Optional(Type.Literal(true)),
		expectInstructions: Type.Optional(Type.Array(text, { minItems: 1 })),
		// What each reviewed revision must show: the head, then `head2/` when the golden has one.
		expected: Type.Array(scenarioExpectationSchema, { minItems: 1, maxItems: 2 }),
	},
	strict,
);

/**
 * A planted claim, the reports a scripted verifier makes of it, and what the review must then show: the goldens of the
 * decision that lets the verifier lower a severity. They are scripted only, since they test what Melian
 * does with a report, never what a model says.
 */
export interface ScenarioGolden {
	readonly name: string;
	readonly directory: string;
	readonly candidate: Static<typeof reportFindingInputSchema>;
	readonly scenario: Static<typeof scenarioSchema>;
	/** Whether the golden reviews a second revision, `head2/`, on the same storage. */
	readonly revisions: 1 | 2;
}

/** Loads the scenario goldens of the verifier corpus, each a directory with a `scenario.json`, in name order. */
export function loadScenarioGoldens(directory: string = verifierDirectory): ScenarioGolden[] {
	return readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, scenarioFile)))
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const root = join(directory, name);
			const scenario = readJson<ScenarioGolden["scenario"]>(join(root, scenarioFile), scenarioSchema);
			const revisions = existsSync(join(root, "head2")) ? 2 : 1;
			if (scenario.expected.length !== revisions)
				throw new Error(`${name}: expected needs one entry per reviewed revision, ${revisions} here`);
			if (scenario.bothOrders === true && scenario.reports.length < 2)
				throw new Error(`${name}: bothOrders needs at least two reports`);
			return {
				name,
				directory: root,
				scenario,
				revisions,
				candidate: readJson<ScenarioGolden["candidate"]>(join(root, "candidate.json"), reportFindingInputSchema),
			};
		});
}

/** What one reviewed revision of a scenario golden showed. */
export interface ScenarioRevision {
	readonly verdict: Verdict;
	readonly rendered: string;
	readonly json: StoredVerdict;
}

/** A scenario golden's review of each revision, and each report whose result lacked an expected substring. */
export interface ScenarioRun {
	readonly revisions: readonly ScenarioRevision[];
	readonly resultMismatches: readonly string[];
}

/**
 * Plants the golden's candidate through a scripted lens, and any deterministic co-report straight into the findings
 * document, then judges it through the real verification task with the golden's reports, one call a turn, in the
 * order given or `reversed`. A golden with `head2/` commits it and reviews again on the same storage.
 */
export async function runScenarioGolden(golden: ScenarioGolden, reversed = false): Promise<ScenarioRun> {
	const { repo, base } = buildGoldenRepository(golden);
	const { scenario, candidate } = golden;
	const reports = reversed ? [...scenario.reports].reverse() : scenario.reports;
	try {
		const source = { kind: "revision" as const, commit: base };
		const fake = createFakeModels({ provider: "verifier-eval-finder", models: [{ id: "finder" }, { id: "judge" }] });
		const finder = fake.ref("finder");
		const judge = fake.ref("judge");
		const instructions = "Verifier scenario planted finder";
		const resultMismatches: string[] = [];
		const reported = (messages: Parameters<typeof scriptVerifier>[0]) =>
			messages.filter(
				(message) =>
					message.role === "assistant" &&
					message.content.some((block) => block.type === "toolCall" && block.name === "report_verdict"),
			).length;
		const judgeReply = (messages: Parameters<typeof scriptVerifier>[0]) => {
			const prompt = systemPromptOf(messages);
			for (const required of scenario.expectInstructions ?? []) {
				if (!prompt.includes(required)) throw new Error(`Missing verifier instruction: ${required}`);
			}
			const done = reported(messages);
			const previous = reports[done - 1];
			const result = messages.findLast((message) => message.role === "toolResult");
			for (const wanted of previous?.expectResult ?? []) {
				const got = result === undefined ? "" : textOf(result);
				if (!got.includes(wanted))
					resultMismatches.push(
						`report ${done} returned ${JSON.stringify(got)}, expected it to contain ${JSON.stringify(wanted)}`,
					);
			}
			const next = reports[done];
			if (next === undefined) return fauxAssistantMessage("Every claim judged.");
			const { expectResult: _, answers, ...report } = next;
			return fauxAssistantMessage(
				fauxToolCall("report_verdict", {
					claim: /Claim (c[1-9][0-9]*) finding/.exec(prompt)![1]!,
					answers: answers ?? { code: "yes", guard: "no", base: "no" },
					...structuredClone(report),
				} as Parameters<typeof fauxToolCall>[1]),
				{ stopReason: "toolUse" },
			);
		};
		const plant = [
			fauxAssistantMessage(fauxToolCall("report_finding", candidate), { stopReason: "toolUse" }),
			fauxAssistantMessage("Candidate planted."),
		];
		scriptConversations(fake, [
			{ match: instructions, replies: Array.from({ length: golden.revisions }, () => plant).flat() },
			{
				match: "Melian adversarial verifier",
				replies: Array.from({ length: golden.revisions * (reports.length + 1) }, () => judgeReply),
			},
		]);
		const reviewHarness = await openReviewHarness(createMemoryStorage(), fake.review, { retry: false });
		try {
			const revisions: ScenarioRevision[] = [];
			for (let round = 0; round < golden.revisions; round++) {
				if (round > 0) commitGoldenTree(repo, join(golden.directory, "head2"), "head2");
				const changeset = await Changeset.resolve(repo, "main...feature");
				const { config } = await loadConfig(repo, source, ".");
				const template = (await Lens.load(repo, source, changeset.revision.paths())).find(
					(lens) => lens.name === "correctness",
				)!;
				const lens = Lens.from({
					...template.toJSON(),
					instructions,
					severities: ["P0", "P1", "P2", "P3"],
					rules: [{ id: candidate.rule, description: "The planted claim under judgement." }],
				});
				const planted = scenario.coReport;
				if (planted !== undefined) {
					const root = await reviewHarness.harness.root(backgroundContext);
					const finding = coReport(repo, candidate, planted);
					const revision = revisionKey(changeset.revision);
					await root.commit((tx) => upsertFinding(tx, root.id, finding, revision), backgroundContext);
				}
				const result = await reviewChangeset({
					harness: reviewHarness.harness,
					checks: planted === undefined ? [] : [{ name: planted.check, status: "ran" }],
					changeset,
					lenses: [lens],
					standards: [],
					models: fake.review,
					policy: source,
					config: {
						...config,
						tiers: { full: [`lens.${lens.name}`, ...(planted === undefined ? [] : [planted.check])] },
						stages: { "pull-request": "full" },
						models: {
							heavy: { model: `${finder.provider}/${finder.modelId}` },
							verifier: { model: `${judge.provider}/${judge.modelId}` },
						},
					},
				});
				revisions.push({
					verdict: result.verdict,
					rendered: result.verdict.render(new Rendering({ all: true })),
					json: JSON.parse(result.verdict.renderJson()) as StoredVerdict,
				});
			}
			return { revisions, resultMismatches };
		} finally {
			await reviewHarness.close(backgroundContext);
		}
	} finally {
		rmSync(repo, { recursive: true, force: true });
	}
}

// The deterministic check's finding of the candidate's own lines, so adjudication merges the two as one defect.
function coReport(
	repo: string,
	candidate: ScenarioGolden["candidate"],
	planted: NonNullable<ScenarioGolden["scenario"]["coReport"]>,
): Finding {
	const content = readFileSync(join(repo, candidate.file), "utf8");
	const endLine = candidate.endLine ?? candidate.line;
	const snippet = content
		.split("\n")
		.slice(candidate.line - 1, endLine)
		.join("\n");
	return Finding.create({
		rule: planted.rule,
		message: "The planted deterministic check reports these lines.",
		file: candidate.file,
		startLine: candidate.line,
		...(candidate.endLine === undefined ? {} : { endLine }),
		snippet,
		occurrence: snippetOccurrence(content, snippet, { startLine: candidate.line, endLine }),
		cause: planted.cause,
		severity: planted.severity,
		explanation: {
			what: "The planted deterministic check reports these lines.",
			whyHere: "A deterministic co-report keeps its own severity and cause.",
			whatToDo: "Nothing; this is a fixture.",
		},
		source: { check: planted.check },
	});
}

/**
 * How a scenario run differs from what its golden expects, described: each revision's status, the one finding's
 * severity, cause, resolution, verdict and lowering, its place under "Pre-existing, important", and the text
 * the terminal must and must not show, then each report whose result lacked an expected substring. Empty when it agrees.
 */
export function scenarioMismatches(golden: ScenarioGolden, run: ScenarioRun): string[] {
	const problems = [...run.resultMismatches];
	golden.scenario.expected.forEach((expected, index) => {
		const revision = run.revisions[index];
		const say = (what: string, got: unknown, wanted: unknown) => {
			if (JSON.stringify(got) !== JSON.stringify(wanted))
				problems.push(
					`revision ${index + 1}: ${what} is ${JSON.stringify(got)}, expected ${JSON.stringify(wanted)}`,
				);
		};
		if (revision === undefined) {
			problems.push(`revision ${index + 1} was not reviewed`);
			return;
		}
		const { verdict, rendered, json } = revision;
		const findings = verdict.all();
		say("the number of findings", findings.length, 1);
		const finding: ResolvedFinding | undefined = findings[0];
		if (finding === undefined) return;
		say("status", verdict.status, expected.status);
		say("blocking", verdict.blocking, expected.blocking);
		say("severity", finding.properties.severity, expected.severity);
		say("originalSeverity", finding.properties.originalSeverity, expected.originalSeverity);
		say("cause", finding.properties.cause, expected.cause);
		say("resolution", finding.properties.resolution, expected.resolution);
		say("verdict", finding.properties.verification?.verdict, expected.verdict);
		say("lowered", finding.lowered() !== undefined, expected.lowered);
		const listed = (members: readonly ImportantFinding[] | undefined) =>
			members?.map(({ id, ...member }) => ({ ...member, listed: id === finding.id }));
		const wanted = expected.important === undefined ? undefined : [{ ...expected.important, listed: true }];
		const order = (members: ReturnType<typeof listed>) =>
			members?.map(({ state, originalSeverity, lifted, listed: own }) => ({
				state,
				originalSeverity,
				lifted,
				listed: own,
			}));
		say("the important findings", order(listed(verdict.preExistingImportant)), order(wanted));
		say("the important findings in JSON", order(listed(json.preExistingImportant)), order(wanted));
		const stored = Object.values(json.findings).flat()[0]?.properties;
		say("severity in JSON", stored?.severity, expected.severity);
		say("originalSeverity in JSON", stored?.originalSeverity, expected.originalSeverity);
		for (const text of expected.rendered ?? [])
			if (!rendered.includes(text))
				problems.push(`revision ${index + 1}: the terminal lacks ${JSON.stringify(text)}`);
		for (const text of expected.notRendered ?? [])
			if (rendered.includes(text))
				problems.push(`revision ${index + 1}: the terminal shows ${JSON.stringify(text)}`);
	});
	return problems;
}

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
		.filter((entry) => entry.isDirectory() && !existsSync(join(directory, entry.name, scenarioFile)))
		.map((entry) => entry.name)
		.sort()
		.map((name) => {
			const root = join(directory, name);
			const expected = readJson<VerifierGolden["expected"]>(join(root, "expected.json"), expectedSchema);
			if (
				JSON.stringify(expected.verdicts.slice().sort()) !==
				JSON.stringify(
					expected.kind === "decoy"
						? ["refuted"]
						: expected.kind === "design"
							? ["confirmed"]
							: ["confirmed", "plausible"],
				)
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
	readonly telemetry: StageTelemetry;
	readonly verification: Verification | undefined;
	/** Why the verifier judged nothing, as its check recorded it: a provider's error, a spent budget, or a claim left out. */
	readonly unjudged?: string;
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
			(lens) => lens.name === (golden.expected.kind === "design" ? "design" : "correctness"),
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
								(messages: Parameters<typeof scriptVerifier>[0]) => {
									for (const required of golden.script.expectInstructions ?? []) {
										if (!systemPromptOf(messages).includes(required))
											throw new Error(`Missing verifier instruction: ${required}`);
									}
									return scriptVerifier(
										messages,
										Object.fromEntries(
											[...systemPromptOf(messages).matchAll(/finding ([0-9a-f]+)/g)].map((match) => [
												match[1]!,
												golden.script,
											]),
										),
									);
								},
								(messages: Parameters<typeof scriptVerifier>[0]) => scriptVerifier(messages),
							],
						},
					]
				: []),
		]);
		// The judge retries a failed request with backoff, as a review does; one provider error would otherwise score unjudged.
		const storage = createMemoryStorage();
		const reviewHarness = await openReviewHarness(storage, fake.review);
		try {
			const result = await reviewChangeset({
				harness: reviewHarness.harness,
				checks: [],
				changeset,
				lenses: [lens],
				standards: [],
				models: fake.review,
				policy: source,
				config: {
					...defaultConfig,
					tiers: { full: [`lens.${lens.name}`] },
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
			const reason = result.verdict!.notRun.find((check) => check.name === "verifier")?.reason;
			return {
				telemetry: await TelemetryReader.open(storage).read(revisionKey(changeset.revision)),
				verification: result instanceof ReviewError ? undefined : result.findings[0]!.properties.verification,
				...(reason === undefined ? {} : { unjudged: reason }),
				rendered: result.verdict!.render(new Rendering({ all: true })),
				verifierRequests: requests[marker]?.length ?? 0,
			};
		} catch (error) {
			throw new GoldenRunError(error, await TelemetryReader.open(storage).read(revisionKey(changeset.revision)));
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
