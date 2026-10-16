import { spawn } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { SpanStatus } from "@earendil-works/pi-telemetry";
import { Changeset, type Decider, defaultConfig, Lens, type ToolLog } from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import { createGitHubProvider } from "@melian-agent/github";
import {
	backgroundContext as context,
	createMemoryStorage,
	defineDoc,
	type Harness,
	openPublishHarness,
	openReviewHarness,
	openSqliteStorage,
	publishReview,
	type ReviewHarness,
	readVerdict,
	reviewChangeset,
	revisionKey,
	summarizeReview,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../src/adjudication.ts";
import * as staticRunner from "../src/static.ts";
import { isolatedGitEnv } from "./fixtures/repo.ts";
import { count, crashFinding, crashRepository, readEvents } from "./fixtures/review-scenario.ts";

type Stage = {
	id: number;
	parentId: number | null;
	name: string;
	attributes: Record<string, string | number | boolean>;
	status: SpanStatus;
	settled: boolean;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	usage?: { models: string[]; tokens: number; cost: number };
};

// This token reads the proposed contract without importing an API that phase 2 has not built.
const TelemetryDocument = defineDoc<{
	spans: Record<string, Stage>;
	reviews: { id: number; revision: string; stages: { spanId: string; reused: boolean }[] }[];
}>({
	kind: "melian.telemetry",
	version: 1,
	scope: "conversation",
	history: "rewindable",
	fork: "asOf",
	initial: () => ({ spans: {}, reviews: [] }),
});

let repo: string;
let opened: (ReviewHarness | { close: () => Promise<void> })[];

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = crashRepository();
	opened = [];
});

afterEach(async () => {
	await Promise.all(opened.map((handle) => handle.close()));
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

async function stored(harness: Harness) {
	return harness.snapshot(TelemetryDocument, (await harness.root(context)).id, context);
}

async function setup(database?: string) {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const fake = createFakeModels({ models: [{ id: "scripted" }] });
	const ref = fake.ref();
	const route = { model: `${ref.provider}/${ref.modelId}` };
	const decider: Decider = {
		name: "telemetry-test",
		calibrated: true,
		decide: async (request) => {
			expect(request.questions.map(({ id }) => id)).toEqual(["correctness"]);
			return { answers: [{ question: "correctness", distribution: { quick: 1 } }] };
		},
	};
	const storage = database === undefined ? createMemoryStorage() : await openSqliteStorage(database);
	const reviewHarness = await openReviewHarness(storage, fake.review, {
		checkout: repo,
		decider,
		retry: false,
	});
	opened.push(reviewHarness);
	const config = {
		...defaultConfig,
		tiers: {
			full: ["guardrails", "static.biome", "static.tsc", "static.enola", "static.mutation", "lens.correctness"],
		},
		lenses: { correctness: { level: { floor: "quick" as const, ceiling: "careful" as const } } },
		static: {
			...defaultConfig.static,
			enola: { ...defaultConfig.static.enola, enabled: true },
			mutation: { ...defaultConfig.static.mutation, enabled: true },
		},
		models: { light: route, medium: route, heavy: route, verifier: route },
	};
	const tools = vi.spyOn(staticRunner, "runStaticTool").mockImplementation(async (input) => {
		expect(input.repoRoot).toBe(repo);
		expect([changeset.revision.base, changeset.revision.head]).toContain(input.commit);
		expect(["biome", "tsc", "enola", "mutation"]).toContain(input.tool);
		const log: ToolLog = {
			version: "2.1.0",
			runs: [{ tool: { driver: { name: input.tool, version: `test-${input.tool}` } }, results: [] }],
		};
		if (input.tool === "mutation") {
			expect(input.commit).toBe(changeset.revision.head);
			expect(input.headCode).toBe("reviewer");
			return { status: "ran", log, baseLog: log, notes: ["whole suite after NoCoverage"] };
		}
		return { status: "ran", log, notes: [] };
	});
	const calls = scriptConversations(fake, [
		{
			match: "You are the correctness reviewer",
			replies: [
				fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
				fauxAssistantMessage("Quick run finished."),
				fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
				fauxAssistantMessage("Careful run finished."),
			],
		},
		{
			match: "You write Melian's walkthrough",
			replies: [
				fauxAssistantMessage(
					fauxToolCall("record_walkthrough", {
						summary: "Changes manager name lookup.",
						files: [{ path: "src/user.ts", summary: "Removes the optional chain." }],
					}),
					{ stopReason: "toolUse" },
				),
			],
		},
	]);
	const options = {
		harness: reviewHarness,
		changeset,
		config,
		lenses: await Lens.builtins(),
		standards: [],
		models: fake.review,
		decider,
		policy: { kind: "revision" as const, commit: changeset.revision.base },
		writer: { trusted: true as const, by: "reviewer" as const },
		origin: {
			kind: "pull-request" as const,
			repository: { owner: "melian-agent", name: "example" },
			pullRequest: 7,
			base: changeset.revision.base,
			head: changeset.revision.head,
		},
	};
	return { options, fake, calls, tools, harness: reviewHarness.harness };
}

describe("stage telemetry contract", { timeout: 60_000 }, () => {
	it("stores every stage, with quick and escalated lenses separate, through publication", async () => {
		const database = join(repo, "telemetry.sqlite");
		const { options, fake, tools, harness, calls } = await setup(database);
		const beganAt = Date.now();
		const review = await reviewChangeset(options);
		expect(review.verdict.status).toBe("findings");
		expect(tools.mock.calls.map(([input]) => input.tool).sort()).toEqual([
			"biome",
			"biome",
			"enola",
			"enola",
			"mutation",
			"tsc",
			"tsc",
		]);
		await summarizeReview({ ...options, harness });
		expect(calls["You write Melian's walkthrough"]).toHaveLength(1);
		const details = (await harness.snapshot(VerdictDocument, (await harness.root(context)).id, context))!.details![
			revisionKey(options.changeset.revision)
		]!;
		const carefulUsage = details.lenses.find(({ level }) => level === "careful")!.usage!;
		expect(carefulUsage.tokens).toBeGreaterThan(0);
		const state = pullRequestState();
		moveTo(state, options.changeset);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		// Publish from its own registry against the same storage, as the CLI does.
		await options.harness.close();
		const publicationHarness = await openPublishHarness(await openSqliteStorage(database), fake.review, provider);
		opened.push(publicationHarness);
		await publishReview({
			harness: publicationHarness.harness,
			provider,
			changeset: options.changeset,
			pullRequest: await provider.pullRequest(7),
			base: options.changeset.revision.base,
			trustedWriters: true,
		});
		expect(state.reviews).toHaveLength(1);
		const doc = await stored(publicationHarness.harness);
		expect(doc, "a completed review must leave durable stage spans").toBeDefined();
		const spans = doc!.reviews.at(-1)!.stages.map(({ spanId }) => doc!.spans[spanId]!);
		expect(spans).toHaveLength(13);
		expect(spans.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"melian.triage",
				"melian.check",
				"melian.lens",
				"melian.verification",
				"melian.verification.candidate",
				"melian.adjudication",
				"melian.walkthrough",
				"melian.publication",
			]),
		);
		expect(
			spans
				.filter(({ name }) => name === "melian.check")
				.map(({ attributes }) => attributes["melian.check"])
				.sort(),
		).toEqual(["guardrails", "static.biome", "static.enola", "static.mutation", "static.tsc"]);
		const lenses = spans.filter(({ name }) => name === "melian.lens");
		expect(lenses.map(({ attributes }) => attributes["melian.level"]).sort()).toEqual(["careful", "quick"]);
		for (const span of spans) {
			expect(span.settled).toBe(true);
			expect(span.status).toEqual({ status: "ok" });
			expect(span.attributes["melian.outcome"]).toBe("completed");
			expect(span.startedAt).toEqual(expect.any(Number));
			expect(span.startedAt).toBeGreaterThanOrEqual(beganAt);
			expect(span.endedAt).toBeGreaterThanOrEqual(span.startedAt);
			expect(span.endedAt).toBeLessThanOrEqual(Date.now());
			expect(span.durationMs).toBe(span.endedAt! - span.startedAt);
		}
		const total = spans.find(({ name }) => name === "melian.verification")!;
		const candidates = spans.filter(({ name }) => name === "melian.verification.candidate");
		expect(candidates).toHaveLength(1);
		expect(candidates[0]!.parentId).toBe(total.id);
		expect(candidates[0]!.startedAt).toBeGreaterThanOrEqual(total.startedAt);
		expect(candidates[0]!.endedAt).toBeLessThanOrEqual(total.endedAt!);
		for (const lens of lenses)
			expect(lens.usage).toMatchObject({
				models: [expect.any(String)],
				tokens: expect.any(Number),
				cost: expect.any(Number),
			});
		expect(lenses.find(({ attributes }) => attributes["melian.level"] === "careful")!.usage).toEqual(carefulUsage);
		expect(lenses.find(({ attributes }) => attributes["melian.level"] === "quick")!.usage!.tokens).toBeGreaterThan(0);
	});

	it("marks finished stages reused and preserves their original intervals and spend", async () => {
		const { options, harness, fake, tools } = await setup();
		await reviewChangeset(options);
		const first = await stored(harness);
		const before = fake.provider.state.callCount;
		const toolCalls = tools.mock.calls.length;
		await reviewChangeset(options);
		expect(fake.provider.state.callCount).toBe(before);
		expect(tools).toHaveBeenCalledTimes(toolCalls);
		const second = await stored(harness);
		expect(second, "an attached review must record reused stages").toBeDefined();
		expect(second!.reviews).toHaveLength(2);
		const original = first!.reviews[0]!;
		const attached = second!.reviews[1]!;
		expect(attached.id).not.toBe(original.id);
		expect(attached.revision).toBe(revisionKey(options.changeset.revision));
		const completed = original.stages.filter(
			({ spanId }) => first!.spans[spanId]!.attributes["melian.outcome"] === "completed",
		);
		expect(completed.length).toBeGreaterThanOrEqual(10);
		for (const reference of completed) {
			expect(reference.reused).toBe(false);
			expect(attached.stages).toContainEqual({ spanId: reference.spanId, reused: true });
			expect(second!.spans[reference.spanId]).toEqual(first!.spans[reference.spanId]);
		}
	});

	it("keeps completed quick timing and the active escalation's first start across a real kill", async () => {
		const database = join(repo, "telemetry.sqlite");
		const log = join(repo, "telemetry.jsonl");
		const script = fileURLToPath(new URL("./fixtures/review-crash.ts", import.meta.url));
		// Bound the parked fixture even if the parent test process dies.
		const child = spawn(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				"--import=data:text/javascript,setTimeout(() => process.exit(1), 30000).unref()",
				script,
				"escalation",
				repo,
				database,
				log,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal ?? code)));
		try {
			await vi.waitFor(
				() => {
					if (child.exitCode !== null || child.signalCode !== null)
						throw new Error(`crash fixture exited: ${stderr}`);
					expect(count(readEvents(log), "model-request")).toBe(1);
				},
				{ timeout: 15_000, interval: 20 },
			);
		} finally {
			child.kill("SIGKILL");
			await exited;
		}
		expect(await exited).toBe("SIGKILL");
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
		const decider = new RecordedDecider({
			triage: { version: "1", answers: { correctness: { distribution: { quick: 1 } } } },
		});
		const handle = await openReviewHarness(await openSqliteStorage(realpathSync(database)), fake.review, {
			decider,
			retry: false,
		});
		opened.push(handle);
		const before = await stored(handle.harness);
		const changeset = await Changeset.resolve(repo, "main...feature");
		expect(
			await readVerdict(
				handle.harness,
				(await handle.harness.root(context)).id,
				revisionKey(changeset.revision),
				context,
			),
		).toBeUndefined();
		const reopenedAt = Date.now();
		await sleep(20);
		const calls = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Careful finished.")] },
		]);
		await reviewChangeset({
			harness: handle,
			changeset,
			config: {
				...defaultConfig,
				tiers: { ...defaultConfig.tiers, full: ["standard"] },
				models: {
					medium: { model: `${fake.ref("medium").provider}/medium` },
					heavy: { model: `${fake.ref("heavy").provider}/heavy` },
				},
			},
			lenses: await Lens.builtins(),
			standards: [],
			models: fake.review,
			checks: [],
			decider,
		});
		const after = await stored(handle.harness);
		expect(calls["You are the correctness reviewer"]).toHaveLength(1);
		expect(before, "stage checkpoints must survive without a verdict").toBeDefined();
		const quick = Object.entries(before!.spans).find(
			([, span]) => span.name === "melian.lens" && span.attributes["melian.level"] === "quick",
		)!;
		const careful = Object.entries(before!.spans).find(
			([, span]) => span.name === "melian.lens" && span.attributes["melian.level"] === "careful",
		)!;
		expect(quick[1].settled).toBe(true);
		expect(careful[1].settled).toBe(false);
		expect(careful[1].endedAt).toBeUndefined();
		expect(after!.spans[quick[0]]).toEqual(quick[1]);
		const resumed = after!.spans[careful[0]]!;
		expect(resumed.startedAt).toBe(careful[1].startedAt);
		expect(resumed.endedAt).toBeGreaterThanOrEqual(reopenedAt);
		expect(resumed.durationMs).toBe(resumed.endedAt! - careful[1].startedAt);
		expect(
			Object.values(after!.spans).filter(
				(span) => span.name === "melian.lens" && span.attributes["melian.level"] === "careful",
			),
		).toHaveLength(1);
	});
});
