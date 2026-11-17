import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, Revision, Standards } from "@melian-agent/core";
import {
	backgroundContext as context,
	openReviewHarness,
	openSqliteStorage,
	type ReviewHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
	unconfinedSandbox,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskId } from "../src/harness.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { baseAndHead, gitIn, isolatedGitEnv } from "./fixtures/repo.ts";

// A store main wrote at version 7 of the lens task, whose prober answered attack 1 with only a probe a signal ended.
const fixture = join(import.meta.dirname, "fixtures", "probing-v7");
const recorded = JSON.parse(readFileSync(join(fixture, "recorded.json"), "utf8")) as {
	base: string;
	head: string;
	revision: string;
	lensTask: { id: number; version: number; result: Record<string, { probing: { skipped: unknown } }> };
	record: { status: string; reason: string };
};

const attacks = [
	{
		target: "src/load.ts load()",
		reason: "an author's path reaches readFileSync unconfined",
		passing: "the read stays inside the repository and prints held",
		failing: "the read returns a file outside the repository and prints LEAK",
	},
	{
		target: "src/load.ts load() over the network",
		reason: "a path could name a network share",
		passing: "the read is refused",
		failing: "the read reaches the share",
	},
];
const call = (name: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
const planner = "Your role at this level: the attack planner";
const prober = "You are the prober for the trust-boundary lens";

let directory: string;
let repo: string;
let harness: ReviewHarness | undefined;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	// The dates capture.mjs fixed, so these are the commits main reviewed.
	vi.stubEnv("GIT_AUTHOR_DATE", "2026-11-16T00:00:00Z");
	vi.stubEnv("GIT_COMMITTER_DATE", "2026-11-16T00:00:00Z");
	directory = mkdtempSync(join(tmpdir(), "melian-probing-v7-"));
	copyFileSync(join(fixture, "state.sqlite"), join(directory, "state.sqlite"));
	repo = baseAndHead(
		{ "src/load.ts": "export function load(path: string) {\n\treturn path;\n}\n" },
		{
			"src/load.ts":
				'import { readFileSync } from "node:fs";\nexport function load(path: string) {\n\treturn readFileSync(path, "utf8");\n}\n',
		},
	);
});

afterEach(async () => {
	await harness?.close();
	harness = undefined;
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

describe("a store main wrote at version 7 of the lens task", () => {
	it("probes again, and reads the attack whose only probe showed nothing as unanswered", async () => {
		expect([gitIn(repo, "rev-parse", "main"), gitIn(repo, "rev-parse", "feature")]).toEqual([
			recorded.base,
			recorded.head,
		]);
		expect(recorded.lensTask.version).toBe(7);
		// Main counted the skip, and read attack 1 as answered.
		expect(Object.values(recorded.lensTask.result).map(({ probing }) => probing.skipped)).toEqual([1]);
		expect(recorded.record).toMatchObject({ status: "ran" });

		const fake = createFakeModels();
		const ref = fake.ref();
		const requests = scriptConversations(fake, [
			{ match: planner, replies: [call("record_plan", { attacks }), fauxAssistantMessage("Planned 2 attacks.")] },
			{
				match: prober,
				replies: [
					call("run_probe", { attack: 1, script: 'process.kill(process.pid, "SIGKILL");\n' }),
					call("skip_attack", { attack: 2, reason: "it needs the network" }),
					fauxAssistantMessage("Reported 0 findings."),
					fauxAssistantMessage("Reported 0 findings."),
				],
			},
		]);
		harness = await openReviewHarness(await openSqliteStorage(join(directory, "state.sqlite")), fake.review, {
			retry: false,
			probeSandbox: unconfinedSandbox(),
		});
		const reviewer = harness.harness;
		const root = (await reviewer.root(context)).id;
		expect((await reviewer.snapshot(ReviewIndex, root, context))?.reviews[recorded.revision]?.task).toBe(
			recorded.lensTask.id,
		);

		const changeset = await Changeset.resolve(repo, "main...feature");
		const policy = { kind: "revision", commit: changeset.revision.base } as const;
		const paths = changeset.revision.paths();
		const lenses = (await Lens.load(repo, policy, paths)).map((lens) =>
			lens.name === "trust-boundary"
				? Lens.from({ ...lens.toJSON(), levels: { ...lens.levels, deep: { ...lens.level("deep"), probe: {} } } })
				: lens,
		);
		const { verdict } = await reviewChangeset({
			harness,
			changeset,
			config: {
				...defaultConfig,
				tiers: { full: ["lens.trust-boundary"] },
				lenses: { "trust-boundary": { level: { floor: "deep" } } },
				models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
			},
			lenses,
			standards: await Standards.load(repo, policy, paths),
			models: fake.review,
			writer: { trusted: true, by: "reviewer" },
		});

		// A finished probing run is never reused, so the review planned and probed again.
		expect([requests[planner]?.length, requests[prober]?.length]).toEqual([2, 4]);
		expect(textOf(requests[prober]!.at(-1)!.at(-1)!)).toContain(
			"Attack 1 has no finding on a probe that failed, nor a probe that passed or a skip",
		);
		const entry = (await reviewer.snapshot(ReviewIndex, root, context))!.reviews[Revision.key(changeset.revision)]!;
		expect(entry.task).not.toBe(recorded.lensTask.id);
		const task = (await reviewer.getTask(entry.task as TaskId, context))!;
		expect(task.version).toBe(8);
		const state = task.state as { outcome: { result: Record<string, { status: string; probing: unknown }> } };
		expect(Object.values(state.outcome.result)).toEqual([
			expect.objectContaining({
				status: "done",
				probing: expect.objectContaining({ attacks: 2, probes: 1, skipped: [2], unanswered: [1] }),
			}),
		]);
		const ended = [...(verdict.ran ?? []), ...verdict.notRun].find(({ name }) => name === "lens.trust-boundary");
		expect(ended).toMatchObject({ status: "ended", level: "deep" });
		expect(ended?.reason).toContain(
			"its prober left attack 1 with no finding on a probe that failed, nor a probe that passed or a skip",
		);
		expect(ended?.reason).toMatch(/it planned 2 attacks and ran 1 probe in .+ s, and skipped attack 2$/);
	});
});
