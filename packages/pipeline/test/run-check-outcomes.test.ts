import type { CheckStatus } from "@melian-agent/core";
import { expect, it } from "vitest";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	defineTask,
	openHarness,
} from "../src/harness.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { StageTelemetry, TelemetryReader } from "../src/telemetry.ts";
import { createFakeModels } from "../src/testing.ts";

it("projects recorded checks without conversations, including a refused lens and verifier", async () => {
	const checks: { name: string; status: CheckStatus; level?: "careful"; cause?: "timeout" }[] = [
		{ name: "lens.alpha", status: "failed", level: "careful" },
		{ name: "verifier", status: "ended" },
		{ name: "static.tsc", status: "skipped", cause: "timeout" },
		{ name: "guardrails", status: "provisional" },
		{ name: "lens.beta", status: "ran", level: "careful" },
	];
	const task = defineTask<{ checks: typeof checks }, { phase: "record" }, null>({
		name: "test.recorded-checks",
		version: 1,
		initial: () => ({ phase: "record" }),
		phases: {
			record: async (_task, runtime, taskContext) => {
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "completed", result: null } }),
					taskContext,
				);
			},
		},
		abort: async () => {},
	});
	const registry = createRegistry();
	registry.install({ name: "test.recorded-checks", tasks: [task] });
	const storage = createMemoryStorage();
	const harness = await openHarness(storage, { models: createFakeModels().models, registry });
	try {
		const root = await harness.root(context);
		const id = await root.commit(async (tx) => {
			const id = await tx.createTask(task, { checks }, { ownership: { kind: "conversation" } });
			(await tx.doc(ReviewIndex, root.id)).reviews["base..head"] = {
				lenses: [],
				adjudication: { task: id, input: "{}" },
			};
			return id;
		}, context);
		await harness.waitForTask(id, context);
		const telemetry = await TelemetryReader.open(storage).read("base..head");
		const expected = [
			{ name: "melian.lens", subject: "alpha@@careful", outcome: "failed", error: undefined },
			{ name: "melian.verification", subject: "verifier", outcome: "ended" },
			{ name: "melian.check", subject: "static.tsc", outcome: "timed-out" },
			{ name: "melian.check", subject: "guardrails", outcome: "provisional" },
			{ name: "melian.lens", subject: "beta@@careful", outcome: "completed" },
		].map((stage, index) => ({
			...stage,
			id: `check:${id}:${checks[index]!.name}`,
			task: id,
			timing: "unavailable",
			note: "No start recorded by the older build, or stage not started.",
			reused: false,
			resumed: false,
		}));
		expect(telemetry.stages.slice(1)).toEqual(expected);
		expect(telemetry.runDetails().stages.slice(1)).toEqual([
			{ name: "lens alpha", level: "careful", models: [], outcome: "failed", usageIncomplete: true },
			{ name: "verification", models: [], outcome: "ended" },
			{ name: "check static.tsc", models: [], outcome: "timed-out" },
			{ name: "check guardrails", models: [], outcome: "provisional" },
			{ name: "lens beta", level: "careful", models: [], outcome: "ran", usageIncomplete: true },
		]);
		const reused = new StageTelemetry(
			"base..head",
			telemetry.stages.map((stage) => ({ ...stage, reused: true })),
		);
		expect(reused.runDetails().stages.map(({ outcome }) => outcome)).toEqual([
			"reused",
			"failed",
			"ended",
			"timed-out",
			"provisional",
			"reused",
		]);
	} finally {
		await harness.close(context);
	}
});
