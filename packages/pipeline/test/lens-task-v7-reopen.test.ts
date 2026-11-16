import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, type MelianConfig, Revision } from "@melian-agent/core";
import {
	backgroundContext as context,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	openSqliteStorage,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewIndex } from "../src/review-index.ts";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const fixture = join(import.meta.dirname, "fixtures", "lens-task-v7");
const recorded = JSON.parse(readFileSync(join(fixture, "recorded.json"), "utf8")) as {
	base: string;
	head: string;
	revision: string;
	lensTask: { version: number };
	findings: string[];
	lenses: string[];
	task: number;
};

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";
const changedReturn = {
	file: "src/a.ts",
	line: 1,
	rule: "changed-return",
	severity: "P2",
	explanation: { what: "a is 2 now.", why: "This change rewrote it.", fix: "Restore 1." },
	failureScenario: "A caller that reads a expects 1 and gets 2.",
	evidence: [{ file: "src/a.ts", line: 1, role: "cause" }],
};

let directory: string;
let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	// The dates capture.mjs fixed, so these are the commits main reviewed.
	vi.stubEnv("GIT_AUTHOR_DATE", "2026-11-15T00:00:00Z");
	vi.stubEnv("GIT_COMMITTER_DATE", "2026-11-15T00:00:00Z");
	directory = mkdtempSync(join(tmpdir(), "melian-lens-task-v7-"));
	copyFileSync(join(fixture, "state.sqlite"), join(directory, "state.sqlite"));
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

describe("a store main wrote at lens task version 7", () => {
	it("stands on the version-7 task, and a version-8 task copies its run, naming its task and nonce", async () => {
		expect([gitIn(repo, "rev-parse", "main"), gitIn(repo, "rev-parse", "feature")]).toEqual([
			recorded.base,
			recorded.head,
		]);
		expect(recorded.lensTask.version).toBe(7);
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const heavy = fake.ref("heavy");
		const config: MelianConfig = {
			...defaultConfig,
			tiers: twoLensTiers,
			models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
		};
		const storage = await openSqliteStorage(join(directory, "state.sqlite"));
		harness = await openHarness(storage, {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const root = (await harness.root(context)).id;
		expect((await harness.snapshot(ReviewIndex, root, context))?.reviews[recorded.revision]).toMatchObject({
			task: recorded.task,
			lenses: recorded.lenses,
		});

		const answer = (messages: readonly Message[]) =>
			systemPromptOf(messages).includes(contracts) && !messages.some((message) => message.role === "toolResult")
				? fauxAssistantMessage(fauxToolCall("report_finding", changedReturn), { stopReason: "toolUse" })
				: fauxAssistantMessage("No findings.");
		const requests = scriptConversations(fake, [
			{ match: correctness, replies: [answer, answer] },
			{ match: contracts, replies: [answer, answer, answer] },
		]);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const builtins = (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts");
		const reviewWith = (lenses: readonly Lens[]) =>
			reviewChangeset({
				harness: harness!,
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
			});
		const revision = Revision.key(changeset.revision);
		const taskOf = async () =>
			harness!.getTask(
				(await harness!.snapshot(ReviewIndex, root, context))!.reviews[revision]!.task as Parameters<
					Harness["getTask"]
				>[0],
				context,
			);

		// The same lenses stand on the stored task itself.
		const same = await reviewWith(builtins);
		expect([requests[correctness]?.length ?? 0, requests[contracts]?.length ?? 0]).toEqual([0, 0]);
		expect(same.findings.map(({ id }) => id)).toEqual(recorded.findings);
		expect((await taskOf())?.id).toBe(recorded.task);

		// A changed contracts lens makes a version-8 task, which copies correctness from the version-7 one.
		const changed = builtins.map((lens) =>
			lens.name === "contracts"
				? Lens.from({ ...lens.toJSON(), instructions: `${lens.instructions} Look twice.` })
				: lens,
		);
		const again = await reviewWith(changed);
		expect([requests[correctness]?.length ?? 0, requests[contracts]?.length ?? 0]).toEqual([0, 2]);
		expect(again.findings.map(({ id }) => id)).toEqual(recorded.findings);
		const task = await taskOf();
		expect(task?.version).toBe(8);
		expect(task?.id).not.toBe(recorded.task);
		const reused = (task!.input as { reused?: Record<string, unknown> }).reused ?? {};
		const key = recorded.lenses.find((lens) => lens.startsWith("correctness@"))!.split(" ")[0]!;
		expect(Object.keys(reused)).toEqual([key]);
		expect(reused[key]).toEqual({ task: recorded.task, nonce: expect.any(String), outcomes: expect.any(Object) });
	});
});
