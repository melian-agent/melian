import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineExtension,
	defineTask,
	type Harness,
	openHarness,
	PrepareSpans,
	type Stage,
	StageTelemetry,
	TelemetryReader,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage } from "@melian-agent/pipeline/testing";
import { afterEach, expect, it } from "vitest";
import { SummaryIndex } from "../src/summarize.ts";

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
});

function clocked(start: number) {
	const clock = { now: start };
	return { clock, now: () => clock.now };
}

it("times steps, nested work and the open step until the record", async () => {
	const { clock, now } = clocked(100);
	const spans = PrepareSpans.start("startup", 10, now);
	spans.step("resolve");
	clock.now = 150;
	expect(
		await spans.time("unlock", async () => {
			clock.now = 170;
			return "unlocked";
		}),
	).toBe("unlocked");
	clock.now = 200;
	spans.end();
	clock.now = 250;
	spans.end();
	await expect(
		spans.time("orphan", async () => {
			clock.now = 260;
			throw new Error("failed");
		}),
	).rejects.toThrow("failed");
	clock.now = 300;
	spans.step("verdict");
	clock.now = 320;
	harness = await openHarness(createMemoryStorage(), {
		models: createFakeModels().models,
		registry: createRegistry(),
	});
	expect(await spans.record(harness, "base..head", context)).toEqual({
		startedAt: 10,
		endedAt: 320,
		spans: [
			{ name: "startup", startedAt: 10, endedAt: 100, durationMs: 90 },
			{ name: "unlock", startedAt: 150, endedAt: 170, durationMs: 20, parent: "resolve" },
			{ name: "resolve", startedAt: 100, endedAt: 200, durationMs: 100 },
			{ name: "orphan", startedAt: 250, endedAt: 260, durationMs: 10 },
			{ name: "verdict", startedAt: 300, endedAt: 320, durationMs: 20 },
		],
	});
});

it("stores one record per revision, which the next review replaces, and reads it detached", async () => {
	const storage = createMemoryStorage();
	harness = await openHarness(storage, { models: createFakeModels().models, registry: createRegistry() });
	const { clock, now } = clocked(5);
	const first = PrepareSpans.start("startup", 1, now);
	await first.record(harness, "base..head", context);
	clock.now = 9;
	const second = PrepareSpans.start("resolve", 7, now);
	const replacing = await second.record(harness, "base..head", context);
	await PrepareSpans.start("startup", 2, now).record(harness, "base..other", context);
	const telemetry = await TelemetryReader.open(storage).read("base..head");
	expect(telemetry.prepare).toEqual(replacing);
	expect(telemetry.prepare).toEqual({
		startedAt: 7,
		endedAt: 9,
		spans: [{ name: "resolve", startedAt: 7, endedAt: 9, durationMs: 2 }],
	});
	expect((await TelemetryReader.open(storage).read("none..head")).prepare).toBeUndefined();
});

const stage = (id: string, startedAt?: number, endedAt?: number): Stage => ({
	id,
	name: "melian.check",
	subject: id,
	task: 1,
	outcome: "completed",
	...(startedAt === undefined ? {} : { startedAt }),
	...(endedAt === undefined ? {} : { endedAt }),
	...(startedAt === undefined || endedAt === undefined ? {} : { durationMs: endedAt - startedAt }),
	timing: startedAt === undefined ? "unavailable" : "available",
	reused: false,
	resumed: false,
});

it.each([
	{
		name: "a gap of exactly the limit and one past it",
		spans: [
			[0, 1000],
			[2000, 3000],
		],
		stages: [stage("late", 4001, 5000)],
		endedAt: 5000,
		untimed: [{ startedAt: 3000, endedAt: 4001, durationMs: 1001 }],
	},
	{
		name: "a leading and a trailing gap",
		spans: [[1500, 2000]],
		stages: [stage("legacy", undefined, 3000)],
		endedAt: 3500,
		untimed: [
			{ startedAt: 0, endedAt: 1500, durationMs: 1500 },
			{ startedAt: 2000, endedAt: 3500, durationMs: 1500 },
		],
	},
	{
		name: "overlapping and reused intervals, and a stage with no timing",
		spans: [
			[0, 3000],
			[500, 800],
		],
		stages: [stage("reused", -5000, 2500), stage("parallel", 2800, 4000), stage("unavailable")],
		endedAt: 4000,
		untimed: [],
	},
	{
		name: "a publication after the record",
		spans: [[0, 4000]],
		stages: [stage("publication", 9000, 9500)],
		endedAt: 4000,
		untimed: [],
	},
	{
		name: "a stage still running",
		spans: [[0, 100]],
		stages: [stage("running", 50)],
		endedAt: 2000,
		untimed: [{ startedAt: 100, endedAt: 2000, durationMs: 1900 }],
	},
])("finds untimed gaps: $name", ({ spans, stages, endedAt, untimed }) => {
	const telemetry = new StageTelemetry("base..head", stages, {
		startedAt: 0,
		endedAt,
		spans: spans.map(([startedAt, ended], index) => ({
			name: `span${index}`,
			startedAt: startedAt!,
			endedAt: ended!,
			durationMs: ended! - startedAt!,
		})),
	});
	expect(telemetry.untimed()).toEqual(untimed);
	expect(telemetry.toJSON().untimed).toEqual(untimed);
});

it("finds nothing untimed without a record, and prints nothing for it", () => {
	const telemetry = new StageTelemetry("base..head", [stage("only", 0, 5000)]);
	expect(telemetry.untimed()).toEqual([]);
	expect(telemetry.toJSON()).not.toHaveProperty("prepare");
	expect(telemetry.toJSON()).not.toHaveProperty("untimed");
	expect(telemetry.render()).not.toContain("span ");
	expect(telemetry.render()).not.toContain("untimed");
});

it("lists spans in time order after the stages, then the untimed gaps", () => {
	const telemetry = new StageTelemetry("base..head", [stage("guardrails", 100, 200)], {
		startedAt: 0,
		endedAt: 4000,
		spans: [
			{ name: "child\u001b[2J", startedAt: 20, endedAt: 30, durationMs: 10, parent: "resolve" },
			{ name: "resolve", startedAt: 10, endedAt: 100, durationMs: 90 },
			{ name: "startup", startedAt: 0, endedAt: 10, durationMs: 10 },
			{ name: "verdict", startedAt: 3900, endedAt: 4000, durationMs: 100 },
			{ name: "whole", startedAt: 10, endedAt: 50, durationMs: 40 },
		],
	});
	expect(telemetry.render()).toBe(
		[
			"melian.check guardrails completed start=100 end=200 duration=100ms",
			"Total: Token usage unavailable.",
			"span startup start=0 end=10 duration=10ms",
			"span resolve start=10 end=100 duration=90ms",
			"span whole start=10 end=50 duration=40ms",
			"span child\\u001b[2J start=20 end=30 duration=10ms parent=resolve",
			"span verdict start=3900 end=4000 duration=100ms",
			"untimed start=200 end=3900 duration=3700ms",
			"",
		].join("\n"),
	);
});

it("separates model wait from the rest of a model stage", async () => {
	const fake = createFakeModels();
	const storage = createMemoryStorage();
	const registry = createRegistry();
	const task = defineTask<null, { phase: "run" | "end" }, null>({
		name: "test.transcript",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, runtime, taskContext) => {
				await runtime.commit(async (tx) => {
					for (const durations of [[30, undefined, 50], [], Array<number>(201).fill(1)]) {
						const child = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
						const input = await tx.appendEntry(child.id, {
							kind: "pi.user",
							model: [{ role: "user", content: "input", timestamp: 0 }],
						});
						let answer = input;
						for (const [index, durationMs] of durations.entries()) {
							answer = await tx.appendEntry(child.id, {
								kind: "pi.assistant",
								model: [
									{
										...fauxAssistantMessage("turn", { timestamp: 100 * (index + 1) }),
										...(durationMs === undefined ? {} : { durationMs }),
									},
								],
							});
							await tx.appendEntry(child.id, {
								kind: "pi.tool",
								model: [
									{
										role: "toolResult",
										toolCallId: "call",
										toolName: "read_file",
										content: [],
										isError: false,
										timestamp: 100 * (index + 1) + 60,
									},
								],
							});
						}
						await tx.createSubmission({
							type: "input",
							status: "done",
							conversationId: child.id,
							requestId: "only",
							entry: input.id,
							answer: answer.id,
						});
					}
					return { status: "running", checkpoint: { phase: "end" } };
				}, taskContext);
			},
			end: async (_task, runtime, taskContext) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: async (_task, runtime, taskContext) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext);
		},
	});
	registry.install(defineExtension({ name: "test.model-wait", tasks: [task] }));
	harness = await openHarness(storage, { models: fake.models, registry });
	const root = await harness.root(context);
	const id = await root.commit(async (tx) => {
		const created = await tx.createTask(task, null, { ownership: { kind: "conversation" } });
		(await tx.doc(SummaryIndex, root.id)).tasks["base..head"] = created;
		return created;
	}, context);
	const settled = (await harness.waitForTask(id, context)).state;
	expect(settled, JSON.stringify(settled)).toMatchObject({ outcome: { status: "completed" } });
	const [waited, unanswered, paged] = (await TelemetryReader.open(storage).read("base..head")).stages;
	expect(waited).toMatchObject({ startedAt: 0, endedAt: 350, durationMs: 350, modelMs: 80 });
	expect(new StageTelemetry("base..head", [waited!]).render()).toContain(" duration=350ms model=80ms\n");
	expect(unanswered!.modelMs).toBe(0);
	expect(paged!.modelMs).toBe(201);
});
