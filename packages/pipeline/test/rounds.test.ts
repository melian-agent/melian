import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adjudication, Changeset, Comparison, ConfigError, defaultConfig, Finding, Lens } from "@melian-agent/core";
import {
	CompareHarness,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	DismissHarness,
	decisionExtension,
	defineDoc,
	type Harness,
	openHarness,
	openSqliteStorage,
	ROOT_CONVERSATION_ID,
	Round,
	RoundError,
	RoundReader,
	recordDismissal,
	reviewChangeset,
	revisionKey,
	type TaskId,
	upsertFinding,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AdjudicationTaskInput, VerdictDocument } from "../src/adjudication.ts";
import { ComparisonDocument } from "../src/compare.ts";
import * as configurations from "../src/configurations.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { RoundsDocument, RoundWriter } from "../src/rounds.ts";
import type * as Instructions from "../src/verification-instructions.ts";
import { baseAndHead, gitIn } from "./fixtures/repo.ts";

// The fixtures record the verifier version main had when it wrote them. A round whose verifier instructions change is
// reviewed again, by design, so these attachment tests run under the version the fixtures hold.
vi.mock("../src/verification-instructions.ts", async (importOriginal) => ({
	...(await importOriginal<typeof Instructions>()),
	verifierVersion: "4190289e598badf0",
}));

const rounds = RoundsDocument;
let repo: string;
let harness: Harness;
const scratch: string[] = [];
const fake = createFakeModels();
beforeEach(async () => {
	repo = baseAndHead({ "a.ts": "export const n = 1;\n" }, { "a.ts": "export const n = 2;\n" });
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	await harness.root(context, { agent: { model: fake.ref() } });
});
afterEach(async () => {
	vi.restoreAllMocks();
	await harness.close(context);
	rmSync(repo, { recursive: true, force: true });
	for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function review(status: "ran" | "failed" = "ran") {
	return reviewChangeset({
		harness,
		changeset: await Changeset.resolve(repo, "main...feature"),
		config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
		lenses: [],
		standards: [],
		models: fake.review,
		checks: [{ name: "static.mutation", status }],
	});
}

it("mints a mutation-only round without triage and freezes its verdict on a later static input", async () => {
	await review();
	const root = await harness.root(context);
	const first = await harness.snapshot(rounds, root.id, context);
	expect(first?.sequence).toBe(1);
	expect(first?.items.r1?.verdict?.status).toBe("passed");
	expect(first?.items.r1?.provenance).toMatchObject({
		kind: "range",
		policy: "config",
		manifest: ["static.mutation"],
	});
	await review("failed");
	const next = await harness.snapshot(rounds, root.id, context);
	expect(next?.sequence).toBe(2);
	expect(next?.items.r1?.verdict?.status).toBe("passed");
	expect(next?.items.r2?.verdict?.status).toBe("not-reviewed");
});

it("keeps the current round when a repeat review attaches", async () => {
	await review();
	await review();
	const root = await harness.root(context);
	expect((await harness.snapshot(rounds, root.id, context))?.sequence).toBe(1);
	expect((await harness.snapshot(rounds, root.id, context))?.items.r1?.tasks).toHaveLength(1);
});

it("mints a round for changed lens thinking and attaches at a fixed level", async () => {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const lenses = await Lens.builtins();
	fake.provider.setResponses([
		(request, options) => {
			expect(systemPromptOf(request.messages)).toContain("correctness");
			expect(options?.reasoning).toBe("high");
			return fauxAssistantMessage("Done.");
		},
		(request, options) => {
			expect(systemPromptOf(request.messages)).toContain("correctness");
			expect(options?.reasoning).toBe("low");
			return fauxAssistantMessage("Done.");
		},
	]);
	const root = await harness.root(context);
	const revision = revisionKey(changeset.revision);
	const tasks: number[][] = [];
	for (const thinking of ["high", "high", "low", "low"] as const) {
		await reviewChangeset({
			harness,
			changeset,
			lenses,
			standards: [],
			models: fake.review,
			checks: [],
			config: {
				...defaultConfig,
				tiers: { full: ["lens.correctness"] },
				models: { heavy: { model: "faux/faux-1", thinking } },
			},
		});
		const state = (await harness.snapshot(rounds, root.id, context))!;
		expect(state.sequence).toBe(thinking === "high" ? 1 : 2);
		expect(state.current[revision]).toBe(thinking === "high" ? "r1" : "r2");
		expect(Object.keys(state.items)).toHaveLength(state.sequence);
		expect(state.items[state.current[revision]!]!.verdict?.status).toBe("passed");
		tasks.push([...state.items[state.current[revision]!]!.tasks]);
	}
	expect(tasks[0]).toHaveLength(1);
	expect(tasks[1]).toEqual(tasks[0]);
	expect(tasks[2]).toHaveLength(1);
	expect(tasks[2]).not.toEqual(tasks[0]);
	expect(tasks[3]).toEqual(tasks[2]);
});

it("mints a model-free review on a host with no credentialed model", async () => {
	const models = createFakeModels({ auth: "none" });
	await reviewChangeset({
		harness,
		changeset: await Changeset.resolve(repo, "main...feature"),
		config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
		lenses: [],
		standards: [],
		models: models.review,
		checks: [{ name: "static.mutation", status: "ran" }],
	});
	expect((await harness.snapshot(rounds, (await harness.root(context)).id, context))?.sequence).toBe(1);
});

it("mints again after an adjudication itself fails, leaving the failed round undecided", async () => {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const options = {
		harness,
		changeset,
		config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
		lenses: [],
		standards: [],
		models: fake.review,
		checks: [{ name: "static.mutation", status: "ran" as const }],
		policy: { kind: "worktree" as const },
	};
	const original = configurations.configsFor;
	vi.spyOn(configurations, "configsFor")
		.mockImplementationOnce(original)
		.mockRejectedValueOnce(new ConfigError("invalidValue", repo, "policy became unreadable during adjudication"));
	await expect(reviewChangeset(options)).rejects.toMatchObject({ code: "adjudicationFailed" });
	const root = await harness.root(context);
	const failed = await harness.snapshot(rounds, root.id, context);
	expect(failed?.sequence).toBe(1);
	expect(failed?.items.r1?.verdict).toBeUndefined();
	await reviewChangeset(options);
	const retried = await harness.snapshot(rounds, root.id, context);
	expect(retried?.sequence).toBe(2);
	expect(retried?.items.r1?.verdict).toBeUndefined();
	expect(retried?.items.r2?.verdict?.status).toBe("passed");
});

it("mints when no lens covers the change and never asks the decider", async () => {
	const [loaded] = await Lens.load(repo, { kind: "revision", commit: "main" }, ["a.ts"]);
	const lens = Lens.from({ ...loaded!.toJSON(), paths: ["elsewhere/**"] });
	await reviewChangeset({
		harness,
		changeset: await Changeset.resolve(repo, "main...feature"),
		config: { ...defaultConfig, tiers: { full: [`lens.${lens.name}`] } },
		lenses: [lens],
		standards: [],
		models: fake.review,
		checks: [],
		decider: {
			name: "must-not-ask",
			calibrated: false,
			decide: async () => {
				throw new Error("no covered lens asks triage");
			},
		},
	});
	expect((await harness.snapshot(rounds, (await harness.root(context)).id, context))?.sequence).toBe(1);
});

it("mints nothing when startAdjudication finds the lens selection replaced", async () => {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const [lens] = await Lens.load(repo, { kind: "revision", commit: changeset.revision.base }, ["a.ts"]);
	scriptConversations(fake, [{ match: lens!.instructions, replies: [fauxAssistantMessage("Done.")] }]);
	const original = configurations.configsFor;
	vi.spyOn(configurations, "configsFor").mockImplementationOnce(async (...args) => {
		const config = await original(...args);
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			(await tx.doc(ReviewIndex, root.id)).reviews[revisionKey(changeset.revision)] = { lenses: ["replacement"] };
		}, context);
		return config;
	});
	await expect(
		reviewChangeset({
			harness,
			changeset,
			config: {
				...defaultConfig,
				models: { heavy: { model: `${fake.ref().provider}/${fake.ref().modelId}` } },
				tiers: { full: [`lens.${lens!.name}`] },
			},
			lenses: [lens!],
			standards: [],
			models: fake.review,
			checks: [],
			policy: { kind: "worktree" },
		}),
	).rejects.toMatchObject({ code: "superseded" });
	expect(await harness.snapshot(rounds, (await harness.root(context)).id, context)).toBeUndefined();
});

it("keeps the current round on dismissal and repeat dismissal, and freezes it on the next review", async () => {
	const changeset = await Changeset.resolve(repo, "main...feature");
	const key = revisionKey(changeset.revision);
	const finding = Finding.create({
		rule: "static-defect",
		message: "bad",
		file: "a.ts",
		startLine: 1,
		snippet: "export const n = 2;",
		occurrence: 0,
		cause: "introduced",
		severity: "P1",
		explanation: { what: "bad", whyHere: "here", whatToDo: "fix" },
		source: { check: "static.mutation", version: "1" },
	});
	const root = await harness.root(context);
	await root.commit((tx) => upsertFinding(tx, root.id, finding, key), context);
	await review();
	const options = {
		harness,
		revision: changeset.revision,
		id: finding.id,
		dismissal: { by: "Test", reason: "Accepted", at: "2026-10-18T00:00:00Z" },
		repoRoot: repo,
	};
	await recordDismissal(options);
	await recordDismissal(options);
	const dismissed = await harness.snapshot(rounds, root.id, context);
	expect(dismissed?.sequence).toBe(1);
	expect(dismissed?.items.r1?.tasks).toHaveLength(2);
	expect(dismissed?.items.r1?.verdict?.dismissed).toHaveLength(1);
	await review("failed");
	const next = await harness.snapshot(rounds, root.id, context);
	expect(next?.sequence).toBe(2);
	expect(next?.items.r1).toEqual(dismissed?.items.r1);
});

const legacy = JSON.parse(readFileSync(new URL("./fixtures/rounds-main/recorded.json", import.meta.url), "utf8")) as {
	changeset: string;
	key: string;
	pending: number;
	finding: string;
	external: string;
};

async function oldStorage(name = "pending") {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "melian-round-reopen-")));
	scratch.push(dir);
	const path = join(dir, "pending.sqlite");
	copyFileSync(new URL(`./fixtures/rounds-main/${name}.sqlite`, import.meta.url), path);
	return { path, storage: await openSqliteStorage(path) };
}

it.each(["import", "adjudicate"])("records the legacy verdict before a comparison %s", async (command) => {
	const { storage } = await oldStorage("decided");
	const comparison = await CompareHarness.open(storage, fake.review, "change");
	try {
		const [base, head] = legacy.key.split("..");
		if (command === "import")
			await comparison.importFindings({ base: base!, head: head! }, [], "2026-10-18T01:00:00Z");
		else
			await comparison.adjudicate({ base: base!, head: head! }, legacy.external, {
				verdict: "noise",
				by: "Test",
				at: "2026-10-18T01:00:00Z",
			});
		const root = await comparison.harness.root(context);
		const state = await comparison.harness.snapshot(rounds, root.id, context);
		expect(state?.sequence).toBe(0);
		expect(Object.values(state!.items)).toMatchObject([{ verdict: { status: "passed" } }]);
	} finally {
		await comparison.close(context);
	}
});

it.each([
	undefined,
	{ base: legacy.key.split("..")[0]!, head: legacy.key.split("..")[1]!, tier: "full", policy: "cli-policy", task: 1 },
])("keeps main's decided round when an unchanged range review attaches (checkRun=%s)", async (checkRun) => {
	const { storage } = await oldStorage("decided");
	const reopened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		const root = await reopened.root(context);
		const before = (await reopened.snapshot(ReviewIndex, root.id, context))!.reviews[legacy.key]!.adjudication!;
		const input = JSON.parse(before.input) as AdjudicationTaskInput;
		gitIn(
			repo,
			"fetch",
			new URL("./fixtures/rounds-main/repo.bundle", import.meta.url).pathname,
			"refs/heads/main:refs/heads/legacy-base",
			"refs/heads/feature:refs/heads/legacy-head",
		);
		const resolved = await Changeset.resolve(repo, "legacy-base...legacy-head");
		const changeset = Changeset.from({ ...resolved.toJSON(), id: legacy.changeset, repoRoot: input.repoRoot });
		const options = {
			harness: reopened,
			changeset,
			config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
			lenses: [],
			standards: [],
			models: fake.review,
			checks: [{ name: "static.mutation", status: "ran" as const }],
			checkRun,
		};
		await reviewChangeset(options);
		await reviewChangeset(options);
		expect((await reopened.snapshot(ReviewIndex, root.id, context))!.reviews[legacy.key]!.adjudication!.task).toBe(
			before.task,
		);
		const state = await reopened.snapshot(rounds, root.id, context);
		expect(state?.sequence).toBe(0);
		expect(Object.values(state!.items)).toMatchObject([{ tasks: [before.task], verdict: { status: "passed" } }]);
	} finally {
		await reopened.close(context);
	}
});

it("mints after a legacy attachment when the CLI supplies a distinct check run with identical records", async () => {
	const { storage } = await oldStorage("decided");
	const reopened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		const root = await reopened.root(context);
		const before = (await reopened.snapshot(ReviewIndex, root.id, context))!.reviews[legacy.key]!.adjudication!;
		const input = JSON.parse(before.input) as AdjudicationTaskInput;
		gitIn(
			repo,
			"fetch",
			new URL("./fixtures/rounds-main/repo.bundle", import.meta.url).pathname,
			"refs/heads/main:refs/heads/legacy-base",
			"refs/heads/feature:refs/heads/legacy-head",
		);
		const resolved = await Changeset.resolve(repo, "legacy-base...legacy-head");
		const changeset = Changeset.from({ ...resolved.toJSON(), id: legacy.changeset, repoRoot: input.repoRoot });
		const checkRun = { base: input.base, head: input.head, tier: "full", policy: "cli-policy", task: 1 };
		const options = {
			harness: reopened,
			changeset,
			config: { ...defaultConfig, tiers: { full: ["static.mutation"] } },
			lenses: [],
			standards: [],
			models: fake.review,
			checks: [{ name: "static.mutation", status: "ran" as const }],
			checkRun,
		};
		await reviewChangeset(options);
		expect((await reopened.snapshot(ReviewIndex, root.id, context))!.reviews[legacy.key]!.adjudication!.task).toBe(
			before.task,
		);
		const attached = structuredClone((await reopened.snapshot(rounds, root.id, context))!);
		expect(attached.sequence).toBe(0);
		await reviewChangeset({ ...options, checkRun: { ...checkRun, task: 2 } });
		const minted = await reopened.snapshot(rounds, root.id, context);
		expect(minted?.sequence).toBe(1);
		expect(minted?.items.r1).toMatchObject({ verdict: { status: "passed" } });
		expect(minted?.items[attached.current[legacy.key]!]).toEqual(attached.items[attached.current[legacy.key]!]);
		expect(
			(await reopened.snapshot(ReviewIndex, root.id, context))!.reviews[legacy.key]!.adjudication!.task,
		).not.toBe(before.task);
	} finally {
		await reopened.close(context);
	}
});

it("synthesises an undecided comparison-only legacy round without writing", async () => {
	const storage = createMemoryStorage();
	const comparison = await CompareHarness.open(storage, fake.review, "change");
	try {
		const root = await comparison.harness.root(context);
		const [base, head] = legacy.key.split("..");
		await root.commit(async (tx) => {
			(await tx.doc(ComparisonDocument, root.id)).unattributed[legacy.key] = Comparison.of({
				base: base!,
				head: head!,
			}).toJSON();
		}, context);
		const [round] = await new RoundReader(storage).read(legacy.changeset);
		expect(round?.stored).toEqual({ base, head, tasks: [] });
		expect(round?.verdict()).toBeUndefined();
		expect(await comparison.harness.snapshot(rounds, root.id, context)).toBeUndefined();
	} finally {
		await comparison.close(context);
	}
});

it("records legacy ownership in the dismissal transaction before its adjudication runs", async () => {
	const { storage } = await oldStorage("decided");
	const opened = await DismissHarness.open(storage, fake.review);
	try {
		vi.spyOn(opened.harness, "resume").mockImplementation(() => undefined);
		vi.spyOn(opened.harness, "waitForTask").mockImplementation(async (task) => {
			const state = await opened.harness.snapshot(rounds, (await opened.harness.root(context)).id, context);
			expect(state?.sequence).toBe(0);
			expect(Object.values(state!.items)[0]?.tasks).toContain(task);
			expect(Object.values(state!.items)[0]?.verdict?.status).toBe("passed");
			throw new Error("paused before adjudication");
		});
		const [base, head] = legacy.key.split("..");
		await expect(
			recordDismissal({
				harness: opened.harness,
				revision: { base: base!, head: head! },
				id: legacy.finding,
				dismissal: { by: "Test", reason: "Accepted", at: "2026-10-18T01:00:00Z" },
				repoRoot: repo,
			}),
		).rejects.toThrow("paused before adjudication");
	} finally {
		await opened.close(context);
	}
});

it("records the live legacy verdict before triage deletes it and mints no round while triage waits", async () => {
	const { storage } = await oldStorage("decided");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let asked!: () => void;
	const started = new Promise<void>((resolve) => {
		asked = resolve;
	});
	const decider = {
		name: "holding",
		calibrated: false,
		decide: async (request: { questions: readonly { id: string }[] }) => {
			asked();
			await gate;
			return {
				answers: request.questions.map((question) => ({ question: question.id, distribution: { careful: 1 } })),
			};
		},
	};
	const registry = createReviewRegistry();
	registry.install(decisionExtension(decider));
	const reopened = await openHarness(storage, {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false } },
	});
	try {
		const bundle = new URL("./fixtures/rounds-main/repo.bundle", import.meta.url);
		gitIn(
			repo,
			"fetch",
			bundle.pathname,
			"refs/heads/main:refs/heads/legacy-base",
			"refs/heads/feature:refs/heads/legacy-head",
		);
		const changeset = (await Changeset.resolve(repo, "legacy-base...legacy-head")).withId(legacy.changeset);
		const [lens] = await Lens.load(repo, { kind: "revision", commit: changeset.revision.base }, ["a.ts"]);
		scriptConversations(fake, [{ match: lens!.instructions, replies: [fauxAssistantMessage("Done.")] }]);
		const review = reviewChangeset({
			harness: reopened,
			changeset,
			config: {
				...defaultConfig,
				models: { heavy: { model: `${fake.ref().provider}/${fake.ref().modelId}` } },
				tiers: { full: [`lens.${lens!.name}`] },
			},
			lenses: [lens!],
			standards: [],
			models: fake.review,
			checks: [],
			decider,
		}).catch((error) => error);
		await started;
		const root = await reopened.root(context);
		const state = await reopened.snapshot(rounds, root.id, context);
		expect(state?.sequence).toBe(0);
		expect(Object.values(state!.items)).toMatchObject([{ verdict: { status: "passed" } }]);
		expect((await reopened.snapshot(VerdictDocument, root.id, context))?.verdicts[legacy.key]).toBeUndefined();
		release();
		expect(await review).not.toBeInstanceOf(Error);
		expect((await reopened.snapshot(rounds, root.id, context))?.sequence).toBe(1);
	} finally {
		release();
		await reopened.close(context);
	}
});

it("synthesises main's legacy round on a detached read without creating a document", async () => {
	const { storage } = await oldStorage();
	try {
		const reader = new RoundReader(storage);
		const [round] = await reader.read(legacy.changeset);
		expect(round?.id).toMatch(/^range-[a-f0-9]{16}\.k[a-f0-9]{16}$/);
		expect(round?.verdict()?.status).toBe("passed");
		const docs = await storage.findDocument(
			{ kind: "melian.rounds", scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } },
			"current",
			context,
		);
		expect(docs).toBeUndefined();
		expect((await reader.read(legacy.changeset)).map((round) => round.id)).toEqual([round?.id]);
	} finally {
		await storage.close(context);
	}
});

it("lets an adjudication main left pending overwrite its own legacy verdict after reopening", async () => {
	const { storage } = await oldStorage();
	const reopened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		const root = await reopened.root(context);
		expect(await reopened.snapshot(RoundsDocument, root.id, context)).toBeUndefined();
		const task = await reopened.waitForTask(legacy.pending as TaskId, context);
		expect(task.state.outcome).toMatchObject({ status: "completed", result: "recorded" });
		const state = await reopened.snapshot(RoundsDocument, root.id, context);
		expect(state?.sequence).toBe(0);
		expect(Object.values(state!.items)).toMatchObject([
			{ tasks: [legacy.pending], verdict: { status: "not-reviewed" } },
		]);
		expect(Object.keys(state!.items)).toEqual([state!.current[legacy.key]]);
	} finally {
		await reopened.close(context);
	}
});

it("places a main task with no live verdict or comparison in its key's legacy round", async () => {
	const { storage } = await oldStorage();
	const reopened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		const root = await reopened.root(context);
		await root.commit(async (tx) => {
			delete (await tx.doc(VerdictDocument, root.id)).verdicts[legacy.key];
			delete (await tx.doc(ComparisonDocument, root.id)).unattributed[legacy.key];
		}, context);
		await reopened.waitForTask(legacy.pending as TaskId, context);
		const state = await reopened.snapshot(rounds, root.id, context);
		expect(state?.sequence).toBe(0);
		expect(state?.current[legacy.key]).toMatch(/^k[0-9a-f]{16}$/);
		expect(Object.values(state!.items)).toMatchObject([
			{ tasks: [legacy.pending], verdict: { status: "not-reviewed" } },
		]);
	} finally {
		await reopened.close(context);
	}
});

it("reopens between minting and deciding with the same round and task", async () => {
	const { storage, path } = await oldStorage();
	const first = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	const root = await first.root(context);
	await root.commit(
		(tx) => new RoundWriter(tx, root.id).mint(legacy.key, legacy.pending, "2026-10-18T00:00:00Z"),
		context,
	);
	expect((await first.snapshot(rounds, root.id, context))?.items.r1?.tasks).toEqual([legacy.pending]);
	await first.close(context);
	const reopened = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createReviewRegistry(),
	});
	try {
		await reopened.waitForTask(legacy.pending as TaskId, context);
		const state = await reopened.snapshot(RoundsDocument, (await reopened.root(context)).id, context);
		expect(state?.sequence).toBe(1);
		expect(state?.current[legacy.key]).toBe("r1");
		expect(state?.items.r1).toMatchObject({
			tasks: [legacy.pending],
			mintedAt: "2026-10-18T00:00:00Z",
			verdict: { status: "not-reviewed" },
		});
		expect(Object.values(state!.items).filter((round) => round.mintedAt === undefined)).toMatchObject([
			{ verdict: { status: "passed" } },
		]);
	} finally {
		await reopened.close(context);
	}
});

it("preserves the verdict as read inside the writer's transaction, once, before deleting all live authority", async () => {
	const root = await harness.root(context);
	const passed = new Adjudication({ findings: [], manifest: [], checks: [], config: defaultConfig })
		.adjudicate()
		.toJSON();
	const failed = new Adjudication({ findings: [], manifest: ["static.mutation"], checks: [], config: defaultConfig })
		.adjudicate()
		.toJSON();
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).verdicts[legacy.key] = passed;
	}, context);
	await harness.snapshot(VerdictDocument, root.id, context);
	await root.commit(async (tx) => {
		const live = await tx.doc(VerdictDocument, root.id);
		live.verdicts[legacy.key] = failed;
		live.provenance = { [legacy.key]: { kind: "range", policy: "config", manifest: [], lenses: [] } };
		live.decisions = { [legacy.key]: { task: 7, findingsVersion: 0 } };
		await new RoundWriter(tx, root.id).mint(legacy.key, 8, "2026-10-18T00:00:00Z");
	}, context);
	const state = await harness.snapshot(RoundsDocument, root.id, context);
	const old = Object.values(state!.items).find((round) => round.mintedAt === undefined)!;
	expect(old.verdict?.status).toBe("not-reviewed");
	expect(old.provenance).toMatchObject({ kind: "range" });
	const live = await harness.snapshot(VerdictDocument, root.id, context);
	expect(live?.verdicts[legacy.key]).toBeUndefined();
	expect(live?.provenance?.[legacy.key]).toBeUndefined();
	expect(live?.decisions?.[legacy.key]).toBeUndefined();
	await root.commit(async (tx) => {
		(await tx.doc(VerdictDocument, root.id)).verdicts[legacy.key] = passed;
		await new RoundWriter(tx, root.id).preserve(legacy.key);
	}, context);
	expect((await harness.snapshot(RoundsDocument, root.id, context))?.items).toEqual(state?.items);
});

it("records no legacy marker or copy when the writer's transaction rolls back", async () => {
	const root = await harness.root(context);
	await expect(
		root.commit(async (tx) => {
			await new RoundWriter(tx, root.id).preserve(legacy.key);
			throw new Error("interrupted");
		}, context),
	).rejects.toThrow("interrupted");
	expect(await harness.snapshot(RoundsDocument, root.id, context)).toBeUndefined();
});

it("preserves an undecided comparison-only legacy key before its first round write", async () => {
	const root = await harness.root(context);
	const [base, head] = legacy.key.split("..");
	await root.commit(async (tx) => {
		(await tx.doc(ComparisonDocument, root.id)).unattributed[legacy.key] = Comparison.of({
			base: base!,
			head: head!,
		}).toJSON();
	}, context);
	await root.commit((tx) => new RoundWriter(tx, root.id).mint(legacy.key, 2, "2026-10-18T00:00:00Z"), context);
	const state = await harness.snapshot(RoundsDocument, root.id, context);
	expect(Object.values(state!.items).filter((round) => round.mintedAt === undefined)).toEqual([
		{ base, head, tasks: [] },
	]);
});

it.each([false, true])(
	"orders known round dates before unknown dates, breaking ties by ID (reversed=%s)",
	(reversed) => {
		const make = (id: string, head: string, mintedAt?: string) =>
			new Round(id, { base: "base", head, tasks: [], ...(mintedAt === undefined ? {} : { mintedAt }) });
		const rounds = [
			make("kz", "missing"),
			make("r2", "head", "2026-10-18T02:00:00Z"),
			make("ky", "missing"),
			make("kb", "old"),
			make("ka", "old"),
			make("kc", "older"),
			make("r1", "head", "2026-10-18T01:00:00Z"),
			make("r0", "head", "2026-10-18T01:00:00Z"),
		];
		if (reversed) rounds.reverse();
		rounds.sort((left, right) =>
			left.compare(
				right,
				new Map([
					["old", 2],
					["older", 1],
				]),
			),
		);
		expect(rounds.map((round) => round.id)).toEqual(["kc", "ka", "kb", "r0", "r1", "r2", "ky", "kz"]);
	},
);

it.each([
	{ left: undefined, right: "2026-10-18T01:00:00Z", expected: -1 },
	{ left: "2026-10-18T01:00:00Z", right: undefined, expected: 1 },
	{ left: undefined, right: undefined, expected: 10 },
	{ left: "2026-10-18T01:00:00Z", right: "2026-10-18T02:00:00Z", expected: -3_600_000 },
	{ left: "2026-10-18T02:00:00Z", right: "2026-10-18T01:00:00Z", expected: 3_600_000 },
])("compares round dates directly: $left against $right", ({ left, right, expected }) => {
	const first = new Round("a", { base: "base", head: "left", tasks: [], mintedAt: left });
	const second = new Round("b", { base: "base", head: "right", tasks: [], mintedAt: right });
	const dates = new Map([
		["left", 20],
		["right", 10],
	]);
	expect(first.compare(second, dates)).toBe(expected);
	expect(second.compare(first, dates)).toBe(-expected);
});

it.each(["verdict", "comparison"])("reads a legacy %s without provenance", async (kind) => {
	const storage = createMemoryStorage();
	const opened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		const root = await opened.root(context, { agent: { model: fake.ref() } });
		await root.commit(async (tx) => {
			if (kind === "verdict") {
				const document = await tx.doc(VerdictDocument, root.id);
				document.verdicts[legacy.key] = new Adjudication({
					findings: [],
					manifest: [],
					checks: [],
					config: defaultConfig,
				})
					.adjudicate()
					.toJSON();
			} else {
				const [base, head] = legacy.key.split("..");
				(await tx.doc(ComparisonDocument, root.id)).unattributed[legacy.key] = Comparison.of({
					base: base!,
					head: head!,
				}).toJSON();
			}
		}, context);
		const result = await new RoundReader(storage).read("range-test");
		expect(result).toHaveLength(1);
		expect(result[0]!.stored.provenance).toBeUndefined();
		expect(result[0]!.verdict()?.status).toBe(kind === "verdict" ? "passed" : undefined);
	} finally {
		await opened.close(context);
	}
});

it("returns independent frozen verdict views", async () => {
	await review();
	const stored = (await harness.snapshot(rounds, (await harness.root(context)).id, context))!.items.r1!;
	const round = new Round("range-test.r1", stored);
	stored.tasks.push(999);
	expect(round.stored.tasks).not.toContain(999);
	const verdict = round.verdict()!;
	const json = verdict.toJSON();
	json.status = "not-reviewed";
	expect(round.verdict()?.status).toBe("passed");
	expect(new Round("undecided", { base: "base", head: "head", tasks: [] }).verdict()).toBeUndefined();
});

it("reads empty storage and a document lost between detached reads as absent", async () => {
	const storage = createMemoryStorage();
	const opened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		expect(await new RoundReader(storage).read("range-test")).toEqual([]);
		const root = await opened.root(context, { agent: { model: fake.ref() } });
		await root.commit(async (tx) => {
			(await tx.doc(RoundsDocument, root.id)).sequence = 1;
		}, context);
		const record = await storage.findDocument(
			{ kind: "melian.rounds", scope: { kind: "conversation", conversationId: root.id } },
			"current",
			context,
		);
		vi.spyOn(storage, "document").mockImplementation(async (id) => {
			expect(id).toBe(record!.id);
			return undefined;
		});
		expect(await new RoundReader(storage).read("range-test")).toEqual([]);
	} finally {
		await opened.close(context);
	}
});

it.each([
	{ kind: "melian.rounds", version: 3 },
	{ kind: "melian.comparisons", version: 3 },
	{ kind: "melian.verdicts", version: 14 },
])("refuses newer $kind version $version", async ({ kind, version }) => {
	const storage = createMemoryStorage();
	const opened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		const root = await opened.root(context, { agent: { model: fake.ref() } });
		const token = defineDoc({
			kind,
			version,
			scope: "conversation",
			history: "latest",
			fork: "current",
			initial: () => ({ present: true }),
		});
		await root.commit(async (tx) => {
			(await tx.doc(token, root.id)).present = true;
		}, context);
		await expect(new RoundReader(storage).read("range-test")).rejects.toBeInstanceOf(RoundError);
	} finally {
		await opened.close(context);
	}
});

it("migrates a recorded old verdict during a detached legacy read", async () => {
	const storage = createMemoryStorage();
	const opened = await openHarness(storage, { models: fake.models, registry: createReviewRegistry() });
	try {
		const root = await opened.root(context, { agent: { model: fake.ref() } });
		const fixture = JSON.parse(
			readFileSync(new URL("./fixtures/stored-checks-v3/review.json", import.meta.url), "utf8"),
		) as { verdicts: ReturnType<typeof VerdictDocument.definition.initial> };
		const token = defineDoc({ ...VerdictDocument.definition, version: 8 });
		await root.commit(async (tx) => {
			Object.assign(await tx.doc(token, root.id), fixture.verdicts);
		}, context);
		const migrate = vi.spyOn(VerdictDocument.definition, "migrate");
		const [round] = await new RoundReader(storage).read("range-test");
		expect(round?.verdict()?.status).toBeDefined();
		expect(migrate).toHaveBeenCalledExactlyOnceWith(fixture.verdicts, 8);
		expect(await opened.snapshot(RoundsDocument, root.id, context)).toBeUndefined();
	} finally {
		await opened.close(context);
	}
});

it.each([undefined, "stored-check-run"])(
	"keeps a minted task's check run instead of a legacy default (%s)",
	async (checkRun) => {
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			const writer = new RoundWriter(tx, root.id);
			await writer.mint(legacy.key, 999, "2026-10-18T00:00:00Z", checkRun);
			expect(await writer.checkRun(999, "cli-check-run")).toBe(checkRun);
		}, context);
	},
);

it("keeps the first accepted legacy check run when later writes supply another or none", async () => {
	const root = await harness.root(context);
	await root.commit(async (tx) => {
		const writer = new RoundWriter(tx, root.id);
		await writer.keep(legacy.key, 999, "accepted-check-run");
		await writer.keep(legacy.key, 999, "another-check-run");
		expect(await writer.checkRun(999, "caller-check-run")).toBe("accepted-check-run");
		await writer.keep(legacy.key, 999);
		expect(await writer.checkRun(999, "caller-check-run")).toBe("accepted-check-run");
	}, context);
});
