import { rmSync } from "node:fs";
import { Changeset, defaultConfig, type MelianConfig } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	createReviewRegistry,
	defineExtension,
	defineTask,
	type Harness,
	openHarness,
	revisionKey,
	summariseReview,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { baseAndHead, isolatedGitEnv } from "./fixtures/repo.ts";

let repo: string;
let harness: Harness;
const fake = () => createFakeModels({ models: [{ id: "scripted" }] });
let models: ReturnType<typeof fake>;
let changeset: Changeset;
let config: MelianConfig;
beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": "export const a = 1;\n" }, { "src/a.ts": "export const a = 2;\n" });
	changeset = await Changeset.resolve(repo, "main...feature");
	models = fake();
	harness = await openHarness(createMemoryStorage(), {
		models: models.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	const root = await harness.root(context);
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).provenance = {
			[revisionKey(changeset.revision)]: {
				kind: "pull-request",
				policy: `revision:${changeset.revision.base}`,
				manifest: [],
				lenses: [],
			},
		};
	}, context);
	const ref = models.ref("scripted");
	config = { ...defaultConfig, models: { light: { model: `${ref.provider}/${ref.modelId}` } } };
});
afterEach(async () => {
	await harness?.close(context);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});
async function stored() {
	return harness.snapshot(VerdictDocument, (await harness.root(context)).id, context);
}
async function summarise(overrides: Partial<Parameters<typeof summariseReview>[0]> = {}) {
	await summariseReview({ harness, changeset, config, models: models.review, ...overrides });
	return stored();
}
function success(summary = "Changes a value.") {
	return fauxAssistantMessage(
		[fauxToolCall("record_walkthrough", { summary, files: [{ path: "src/a.ts", summary: "Changes a." }] })],
		{ stopReason: "toolUse" },
	);
}
describe("walkthrough summaries", () => {
	it("skips disabled walkthroughs and range reviews", async () => {
		const auth = vi.spyOn(models.models, "checkAuth");
		await summarise({
			config: { ...config, publish: { walkthrough: { ...config.publish.walkthrough, enabled: false } } },
		});
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).provenance![revisionKey(changeset.revision)]!.kind = "range";
		}, context);
		await summarise();
		expect(auth).not.toHaveBeenCalled();
		expect((await stored())?.walkthroughs).toBeUndefined();
		expect((await stored())?.walkthroughNotes).toBeUndefined();
	});
	it("distinguishes no route from no credentials and retries after credentials arrive", async () => {
		const revision = revisionKey(changeset.revision);
		expect((await summarise({ config: { ...config, models: {} } }))?.walkthroughNotes?.[revision]).toContain(
			"No light model is configured.",
		);
		const auth = vi.spyOn(models.models, "checkAuth").mockResolvedValue(undefined);
		expect((await summarise())?.walkthroughNotes?.[revision]).toContain("No light model has credentials.");
		auth.mockRestore();
		scriptConversations(models, [{ match: "You write Melian's walkthrough", replies: [success()] }]);
		const doc = await summarise();
		expect(doc?.walkthroughs?.[revision]?.summary).toBe("Changes a value.");
		expect(doc?.walkthroughNotes?.[revision]).toBeUndefined();
	});
	it("resolves the light model through the review's stored plan, not the configuration", async () => {
		const revision = revisionKey(changeset.revision);
		const ref = models.ref("scripted");
		const withPlan = async (light: {
			status: "routed" | "unrouted";
			models: { model: string; credential: string }[];
		}) => {
			const root = await harness.root(context);
			await root.commit(async (tx) => {
				const stored = (await tx.doc(VerdictDocument, root.id)).provenance![revision]!;
				stored.plan = { tiers: [{ tier: "light", ...light }], lenses: [] };
			}, context);
		};
		await withPlan({ status: "unrouted", models: [] });
		expect((await summarise())?.walkthroughNotes?.[revision]).toContain("No light model is configured.");
		await withPlan({ status: "routed", models: [{ model: `${ref.provider}/${ref.modelId}`, credential: "test" }] });
		scriptConversations(models, [{ match: "You write Melian's walkthrough", replies: [success()] }]);
		expect((await summarise({ config: { ...config, models: {} } }))?.walkthroughs?.[revision]?.summary).toBe(
			"Changes a value.",
		);
	});
	it("stores fixed notes for provider errors and no tool call, then stops after two attempts", async () => {
		const revision = revisionKey(changeset.revision);
		for (const reply of [
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "private provider detail" }),
			fauxAssistantMessage("No tool used."),
		]) {
			scriptConversations(models, [{ match: "You write Melian's walkthrough", replies: [reply] }]);
			const doc = await summarise();
			expect(doc?.walkthroughs?.[revision]).toBeUndefined();
			expect(doc?.walkthroughNotes?.[revision]).toBe(
				"No walkthrough available. The summariser returned no summary.",
			);
			expect(JSON.stringify(doc?.walkthroughNotes)).not.toContain("private provider detail");
		}
		const captured = scriptConversations(models, [{ match: "You write Melian's walkthrough", replies: [success()] }]);
		await summarise();
		await summarise();
		expect(captured["You write Melian's walkthrough"]).toHaveLength(0);
		scriptConversations(models, [{ match: "You write Melian's walkthrough", replies: [success("Rerun summary.")] }]);
		expect((await summarise({ rerun: true }))?.walkthroughs?.[revision]?.summary).toBe("Rerun summary.");
	});
	it("asks a persistently failing summariser twice across three reviews, and again on a rerun", async () => {
		const fail = fauxAssistantMessage("", { stopReason: "error", errorMessage: "down" });
		const captured = scriptConversations(models, [
			{ match: "You write Melian's walkthrough", replies: [fail, fail, fail, fail] },
		]);
		for (let review = 0; review < 3; review++) await summarise();
		expect(captured["You write Melian's walkthrough"]).toHaveLength(2);
		await summarise({ rerun: true });
		expect(captured["You write Melian's walkthrough"]).toHaveLength(3);
	});
	it("catches credential, prompt and missing-extension failures without failing review", async () => {
		const revision = revisionKey(changeset.revision);
		const auth = vi.spyOn(models.models, "checkAuth").mockRejectedValue(new Error("private credential error"));
		expect((await summarise())?.walkthroughNotes?.[revision]).toBe(
			"No walkthrough available. The summariser failed.",
		);
		auth.mockRestore();
		const files = vi.spyOn(changeset.revision.files, Symbol.iterator).mockImplementationOnce(() => {
			throw new Error("private prompt error");
		});
		expect((await summarise())?.walkthroughNotes?.[revision]).toBe(
			"No walkthrough available. The summariser failed.",
		);
		files.mockRestore();
		await harness.close(context);
		harness = await openHarness(createMemoryStorage(), { models: models.models, registry: createRegistry() });
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).provenance = {
				[revision]: { kind: "pull-request", policy: "config", manifest: [], lenses: [] },
			};
		}, context);
		expect((await summarise())?.walkthroughNotes?.[revision]).toBe(
			"No walkthrough available. The summariser failed.",
		);
	});
	it("records a task failure as a fixed note and retries a new task", async () => {
		const wait = vi.spyOn(harness, "waitForTask").mockRejectedValueOnce(new Error("task failed with private detail"));
		scriptConversations(models, [{ match: "You write Melian's walkthrough", replies: [success()] }]);
		expect((await summarise())?.walkthroughNotes?.[revisionKey(changeset.revision)]).toContain(
			"The summariser failed.",
		);
		wait.mockRestore();
		await harness.waitForIdle(context);
		scriptConversations(models, [{ match: "You write Melian's walkthrough", replies: [success("Recovered.")] }]);
		expect((await summarise({ rerun: true }))?.walkthroughs?.[revisionKey(changeset.revision)]?.summary).toBe(
			"Recovered.",
		);
	});
	it("records a failed task outcome without throwing", async () => {
		await harness.close(context);
		const failure = defineTask<unknown, { phase: "fail" }, string>({
			name: "melian.summarise",
			version: 1,
			initial: () => ({ phase: "fail" }),
			phases: {
				fail: async (_task, runtime, context) => {
					await runtime.commit(
						() => ({
							status: "terminal",
							outcome: { status: "failed", error: { message: "private task detail" } },
						}),
						context,
					);
				},
			},
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "summary-failure", tasks: [failure] }));
		harness = await openHarness(createMemoryStorage(), { models: models.models, registry });
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(VerdictDocument, root.id)).provenance = {
				[revisionKey(changeset.revision)]: { kind: "pull-request", policy: "config", manifest: [], lenses: [] },
			};
		}, context);
		const doc = await summarise();
		expect(doc?.walkthroughNotes?.[revisionKey(changeset.revision)]).toBe(
			"No walkthrough available. The summariser failed.",
		);
		expect(JSON.stringify(doc)).not.toContain("private task detail");
	});

	it("rejects extra properties and validates paths against the changed files", async () => {
		const captured = scriptConversations(models, [
			{
				match: "You write Melian's walkthrough",
				replies: [
					fauxAssistantMessage(
						[fauxToolCall("record_walkthrough", { summary: "summary", files: [], unexpected: "payload" })],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(
						[
							fauxToolCall("record_walkthrough", {
								summary: "summary",
								files: [{ path: "src/a.ts", summary: "summary", unexpected: "payload" }],
							}),
						],
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(
						[
							fauxToolCall("record_walkthrough", {
								summary: "s".repeat(4000),
								files: Array.from({ length: 100 }, (_, i) => ({
									path: i === 0 ? "not-changed.ts" : "src/a.ts",
									summary: "x".repeat(2000),
								})),
								diagram: "d".repeat(4000),
							}),
						],
						{ stopReason: "toolUse" },
					),
				],
			},
		]);
		const doc = await summarise();
		const walkthrough = doc?.walkthroughs?.[revisionKey(changeset.revision)];
		expect(walkthrough).toBeDefined();
		expect(walkthrough?.files.every(({ path }) => path === "src/a.ts")).toBe(true);
		expect(JSON.stringify(walkthrough).length).toBeLessThan(17_000);
		const requests = captured["You write Melian's walkthrough"]!;
		expect(requests).toHaveLength(3);
		expect(requests[1]?.map(textOf).join("\n")).toContain("unexpected");
		expect(requests[2]?.map(textOf).join("\n")).toContain("unexpected");
	});
});
