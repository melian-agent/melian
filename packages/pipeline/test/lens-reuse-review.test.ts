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
import { ReviewIndex } from "../src/review-index.ts";
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
	extra: { readonly unlockModels?: (providers: readonly string[]) => Promise<void> } = {},
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
	const input = task!.input as { reused?: Record<string, unknown> };
	const copied = "reused" in input ? Object.keys(input.reused ?? {}).map((key) => key.split("@")[0]) : "none";
	const outcome = task!.state.outcome as { result: Record<string, { conversation?: string }> };
	const conversations = Object.fromEntries(
		Object.entries(outcome.result).map(([key, { conversation }]) => [key.split("@")[0], conversation]),
	);
	const details = (await harness.snapshot(VerdictDocument, root, context))!.details![
		Revision.key(changeset.revision)
	]!;
	const usage = Object.fromEntries(details.lenses.map(({ name, usage }) => [name, usage]));
	return { review: result, asked: [...asked].sort(), lensStages, copied, conversations, task: entry.task, usage };
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
		).toEqual(["lens.contracts", "lens.correctness"]);
		expect(second.lensStages.contracts).toEqual({ outcome: "reused", tokens: undefined });
		expect(first.usage.contracts).toBeDefined();
		expect(second.usage.contracts).toBeUndefined();
		expect(second.usage.correctness).toBeDefined();
		expect(second.lensStages.correctness?.outcome).toBe("ran");
		expect(second.lensStages.correctness?.tokens).toBeGreaterThan(0);
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

	it("keeps a copied lens's caller notes from the review that asked it, not the one that copied it", async () => {
		const root = mkdtempSync(join(tmpdir(), "melian-reuse-notes-"));
		try {
			const parts = { tree: "a".repeat(40), version: "0.0.1", binary: "b".repeat(64), config: "c".repeat(64) };
			const enabled = { ...config, static: { ...config.static, enola: { ...config.static.enola, enabled: true } } };
			const notesOf = async (reviewed: readonly Lens[], callers?: CallerContext, settings = enabled) => {
				const plain = () => fauxAssistantMessage("No findings.");
				scriptConversations(fake, [
					{ match: correctness, replies: [plain] },
					{ match: contracts, replies: [plain] },
				]);
				const result = await reviewChangeset({
					harness,
					changeset: await Changeset.resolve(repo, "main...feature"),
					config: settings,
					lenses: reviewed,
					standards: [],
					models: fake.review,
					...(callers === undefined ? {} : { callers }),
					checks: [{ name: "guardrails", status: "ran" }],
				});
				return Object.fromEntries(
					(result.verdict.ran ?? [])
						.filter(({ name }) => name.startsWith("lens."))
						.map((record) => [record.name, "reason" in record ? (record.reason ?? "") : ""]),
				);
			};
			const unavailable = "Callers unavailable: the host supplied no graph context";
			const first = await notesOf(
				lenses,
				CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts }, root),
			);
			expect(first["lens.contracts"]).not.toContain(unavailable);

			const again = await notesOf(
				changed("correctness", (lens) => ({ instructions: `${lens.instructions} Look twice.` })),
			);
			expect(again["lens.correctness"]).toContain(unavailable);
			expect(again["lens.contracts"]).not.toContain(unavailable);

			// The correctness lens is copied from the review above, which ran it without callers, though this one has them.
			const third = await notesOf(
				lenses.map((lens) => Lens.from({ ...lens.toJSON(), instructions: `${lens.instructions} Look twice.` })),
				CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts }, root),
			);
			expect(third["lens.correctness"]).toContain(unavailable);
			expect(third["lens.contracts"]).not.toContain(unavailable);

			// A review with Enola off keeps no caller notes, so a lens copied from it carries none into one with Enola on.
			const off = lenses.map((lens) =>
				Lens.from({ ...lens.toJSON(), instructions: `${lens.instructions} Look off.` }),
			);
			await notesOf(off, undefined, config);
			await notesOf(
				off.map((lens) =>
					lens.name === "correctness"
						? Lens.from({ ...lens.toJSON(), instructions: `${lens.instructions} On.` })
						: lens,
				),
				CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts }, root),
			);
			const changeset = await Changeset.resolve(repo, "main...feature");
			const index = (await harness.snapshot(ReviewIndex, (await harness.root(context)).id, context))!.reviews;
			const task = await harness.getTask(
				index[Revision.key(changeset.revision)]!.task as Parameters<Harness["getTask"]>[0],
				context,
			);
			const input = task!.input as { reused?: object; callers: { notes: Record<string, unknown> } };
			expect(Object.keys(input.reused ?? {}).map((key) => key.split("@")[0])).toEqual(["contracts"]);
			expect(Object.keys(input.callers.notes).map((key) => key.split("@")[0])).toEqual(["correctness"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps the caller caveat of a run it copies from a review that had no callers", async () => {
		const root = mkdtempSync(join(tmpdir(), "melian-reuse-caveat-"));
		try {
			const parts = { tree: "a".repeat(40), version: "0.0.1", binary: "b".repeat(64), config: "c".repeat(64) };
			const enabled = { ...config, static: { ...config.static, enola: { ...config.static.enola, enabled: true } } };
			const caveatsOf = async (reviewed: readonly Lens[], callers?: CallerContext) => {
				const plain = () => fauxAssistantMessage("No findings.");
				scriptConversations(fake, [
					{ match: correctness, replies: [plain] },
					{ match: contracts, replies: [plain] },
				]);
				const result = await reviewChangeset({
					harness,
					changeset: await Changeset.resolve(repo, "main...feature"),
					config: enabled,
					lenses: reviewed,
					standards: [],
					models: fake.review,
					...(callers === undefined ? {} : { callers }),
					checks: [{ name: "guardrails", status: "ran" }],
				});
				return Object.fromEntries(
					(result.verdict.ran ?? [])
						.filter(({ name }) => name.startsWith("lens."))
						.map((record) => [record.name, "caveats" in record ? (record.caveats ?? []) : []]),
				);
			};
			const blind = [`${blindCallers}: the host supplied no graph context`];
			expect((await caveatsOf(lenses))["lens.contracts"]).toEqual(blind);

			// The contracts lens is copied from the review above, which ran it without callers, though this one has them.
			const again = await caveatsOf(
				changed("correctness", (lens) => ({ instructions: `${lens.instructions} Look twice.` })),
				CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts }, root),
			);
			expect(again["lens.contracts"]).toEqual(blind);

			// Asked again with callers, neither lens is copied, so the earlier caveat goes.
			const fresh = await caveatsOf(
				lenses.map((lens) => Lens.from({ ...lens.toJSON(), instructions: `${lens.instructions} Look again.` })),
				CallerContext.from({ groups: [], issues: [], notes: [], paths: [], parts }, root),
			);
			expect(fresh).toEqual({ "lens.contracts": [], "lens.correctness": [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
