import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Changeset, type Decider, defaultConfig, Lens, Revision, type ToolLog } from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import { createGitHubProvider } from "@melian-agent/github";
import {
	type ConversationId,
	checksExtension,
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineExtension,
	defineTask,
	openHarness,
	openPublishHarness,
	openReviewHarness,
	openSqliteStorage,
	PrepareSpans,
	publishReview,
	type ReviewHarness,
	type ROOT_CONVERSATION_ID,
	recordDismissal,
	reviewChangeset,
	runChecks,
	type Stage,
	StageTelemetry,
	summarizeReview,
	type TaskId,
	TelemetryReader,
	TokenUsage,
	UsageDoc,
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
import { CheckSources, ChecksDocument } from "../src/checks.ts";
import { DecisionDocument } from "../src/decisions.ts";
import { LensDocument } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import * as staticRunner from "../src/static.ts";
import { TaskTiming } from "../src/task-timing.ts";
import { isolatedGitEnv } from "./fixtures/repo.ts";
import { resumedTask } from "./fixtures/resumed-task.ts";
import { count, crashFinding, crashRepository, readEvents } from "./fixtures/review-scenario.ts";

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
				() => fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("Quick run finished."),
				() => fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
				() => fauxAssistantMessage("Careful run finished."),
			],
		},
		{
			match: "You write Melian's walkthrough",
			replies: [
				() =>
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
	return { options, fake, calls, tools, storage, harness: reviewHarness.harness };
}

async function killed(script: string, args: string[], log: string, event: string) {
	const child = spawn(
		process.execPath,
		[
			"--conditions=@melian-agent/source",
			"--import=data:text/javascript,setTimeout(() => process.exit(1),30000).unref()",
			script,
			...args,
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
				if (child.exitCode !== null || child.signalCode !== null) throw new Error(`fixture exited: ${stderr}`);
				expect(count(readEvents(log), event)).toBe(1);
			},
			{ timeout: 15000, interval: 20 },
		);
	} finally {
		child.kill("SIGKILL");
		await exited;
	}
	expect(await exited).toBe("SIGKILL");
}

describe("stage telemetry contract", { timeout: 60_000 }, () => {
	it("derives model intervals from transcripts and times deterministic stages through dismissal and publication", async () => {
		const database = join(repo, "telemetry.sqlite");
		const { options, fake, tools, harness, calls, storage } = await setup(database);
		const beganAt = Date.now();
		const review = await reviewChangeset(options);
		expect(review.verdict.status).toBe("findings");
		expect(tools).toHaveBeenCalledTimes(7);
		await summarizeReview({ ...options, harness });
		expect(calls["You write Melian's walkthrough"]).toHaveLength(1);
		const revision = Revision.key(options.changeset.revision);
		const before = await TelemetryReader.open(storage).read(revision, beganAt);
		const stages = before.stages;
		for (const stage of stages.filter((stage) => stage.conversation !== undefined)) {
			const stored = await harness.snapshot(UsageDoc, stage.conversation! as ConversationId, context);
			expect(stage.usage!.models).toEqual(stored!.models);
		}
		expect(stages).toHaveLength(11);
		expect(stages.map(({ name }) => name)).toEqual(
			expect.arrayContaining([
				"melian.triage",
				"melian.check",
				"melian.lens",
				"melian.verification.candidate",
				"melian.adjudication",
				"melian.walkthrough",
			]),
		);
		expect(
			stages
				.filter(({ name }) => name === "melian.check")
				.map(({ subject }) => subject)
				.sort(),
		).toEqual(["guardrails", "static.biome", "static.enola", "static.mutation", "static.tsc"]);
		const lenses = stages.filter(({ name }) => name === "melian.lens");
		expect(lenses.map(({ subject }) => subject)).toEqual(
			expect.arrayContaining([expect.stringContaining("@quick"), expect.stringContaining("@careful")]),
		);
		for (const stage of stages) {
			expect(stage.outcome).toBe("completed");
			expect(stage.timing).toBe("available");
			expect(stage.startedAt).toBeGreaterThanOrEqual(beganAt);
			expect(stage.endedAt).toBeGreaterThanOrEqual(stage.startedAt!);
			expect(stage.durationMs).toBe(stage.endedAt! - stage.startedAt!);
			expect(stage.reused).toBe(false);
		}
		for (const lens of lenses)
			expect(lens.usage).toMatchObject({
				models: expect.any(Object),
				total: { totalTokens: expect.any(Number), cost: { total: expect.any(Number) } },
			});
		const details = (await harness.snapshot(VerdictDocument, (await harness.root(context)).id, context))!.details![
			revision
		]!;
		expect(lenses.find(({ subject }) => subject.endsWith("@careful"))!.usage!.total.cost.total).toBe(0);
		const detailed = lenses.find(({ subject }) => subject.endsWith("@careful"))!.usage!;
		expect({
			models: Object.keys(detailed.models),
			tokens: detailed.total.totalTokens,
			cost: detailed.total.cost.total,
		}).toEqual(details.lenses.find(({ level }) => level === "careful")!.usage);
		await recordDismissal({
			harness,
			revision: options.changeset.revision,
			id: review.findings[0]!.id,
			dismissal: { by: "test", reason: "Handled by the caller.", at: "2026-10-16T12:00:00Z" },
			repoRoot: repo,
		});
		const state = pullRequestState();
		moveTo(state, options.changeset);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		await options.harness.close();
		const publicationStorage = await openSqliteStorage(database);
		const publicationHarness = await openPublishHarness(publicationStorage, fake.review, provider);
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
		const after = await TelemetryReader.open(publicationStorage).read(revision);
		expect(after.stages.filter(({ name }) => name === "melian.publication")).toEqual([
			expect.objectContaining({ outcome: "completed", timing: "available" }),
		]);
		expect(after.stages.find(({ name }) => name === "melian.adjudication")!.task).not.toBe(
			stages.find(({ name }) => name === "melian.adjudication")!.task,
		);
	});

	it("joins the host's spans with its own steps between tasks, none of them over a task", async () => {
		const { options, storage, harness } = await setup();
		// The host's step is still open when the review runs its checks, which must end it first.
		const spans = PrepareSpans.start("host", Date.now());
		await reviewChangeset({ ...options, spans });
		const revision = Revision.key(options.changeset.revision);
		await spans.record(harness, revision, context);
		const telemetry = await TelemetryReader.open(storage).read(revision);
		const spansOf = (top: boolean) =>
			telemetry.prepare!.spans.filter((span) => (span.parent === undefined) === top).map(({ name }) => name);
		expect(spansOf(true)).toEqual([
			"host",
			"standards.trust",
			"abort.replaced",
			"bands",
			"routes",
			"lenses.prepare",
			"callers.coverage",
			"verification.prepare",
			"adjudication.prepare",
			"verdict.read",
			"coverage.record",
		]);
		expect(spansOf(false)).toEqual([]);
		expect(new Set(telemetry.stages.map(({ name }) => name))).toEqual(
			new Set([
				"melian.check",
				"melian.triage",
				"melian.lens",
				"melian.verification.candidate",
				"melian.adjudication",
			]),
		);
		for (const span of telemetry.prepare!.spans)
			for (const stage of telemetry.stages)
				expect(
					span.endedAt <= stage.startedAt! || span.startedAt >= stage.endedAt!,
					`${span.name} overlaps ${stage.name} ${stage.subject}`,
				).toBe(true);
	});

	it("attaches to the same tasks and adds no timing records on repeated calls or detached reads", async () => {
		const { options, harness, fake, tools, storage } = await setup();
		await reviewChangeset(options);
		const revision = Revision.key(options.changeset.revision);
		const root = (await harness.root(context)).id;
		const firstIndex = structuredClone(await harness.snapshot(ReviewIndex, root, context));
		const firstVerdict = await storage.findDocument(
			{ kind: VerdictDocument.definition.kind, scope: { kind: "conversation", conversationId: root } },
			"current",
			context,
		);
		const first = await TelemetryReader.open(storage).read(revision);
		const firstTimings = await storage.scanDocuments(
			{ scope: { kind: "conversation", conversationId: root }, at: "current", kind: "melian.stage-timing" },
			200,
			undefined,
			context,
		);
		const firstVerdictValue = await storage.document(firstVerdict!.id, "current", context);
		expect(first.stages).toHaveLength(10);
		const calls = fake.provider.state.callCount;
		const toolCalls = tools.mock.calls.length;
		const before = Date.now() + 1;
		await reviewChangeset(options);
		expect(fake.provider.state.callCount).toBe(calls);
		expect(
			await storage.scanDocuments(
				{ scope: { kind: "conversation", conversationId: root }, at: "current", kind: "melian.stage-timing" },
				200,
				undefined,
				context,
			),
		).toEqual(firstTimings);
		expect(tools).toHaveBeenCalledTimes(toolCalls);
		expect(await harness.snapshot(ReviewIndex, root, context)).toEqual(firstIndex);
		const secondVerdict = await storage.findDocument(
			{ kind: VerdictDocument.definition.kind, scope: { kind: "conversation", conversationId: root } },
			"current",
			context,
		);
		expect(await storage.document(secondVerdict!.id, "current", context)).toEqual(firstVerdictValue);
		const commit = vi.spyOn(storage, "commit");
		const second = await TelemetryReader.open(storage).read(revision, before);
		expect(second.stages.map(({ reused, ...stage }) => stage)).toEqual(
			first.stages.map(({ reused, ...stage }) => stage),
		);
		expect(second.stages.every(({ reused }) => reused)).toBe(true);
		await TelemetryReader.open(storage).read(revision, before);
		expect(commit).not.toHaveBeenCalled();
	});

	it("keeps original check sources across three runs and ranks a mutation timeout", async () => {
		const { options, harness, storage, tools } = await setup();
		let run = 0;
		tools.mockImplementation(async (input) => {
			expect(input.repoRoot).toBe(repo);
			if (input.tool === "mutation")
				return { status: "skipped", cause: "timeout", reason: "Stryker ran past static.mutation.timeout" };
			if (input.tool === "tsc" && run === 0) throw new Error("tsc failed");
			const log: ToolLog = {
				version: "2.1.0",
				runs: [{ tool: { driver: { name: input.tool, version: "test" } }, results: [] }],
			};
			return { status: "ran", log, notes: [] };
		});
		const input = {
			rootConversationId: (await harness.root(context)).id,
			changeset: options.changeset,
			config: options.config,
			source: options.policy,
			tier: "full",
			writer: options.writer,
		};
		await runChecks(harness, input, context);
		const revision = Revision.key(options.changeset.revision);
		const first = await TelemetryReader.open(storage).read(revision);
		expect(first.stages.filter(({ name }) => name === "melian.check")).toHaveLength(5);
		expect(first.stages.find(({ subject }) => subject === "static.tsc")!.outcome).toBe("failed");
		run++;
		await runChecks(harness, { ...input, rerunFailed: true }, context);
		const second = await TelemetryReader.open(storage).read(revision);
		expect(second.stages.find(({ subject }) => subject === "static.tsc")!.outcome).toBe("completed");
		expect(second.stages.find(({ subject }) => subject === "static.tsc")!.task).not.toBe(
			first.stages.find(({ subject }) => subject === "static.tsc")!.task,
		);

		run++;
		await runChecks(harness, { ...input, rerunFailed: true }, context);
		const third = await TelemetryReader.open(storage).read(revision);
		expect(third.stages.find(({ subject }) => subject === "static.biome")).toEqual({
			...first.stages.find(({ subject }) => subject === "static.biome")!,
			reused: true,
		});
		expect(third.stages.find(({ subject }) => subject === "static.tsc")).toEqual({
			...second.stages.find(({ subject }) => subject === "static.tsc")!,
			reused: true,
		});
		expect(third.stages.find(({ subject }) => subject === "static.mutation")).toMatchObject({
			outcome: "timed-out",
			durationMs: expect.any(Number),
			reused: false,
		});
	});

	it("ranks timeouts, bounds the line at three, breaks ties and escapes every terminal string", () => {
		const stage = (id: string, name: string, subject: string, durationMs: number): Stage => ({
			id,
			name,
			subject,
			task: 1,
			outcome: "timed-out",
			startedAt: 0,
			endedAt: durationMs,
			durationMs,
			timing: "available",
			reused: false,
			resumed: false,
		});
		const telemetry = new StageTelemetry("base..head", [
			stage("4", "melian.check", "fourth", 1),
			stage("2", "melian.lens", "z", 10),
			{ ...stage("1", "melian.check", "static.mutation", 100), reused: true },
			stage("3", "melian.lens", "a", 10),
			{
				...stage("5", "bad\u001b[2J", "subject\u001b[2J", 5),
				error: "failure\u001b[2J",
				usage: new TokenUsage({
					"model\u001b[2J": {
						input: 1,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}).toJSON(),
			},
			{
				id: "6",
				name: "melian.check",
				subject: "unfinished",
				task: 1,
				outcome: "running",
				timing: "unavailable",
				reused: false,
				resumed: false,
			},
			stage("7", "melian.check", "zzzz", 10),
		]);
		expect(telemetry.slowest()).toBe(
			"melian: Slowest stages: melian.check static.mutation 100ms (reused); melian.check zzzz 10ms; melian.lens a 10ms. Total: 1 tokens, $0 (usage unavailable for 2 stages).\n",
		);
		const text = telemetry.render();
		expect(text).not.toContain("\u001b");
		expect(text).toContain("start=0 end=100 duration=100ms reused");
		expect(text).toContain("start=unavailable end=unavailable duration=unavailablems");
		expect(text).toContain("bad\\u001b[2J");
		expect(text).toContain("failure\\u001b[2J");
		expect(text).toContain("model\\u001b[2J");
		const hostile = new StageTelemetry("base..head", [telemetry.stages[4]!]).slowest();
		expect(hostile).not.toContain("\u001b");
		expect(hostile).toContain("bad\\u001b[2J subject\\u001b[2J");
	});
	it("reads a faulted check's settled time from Pi, including errors with terminal controls", async () => {
		const storage = createMemoryStorage();
		const fake = createFakeModels();
		const registry = createRegistry();
		registry.install(checksExtension);
		let now = 100;
		const harness = await openHarness(storage, {
			models: fake.models,
			registry,
			now: () => now,
			env: async () => {
				now = 150;
				throw new Error("fault\u001b[2J");
			},
		});
		opened.push({ close: () => harness.close(context) });
		const changeset = await Changeset.resolve(repo, "main...feature");
		await runChecks(
			harness,
			{
				rootConversationId: (await harness.root(context)).id,
				changeset,
				config: { ...defaultConfig, tiers: { fast: ["guardrails"] } },
				source: { kind: "worktree" },
			},
			context,
		);
		now = 10000;
		const timings = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		expect(timings.stages).toEqual([
			expect.objectContaining({
				subject: "guardrails",
				outcome: "faulted",
				startedAt: 100,
				endedAt: 150,
				durationMs: 50,
				error: "fault\u001b[2J",
			}),
		]);
		expect(timings.render()).toContain("fault\\u001b[2J");
	});

	it("reports a gap that a task resumed after a crash would otherwise cover", async () => {
		const database = join(repo, "resumed.sqlite");
		const log = join(repo, "resumed.jsonl");
		await killed(
			fileURLToPath(new URL("./fixtures/prepare-spans-crash.ts", import.meta.url)),
			[database, log],
			log,
			"started",
		);
		const spans = PrepareSpans.start("startup", Date.now());
		spans.end();
		await sleep(1200);
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.resumed", tasks: [resumedTask(async () => {})] }));
		const storage = await openSqliteStorage(database);
		const harness = await openHarness(storage, { models: createFakeModels().models, registry });
		opened.push({ close: () => harness.close(context) });
		const root = await harness.root(context);
		const id = (await harness.snapshot(DecisionDocument, root.id, context))!.decisions["base..head"]!.triage!.task;
		expect((await harness.waitForTask(id as TaskId, context)).state).toMatchObject({
			outcome: { status: "completed" },
		});
		spans.step("verdict");
		await spans.record(harness, "base..head", context);
		const telemetry = await TelemetryReader.open(storage).read("base..head");
		const [resumed] = telemetry.stages;
		expect(resumed!.startedAt!).toBeLessThan(telemetry.prepare!.startedAt);
		expect(resumed!.endedAt!).toBeGreaterThan(telemetry.prepare!.startedAt + 1200);
		const [startup] = telemetry.prepare!.spans;
		expect(telemetry.untimed()).toEqual([
			expect.objectContaining({ startedAt: startup!.endedAt, durationMs: expect.any(Number) }),
		]);
		expect(telemetry.untimed()[0]!.durationMs).toBeGreaterThan(1000);
	});

	it("keeps settled transcript ends after a kill before the parent records its result", async () => {
		const database = join(repo, "settled.sqlite");
		const log = join(repo, "settled.jsonl");
		await killed(
			fileURLToPath(new URL("./fixtures/stage-telemetry-crash.ts", import.meta.url)),
			[repo, database, log],
			log,
			"run-settled",
		);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const storage = await openSqliteStorage(database);
		const first = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		expect(first.stages).toHaveLength(1);
		const lens = first.stages[0]!;
		expect(lens).toMatchObject({ name: "melian.lens", outcome: "completed", durationMs: expect.any(Number) });
		const input = await storage.scanSubmissions(
			{ conversationId: lens.conversation! as typeof ROOT_CONVERSATION_ID },
			200,
			undefined,
			context,
		);
		const last = input.items.at(-1)!;
		expect(last.status).toBe("done");
		if (last.status !== "done" || last.type !== "input") throw new Error("expected answered input");
		const answer = (await storage.entry(last.answer, context))!.entry.model![0]!;
		expect(lens.endedAt).toBe(answer.role === "assistant" ? answer.timestamp + (answer.durationMs ?? 0) : undefined);
		await storage.close(context);
		await sleep(30);
		const fake = createFakeModels();
		const reopened = await openSqliteStorage(database);
		const handle = await openReviewHarness(reopened, fake.review, { retry: false });
		opened.push(handle);
		await reviewChangeset({
			harness: handle,
			changeset,
			config: {
				...defaultConfig,
				tiers: { full: ["lens.correctness"] },
				models: { heavy: { model: `${fake.ref().provider}/${fake.ref().modelId}` } },
			},
			lenses: await Lens.builtins(),
			standards: [],
			models: fake.review,
			checks: [],
		});
		const after = await TelemetryReader.open(reopened).read(Revision.key(changeset.revision));
		expect(after.stages.find(({ name }) => name === "melian.lens")).toEqual(lens);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("keeps quick completion and the escalation's original input timestamp across a kill", async () => {
		const database = join(repo, "escalation.sqlite");
		const log = join(repo, "escalation.jsonl");
		await killed(
			fileURLToPath(new URL("./fixtures/review-crash.ts", import.meta.url)),
			["escalation", repo, database, log],
			log,
			"model-request",
		);
		const changeset = await Changeset.resolve(repo, "main...feature");
		const storage = await openSqliteStorage(database);
		const before = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		const quick = before.stages.find(({ subject }) => subject.endsWith("@quick"))!;
		const careful = before.stages.find(({ subject }) => subject.endsWith("@careful"))!;
		expect(quick).toMatchObject({ outcome: "completed", durationMs: expect.any(Number) });
		expect(careful.startedAt).toEqual(expect.any(Number));
		expect(careful.endedAt).toBeUndefined();
		await storage.close(context);
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [() => fauxAssistantMessage("Careful finished.")] },
		]);
		const decider = new RecordedDecider({
			triage: { version: "1", answers: { correctness: { distribution: { quick: 1 } } } },
		});
		const reopened = await openSqliteStorage(database);
		const handle = await openReviewHarness(reopened, fake.review, { retry: false, decider });
		opened.push(handle);
		const resumedAt = Date.now();
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
		const after = await TelemetryReader.open(reopened).read(Revision.key(changeset.revision), resumedAt);
		expect(after.stages.find(({ id }) => id === quick.id)).toEqual({ ...quick, reused: true });
		expect(after.stages.find(({ id }) => id === careful.id)).toMatchObject({
			startedAt: careful.startedAt,
			endedAt: expect.any(Number),
			resumed: true,
		});
	});

	it("does not reconcile a live replaced lens task when reading", async () => {
		const database = join(repo, "read.sqlite");
		const { options, fake } = await setup(database);
		await reviewChangeset(options);
		await options.harness.close();
		const storage = await openSqliteStorage(database);
		const harness = await openHarness(storage, { models: fake.models, registry: createRegistry() });
		opened.push({ close: () => harness.close(context) });
		const root = await harness.root(context);
		const revision = Revision.key(options.changeset.revision);
		const fakeTask = defineTask<null, { phase: "spawn" }, null>({
			name: "melian.lenses",
			version: 3,
			initial: () => ({ phase: "spawn" }),
			phases: {
				spawn: async () => {
					throw new Error("read resumed work");
				},
			},
			abort: async (_task, runtime, abortContext) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), abortContext);
			},
		});
		const replaced = await root.commit(
			(tx) => tx.createTask(fakeTask, null, { ownership: { kind: "conversation" } }),
			context,
		);
		const before = await storage.task(replaced, context);
		const commit = vi.spyOn(storage, "commit");
		await TelemetryReader.open(storage).read(revision);
		expect(await storage.task(replaced, context)).toEqual(before);
		expect(commit).not.toHaveBeenCalled();
	});
	it.each([false, true])("retains memo starts and identifies a legacy fault (legacy=%s)", async (legacy) => {
		const storage = createMemoryStorage();
		const fake = createFakeModels();
		let now = 100;
		const definition = defineTask<null, { phase: "run" }, null>({
			name: "test.stage-clock",
			version: 1,
			initial: () => ({ phase: "run" }),
			phases: {
				run: async (_task, runtime, taskContext) => {
					await TaskTiming.start(runtime, legacy ? true : undefined, taskContext);
					now = 200;
					const timing = await TaskTiming.start(runtime, legacy ? true : undefined, taskContext);
					now = 99;
					if (legacy) throw new Error("older task fault");
					await runtime.commit(async (tx) => {
						await timing.end(tx);
						return { status: "terminal", outcome: { status: "completed", result: null } };
					}, taskContext);
				},
			},
			abort: async (_task, runtime, abortContext) => {
				const timing = await TaskTiming.read(runtime, abortContext);
				await runtime.commit(async (tx) => {
					await timing.end(tx);
					return { status: "terminal", outcome: { status: "aborted" } };
				}, abortContext);
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "test.stage-clock", tasks: [definition] }));
		const harness = await openHarness(storage, { models: fake.models, registry, now: () => now });
		opened.push({ close: () => harness.close(context) });
		const root = await harness.root(context);
		const id = await root.commit(async (tx) => {
			const id = await tx.createTask(definition, null, { ownership: { kind: "conversation" } });
			(await tx.doc(ReviewIndex, root.id)).reviews["base..head"] = {
				lenses: [],
				adjudication: { task: id, input: "{}" },
			};
			return id;
		}, context);
		await harness.waitForTask(id, context);
		const stage = (await TelemetryReader.open(storage).read("base..head")).stages[0]!;
		expect(stage).toMatchObject(
			legacy
				? { outcome: "faulted", timing: "unavailable", endedAt: 99, note: expect.stringContaining("older build") }
				: { outcome: "completed", startedAt: 100, endedAt: 99, durationMs: 0, clockRegressed: true },
		);
		if (legacy) expect(stage.startedAt).toBeUndefined();
		else expect((await TelemetryReader.open(storage).read("base..head")).render()).toContain("clock regressed");
	});
	it("ends stale publication at its terminal commit with a failed outcome", async () => {
		const database = join(repo, "stale-publication.sqlite");
		const { options, fake } = await setup(database);
		await reviewChangeset(options);
		await options.harness.close();
		const state = pullRequestState();
		moveTo(state, options.changeset);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		const pull = await provider.pullRequest(7);
		vi.spyOn(provider, "pullRequest").mockImplementation(async (number) => {
			expect(number).toBe(7);
			return { ...pull, head: { ...pull.head, sha: "f".repeat(40) } };
		});
		const storage = await openSqliteStorage(database);
		const publishing = await openPublishHarness(storage, fake.review, provider);
		opened.push(publishing);
		await expect(
			publishReview({
				harness: publishing.harness,
				provider,
				changeset: options.changeset,
				pullRequest: pull,
				base: options.changeset.revision.base,
				trustedWriters: true,
			}),
		).rejects.toMatchObject({ code: "staleTarget" });
		const timing = await TelemetryReader.open(storage).read(Revision.key(options.changeset.revision));
		expect(timing.stages.filter(({ name }) => name === "melian.publication")).toEqual([
			expect.objectContaining({ outcome: "failed", endedAt: expect.any(Number), durationMs: expect.any(Number) }),
		]);
	});

	it("shows older check records without timing sources as unavailable", async () => {
		const { options, harness, storage, tools } = await setup();
		await reviewChangeset(options);
		const execute = tools.getMockImplementation()!;
		tools.mockImplementation(async (input) => {
			if (input.tool === "tsc") throw new Error("new compiler failure");
			return execute(input, context);
		});
		await runChecks(
			harness,
			{
				rootConversationId: (await harness.root(context)).id,
				changeset: options.changeset,
				config: { ...options.config, checks: { ...options.config.checks, allowSkip: ["static.enola"] } },
				source: options.policy,
				tier: "full",
				writer: options.writer,
			},
			context,
		);

		const revision = Revision.key(options.changeset.revision);
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			delete (await tx.doc(ChecksDocument, root.id)).owners;
		}, context);
		const find = storage.findDocument.bind(storage);
		vi.spyOn(storage, "findDocument").mockImplementation((address, at, readContext) => {
			if (address.kind === CheckSources.definition.kind) return Promise.resolve(undefined);
			return find(address, at, readContext);
		});
		const timings = await TelemetryReader.open(storage).read(revision);
		const checks = timings.stages.filter(({ name }) => name === "melian.check");
		expect(checks).toHaveLength(5);
		for (const check of checks) {
			expect(check).toMatchObject({
				outcome: check.subject === "static.tsc" ? "failed" : "completed",
				timing: "unavailable",
				note: expect.stringContaining("older build"),
			});
			expect(check.startedAt).toBeUndefined();
		}
	});
	it("reads spend once per conversation from durable usage, including reused work", async () => {
		const { options, harness, storage } = await setup();
		await reviewChangeset(options);
		const revision = Revision.key(options.changeset.revision);
		const before = await TelemetryReader.open(storage).read(revision);
		const lens = before.stages.find(({ name }) => name === "melian.lens")!;
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			const usage = await tx.doc(UsageDoc, lens.conversation! as ConversationId);
			const key = Object.keys(usage.models)[0]!;
			usage.models[key]!.cost.total = 0.5;
			const base = usage.models[key]!;
			usage.models["faux/other"] = { ...base, totalTokens: 11, cost: { ...base.cost, total: 0.75 } };
		}, context);
		const after = await TelemetryReader.open(storage).read(revision, Date.now() + 1);
		expect(after.stages.find(({ id }) => id === lens.id)).toMatchObject({
			reused: true,
			usage: {
				models: { "faux/other": { totalTokens: 11, cost: { total: 0.75 } } },
				total: { totalTokens: lens.usage!.total.totalTokens + 11, cost: { total: 1.25 } },
			},
		});
	});
	it("renders a lens whose stored level is absent as legacy", async () => {
		const { options, harness, storage } = await setup();
		await reviewChangeset(options);
		const revision = Revision.key(options.changeset.revision);
		const first = await TelemetryReader.open(storage).read(revision);
		const lens = first.stages.find(({ name }) => name === "melian.lens")!;
		await (await harness.root(context)).commit(async (tx) => {
			delete (await tx.doc(LensDocument, lens.conversation! as ConversationId)).lens!.level;
		}, context);
		expect(
			(await TelemetryReader.open(storage).read(revision)).stages.find(({ id }) => id === lens.id)!.subject,
		).toMatch(/@legacy$/);
	});

	it("retries a parent that failed before it created check sources", async () => {
		const { options, harness, storage } = await setup();
		const input = {
			rootConversationId: (await harness.root(context)).id,
			changeset: options.changeset,
			config: options.config,
			source: options.policy,
			tier: "missing-tier",
		};
		await expect(runChecks(harness, input, context)).rejects.toMatchObject({ code: "unknownTier" });
		const first = await storage.scanTasks({ kind: "melian.checks" }, 200, undefined, context);
		await expect(runChecks(harness, { ...input, rerunFailed: true }, context)).rejects.toMatchObject({
			code: "unknownTier",
		});
		const second = await storage.scanTasks({ kind: "melian.checks" }, 200, undefined, context);
		expect(second.items).toHaveLength(first.items.length + 1);
	});
});
