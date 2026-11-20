import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	defaultConfig,
	GraphSnapshot,
	Lens,
	type LensToolName,
	type MelianConfig,
	ReviewCoverage,
	Revision,
	Standards,
} from "@melian-agent/core";
import {
	CallerContext,
	type CallerData,
	CoverageCache,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	GraphCache,
	type Harness,
	type Message,
	openHarness,
	reviewChangeset,
	TelemetryReader,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { blindCallers } from "../src/caveats.ts";
import { lensListedTools } from "../src/lens-tools.ts";
import { MutationEnumerationError, TypeScriptMutationAdapter } from "../src/mutation-enumeration.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { ReviewRecords } from "../src/review-records.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";

// The finding the contracts lens reports on its first turn, so a copied run's finding has to survive the copy.
const changedReturn = {
	file: "src/a.ts",
	line: 1,
	rule: "changed-return",
	severity: "P2",
	explanation: { what: "a is 2 now.", why: "This change rewrote it.", fix: "Restore 1." },
	failureScenario: "A caller that reads a expects 1 and gets 2.",
	evidence: [{ file: "src/a.ts", line: 1, role: "cause" }],
};

let repo: string;
let fake: FakeModels;
let harness: Harness;
let storage: ReturnType<typeof createMemoryStorage>;
let lenses: Lens[];
let config: MelianConfig;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	config = {
		...defaultConfig,
		tiers: twoLensTiers,
		models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	storage = createMemoryStorage();
	harness = await openHarness(storage, {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	lenses = (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts");
});

afterEach(async () => {
	await harness.close(context);
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

function changed(name: string, change: (lens: Lens) => Partial<ReturnType<Lens["toJSON"]>>): Lens[] {
	return lenses.map((lens) => (lens.name === name ? Lens.from({ ...lens.toJSON(), ...change(lens) }) : lens));
}

// Reviews the change once, and says which lenses this review asked a model.
async function review(
	reviewed: readonly Lens[],
	standards: Standards | [] = [],
	extra: {
		readonly unlockModels?: (providers: readonly string[]) => Promise<void>;
		readonly callers?: CallerContext;
		readonly config?: MelianConfig;
		readonly rerun?: boolean;
	} = {},
) {
	const asked = new Set<string>();
	const answer = (name: string) => (messages: readonly Message[]) => {
		asked.add(name);
		const reports = name === "contracts" && systemPromptOf(messages).includes(contracts);
		if (reports && !messages.some((message) => message.role === "toolResult"))
			return fauxAssistantMessage(fauxToolCall("report_finding", changedReturn), { stopReason: "toolUse" });
		return fauxAssistantMessage("No findings.");
	};
	// Spare replies, for a review that runs inside another's unlock and so takes over its scripts.
	scriptConversations(fake, [
		{ match: correctness, replies: Array.from({ length: 4 }, () => answer("correctness")) },
		{ match: contracts, replies: Array.from({ length: 4 }, () => answer("contracts")) },
	]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const result = await reviewChangeset({
		harness,
		changeset,
		config,
		lenses: reviewed,
		standards,
		models: fake.review,
		checks: [
			{ name: "guardrails", status: "ran" },
			{ name: "static.biome", status: "ran" },
			{ name: "static.tsc", status: "ran" },
			{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
		],
		...extra,
	});
	const run = (await TelemetryReader.open(storage).read(Revision.key(changeset.revision))).runDetails();
	const lensStages = Object.fromEntries(
		run.stages
			.filter(({ name }) => name.startsWith("lens "))
			.map((stage) => [stage.name.slice("lens ".length), { outcome: stage.outcome, tokens: stage.tokens }]),
	);
	const root = (await harness.root(context)).id;
	const entry = (await harness.snapshot(ReviewIndex, root, context))!.reviews[Revision.key(changeset.revision)]!;
	const task = await harness.getTask(entry.task as Parameters<Harness["getTask"]>[0], context);
	const input = task!.input as {
		reused?: Record<string, unknown>;
		callers?: { notes: Record<string, string[]>; caveat?: string };
	};
	const copied = "reused" in input ? Object.keys(input.reused ?? {}).map((key) => key.split("@")[0]) : "none";
	const outcome = task!.state.outcome as { result: Record<string, { conversation?: string }> };
	const conversations = Object.fromEntries(
		Object.entries(outcome.result).map(([key, { conversation }]) => [key.split("@")[0], conversation]),
	);
	const details = (await harness.snapshot(VerdictDocument, root, context))!.details![
		Revision.key(changeset.revision)
	]!;
	const usage = Object.fromEntries(details.lenses.map(({ name, usage }) => [name, usage]));
	return {
		review: result,
		run,
		asked: [...asked].sort(),
		lensStages,
		copied,
		conversations,
		task: entry.task,
		usage,
		callers: input.callers,
	};
}

describe("a repeat review copies each lens run whose request is unchanged", () => {
	it("asks only the lens whose instructions changed, keeps the copied lens's finding, and charges it nothing", async () => {
		const first = await review(lenses);
		expect(first.asked).toEqual(["contracts", "correctness"]);
		expect(first.review.findings.map(({ ruleId }) => ruleId)).toEqual(["changed-return"]);
		expect(first.copied).toBe("none");

		const second = await review(
			changed("correctness", (lens) => ({ instructions: `${lens.instructions} Look twice.` })),
		);

		expect(second.asked).toEqual(["correctness"]);
		expect(second.copied).toEqual(["contracts"]);
		expect(first.conversations.contracts).toBeDefined();
		expect(second.conversations.contracts).toBe(first.conversations.contracts);
		expect(second.conversations.correctness).not.toBe(first.conversations.correctness);
		expect(second.review.findings.map(({ id }) => id)).toEqual(first.review.findings.map(({ id }) => id));
		expect(
			(second.review.verdict.ran ?? []).filter(({ name }) => name.startsWith("lens.")).map(({ name }) => name),
		).toEqual(["lens.correctness", "lens.contracts"]);
		expect(second.lensStages.contracts).toEqual({ outcome: "reused", tokens: undefined });
		expect(first.usage.contracts).toBeDefined();
		expect(second.usage.contracts).toBeUndefined();
		expect(second.usage.correctness).toBeDefined();
		expect(second.lensStages.correctness?.outcome).toBe("ran");
		expect(second.lensStages.correctness?.tokens).toBeGreaterThan(0);
		const records = ReviewRecords.of("c".repeat(64), { base: "a".repeat(40), head: "b".repeat(40) });
		const exported = records.telemetry(records.round([], undefined, [], []), second.run).toJSON().payload as {
			stages: { outcome: string }[];
		};
		expect(exported.stages.map(({ outcome }) => outcome)).toEqual(second.run.stages.map(({ outcome }) => outcome));
	});

	it("copies nothing from a lens task that ended without completing, and asks every lens again", async () => {
		let held!: () => void;
		const asked = new Promise<void>((resolve) => {
			held = resolve;
		});
		// The fake model ignores the abort signal, so each held reply ends as an aborted one once the task is aborted.
		const pending: (() => void)[] = [];
		const hang = () => {
			held();
			return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
				pending.push(() => resolve(fauxAssistantMessage([], { stopReason: "aborted", errorMessage: "aborted" })));
			});
		};
		scriptConversations(fake, [
			{ match: correctness, replies: [hang] },
			{ match: contracts, replies: [hang] },
		]);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const first = reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: [],
			models: fake.review,
			checks: [{ name: "guardrails", status: "ran" }],
		}).catch(() => undefined);
		await asked;
		const root = (await harness.root(context)).id;
		const entry = (await harness.snapshot(ReviewIndex, root, context))!.reviews[Revision.key(changeset.revision)]!;
		const aborted = harness.abortTask(entry.task as Parameters<Harness["abortTask"]>[0], context);
		for (const finish of pending) finish();
		await aborted;
		await first;
		const ended = await harness.getTask(entry.task as Parameters<Harness["getTask"]>[0], context);
		expect(ended!.state.status).toBe("terminal");
		expect((ended!.state.outcome as { status: string }).status).not.toBe("completed");

		const again = await review(lenses);
		expect(again.task).not.toBe(entry.task);
		expect(again.asked).toEqual(["contracts", "correctness"]);
		expect(again.copied).toBe("none");
	});

	it("unlocks the providers of only the lenses it asks, since a copied lens asks no model", async () => {
		const unlocked: string[][] = [];
		const unlockModels = async (providers: readonly string[]) => {
			unlocked.push([...providers]);
		};
		await review(lenses, [], { unlockModels });
		await review(
			changed("correctness", (lens) => ({ instructions: `${lens.instructions} Look twice.` })),
			[],
			{ unlockModels },
		);
		// Each review unlocks its lens runs, then the verifier's wave: the repeat review's lens call names one run.
		expect(unlocked).toEqual([["faux", "faux"], ["faux"], ["faux"], ["faux"]]);
	});

	it("unlocks every run's provider when a review that ran during its unlock leaves it nothing to copy", async () => {
		await review(lenses);
		const unlocked: string[][] = [];
		const unlockModels = async (providers: readonly string[]) => {
			unlocked.push([...providers]);
			if (unlocked.length > 1) return;
			// While this review unlocks the one run it means to ask, another changes the contracts lens, so the task this
			// review then reads holds neither of its runs.
			await review(
				changed("contracts", (lens) => ({ instructions: `${lens.instructions} Look again.` })),
				[],
			);
		};
		const again = await review(
			changed("correctness", (lens) => ({ instructions: `${lens.instructions} Look twice.` })),
			[],
			{ unlockModels },
		);
		expect(again.copied).toBe("none");
		// The run it meant to ask, then every run once its commit found the copy gone, then the verifier's wave.
		expect(unlocked).toEqual([["faux"], ["faux", "faux"], ["faux"]]);
	});

	it("unlocks every run's provider when it meant to attach and a review that ran meanwhile leaves it a run to ask", async () => {
		const first = await review(lenses);
		const unlocked: string[][] = [];
		const unlockModels = async (providers: readonly string[]) => {
			unlocked.push([...providers]);
		};
		const getTask = harness.getTask.bind(harness);
		let raced = false;
		// Once this review has read the finished task it means to attach to, another reviews only the correctness lens,
		// so this review's commit finds a task of another selection and runs both lenses afresh.
		vi.spyOn(harness, "getTask").mockImplementation(async (...args) => {
			const read = await getTask(...args);
			if (!raced) {
				raced = true;
				await review(lenses.filter(({ name }) => name === "correctness"));
			}
			return read;
		});
		const again = await review(lenses, [], { unlockModels });
		expect(again.task).not.toBe(first.task);
		// Every run once its commit found it could not attach, then the verifier's wave.
		expect(unlocked).toEqual([["faux", "faux"], ["faux"]]);
	});

	it("unlocks every run's provider when it read a task to attach to and a review that ran meanwhile replaced it", async () => {
		const changeset = await Changeset.resolve(repo, "main...feature");
		scriptConversations(fake, [
			{ match: correctness, replies: [() => fauxAssistantMessage("No findings.")] },
			{
				match: contracts,
				replies: [() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider down" })],
			},
		]);
		await reviewChangeset({
			harness,
			changeset,
			config,
			lenses,
			standards: [],
			models: fake.review,
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.biome", status: "ran" },
				{ name: "static.tsc", status: "ran" },
				{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
			],
		}).catch(() => undefined);
		const root = (await harness.root(context)).id;
		const entry = async () =>
			(await harness.snapshot(ReviewIndex, root, context))!.reviews[Revision.key(changeset.revision)]!.task;
		const failed = await entry();
		const unlocked: string[][] = [];
		const getTask = harness.getTask.bind(harness);
		let racer: Promise<Awaited<ReturnType<typeof review>>> | undefined;
		// Once this review has read the failed task it means to attach to, another reviews the same lenses with --rerun,
		// so a live task asks contracts again, and this review's commit finds that task under its own selection.
		vi.spyOn(harness, "getTask").mockImplementation(async (...args) => {
			const read = await getTask(...args);
			if (racer === undefined && args[0] === failed) {
				racer = review(lenses, [], { rerun: true });
				while ((await entry()) === failed) await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return read;
		});
		const again = await review(lenses, [], {
			unlockModels: async (providers) => {
				unlocked.push([...providers]);
			},
		});
		expect(again.task).toBe((await racer!).task);
		expect(again.task).not.toBe(failed);
		// Every run once its commit found a task other than the one it read.
		expect(unlocked[0]).toEqual(["faux", "faux"]);
	});

	it("attaches to the first review's lens task when the same lenses come in another order", async () => {
		const first = await review(lenses);
		const again = await review([...lenses].reverse());
		expect(again.task).toBe(first.task);
		expect(again.asked).toEqual([]);
	});

	it("asks only the lenses offered a tool whose description changed", async () => {
		const reading: LensToolName[] = ["read_file", "search"];
		const narrowed = changed("correctness", () => ({ tools: reading }));
		await review(narrowed);
		const { description } = lensListedTools.list_files;
		try {
			(lensListedTools.list_files as { description: string }).description = `${description} Changed.`;
			expect((await review(narrowed)).asked).toEqual(["contracts"]);
		} finally {
			(lensListedTools.list_files as { description: string }).description = description;
		}
	});

	it("copies every run when the standards differ only in the preference file's path, which names the host", async () => {
		const paths = ["src/a.ts"];
		await review(lenses, await Standards.load(repo, { kind: "worktree", preferences: "/home/a/melian.yaml" }, paths));
		const again = await review(
			lenses,
			await Standards.load(repo, { kind: "worktree", preferences: "/home/b/melian.yaml" }, paths),
		);
		expect(again.asked).toEqual([]);
	});

	it("asks every lens again when the same standards are read at another commit", async () => {
		const paths = ["src/a.ts"];
		const at = (branch: string) => ({ kind: "revision" as const, commit: gitIn(repo, "rev-parse", branch) });
		await review(lenses, await Standards.load(repo, at("main"), paths));
		const again = await review(lenses, await Standards.load(repo, at("feature"), paths));
		expect(again.asked).toEqual(["contracts", "correctness"]);
	});

	it("asks every lens again when the standards' source changes", async () => {
		const paths = ["src/a.ts"];
		await review(lenses, await Standards.load(repo, { kind: "worktree" }, paths));
		const again = await review(lenses, []);
		expect(again.asked).toEqual(["contracts", "correctness"]);
	});

	it("keeps a copied lens's reads in the coverage the repeat review records", async () => {
		const root = mkdtempSync(join(tmpdir(), "melian-reuse-coverage-"));
		try {
			const parts = { tree: "a".repeat(40), version: "0.0.1", binary: "b".repeat(64), config: "c".repeat(64) };
			await (await GraphCache.open(root)).store(
				GraphSnapshot.create(parts, {
					"facts.jsonl": "",
					"insights.json": "[]",
					"receipt.json": JSON.stringify({
						format_version: 1,
						enola_version: parts.version,
						snapshot_id: `sha256:${"d".repeat(64)}`,
					}),
				}),
			);
			const enabled = { ...config, static: { ...config.static, enola: { ...config.static.enola, enabled: true } } };
			const reads = async (reviewed: readonly Lens[]) => {
				const reader = (messages: readonly Message[]) =>
					messages.some((message) => message.role === "toolResult")
						? fauxAssistantMessage("No findings.")
						: fauxAssistantMessage(fauxToolCall("read_file", { path: "src/a.ts" }), { stopReason: "toolUse" });
				scriptConversations(fake, [
					{ match: correctness, replies: [reader, reader] },
					{ match: contracts, replies: [reader, reader] },
				]);
				const result = await reviewChangeset({
					harness,
					changeset: await Changeset.resolve(repo, "main...feature"),
					config: enabled,
					lenses: reviewed,
					standards: [],
					models: fake.review,
					callers: CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts }, root),
					checks: [
						{ name: "guardrails", status: "ran" },
						{ name: "static.biome", status: "ran" },
						{ name: "static.tsc", status: "ran" },
						{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
					],
				});
				const id = result.verdict.ran?.find(({ name }) => name === "lens.contracts")?.coverage?.review;
				const stored = await (await CoverageCache.open(root)).read(parts, "review", { id });
				if (!(stored instanceof ReviewCoverage)) throw new Error("Review coverage missing");
				return Object.fromEntries(
					stored
						.toJSON()
						.lenses.map(({ name, files }) => [
							name,
							files.map(({ path, revision, status }) => `${revision} ${path} ${status}`),
						]),
				);
			};

			const each = ["head src/a.ts read", "base src/a.ts not read"];
			expect(await reads(lenses)).toEqual({ contracts: each, correctness: each });
			expect(
				await reads(changed("correctness", (lens) => ({ instructions: `${lens.instructions} Look twice.` }))),
			).toEqual({ contracts: each, correctness: each });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("a repeat review copies a lens run only from a task shown the same callers", () => {
	const parts = { tree: "a".repeat(40), version: "0.0.1", binary: "b".repeat(64), config: "c".repeat(64) };
	let root: string;
	let enabled: MelianConfig;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "melian-reuse-callers-"));
		enabled = { ...config, static: { ...config.static, enola: { ...config.static.enola, enabled: true } } };
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	const graph = (data: Partial<CallerData> = {}, graphParts = parts) =>
		CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts: graphParts, ...data }, root);
	const lookTwice = () => changed("correctness", (lens) => ({ instructions: `${lens.instructions} Look twice.` }));

	it("copies the unchanged lens when both reviews were shown the same graph and caveat", async () => {
		await review(lenses, [], { config: enabled, callers: graph() });
		const again = await review(lookTwice(), [], { config: enabled, callers: graph() });
		expect(again.asked).toEqual(["correctness"]);
		expect(again.copied).toEqual(["contracts"]);
	});

	it("asks every lens again when the earlier review saw callers and this one has none", async () => {
		await review(lenses, [], { config: enabled, callers: graph() });
		const again = await review(lookTwice(), [], { config: enabled });
		expect(again.asked).toEqual(["contracts", "correctness"]);
		expect(again.copied).toEqual("none");
		expect(again.callers?.caveat).toBe(`${blindCallers}: the host supplied no graph context`);
	});

	it("asks every lens again when the earlier review had no callers and this one has them", async () => {
		await review(lenses, [], { config: enabled });
		const again = await review(lookTwice(), [], { config: enabled, callers: graph() });
		expect(again.asked).toEqual(["contracts", "correctness"]);
		expect(again.copied).toEqual("none");
		expect(again.callers).not.toHaveProperty("caveat");
	});

	it("asks every lens again when the graph was rebuilt for the same tree", async () => {
		await review(lenses, [], { config: enabled, callers: graph() });
		const again = await review(lookTwice(), [], {
			config: enabled,
			callers: graph({}, { ...parts, version: "0.0.2" }),
		});
		expect(again.asked).toEqual(["contracts", "correctness"]);
		expect(again.copied).toEqual("none");
	});

	it("asks every lens again when the graph matches and only the caveat differs", async () => {
		await review(lenses, [], { config: enabled, callers: graph() });
		const again = await review(lookTwice(), [], {
			config: enabled,
			callers: graph({ issues: [{ file: "src/a.ts", reason: "the query timed out" }] }),
		});
		expect(again.asked).toEqual(["contracts", "correctness"]);
		expect(again.copied).toEqual("none");
		expect(again.callers?.caveat).toBe(
			`${blindCallers}: each changed site was a test file or its caller query failed`,
		);
	});

	it("asks every lens again when Enola was off for the earlier review", async () => {
		await review(lenses);
		const again = await review(lookTwice(), [], { config: enabled, callers: graph() });
		expect(again.asked).toEqual(["contracts", "correctness"]);
		expect(again.copied).toEqual("none");
	});

	it("unlocks every run's provider when it meant to copy and a review that ran meanwhile leaves it a task to attach to", async () => {
		await review(lenses, [], { config: enabled, callers: graph() });
		const unlocked: string[][] = [];
		let racer: Awaited<ReturnType<typeof review>> | undefined;
		const unlockModels = async (providers: readonly string[]) => {
			unlocked.push([...providers]);
			if (racer !== undefined) return;
			// While this review unlocks the one run it means to ask, another reviews the same lenses with no callers, so it
			// copies nothing and asks both. This review's commit then finds that task under its own selection.
			racer = await review(lookTwice(), [], { config: enabled });
		};
		const again = await review(lookTwice(), [], { config: enabled, callers: graph(), unlockModels });
		expect(racer?.copied).toBe("none");
		expect(again.task).toBe(racer?.task);
		// The run it meant to ask, then every run once its commit found a task to attach to. The verification it then
		// attaches to is the other review's, so it unlocks no verifier.
		expect(unlocked).toEqual([["faux"], ["faux", "faux"]]);
	});

	it("keeps a copied lens's caller notes from the review that asked it when only a file's caller query differs", async () => {
		const groups = [{ file: "src/a.ts", symbol: "a", callers: [], truncated: false }];
		const failed = "Callers unavailable for src/a.ts: the query timed out";
		await review(lenses, [], { config: enabled, callers: graph({ groups }) });
		const again = await review(lookTwice(), [], {
			config: enabled,
			callers: graph({ groups, issues: [{ file: "src/a.ts", reason: "the query timed out" }] }),
		});
		expect(again.copied).toEqual(["contracts"]);
		const notes = Object.fromEntries(
			Object.entries(again.callers?.notes ?? {}).map(([key, notes]) => [key.split("@")[0], notes]),
		);
		expect(notes).toEqual({ contracts: [], correctness: [failed] });
	});
});

describe("a repeat review keys the instrumenter that answers list_mutants", () => {
	const listing: LensToolName[] = ["read_file", "search", "list_mutants"];
	const instrumenter = (toolVersion: string, source: "checkout" | "melian") =>
		vi
			.spyOn(TypeScriptMutationAdapter, "open")
			.mockResolvedValue({
				identity: { toolVersion },
				source,
				installedPackages: () => `packages beneath ${toolVersion}`,
			} as unknown as TypeScriptMutationAdapter);

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("asks only the lens offered list_mutants again when the instrumenter's version or its source changes", async () => {
		const offered = changed("contracts", (lens) => ({ tools: [...lens.tools, "list_mutants"] }));
		instrumenter("10.0.0", "checkout");
		await review(offered);
		expect((await review(offered)).asked).toEqual([]);
		instrumenter("10.1.0", "checkout");
		expect((await review(offered)).asked).toEqual(["contracts"]);
		instrumenter("10.1.0", "melian");
		expect((await review(offered)).asked).toEqual(["contracts"]);
	});

	it("keys an instrumenter that cannot be found as unavailable, apart from one that can", async () => {
		const offered = changed("contracts", (lens) => ({ tools: [...lens.tools, "list_mutants"] }));
		vi.spyOn(TypeScriptMutationAdapter, "open").mockRejectedValue(
			new MutationEnumerationError("instrumenter", "Stryker's instrumenter is unavailable"),
		);
		expect((await review(offered)).asked).toEqual(["contracts", "correctness"]);
		instrumenter("10.0.0", "checkout");
		expect((await review(offered)).asked).toEqual(["contracts"]);
	});

	it("fails the review on any other failure to resolve the instrumenter", async () => {
		const offered = changed("contracts", (lens) => ({ tools: [...lens.tools, "list_mutants"] }));
		const refusal = new MutationEnumerationError("policy", "the base's policy cannot be read");
		vi.spyOn(TypeScriptMutationAdapter, "open").mockRejectedValue(refusal);
		await expect(review(offered)).rejects.toBe(refusal);
	});

	it("resolves the instrumenter once a review, and not at all when no lens is offered list_mutants", async () => {
		const open = instrumenter("10.0.0", "checkout");
		await review(lenses.map((lens) => Lens.from({ ...lens.toJSON(), tools: listing })));
		expect(open).toHaveBeenCalledTimes(1);
		open.mockClear();
		await review(lenses);
		expect(open).not.toHaveBeenCalled();
	});
});
