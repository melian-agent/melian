import { rmSync } from "node:fs";
import {
	Changeset,
	defaultConfig,
	Lens,
	type LensToolName,
	type MelianConfig,
	Revision,
	Standards,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
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
import { lensListedTools } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";
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
async function review(reviewed: readonly Lens[], standards: Standards | [] = []) {
	const asked = new Set<string>();
	const answer = (name: string) => (messages: readonly Message[]) => {
		asked.add(name);
		const reports = name === "contracts" && systemPromptOf(messages).includes(contracts);
		if (reports && !messages.some((message) => message.role === "toolResult"))
			return fauxAssistantMessage(fauxToolCall("report_finding", changedReturn), { stopReason: "toolUse" });
		return fauxAssistantMessage("No findings.");
	};
	scriptConversations(fake, [
		{ match: correctness, replies: [answer("correctness"), answer("correctness")] },
		{ match: contracts, replies: [answer("contracts"), answer("contracts")] },
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
	return { review: result, asked: [...asked].sort(), lensStages, copied };
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
		expect(second.review.findings.map(({ id }) => id)).toEqual(first.review.findings.map(({ id }) => id));
		expect(
			(second.review.verdict.ran ?? []).filter(({ name }) => name.startsWith("lens.")).map(({ name }) => name),
		).toEqual(["lens.contracts", "lens.correctness"]);
		expect(second.lensStages.contracts).toEqual({ outcome: "reused", tokens: undefined });
		expect(second.lensStages.correctness?.outcome).toBe("ran");
		expect(second.lensStages.correctness?.tokens).toBeGreaterThan(0);
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

	it("asks every lens again when the standards' source changes", async () => {
		const paths = ["src/a.ts"];
		await review(lenses, await Standards.load(repo, { kind: "worktree" }, paths));
		const again = await review(lenses, []);
		expect(again.asked).toEqual(["contracts", "correctness"]);
	});
});
