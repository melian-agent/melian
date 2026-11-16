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
	TelemetryReader,
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

const fixture = join(import.meta.dirname, "fixtures", "lens-requests-previous");
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
	directory = mkdtempSync(join(tmpdir(), "melian-lens-requests-"));
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

describe("a store main wrote before lens runs had request keys", () => {
	it("reads each lens stage main wrote as showing nothing, since its policy names no shown files", async () => {
		const storage = await openSqliteStorage(join(directory, "state.sqlite"));
		try {
			const stages = (await TelemetryReader.open(storage).read(recorded.revision)).stages.filter(
				({ name }) => name === "melian.lens",
			);

			expect(stages.map(({ subject, outcome }) => [subject.split("@")[0], outcome]).sort()).toEqual([
				["contracts", "completed"],
				["correctness", "completed"],
			]);
			for (const stage of stages) {
				expect(stage.coverage).toBeDefined();
				expect(stage).not.toHaveProperty("shown");
			}
		} finally {
			await storage.close();
		}
	});

	it("asks each lens once on a repeat review, copying none of the version-6 task's runs", async () => {
		expect([gitIn(repo, "rev-parse", "main"), gitIn(repo, "rev-parse", "feature")]).toEqual([
			recorded.base,
			recorded.head,
		]);
		expect(recorded.lensTask.version).toBe(6);
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
		const review = await reviewChangeset({
			harness,
			changeset,
			config,
			lenses: (await Lens.builtins()).filter(({ name }) => name === "correctness" || name === "contracts"),
			standards: [],
			models: fake.review,
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.biome", status: "ran" },
				{ name: "static.tsc", status: "ran" },
				{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
			],
		});

		expect([requests[correctness]?.length, requests[contracts]?.length]).toEqual([1, 2]);
		expect(review.findings.map(({ id }) => id)).toEqual(recorded.findings);
		const entry = (await harness.snapshot(ReviewIndex, root, context))!.reviews[Revision.key(changeset.revision)]!;
		expect(entry.task).not.toBe(recorded.task);
		expect(entry.lenses).toHaveLength(2);
		for (const lens of entry.lenses) expect(lens).toMatch(/ request [0-9a-f]{64}$/);
		const stages = (await TelemetryReader.open(storage).read(Revision.key(changeset.revision)))
			.runDetails()
			.stages.filter(({ name }) => name.startsWith("lens "));
		expect(stages.map(({ outcome }) => outcome)).toEqual(["ran", "ran"]);
	});
});
