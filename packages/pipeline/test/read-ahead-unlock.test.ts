import { rmSync } from "node:fs";
import {
	Changeset,
	type DeciderAnswer,
	type DecisionRequest,
	defaultConfig,
	Lens,
	type MelianConfig,
	Revision,
} from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	decisionExtension,
	type Harness,
	openHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DecisionDocument } from "../src/decisions.ts";
import { baseAndHead, isolatedGitEnv, lines } from "./fixtures/repo.ts";

const correctness = "You are the correctness reviewer";

// What a check-free review records, so the review runs its lens alone.
const checks = [
	{ name: "guardrails", status: "ran" as const },
	{ name: "static.biome", status: "ran" as const },
	{ name: "static.tsc", status: "ran" as const },
	{ name: "decisions.fast", status: "skipped" as const, reason: "no decision provider is configured" },
];

// A decider whose answers the test scripts one call at a time: a function per call, run when the call comes.
class ScriptedDecider {
	readonly name = "scripted";
	readonly calibrated = false;
	readonly calls: DecisionRequest[] = [];
	readonly replies: ((request: DecisionRequest) => Promise<DeciderAnswer>)[] = [];

	async decide(request: DecisionRequest): Promise<DeciderAnswer> {
		this.calls.push(request);
		const reply = this.replies.shift();
		if (reply === undefined) throw new Error("the test scripted no more answers");
		return reply(request);
	}
}

const careful = async (request: DecisionRequest): Promise<DeciderAnswer> => ({
	answers: request.questions.map((question) => ({ question: question.id, distribution: { careful: 1 } })),
});

let repo: string;
let fake: FakeModels;
let harness: Harness;
let decider: ScriptedDecider;
let lenses: Lens[];
let config: MelianConfig;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead({ "src/a.ts": lines("export const a = 1;") }, { "src/a.ts": lines("export const a = 2;") });
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	const heavy = fake.ref("heavy");
	config = {
		...defaultConfig,
		tiers: { ...defaultConfig.tiers, full: ["fast", "lens.correctness"] },
		models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
	};
	decider = new ScriptedDecider();
	const registry = createReviewRegistry();
	registry.install(decisionExtension(decider));
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	lenses = (await Lens.load(repo, { kind: "revision", commit: "main" }, ["src/a.ts"])).filter(
		({ name }) => name === "correctness",
	);
	scriptConversations(fake, [{ match: correctness, replies: [() => fauxAssistantMessage("No findings.")] }]);
});

afterEach(async () => {
	await harness.close(context);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

type ReviewWith = {
	rerun?: boolean;
	unlockModels?: (providers: readonly string[]) => Promise<void>;
};

async function review(options: ReviewWith = {}) {
	return reviewChangeset({
		harness,
		changeset: await Changeset.resolve(repo, "main...feature"),
		config,
		lenses,
		standards: [],
		models: fake.review,
		checks,
		decider,
		triageProviders: ["decider"],
		...(options.rerun === undefined ? {} : { rerun: options.rerun }),
		...(options.unlockModels === undefined ? {} : { unlockModels: options.unlockModels }),
	});
}

describe("triage's read-ahead unlock", () => {
	const decisionTask = async () => {
		const root = (await harness.root(context)).id;
		const changeset = await Changeset.resolve(repo, "main...feature");
		const set = (await harness.snapshot(DecisionDocument, root, context))?.decisions[
			Revision.key(changeset.revision)
		];
		return set === undefined ? undefined : Object.values(set)[0]?.task;
	};

	it("unlocks the decider's providers when it read a finished decision and a rerun meanwhile replaced it", async () => {
		decider.replies.push(async () => {
			throw new Error("decider down");
		});
		await review();
		const failed = await decisionTask();
		expect(failed).toBeDefined();
		// The rerun's decider answers only after this review has committed, so its commit finds a live task.
		const held = Promise.withResolvers<void>();
		decider.replies.push(async (request) => {
			await held.promise;
			return careful(request);
		});
		const getTask = harness.getTask.bind(harness);
		let racer: Promise<unknown> | undefined;
		// Once this review has read the failed decision it means to attach to, a --rerun review replaces it with a live
		// task, so this review's commit finds a task its read never saw.
		vi.spyOn(harness, "getTask").mockImplementation(async (...args) => {
			const read = await getTask(...args);
			if (racer === undefined && args[0] === failed) {
				racer = review({ rerun: true });
				while ((await decisionTask()) === failed) await new Promise((resolve) => setTimeout(resolve, 5));
				setTimeout(() => held.resolve(), 50);
			}
			return read;
		});
		const unlocked: string[][] = [];
		await review({
			unlockModels: async (providers) => {
				unlocked.push([...providers]);
			},
		});
		await racer;
		expect(await decisionTask()).not.toBe(failed);
		// The decider's provider once its commit found a task other than the one it read, then the lens's.
		expect(unlocked[0]).toEqual(["decider"]);
	});

	it("unlocks nothing for triage when the decision it read is the one it attaches to", async () => {
		decider.replies.push(careful);
		await review();
		const unlocked: string[][] = [];
		await review({
			unlockModels: async (providers) => {
				unlocked.push([...providers]);
			},
		});
		expect(unlocked).toEqual([]);
		expect(decider.calls).toHaveLength(1);
	});
});
