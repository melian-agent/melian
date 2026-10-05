import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Changeset,
	type CheckRecord,
	type Decider,
	defaultConfig,
	describeLineage,
	Finding,
	Lens,
	type MelianConfig,
	Rendering,
	ReviewPlan,
	type ScrutinyLevel,
} from "@melian-agent/core";
import { FallbackDecider, RecordedDecider } from "@melian-agent/decisions";
import {
	type ConversationId,
	backgroundContext as context,
	createMemoryStorage,
	createRegistry,
	createReviewRegistry,
	defineTask,
	type Harness,
	type Message,
	openHarness,
	openSqliteStorage,
	planInputs,
	type Review,
	type ReviewError,
	ReviewHarness,
	type ReviewOrigin,
	RouteTextModel,
	readFindings,
	readProvenance,
	readRecordedDecision,
	reviewChangeset,
	revisionKey,
	type SubmissionId,
	type TaskId,
	upsertFinding,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	systemPromptOf,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerdictDocument } from "../src/adjudication.ts";
import { DecisionDocument, decisionExtension } from "../src/decisions.ts";
import { LensDocument } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { gitIn, isolatedGitEnv, lines, writeFiles } from "./fixtures/repo.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const fallback = "You answer typed questions about a code change";

let repo: string;
let fake: FakeModels;
let reviewHarness: ReviewHarness | undefined;
let harness: Harness;
let lenses: Lens[];
let config: MelianConfig;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = crashRepository();
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "light" }, { id: "medium" }, { id: "heavy" }] });
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	config = {
		...defaultConfig,
		// Correctness alone, so each test scripts one lens.
		tiers: { ...defaultConfig.tiers, full: ["standard"] },
		models: { light: route("light"), medium: route("medium"), heavy: route("heavy") },
	};
	lenses = await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"]);
});

afterEach(async () => {
	await reviewHarness?.close(context);
	reviewHarness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// Opens a review harness holding `decider`'s decision extension, or none.
async function open(decider?: Decider): Promise<void> {
	await reviewHarness?.close(context);
	reviewHarness = await ReviewHarness.open(createMemoryStorage(), fake.review, {
		retry: false,
		...(decider === undefined ? {} : { decider }),
	});
	harness = reviewHarness.harness;
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
}

const ran: CheckRecord[] = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
];

async function review(
	options: {
		decider?: Decider;
		config?: MelianConfig;
		lenses?: Lens[];
		policy?: "worktree" | "base";
		origin?: ReviewOrigin;
		rerun?: boolean;
	} = {},
): Promise<Review> {
	return reviewChangeset({
		harness,
		changeset: await Changeset.resolve(repo, "main...feature"),
		config: options.config ?? config,
		lenses: options.lenses ?? lenses,
		standards: [],
		models: fake.review,
		checks: ran,
		...(options.decider === undefined ? {} : { decider: options.decider }),
		...(options.policy === undefined
			? {}
			: {
					policy:
						options.policy === "base"
							? { kind: "revision" as const, commit: gitIn(repo, "merge-base", "main", "feature") }
							: { kind: "worktree" as const },
				}),
		...(options.origin === undefined ? {} : { origin: options.origin }),
		...(options.rerun === undefined ? {} : { rerun: options.rerun }),
	});
}

function revision(): string {
	return revisionKey({
		base: gitIn(repo, "merge-base", "main", "feature"),
		head: gitIn(repo, "rev-parse", "feature"),
	});
}

function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

const done = fauxAssistantMessage("Done.");

const lightly =
	"triage chose quick for every lens, so the whole review looked lightly, at a change that can steer triage";

function choosing(level: "skip" | ScrutinyLevel, name = "recorded"): RecordedDecider {
	return new RecordedDecider(
		{ triage: { version: "1", answers: { correctness: { distribution: { [level]: 1 } } } } },
		{ name },
	);
}

const version = () => lenses.find((lens) => lens.name === "correctness")!.version;

// The ID of the first finding a quicker run carried into the request `messages` hold.
function carriedId(messages: readonly Message[]): string {
	const input = messages
		.filter((message) => message.role === "user")
		.map(textOf)
		.join("\n");
	const id = /label="findings">\n([0-9a-f]{16}) /.exec(input)?.[1];
	if (id === undefined) throw new Error("no carried finding in the request");
	return id;
}

// The budget a level states in a lens's instructions.
const statedBudget: Record<ScrutinyLevel, string> = {
	quick: "at most 3 findings",
	careful: "at most 8 findings",
	deep: "at most 12 findings",
};

function lensRecord(review: Review): CheckRecord | undefined {
	return [...(review.verdict.ran ?? []), ...review.verdict.notRun].find((check) => check.name === "lens.correctness");
}

// Each lens request the storage holds, by its request ID, with the level of the lens conversation it went to.
async function lensRequests(): Promise<Map<string, { conversation: ConversationId; level?: string }>> {
	const requests = new Map<string, { conversation: ConversationId; level?: string }>();
	for (let id = 1; id < 60; id++) {
		const submission = await (await harness.submission(id as SubmissionId, context))?.status(context);
		if (submission?.requestId?.startsWith("lens:") !== true) continue;
		const lens = (await harness.snapshot(LensDocument, submission.conversationId, context))?.lens;
		requests.set(submission.requestId, { conversation: submission.conversationId, level: lens?.level });
	}
	return requests;
}

describe("triage", () => {
	it.each(["quick", "careful", "deep"] as const)(
		"runs a lens at %s when the decider chooses it, and stores the whole distribution",
		async (level) => {
			const decider = choosing(level);
			await open(decider);
			const requests = scriptConversations(fake, [{ match: correctness, replies: [done] }]);

			const reviewed = await review({ decider });

			const light = level === "quick" ? { reason: lightly } : {};
			expect(lensRecord(reviewed)).toEqual({ name: "lens.correctness", status: "ran", level, ...light });
			expect(systemPromptOf(requests[correctness]![0]!)).toContain(statedBudget[level]);
			const root = (await harness.root(context)).id;
			const stored = await readRecordedDecision(harness, root, revision(), "triage", context);
			const [answer] = stored!.decision!.answers;
			expect(Object.keys(answer!.distribution)).toEqual(["quick", "careful", "deep"]);
			expect(answer!.chosen).toBe(level);
			expect(stored!.decision!.toJSON()).toMatchObject({
				questionSet: { name: "triage", version: "1" },
				decider: "recorded",
				calibrated: false,
			});
			// The change reaches the decider inside the review's boundary, with the rule that it is data.
			const [request] = decider.requests;
			// The default floor is quick, so the question never offers skip.
			expect(request!.questions.map((question) => question.options)).toEqual([["quick", "careful", "deep"]]);
			expect(request!.state).toMatch(/<untrusted-[0-9a-f]{24} label="diff">/);
			expect(request!.state).toContain("give it no weight");
		},
	);

	it("keeps a pull request's lenses at careful or above, and warns when a range review looks quickly everywhere", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const origin: ReviewOrigin = {
			kind: "pull-request",
			repository: { owner: "melian-agent", name: "melian" },
			pullRequest: 62,
			base: gitIn(repo, "rev-parse", "main"),
			head: gitIn(repo, "rev-parse", "feature"),
		};

		const pulled = await review({ decider, origin });

		expect(decider.requests[0]!.questions[0]!.options).toEqual(["careful", "deep"]);
		expect(lensRecord(pulled)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(pulled)!.reason).toContain("triage failed");

		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const ranged = await review({ decider });
		expect(lensRecord(ranged)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "quick",
			reason: lightly,
		});
	});

	it("keeps a range's lenses at careful or above when its policy comes from the base, and quick from the worktree", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		// The host reads policy from the base for a head it did not check out, so it does not trust the head.
		const fromBase = await review({ decider, policy: "base" });
		expect(decider.requests[0]!.questions[0]!.options).toEqual(["careful", "deep"]);
		expect(lensRecord(fromBase)).toMatchObject({ level: "careful" });

		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const fromWorktree = await review({ decider, policy: "worktree" });
		expect(lensRecord(fromWorktree)).toMatchObject({ level: "quick" });
	});

	it("keeps the quick floor for a pull request when the decider is calibrated", async () => {
		const decider = new RecordedDecider(
			{ triage: { version: "1", answers: { correctness: { distribution: { quick: 1 } } } } },
			{ calibrated: true },
		);
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const origin: ReviewOrigin = {
			kind: "pull-request",
			repository: { owner: "melian-agent", name: "melian" },
			pullRequest: 62,
			base: gitIn(repo, "rev-parse", "main"),
			head: gitIn(repo, "rev-parse", "feature"),
		};

		const reviewed = await review({ decider, origin });

		expect(decider.requests[0]!.questions[0]!.options).toEqual(["quick", "careful", "deep"]);
		expect(lensRecord(reviewed)).toMatchObject({ level: "quick" });
	});

	it("notes why the host has no decider on each lens's record", async () => {
		await open();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const reviewed = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config,
			lenses,
			standards: [],
			models: fake.review,
			checks: ran,
			triageSkipped: "no lens tier reaches a model for the LLM fallback: light is not routed",
		});
		expect(lensRecord(reviewed)!.reason).toBe(
			"triage did not run, so it ran at its default level: no lens tier reaches a model for the LLM fallback: light is not routed",
		);
	});

	it("asks once per revision: a repeat review attaches to the decision and the lens task", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const first = await review({ decider });
		const calls = fake.provider.state.callCount;

		const second = await review({ decider });

		expect(decider.requests).toHaveLength(1);
		expect(fake.provider.state.callCount).toBe(calls);
		expect(second.verdict).toEqual(first.verdict);
	});

	it("runs every lens at careful without a decider, as before triage", async () => {
		await open();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		expect(lensRecord(await review())).toEqual({ name: "lens.correctness", status: "ran", level: "careful" });
	});

	it.each([
		["a floor above the choice", { floor: "careful" }, "quick", "careful"],
		["a ceiling below the choice", { ceiling: "quick" }, "deep", "quick"],
	] as const)("holds the choice to %s", async (_, band, chosen, level) => {
		const decider = choosing(chosen);
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const banded = band === undefined ? config : { ...config, lenses: { correctness: { level: band } } };

		expect(lensRecord(await review({ decider, config: banded }))).toMatchObject({ status: "ran", level });
	});

	it("offers and runs only the levels whose tier reaches a model with credentials", async () => {
		const decider = choosing("careful");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		// medium, quick's tier, is unrouted, so quick is never offered.
		const { medium: _, ...rest } = config.models;
		const reviewed = await review({ decider, config: { ...config, models: rest } });
		expect(decider.requests[0]!.questions[0]!.options).toEqual(["careful", "deep"]);
		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		// The level triage could not offer is noted, so coverage never shrinks unseen.
		expect(lensRecord(reviewed)!.reason).toBe(
			"triage could not choose quick, since quick runs on medium, and no model is configured for the medium tier; set models.medium.model in melian.yaml",
		);
	});

	it("fails the review before any lens runs when a lens's band holds no level it can run at", async () => {
		await open();
		const { heavy: _, ...rest } = config.models;
		const floored = { ...config, models: rest, lenses: { correctness: { level: { floor: "careful" } } } } as const;

		const error = await review({ config: floored }).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "noAvailableModel", lenses: ["correctness"] });
		expect((error as Error).message).toBe(
			"lens correctness may run from careful to deep, and no level there can run: careful runs on heavy, and no model is configured for the heavy tier; set models.heavy.model in melian.yaml; deep runs on heavy, and no model is configured for the heavy tier; set models.heavy.model in melian.yaml. Route the tier in melian.local.yaml, log in with pi, or set the provider's API key",
		);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("fails the review when a careful-only lens declares no level within a deep floor", async () => {
		const decider = choosing("deep");
		await open(decider);
		const lens = lenses.find((each) => each.name === "correctness")!;
		const carefulOnly = Lens.from({ ...lens.toJSON(), levels: { careful: lens.levels.careful } });
		const floored = { ...config, lenses: { correctness: { level: { floor: "deep" } } } } as const;

		const error = await review({ decider, config: floored, lenses: [carefulOnly] }).catch(
			(caught: unknown) => caught,
		);

		expect(error).toMatchObject({ code: "noAvailableModel", lenses: ["correctness"] });
		expect((error as Error).message).toBe(
			"lens correctness may run from deep to deep, and no level there can run: it declares none of them, only careful. Route the tier in melian.local.yaml, log in with pi, or set the provider's API key",
		);
		expect(decider.requests).toHaveLength(0);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it.each([
		["quick", ["quick", "careful", "deep"]],
		["skip", ["skip", "quick", "careful", "deep"]],
	] as const)(
		"lets a policy floor of %s set on purpose beat the careful default of an untrusted head",
		async (floor, options) => {
			const decider = choosing("quick");
			await open(decider);
			scriptConversations(fake, [{ match: correctness, replies: [done] }]);
			const origin: ReviewOrigin = {
				kind: "pull-request",
				repository: { owner: "melian-agent", name: "melian" },
				pullRequest: 62,
				base: gitIn(repo, "rev-parse", "main"),
				head: gitIn(repo, "rev-parse", "feature"),
			};
			const set = { ...config, lenses: { correctness: { level: { floor } } } } as const;

			const pulled = await review({ decider, origin, config: set });

			expect(decider.requests[0]!.questions[0]!.options).toEqual(options);
			expect(lensRecord(pulled)).toMatchObject({ status: "ran", level: "quick" });
		},
	);

	it("skips a lens only above a floor of skip, and the skip is allowed", async () => {
		const decider = choosing("skip");
		await open(decider);
		const optional = { ...config, lenses: { correctness: { level: { floor: "skip" } } } } as const;

		const { verdict } = await review({ decider, config: optional });

		expect(fake.provider.state.callCount).toBe(0);
		expect(verdict.status).toBe("passed");
		expect(verdict.notRun).toContainEqual({
			name: "lens.correctness",
			status: "skipped",
			reason: "triage skipped it, as its floor allows",
		});
	});

	it("runs a lens at its runnable floor when triage chooses skip from a cut change prompt", async () => {
		writeFiles(repo, { "src/large.ts": `export const text = "${"x".repeat(210 * 1024)}";\n` });
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "a large change");
		const decider = choosing("skip");
		await open(decider);
		const sent = scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const optional = { ...config, lenses: { correctness: { level: { floor: "skip" } } } } as const;

		const reviewed = await review({ decider, config: optional });

		expect(decider.requests[0]!.state).toContain("[The diff continues; the remaining files are omitted.]");
		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "quick" });
		expect(lensRecord(reviewed)!.reason).toContain("triage input was cut, so no lens could skip");
		expect(sent[correctness]).toHaveLength(1);
		const stored = await readRecordedDecision(
			harness,
			(await harness.root(context)).id,
			revision(),
			"triage",
			context,
		);
		expect(stored).toMatchObject({ inputCut: true });
		expect(stored!.decision!.chosen("correctness")).toBe("skip");

		const repeated = await review({ decider, config: optional });
		expect(lensRecord(repeated)).toMatchObject({ status: "ran", level: "quick" });
		expect(decider.requests).toHaveLength(1);
		expect(sent[correctness]).toHaveLength(1);
	});

	it("removes a triage-skipped lens from another lens's hand-off instructions", async () => {
		const contracts = "You are the contracts reviewer";
		const twoLenses = {
			...config,
			tiers: { ...config.tiers, full: ["standard", "lens.contracts"] },
			lenses: { contracts: { level: { floor: "skip" } } },
		} as const;
		await open();
		const both = scriptConversations(fake, [
			{ match: correctness, replies: [done] },
			{ match: contracts, replies: [done] },
		]);

		await review({ config: twoLenses });

		expect(systemPromptOf(both[correctness]![0]!)).toContain("- `contracts`:");
		expect(both[contracts]).toHaveLength(1);
		const decider = new RecordedDecider({
			triage: {
				version: "1",
				answers: {
					correctness: { distribution: { careful: 1 } },
					contracts: { distribution: { skip: 1 } },
				},
			},
		});
		await open(decider);
		const skipped = scriptConversations(fake, [
			{ match: correctness, replies: [done] },
			{ match: contracts, replies: [done] },
		]);

		const reviewed = await review({ decider, config: twoLenses });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		expect(reviewed.verdict.notRun).toContainEqual({
			name: "lens.contracts",
			status: "skipped",
			reason: "triage skipped it, as its floor allows",
		});
		expect(skipped[correctness]).toHaveLength(1);
		expect(skipped[contracts]).toHaveLength(0);
		expect(systemPromptOf(skipped[correctness]![0]!)).not.toContain("contracts");
	});

	it("reads each lens's band from the policy's configuration for every file it reviews", async () => {
		writeFiles(repo, { "src/melian.yaml": lines("lenses:", "  correctness:", "    level: { floor: deep }") });
		await open();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		expect(lensRecord(await review({ policy: "worktree" }))).toMatchObject({ status: "ran", level: "deep" });
	});

	it("combines the bands of two folders a lens reviews, the floor winning where they cross", async () => {
		writeFiles(repo, {
			"src/melian.yaml": lines("lenses:", "  correctness:", "    level: { floor: careful }"),
			"services/melian.yaml": lines("lenses:", "  correctness:", "    level: { ceiling: quick }"),
			"services/pay.ts": lines("export const pay = 1;"),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "a payments service");
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await review({ decider, policy: "worktree" });

		expect(decider.requests[0]!.questions[0]!.options).toEqual(["careful"]);
		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
	});

	it("judges each folder variant on its own level's model, and asks one question for both", async () => {
		writeFiles(repo, {
			"services/.melian/lenses/correctness/LENS.md": lines(
				"---",
				"name: correctness",
				"extends: correctness",
				"---",
				"Check the payments too.",
			),
			"services/pay.ts": lines("export const pay = 1;"),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "a payments service");
		writeFiles(repo, { "services/melian.yaml": lines("lenses:", "  correctness:", "    level: { floor: deep }") });
		const variants = await Lens.load(repo, { kind: "worktree" }, ["src/user.ts", "services/pay.ts"]);
		const medium = `${fake.ref("medium").provider}/medium`;
		const heavy = `${fake.ref("heavy").provider}/heavy`;
		const models: MelianConfig["models"] = {
			medium: { model: medium, accept: [medium], acceptOverridden: false },
			heavy: { model: heavy, accept: [heavy], acceptOverridden: false },
		};
		const planned = { ...config, models };
		const { catalog, credentials } = await planInputs(fake.review);
		const plan = ReviewPlan.resolve({
			config: planned,
			routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
			catalog,
			credentials,
			lenses: variants,
			checks: ["lens.correctness"],
		});
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);

		const reviewed = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: planned,
			lenses: variants,
			standards: [],
			models: fake.review,
			checks: ran,
			policy: { kind: "worktree" },
			decider,
			plan,
		});

		const [request] = decider.requests;
		expect(request!.questions.map((question) => [question.id, question.options])).toEqual([
			["correctness", ["quick", "careful", "deep"]],
		]);
		const levels = (reviewed.verdict.ran ?? [])
			.filter((check) => check.name === "lens.correctness")
			.map((check) => check.level)
			.sort();
		expect(levels).toEqual(["deep", "quick"]);
		expect(reviewed.verdict.status).toBe("passed");
		expect(
			reviewed.verdict.ran?.filter((check) => check.name === "lens.correctness").map((check) => check.lineage),
		).toEqual([undefined, undefined]);
	});

	it("includes options only the later folder variant contributes to the shared question", async () => {
		writeFiles(repo, {
			"services/.melian/lenses/correctness/LENS.md": lines(
				"---",
				"name: correctness",
				"extends: correctness",
				"---",
				"Check the payments too.",
			),
			"services/pay.ts": lines("export const pay = 1;"),
		});
		gitIn(repo, "add", "--all");
		gitIn(repo, "commit", "--quiet", "-m", "a payments service");
		writeFiles(repo, {
			"src/melian.yaml": lines("lenses:", "  correctness:", "    level: { floor: careful, ceiling: careful }"),
			"services/melian.yaml": lines("lenses:", "  correctness:", "    level: { floor: deep, ceiling: deep }"),
		});
		const variants = (await Lens.load(repo, { kind: "worktree" }, ["src/user.ts", "services/pay.ts"]))
			.filter((lens) => lens.name === "correctness")
			.sort((a, b) => a.scope.localeCompare(b.scope));
		expect(variants.map((lens) => lens.scope)).toEqual(["", "services"]);
		const decider = choosing("deep");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);

		const reviewed = await review({ decider, policy: "worktree", lenses: variants });

		expect(decider.requests[0]!.questions.map((question) => [question.id, question.options])).toEqual([
			["correctness", ["careful", "deep"]],
		]);
		expect(
			reviewed.verdict.ran?.filter((check) => check.name === "lens.correctness").map((check) => check.level),
		).toEqual(["careful", "deep"]);
	});

	it("records a decision that failed, and runs every lens at its default level with a note", async () => {
		const decider = new RecordedDecider({});
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(reviewed)!.reason).toBe(
			"triage failed, so it ran at its default level: no answer to correctness in triage is recorded",
		);
		const stored = await readRecordedDecision(
			harness,
			(await harness.root(context)).id,
			revision(),
			"triage",
			context,
		);
		expect(stored).toMatchObject({ failure: "no answer to correctness in triage is recorded" });
		expect(stored!.decision).toBeUndefined();
	});

	it("fails closed when the harness holds another decider than the one the decision names", async () => {
		const installed = choosing("quick", "installed");
		const asked = choosing("quick", "asked");
		await open(installed);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await review({ decider: asked });

		expect(installed.requests).toHaveLength(0);
		expect(asked.requests).toHaveLength(0);
		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		const stored = await readRecordedDecision(
			harness,
			(await harness.root(context)).id,
			revision(),
			"triage",
			context,
		);
		expect(stored!.decision).toBeUndefined();
		expect(stored!.failure).toBeUndefined();
		expect(lensRecord(reviewed)!.reason).toContain("the decision task ended aborted");
	});

	describe("attaching to a stored decision", () => {
		// Fails its first `failures` calls, then chooses quick.
		function flaky(failures: number): Decider & { readonly calls: number } {
			let calls = 0;
			return {
				name: "flaky",
				calibrated: false,
				get calls() {
					return calls;
				},
				decide: async (request) => {
					calls++;
					if (calls <= failures) throw new Error("503 overloaded_error");
					return {
						answers: request.questions.map((question) => ({ question: question.id, distribution: { quick: 1 } })),
					};
				},
			};
		}

		it("keeps a failed decision on a repeat review, and asks again with rerun", async () => {
			const decider = flaky(1);
			await open(decider);
			scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);
			expect(lensRecord(await review({ decider }))!.reason).toContain("triage failed");
			const repeat = await review({ decider });
			expect(decider.calls).toBe(1);
			expect(lensRecord(repeat)).toMatchObject({
				level: "careful",
				reason: expect.stringContaining("triage failed"),
			});

			const rerun = await review({ decider, rerun: true });

			expect(decider.calls).toBe(2);
			expect(lensRecord(rerun)).toMatchObject({ level: "quick" });
		});

		it("never asks again after a decision that completed, even with rerun", async () => {
			const decider = flaky(0);
			await open(decider);
			scriptConversations(fake, [{ match: correctness, replies: [done] }]);
			await review({ decider });
			await review({ decider, rerun: true });
			expect(decider.calls).toBe(1);
		});

		it("asks a changed question again rather than attach", async () => {
			const decider = flaky(0);
			await open(decider);
			scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);
			await review({ decider });
			const floored = { ...config, lenses: { correctness: { level: { floor: "careful" } } } } as const;
			const changed = await review({ decider, config: floored });
			expect(decider.calls).toBe(2);
			// quick is no longer offered, so the answer fails closed to careful.
			expect(lensRecord(changed)).toMatchObject({
				level: "careful",
				reason: expect.stringContaining("triage failed"),
			});
		});
	});

	it("stores at most 200 characters of a decider's failure", async () => {
		const decider: Decider = {
			name: "verbose",
			calibrated: false,
			decide: async () => {
				throw new Error(`model said: ${"x".repeat(500)}`);
			},
		};
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		await review({ decider });
		const stored = await readRecordedDecision(
			harness,
			(await harness.root(context)).id,
			revision(),
			"triage",
			context,
		);
		expect(stored!.failure).toHaveLength(200);
		expect(stored!.failure).toMatch(/…$/);
	});

	it("keeps the triage note on the record of a lens that did not finish, after the reason it did not", async () => {
		const decider = new RecordedDecider({});
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [] }]);
		const error = await review({ decider }).catch((caught: unknown) => caught);
		const record = (error as ReviewError).verdict!.notRun.find((check) => check.name === "lens.correctness");
		expect(record!.reason).toBe(
			"the lens did not finish; triage failed, so it ran at its default level: no answer to correctness in triage is recorded",
		);
	});

	it("refuses a decider the harness was not opened with", async () => {
		await open();
		await expect(review({ decider: choosing("quick") })).rejects.toMatchObject({ code: "notInstalled" });
	});
});

describe("a decider that never answers", () => {
	it("fails closed at the decision timeout, and every lens runs at its default level", async () => {
		await reviewHarness?.close(context);
		reviewHarness = undefined;
		const registry = createReviewRegistry();
		let keepAlive: NodeJS.Timeout | undefined;
		registry.install(
			decisionExtension(
				{
					name: "silent",
					calibrated: false,
					decide: () =>
						new Promise<never>(() => {
							keepAlive = setInterval(() => {}, 60_000);
						}),
				},
				50,
			),
		);
		harness = await openHarness(createMemoryStorage(), {
			models: fake.models,
			registry,
			settings: { retry: { enabled: false } },
		});
		await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		try {
			const reviewed = await review({
				decider: { name: "silent", calibrated: false, decide: async () => ({ answers: [] }) },
			});

			expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
			expect(lensRecord(reviewed)!.reason).toContain("triage failed, so it ran at its default level");
		} finally {
			clearInterval(keepAlive);
			await harness.close(context);
		}
	});
});

describe("a decision task another call replaced", () => {
	// A decider that holds its first call until `release`, or until its signal aborts when `heeding`; later calls choose quick.
	function holding(heeding: boolean) {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const decider: Decider = {
			name: "holding",
			calibrated: false,
			decide: async (request, signal) => {
				calls++;
				if (calls === 1) {
					await new Promise<void>((resolve, reject) => {
						gate.then(resolve);
						if (heeding) signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
					});
				}
				return {
					answers: request.questions.map((question) => ({ question: question.id, distribution: { quick: 1 } })),
				};
			},
		};
		return { decider, release, calls: () => calls };
	}

	const decisionTasks = async () =>
		(await harness.inspect(context)).tasks.filter((task) => task.record.kind === "melian.decision");

	it("aborts a pending decision task that a rerun replaces", async () => {
		const held = holding(true);
		await open(held.decider);
		scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);
		const first = review({ decider: held.decider });
		await vi.waitFor(() => expect(held.calls()).toBe(1));
		const [pending] = await decisionTasks();

		const rerun = await review({ decider: held.decider, rerun: true });
		await expect(first).rejects.toMatchObject({ code: "superseded" });

		expect(lensRecord(rerun)).toMatchObject({ level: "quick" });
		const settled = await harness.waitForTask(pending!.record.id, context);
		expect(settled.state.outcome.status).toBe("aborted");
	});

	it("writes nothing from a decision task the document no longer names", async () => {
		const held = holding(false);
		await open(held.decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const first = review({ decider: held.decider });
		await vi.waitFor(() => expect(held.calls()).toBe(1));
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			const document = await tx.doc(DecisionDocument, root.id);
			const entry = document.decisions[revision()]!.triage!;
			document.decisions = { ...document.decisions, [revision()]: { triage: { ...entry, task: 999_999 } } };
		}, context);

		held.release();
		const reviewed = await first;

		expect(lensRecord(reviewed)).toMatchObject({ level: "careful" });
		expect(lensRecord(reviewed)!.reason).toContain("the decision task ended superseded");
		const stored = await readRecordedDecision(harness, root.id, revision(), "triage", context);
		expect(stored).toMatchObject({ task: 999_999 });
		expect(stored!.decision).toBeUndefined();
	});

	it("asks again on rerun after a crash left the decision undecided", async () => {
		const held = holding(true);
		await open(held.decider);
		scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);
		void review({ decider: held.decider }).catch(() => undefined);
		await vi.waitFor(() => expect(held.calls()).toBe(1));

		const rerun = await review({ decider: held.decider, rerun: true });

		expect(held.calls()).toBe(2);
		expect(lensRecord(rerun)).toMatchObject({ level: "quick" });
	});
});

describe("decision task cancellation", () => {
	it("forwards a mid-decision task abort to the decider's signal", async () => {
		let received: AbortSignal | undefined;
		let observedAbort = false;
		const decide = vi.fn((_request: Parameters<Decider["decide"]>[0], signal: AbortSignal | undefined) => {
			received = signal;
			return new Promise<never>((_, reject) => {
				signal?.addEventListener(
					"abort",
					() => {
						observedAbort = true;
						reject(signal.reason);
					},
					{ once: true },
				);
			});
		});
		const decider: Decider = { name: "cancellable", calibrated: false, decide };
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const reviewing = review({ decider });
		await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
		expect(received?.aborted).toBe(false);
		const root = await harness.root(context);
		const pending = await readRecordedDecision(harness, root.id, revision(), "triage", context);

		await harness.abortTask(pending!.task as TaskId, context);
		const reviewed = await reviewing;

		expect(observedAbort).toBe(true);
		expect(received?.aborted).toBe(true);
		expect((await harness.waitForTask(pending!.task as TaskId, context)).state.outcome.status).toBe("aborted");
		expect(await readRecordedDecision(harness, root.id, revision(), "triage", context)).toEqual({
			task: pending!.task,
		});
		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(reviewed)!.reason).toContain("the decision task ended aborted");
	});
});

describe("a decision resumed with another decider", () => {
	it("leaves no answer and asks the original decider after another reopen", async () => {
		const dir = mkdtempSync(join(tmpdir(), "melian-triage-decider-"));
		const path = join(dir, "review.sqlite");
		const original = choosing("quick", "original");
		const other = choosing("deep", "other");
		const parked = vi.fn(
			(_request: Parameters<Decider["decide"]>[0], signal: AbortSignal | undefined) =>
				new Promise<never>((_, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const reopen = async (decider: Decider) => {
			await reviewHarness?.close(context);
			reviewHarness = await ReviewHarness.open(await openSqliteStorage(path), fake.review, {
				retry: false,
				decider,
			});
			harness = reviewHarness.harness;
			await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
		};
		try {
			const waiting: Decider = { name: original.name, calibrated: false, decide: parked };
			await reopen(waiting);
			const interrupted = review({ decider: waiting }).catch(() => undefined);
			await vi.waitFor(() => expect(parked).toHaveBeenCalledOnce());
			const pending = await readRecordedDecision(
				harness,
				(await harness.root(context)).id,
				revision(),
				"triage",
				context,
			);
			await reopen(other);
			await interrupted;
			scriptConversations(fake, [{ match: correctness, replies: [done, done] }]);

			const mismatched = await review({ decider: original });

			expect(other.requests).toHaveLength(0);
			expect(original.requests).toHaveLength(0);
			expect(lensRecord(mismatched)).toMatchObject({ status: "ran", level: "careful" });
			const stored = await readRecordedDecision(
				harness,
				(await harness.root(context)).id,
				revision(),
				"triage",
				context,
			);
			expect(stored).toEqual({ task: pending!.task });
			expect((await harness.waitForTask(pending!.task as TaskId, context)).state.outcome.status).toBe("aborted");

			await reopen(original);
			const triaged = await review({ decider: original });

			expect(original.requests).toHaveLength(1);
			expect(other.requests).toHaveLength(0);
			expect(lensRecord(triaged)).toMatchObject({ status: "ran", level: "quick" });
		} finally {
			await reviewHarness?.close(context);
			reviewHarness = undefined;
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("triage under a review plan", () => {
	// heavy, careful's and deep's tier, fails: its only accepted model has no credentials. medium, quick's, is routed.
	async function refusingHeavy() {
		const medium = `${fake.ref("medium").provider}/medium`;
		const models: MelianConfig["models"] = {
			medium: { model: medium },
			heavy: { accept: ["nowhere/opus"], unavailable: "fail" },
		};
		const planned = { ...config, models };
		const { catalog, credentials } = await planInputs(fake.review);
		const plan = ReviewPlan.resolve({
			config: planned,
			routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
			catalog,
			credentials,
			lenses,
			checks: ["lens.correctness"],
		});
		return { planned, plan };
	}

	async function reviewUnder(decider: Decider, planned: MelianConfig, plan: ReviewPlan): Promise<Review> {
		return reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: planned,
			lenses,
			standards: [],
			models: fake.review,
			checks: ran,
			decider,
			plan,
		});
	}

	it("records a lens triaged to a level whose tier the plan refuses as failed, with the plan's reason", async () => {
		const decider = choosing("careful");
		await open(decider);
		const { planned, plan } = await refusingHeavy();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await reviewUnder(decider, planned, plan);

		expect(fake.provider.state.callCount).toBe(0);
		expect(lensRecord(reviewed)).toMatchObject({
			name: "lens.correctness",
			status: "failed",
			level: "careful",
			reason: plan.refusal("heavy"),
		});
		expect(reviewed.verdict.status).toBe("not-reviewed");
		// The refusal is the lens's one record, never "no lens is named".
		const records = [...(reviewed.verdict.ran ?? []), ...reviewed.verdict.notRun].filter(
			(check) => check.name === "lens.correctness",
		);
		expect(records).toHaveLength(1);
	});

	it("runs a lens triaged to a level whose tier the plan routes, though its careful tier is refused", async () => {
		const decider = choosing("quick");
		await open(decider);
		const { planned, plan } = await refusingHeavy();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await reviewUnder(decider, planned, plan);

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "quick" });
		expect(reviewed.verdict.status).toBe("passed");
		// The verdict's provenance holds both the run that stands for the lens, at its level, and the plan it ran under.
		const provenance = await readProvenance(harness, (await harness.root(context)).id, revision(), context);
		expect(provenance!.lenses).toEqual([`correctness@${version()}@quick`]);
		expect(provenance!.plan).toEqual(plan.toJSON());
		// Its escalation to careful would be refused, so the run is keyed as capped by the plan.
		const index = await harness.snapshot(ReviewIndex, (await harness.root(context)).id, context);
		expect(index!.reviews[revision()]!.lenses[0]).toContain(
			`capped since the plan refuses careful: ${plan.refusal("heavy")}`,
		);
	});
});

describe("escalation under a review plan", () => {
	const severe = call("report_finding", crashFinding);

	it("judges the escalated run's record on the model it finished on, and asks the plan about that run", async () => {
		const decider = choosing("quick");
		await open(decider);
		const medium = `${fake.ref("medium").provider}/medium`;
		const heavy = `${fake.ref("heavy").provider}/heavy`;
		const models: MelianConfig["models"] = {
			medium: { model: medium },
			heavy: { model: heavy, accept: [heavy], acceptOverridden: false },
		};
		const planned = { ...config, models };
		const { catalog, credentials } = await planInputs(fake.review);
		const plan = ReviewPlan.resolve({
			config: planned,
			routes: {
				committed: { ...models, heavy: { ...models.heavy, model: medium } },
				overridden: { heavy: "melian.local.yaml" },
				lensTiers: {},
				retiered: {},
			},
			catalog,
			credentials,
			lenses,
			checks: ["lens.correctness"],
		});
		const mark = vi.spyOn(plan, "mark");
		const judge = vi.spyOn(plan, "judge");
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, done] }]);

		const reviewed = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: planned,
			lenses,
			standards: [],
			models: fake.review,
			checks: ran,
			decider,
			plan,
		});

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(reviewed)!.reason).toContain("escalated from quick to careful");
		const root = await harness.root(context);
		const details = (await harness.snapshot(VerdictDocument, root.id, context))!.details![revision()]!;
		expect(details.lenses).toEqual([
			{
				name: "correctness",
				version: version(),
				level: "careful",
				models: [heavy],
				ran: heavy,
				lineage: describeLineage(lensRecord(reviewed)!.lineage!),
				usage: expect.objectContaining({ models: [heavy], tokens: expect.any(Number), cost: expect.any(Number) }),
				budget: expect.objectContaining({ findings: expect.any(Number) }),
			},
		]);
		// The map the plan marks from holds the careful run's model, not the quick run's.
		const marked = mark.mock.calls.at(-1)![1]!;
		expect(marked.get("correctness")).toEqual([{ scope: "", level: "careful", model: heavy }]);
		// The refusal callback asked about the escalated run on the model it finished on.
		expect(judge.mock.calls).toContainEqual(["correctness", "careful", heavy, ""]);
	});

	it("fails the escalated run's record when it finished on a model the plan refuses", async () => {
		const decider = choosing("quick");
		await open(decider);
		const medium = `${fake.ref("medium").provider}/medium`;
		const heavy = `${fake.ref("heavy").provider}/heavy`;
		const models: MelianConfig["models"] = {
			medium: { model: medium },
			heavy: { model: heavy, accept: [heavy], acceptOverridden: false },
		};
		const planned = { ...config, models };
		const { catalog, credentials } = await planInputs(fake.review);
		const plan = ReviewPlan.resolve({
			config: planned,
			routes: { committed: models, overridden: {}, lensTiers: {}, retiered: {} },
			catalog,
			credentials,
			lenses,
			checks: ["lens.correctness"],
		});
		// The run finishes on heavy, which the plan, as it judges the finished run, now refuses.
		const original = ReviewPlan.from(plan.toJSON());
		vi.spyOn(plan, "judge").mockImplementation((name, level, ran, scope) =>
			ran === heavy && level === "careful"
				? { refusal: "careful finished on a model policy refuses" }
				: original.judge(name, level, ran, scope),
		);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, done] }]);

		const reviewed = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: planned,
			lenses,
			standards: [],
			models: fake.review,
			checks: ran,
			decider,
			plan,
		});

		expect(lensRecord(reviewed)).toMatchObject({
			status: "failed",
			level: "careful",
			reason: "careful finished on a model policy refuses",
		});
	});
});

describe("escalation", () => {
	const severe = call("report_finding", crashFinding);

	it("runs a lens again at the next level, in its own conversation, when at quick it reports at or above escalateAt", async () => {
		const decider = choosing("quick");
		await open(decider);
		const requests = scriptConversations(fake, [{ match: correctness, replies: [severe, done, done] }]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "careful",
			reason:
				"escalated from quick to careful: at quick it reported a P1 finding, at or above P1; 1 finding quick carried at or above P1, which careful neither restated nor refuted, still counts as quick reported it",
		});
		// The careful run starts afresh on the change, at careful's budget, with the quick run's finding to check.
		const careful = requests[correctness]![2]!;
		expect(systemPromptOf(careful)).toContain(statedBudget.careful);
		expect(careful.filter((message) => message.role === "assistant")).toEqual([]);
		const input = textOf(careful.find((message) => message.role === "user")!);
		expect(input).toMatch(/^Review the change from/);
		expect(input).toContain("## Findings a quicker look reported");
		expect(input).toMatch(
			/<untrusted-[0-9a-f]{24} label="findings">\n[0-9a-f]{16} P1 null-dereference at src\/user\.ts:7-7: /,
		);
		// Each level is its own conversation and its own request, so the rerun's input is not deduplicated.
		const sent = await lensRequests();
		const quick = sent.get(`lens:correctness@${version()}@quick:0`);
		const rerun = sent.get(`lens:correctness@${version()}@careful:0`);
		expect(quick).toMatchObject({ level: "quick" });
		expect(rerun).toMatchObject({ level: "careful" });
		expect(rerun!.conversation).not.toBe(quick!.conversation);
		// The quick P1 the careful run left unanswered still blocks, attributed to the quick run.
		expect(reviewed.verdict).toMatchObject({ status: "findings", blocking: true });
		expect(reviewed.findings.map((finding) => finding.properties.source)).toEqual([
			{ check: "lens.correctness", version: `${version()}@quick` },
		]);
		const root = (await harness.root(context)).id;
		const index = await harness.snapshot(ReviewIndex, root, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@quick band quick-deep escalateAt P1 escalates to correctness@${version()}@careful (faux/heavy) on faux/medium`,
		]);
		expect((await readProvenance(harness, root, revision(), context))!.lenses).toEqual([
			`correctness@${version()}@careful`,
		]);
	});

	it("counts a quick finding the escalated run restates once, with the escalated run speaking for it", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, severe, done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings.map((finding) => finding.properties.source)).toEqual([
			{ check: "lens.correctness", version: `${version()}@careful` },
		]);
		expect(reviewed.findings[0]!.properties.reportedBy).toEqual([
			{ check: "lens.correctness", version: `${version()}@careful` },
		]);
		expect(lensRecord(reviewed)!.reason).toBe(
			"escalated from quick to careful: at quick it reported a P1 finding, at or above P1; careful restated 1 finding quick carried",
		);
	});

	it("drops a quick finding the escalated run refutes by its ID, whatever lines the refutation names", async () => {
		const decider = choosing("quick");
		await open(decider);
		// The quick run reports lines 6 to 7; the careful run refutes it by the ID it was given, naming line 7 alone.
		const spanning = call("report_finding", { ...crashFinding, line: 6, endLine: 7 });
		const refute = (messages: readonly Message[]) =>
			call("report_finding", {
				...crashFinding,
				refuted: carriedId(messages),
				failureScenario: "Every caller passes a user whose manager is set, so the dereference cannot fail.",
			});
		const requests = scriptConversations(fake, [{ match: correctness, replies: [spanning, done, refute, done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings).toEqual([]);
		expect(reviewed.verdict.status).toBe("passed");
		expect(lensRecord(reviewed)!.reason).toBe(
			"escalated from quick to careful: at quick it reported a P1 finding, at or above P1; careful refuted 1 finding quick carried",
		);
		const results = requests[correctness]![3]!.filter((message) => message.role === "toolResult").map(textOf);
		expect(results.at(-1)).toMatch(/^recorded that finding [0-9a-f]{16} is not a defect$/);
	});

	it("carries only the quick findings at or above escalateAt, and drops the rest", async () => {
		const decider = choosing("quick");
		await open(decider);
		const mild = { ...crashFinding, line: 6, rule: "wrong-result", severity: "P2" };
		const both = fauxAssistantMessage(
			[fauxToolCall("report_finding", crashFinding), fauxToolCall("report_finding", mild)],
			{ stopReason: "toolUse" },
		);
		const requests = scriptConversations(fake, [{ match: correctness, replies: [both, done, done] }]);

		const reviewed = await review({ decider });

		const input = textOf(requests[correctness]![2]!.find((message) => message.role === "user")!);
		expect(input).toContain("P1 null-dereference at src/user.ts:7-7");
		expect(input).not.toContain("wrong-result");
		expect(reviewed.findings.map((finding) => [finding.ruleId, finding.properties.source.version])).toEqual([
			["null-dereference", `${version()}@quick`],
		]);
		expect(lensRecord(reviewed)!.reason).toContain("1 finding quick carried at or above P1");
	});

	it("keeps a quick finding when the escalated run reports another rule at the same lines", async () => {
		const decider = choosing("quick");
		await open(decider);
		const other = call("report_finding", { ...crashFinding, rule: "wrong-result" });
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, other, done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings.map((finding) => finding.ruleId).sort()).toEqual(["null-dereference", "wrong-result"]);
		expect(lensRecord(reviewed)!.reason).toContain(
			"1 finding quick carried at or above P1, which careful neither restated nor refuted, still counts as quick reported it",
		);
	});

	it("keeps a quick finding when the escalated run reports the same rule at lines that do not overlap", async () => {
		const decider = choosing("quick");
		await open(decider);
		const apart = call("report_finding", {
			...crashFinding,
			line: 1,
			evidence: [{ file: "src/user.ts", line: 1, role: "cause" }],
		});
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, apart, done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings.map((finding) => finding.ruleId)).toEqual(["null-dereference", "null-dereference"]);
		expect(lensRecord(reviewed)!.reason).toContain(
			"1 finding quick carried at or above P1, which careful neither restated nor refuted, still counts as quick reported it",
		);
	});

	it("ignores a refutation naming an ID the quick run did not carry", async () => {
		const decider = choosing("quick");
		await open(decider);
		const stranger = () =>
			call("report_finding", {
				...crashFinding,
				refuted: "0123456789abcdef",
				failureScenario: "Every caller passes a user whose manager is set, so the dereference cannot fail.",
			});
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, stranger(), done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings.map((finding) => finding.properties.source)).toEqual([
			{ check: "lens.correctness", version: `${version()}@quick` },
		]);
		expect(lensRecord(reviewed)!.reason).not.toContain("careful refuted");
		expect(lensRecord(reviewed)!.reason).toContain(
			"1 finding quick carried at or above P1, which careful neither restated nor refuted, still counts as quick reported it",
		);
	});

	it("ignores a refutation of an ID the escalated run also restated", async () => {
		const decider = choosing("quick");
		await open(decider);
		const both = (messages: readonly Message[]) =>
			fauxAssistantMessage(
				[
					fauxToolCall("report_finding", crashFinding),
					fauxToolCall("report_finding", {
						...crashFinding,
						refuted: carriedId(messages),
						failureScenario: "Every caller passes a user whose manager is set, so the dereference cannot fail.",
					}),
				],
				{ stopReason: "toolUse" },
			);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done, both, done] }]);

		const reviewed = await review({ decider });

		expect(reviewed.findings).toHaveLength(1);
		expect(lensRecord(reviewed)!.reason).toContain("careful restated 1 finding quick carried");
		expect(lensRecord(reviewed)!.reason).not.toContain("careful refuted");
	});

	it("takes a refutation from an escalated run whose findings budget is spent", async () => {
		const decider = choosing("quick");
		await open(decider);
		const tight = lenses.map((lens) => {
			if (lens.name !== "correctness") return lens;
			const settings = lens.level("careful");
			return Lens.from({
				...lens.toJSON(),
				levels: { ...lens.levels, careful: { ...settings, budget: { ...settings.budget, findings: 1 } } },
			});
		});
		const other = call("report_finding", { ...crashFinding, line: 6, rule: "wrong-result" });
		const refute = (messages: readonly Message[]) =>
			call("report_finding", {
				...crashFinding,
				refuted: carriedId(messages),
				failureScenario: "Every caller passes a user whose manager is set, so the dereference cannot fail.",
			});
		const requests = scriptConversations(fake, [
			{ match: correctness, replies: [severe, done, other, refute, done] },
		]);

		const reviewed = await review({ decider, lenses: tight });

		const results = requests[correctness]![4]!.filter((message) => message.role === "toolResult").map(textOf);
		expect(results.at(-1)).toMatch(/^recorded that finding [0-9a-f]{16} is not a defect$/);
		expect(reviewed.findings.map((finding) => finding.ruleId)).toEqual(["wrong-result"]);
	});

	it("counts once a quick finding the escalated run restates at other lines of the same defect", async () => {
		const decider = choosing("quick");
		await open(decider);
		const spanning = call("report_finding", { ...crashFinding, line: 6, endLine: 7 });
		const requests = scriptConversations(fake, [{ match: correctness, replies: [spanning, done, severe, done] }]);

		const reviewed = await review({ decider });

		const input = textOf(requests[correctness]![2]!.find((message) => message.role === "user")!);
		expect(input).toMatch(/[0-9a-f]{16} P1 null-dereference at src\/user\.ts:6-7: /);
		expect(reviewed.findings.map((finding) => finding.properties.source)).toEqual([
			{ check: "lens.correctness", version: `${version()}@careful` },
		]);
		expect(lensRecord(reviewed)!.reason).toContain("careful restated 1 finding quick carried");
	});

	it("keeps a quick finding when the escalated run reports the same rule at overlapping lines in another file", async () => {
		writeFiles(repo, { "src/other.ts": `${gitIn(repo, "show", "feature:src/user.ts")}\n` });
		gitIn(repo, "add", "src/other.ts");
		gitIn(repo, "commit", "-qm", "add another user file");
		const decider = choosing("quick");
		await open(decider);
		const spanning = call("report_finding", { ...crashFinding, line: 6, endLine: 7 });
		const other = call("report_finding", {
			...crashFinding,
			file: "src/other.ts",
			evidence: [{ file: "src/other.ts", line: 7, role: "cause" }],
		});
		scriptConversations(fake, [{ match: correctness, replies: [spanning, done, other, done] }]);

		const reviewed = await review({ decider });

		expect(
			reviewed.findings.map((finding) => ({
				path: finding.properties.path,
				rule: finding.ruleId,
				line: finding.lines()[0],
				endLine: finding.lines()[1],
				source: finding.properties.source,
			})),
		).toEqual(
			expect.arrayContaining([
				{
					path: "src/user.ts",
					rule: "null-dereference",
					line: 6,
					endLine: 7,
					source: { check: "lens.correctness", version: `${version()}@quick` },
				},
				{
					path: "src/other.ts",
					rule: "null-dereference",
					line: 7,
					endLine: 7,
					source: { check: "lens.correctness", version: `${version()}@careful` },
				},
			]),
		);
		expect(reviewed.findings).toHaveLength(2);
		expect(reviewed.verdict.all()).toHaveLength(2);
		expect(lensRecord(reviewed)!.reason).toContain("1 finding quick carried at or above P1");
		expect(lensRecord(reviewed)!.reason).not.toContain("careful restated");
	});

	it("runs a lens again when a budget ended it at quick before it reported anything", async () => {
		const decider = choosing("quick");
		await open(decider);
		const tight = lenses.map((lens) => {
			if (lens.name !== "correctness") return lens;
			const settings = lens.level("quick");
			return Lens.from({
				...lens.toJSON(),
				levels: { ...lens.levels, quick: { ...settings, budget: { ...settings.budget, tools: 1 } } },
			});
		});
		const reads = fauxAssistantMessage(
			[
				fauxToolCall("read_file", { path: "src/user.ts" }),
				fauxToolCall("read_file", { path: "src/user.ts", startLine: 5 }),
			],
			{ stopReason: "toolUse" },
		);
		scriptConversations(fake, [{ match: correctness, replies: [reads, done, done] }]);

		const reviewed = await review({ decider, lenses: tight });

		expect(lensRecord(reviewed)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "careful",
			reason: "escalated from quick to careful: at quick its tools budget ended it before it reported anything",
		});
		expect(reviewed.verdict.status).toBe("passed");
	});

	it("leaves a lens a budget ended at quick ended when its ceiling is quick", async () => {
		const decider = choosing("quick");
		await open(decider);
		const tight = lenses.map((lens) => {
			if (lens.name !== "correctness") return lens;
			const settings = lens.level("quick");
			return Lens.from({
				...lens.toJSON(),
				levels: { ...lens.levels, quick: { ...settings, budget: { ...settings.budget, tools: 1 } } },
			});
		});
		const reads = fauxAssistantMessage(
			[
				fauxToolCall("read_file", { path: "src/user.ts" }),
				fauxToolCall("read_file", { path: "src/user.ts", startLine: 5 }),
			],
			{ stopReason: "toolUse" },
		);
		scriptConversations(fake, [{ match: correctness, replies: [reads, done] }]);
		const capped = { ...config, lenses: { correctness: { level: { ceiling: "quick" } } } } as const;

		const reviewed = await review({ decider, lenses: tight, config: capped });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ended", level: "quick" });
		expect(reviewed.verdict.status).toBe("not-reviewed");
		// The note goes on the ended record too, and renders after the budget's description, never in its place.
		const capping =
			"escalation capped at quick, its ceiling: at quick its tools budget ended it before it reported anything";
		expect(lensRecord(reviewed)!.reason).toBe(`${capping}; ${lightly}`);
		expect(reviewed.verdict.render(new Rendering())).toMatch(
			new RegExp(`lens\\.correctness {2}ended at quick: its tool call budget of 1 ran out .*; ${capping}`),
		);
	});

	it("reports a severe quick finding with a note when the ceiling caps the escalation", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done] }]);
		const capped = { ...config, lenses: { correctness: { level: { ceiling: "quick" } } } } as const;

		const reviewed = await review({ decider, config: capped });

		expect(lensRecord(reviewed)).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "quick",
			reason: `escalation capped at quick, its ceiling: at quick it reported a P1 finding, at or above P1; ${lightly}`,
		});
		expect(reviewed.findings.map((finding) => finding.ruleId)).toEqual(["null-dereference"]);
	});

	it("leaves the whole-review note off every lens when only some stay at quick", async () => {
		const decider = new RecordedDecider({
			triage: {
				version: "1",
				answers: {
					correctness: { distribution: { quick: 1 } },
					contracts: { distribution: { careful: 1 } },
				},
			},
		});
		await open(decider);
		const both = { ...config, tiers: { ...config.tiers, full: ["standard", "lens.contracts"] } };
		scriptConversations(fake, [
			{ match: correctness, replies: [done] },
			{ match: "You are the contracts reviewer", replies: [done] },
		]);

		const reviewed = await review({ decider, config: both });

		const records = (reviewed.verdict.ran ?? []).filter((check) => check.name.startsWith("lens."));
		expect(records.map((check) => [check.name, check.level]).sort()).toEqual([
			["lens.contracts", "careful"],
			["lens.correctness", "quick"],
		]);
		expect(records.map((check) => check.reason ?? "")).not.toContain(lightly);
		expect(JSON.stringify(records)).not.toContain("looked lightly");
	});

	it("fails the review when a lens's default level has no model, rather than run it at a lighter one", async () => {
		const decider = choosing("quick");
		await open(decider);
		const { heavy: _, ...rest } = config.models;

		const error = await review({ decider, config: { ...config, models: rest } }).catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "noAvailableModel", lenses: ["correctness"] });
		expect((error as Error).message).toContain(
			"its default level, careful, runs on heavy, and no model is configured for the heavy tier",
		);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("does not escalate a quick finding below escalateAt, and does at a lower escalateAt", async () => {
		const mild = call("report_finding", { ...crashFinding, severity: "P2" });
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [mild, done] }]);
		expect(lensRecord(await review({ decider }))).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "quick",
			reason: lightly,
		});

		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [mild, done, done] }]);
		const lower = { ...config, triage: { escalateAt: "P2" } } as const;
		expect(lensRecord(await review({ decider, config: lower }))).toMatchObject({ status: "ran", level: "careful" });
	});

	it("runs the lenses again, rather than attach, when the severity that escalates them changes", async () => {
		const decider = choosing("quick");
		await open(decider);
		const mild = call("report_finding", { ...crashFinding, severity: "P2" });
		scriptConversations(fake, [{ match: correctness, replies: [mild, done] }]);
		expect(lensRecord(await review({ decider }))).toMatchObject({ level: "quick" });

		// The same revision and levels, but a P2 now escalates: the earlier task decided under the old rule.
		scriptConversations(fake, [{ match: correctness, replies: [mild, done, done] }]);
		const lower = { ...config, triage: { escalateAt: "P2" } } as const;
		const reviewed = await review({ decider, config: lower });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		const index = await harness.snapshot(ReviewIndex, (await harness.root(context)).id, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@quick band quick-deep escalateAt P2 escalates to correctness@${version()}@careful (faux/heavy) on faux/medium`,
		]);
	});

	it("keys a quick run by where it escalates, capped at its ceiling or to its next level", async () => {
		const decider = choosing("quick");
		await open(decider);
		scriptConversations(fake, [{ match: correctness, replies: [severe, done] }]);
		const capped = { ...config, lenses: { correctness: { level: { ceiling: "quick" } } } } as const;
		await review({ decider, config: capped });
		const root = (await harness.root(context)).id;
		expect((await harness.snapshot(ReviewIndex, root, context))!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@quick band quick-quick escalateAt P1 capped at its ceiling on faux/medium`,
		]);

		scriptConversations(fake, [{ match: correctness, replies: [severe, done, done] }]);
		const second = await review({ decider });

		expect(lensRecord(second)).toMatchObject({ level: "careful" });
		expect((await harness.snapshot(ReviewIndex, root, context))!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@quick band quick-deep escalateAt P1 escalates to correctness@${version()}@careful (faux/heavy) on faux/medium`,
		]);
	});

	it("never lets a review at one level attach to a review of the revision at another", async () => {
		// Chooses the least look each question offers.
		const decider: Decider = {
			name: "least",
			calibrated: false,
			decide: async (request) => ({
				answers: request.questions.map((question) => ({
					question: question.id,
					distribution: { [question.options[0]!]: 1 },
				})),
			}),
		};
		await open(decider);
		const mild = call("report_finding", { ...crashFinding, severity: "P2" });
		scriptConversations(fake, [{ match: correctness, replies: [mild, done] }]);
		const first = await review({ decider });
		expect(lensRecord(first)).toMatchObject({ level: "quick" });
		expect(first.findings).toHaveLength(1);
		const calls = fake.provider.state.callCount;

		// A floor of deep offers only deep: another question, another selection, and another task.
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const floored = { ...config, lenses: { correctness: { level: { floor: "deep" } } } } as const;
		const second = await review({ decider, config: floored });

		expect(fake.provider.state.callCount).toBe(calls + 1);
		expect(lensRecord(second)).toMatchObject({ level: "deep" });
		expect(second.findings).toEqual([]);
		const root = (await harness.root(context)).id;
		const index = await harness.snapshot(ReviewIndex, root, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@deep band deep-deep escalateAt P1 on faux/heavy`,
		]);
	});
});

describe("the LLM fallback", () => {
	async function fallbackDecider(): Promise<FallbackDecider> {
		const model = await RouteTextModel.create(fake.review, [fake.ref("light")]);
		return new FallbackDecider(model!);
	}

	it("answers triage on a text model through one tool, uncalibrated, and the lens runs at its answer", async () => {
		const decider = await fallbackDecider();
		await open(decider);
		const answer = call("answer", {
			answers: [
				{
					question: "correctness",
					probabilities: [
						{ option: "careful", probability: 0.25 },
						{ option: "deep", probability: 0.75 },
					],
				},
			],
		});
		const requests = scriptConversations(fake, [
			{ match: fallback, replies: [answer] },
			{ match: correctness, replies: [done] },
		]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "deep" });
		expect(reviewed.verdict.notRun).toContainEqual({
			name: "decisions.fast",
			status: "skipped",
			reason: "no decision provider is configured; triage ran on the LLM fallback",
		});
		const [asked] = requests[fallback]!;
		const prompt = asked!
			.filter((message: Message) => message.role === "user")
			.map(textOf)
			.join("\n");
		expect(prompt).toContain("How closely should the `correctness` lens review this change?");
		expect(prompt).toMatch(/<untrusted-[0-9a-f]{24} label="diff">/);
		// The decider has no tools, so it is never told to read the head.
		expect(prompt).not.toContain("read_file");
		const stored = await readRecordedDecision(
			harness,
			(await harness.root(context)).id,
			revision(),
			"triage",
			context,
		);
		expect(stored!.decision!.toJSON()).toMatchObject({
			decider: `llm-fallback:${fake.ref("light").provider}/light`,
			calibrated: false,
			model: `${fake.ref("light").provider}/light`,
			answers: [
				{
					question: "correctness",
					distribution: { quick: 0, careful: 0.25, deep: 0.75 },
					chosen: "deep",
				},
			],
		});
	});

	describe("across reviews", () => {
		const answer = call("answer", {
			answers: [{ question: "correctness", probabilities: [{ option: "careful", probability: 1 }] }],
		});

		// Two reviews of one revision on one storage, the second with a fallback on `second`; how often triage asked.
		async function asked(first: string, second: string): Promise<number> {
			const dir = mkdtempSync(join(tmpdir(), "melian-triage-"));
			try {
				const requests = scriptConversations(fake, [
					{ match: fallback, replies: [answer, answer, answer] },
					{ match: correctness, replies: [done, done, done] },
				]);
				for (const id of [first, second]) {
					await reviewHarness?.close(context);
					const decider = new FallbackDecider((await RouteTextModel.create(fake.review, [fake.ref(id)]))!);
					reviewHarness = await ReviewHarness.open(await openSqliteStorage(join(dir, "db.sqlite")), fake.review, {
						retry: false,
						decider,
					});
					harness = reviewHarness.harness;
					await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
					await review({ decider });
				}
				return requests[fallback]!.length;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		it("asks again when a later review routes triage to another model", async () => {
			expect(await asked("light", "medium")).toBe(2);
		});

		it("asks once when a later review routes triage to the same model", async () => {
			expect(await asked("light", "light")).toBe(1);
		});
	});

	it.each([
		["error", "503 overloaded_error"],
		["aborted", undefined],
	] as const)(
		"fails closed without recording an answer when the model stops with %s",
		async (stopReason, errorMessage) => {
			const decider = await fallbackDecider();
			await open(decider);
			const requests = scriptConversations(fake, [
				{
					match: fallback,
					replies: [
						fauxAssistantMessage(
							fauxToolCall("answer", {
								answers: [{ question: "correctness", probabilities: [{ option: "quick", probability: 1 }] }],
							}),
							{ stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) },
						),
					],
				},
				{ match: correctness, replies: [done] },
			]);

			const reviewed = await review({ decider });

			const reason = `${fake.ref("light").provider}/light failed: ${errorMessage ?? stopReason}`;
			expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
			expect(lensRecord(reviewed)!.reason).toContain("triage failed, so it ran at its default level");
			expect(lensRecord(reviewed)!.reason).toContain(reason);
			const stored = await readRecordedDecision(
				harness,
				(await harness.root(context)).id,
				revision(),
				"triage",
				context,
			);
			expect(stored).toMatchObject({ failure: reason });
			expect(stored!.decision).toBeUndefined();
			expect(requests[fallback]).toHaveLength(1);
			expect(requests[correctness]).toHaveLength(1);
		},
	);

	it("fails closed to the default level when the model answers in prose", async () => {
		const decider = await fallbackDecider();
		await open(decider);
		scriptConversations(fake, [
			{ match: fallback, replies: [fauxAssistantMessage("Run it at quick.")] },
			{ match: correctness, replies: [done] },
		]);

		const reviewed = await review({ decider });

		expect(lensRecord(reviewed)).toMatchObject({ status: "ran", level: "careful" });
		expect(lensRecord(reviewed)!.reason).toContain("triage failed, so it ran at its default level");
	});
});

describe("decision providers (issue #24)", () => {
	it("records a decisions check with its reason once a provider is configured, rather than leave it without one", async () => {
		await open();
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);
		const provided = { ...config, decisions: { ...config.decisions, provider: "clef" } };

		const { verdict } = await review({ config: provided });

		expect(verdict.status).toBe("not-reviewed");
		expect(verdict.notRun).toEqual([
			{
				name: "decisions.fast",
				status: "skipped",
				reason: "decisions.provider is clef, and Melian has no adapter for a decision provider yet",
			},
		]);
	});
});

describe("reviews recorded before levels joined the keys", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "melian-triage-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("reads a sighting stored under the lens's version alone, and replaces it with a fresh run rather than attach", async () => {
		await open();
		const root = await harness.root(context);
		const atVersion = { check: "lens.correctness", version: version() };
		const old = Finding.create({
			rule: "null-dereference",
			message: "managerName reads name from a manager that may be undefined.",
			file: "src/user.ts",
			startLine: 7,
			snippet: "\treturn user.manager.name;",
			occurrence: 0,
			cause: "introduced",
			severity: "P1",
			explanation: { what: "w", whyHere: "y", whatToDo: "t" },
			source: atVersion,
		});
		// What an older Melian's review left: a sighting naming the lens's version alone, and the selection by name@version.
		await root.commit(async (tx) => {
			await upsertFinding(tx, root.id, old, revision());
			(await tx.doc(ReviewIndex, root.id)).reviews = { [revision()]: { lenses: [`correctness@${version()}`] } };
		}, context);
		const before = await readFindings(harness, root.id, revision(), context, { producers: [atVersion] });
		expect(before.map((finding) => finding.properties.id)).toEqual([old.properties.id]);
		scriptConversations(fake, [{ match: correctness, replies: [done] }]);

		const reviewed = await review();

		expect(fake.provider.state.callCount).toBe(1);
		expect(reviewed.findings).toEqual([]);
		const index = await harness.snapshot(ReviewIndex, root.id, context);
		expect(index!.reviews[revision()]!.lenses).toEqual([
			`correctness@${version()}@careful band quick-deep escalateAt P1 on faux/heavy`,
		]);
		// The fresh run of the lens replaces the earlier run's sightings at the revision, the bare-version one included.
		const after = await readFindings(harness, root.id, revision(), context, { producers: [atVersion] });
		expect(after).toEqual([]);
	});

	it("keeps a version-1 checkpoint's phase, child and attempt when upgrading mid-review", () => {
		const lens = lenses.find((each) => each.name === "correctness")!;
		const key = `correctness@${lens.version}`;
		const input = {
			root: 1 as ConversationId,
			revision: {
				repoRoot: repo,
				nonce: "0".repeat(24),
				base: gitIn(repo, "merge-base", "main", "feature"),
				head: gitIn(repo, "rev-parse", "feature"),
				files: [],
			},
			lenses: [
				{
					key,
					name: lens.name,
					version: lens.version,
					level: "careful",
					route: [fake.ref("medium"), fake.ref("heavy")],
					instructions: correctness,
					tools: [...lens.tools],
					severities: [...lens.severities],
					rules: lens.rules.map((rule) => ({ ...rule })),
					budget: { findings: 8 },
					coverage: { scope: "", paths: ["**"], nearer: [] },
					prompt: "Review the change.",
				},
			],
		};
		const checkpoint = { phase: "review", children: { [key]: 2 as ConversationId }, attempts: { [key]: 1 } };
		const definition = createReviewRegistry().snapshot().task("melian.lenses")!.definition;
		const migrate = definition.migrate as (
			input: unknown,
			checkpoint: unknown,
			from: number,
		) => { input: unknown; checkpoint: unknown };

		const upgraded = migrate(input, checkpoint, 1);

		expect(definition.version).toBe(2);
		expect(upgraded.input).toMatchObject({
			root: input.root,
			revision: input.revision,
			lenses: [{ key, version: lens.version, route: input.lenses[0]!.route }],
		});
		expect(upgraded.input).not.toHaveProperty("lenses.0.level");
		expect(upgraded.checkpoint).toEqual({ phase: "review", children: { [key]: 2 }, attempts: { [key]: 1 } });
	});

	it("resumes a lens task an older Melian created, at version 1, under the current definition", async () => {
		const path = join(dir, "review.sqlite");
		// The definition as an older Melian registered it; only its name and version reach storage.
		const LegacyLensTask = defineTask<unknown, { phase: "spawn" }, unknown>({
			name: "melian.lenses",
			version: 1,
			initial: () => ({ phase: "spawn" }),
			phases: { spawn: async () => undefined },
			abort: async () => undefined,
		});
		const head = gitIn(repo, "rev-parse", "feature");
		const base = gitIn(repo, "merge-base", "main", "feature");
		const lens = lenses.find((each) => each.name === "correctness")!;
		const legacy = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createRegistry(),
		});
		const root = await legacy.root(context, { agent: { model: fake.ref("orchestrator") } });
		const input = {
			root: root.id,
			revision: { repoRoot: repo, nonce: "0".repeat(24), base, head, files: [] },
			lenses: [
				{
					key: `correctness@${lens.version}`,
					name: "correctness",
					version: lens.version,
					level: "careful",
					route: [fake.ref("heavy")],
					instructions: correctness,
					tools: [...lens.tools],
					severities: [...lens.severities],
					rules: lens.rules.map((rule) => ({ ...rule })),
					budget: { findings: 8 },
					coverage: { scope: "", paths: ["**"], nearer: [] },
					prompt: "Review the change.",
				},
			],
		};
		const taskId = await root.commit(
			(tx) => tx.createTask(LegacyLensTask, input, { ownership: { kind: "conversation" } }),
			context,
		);
		await legacy.close(context);
		scriptConversations(fake, [{ match: correctness, replies: [call("report_finding", crashFinding), done] }]);

		const current = await openHarness(await openSqliteStorage(path), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		try {
			current.resume();
			const settled = await current.waitForTask(taskId as TaskId<Record<string, { status: string }>>, context);
			expect(settled.state.outcome).toMatchObject({
				status: "completed",
				result: { [`correctness@${lens.version}`]: { status: "done" } },
			});
			const findings = await readFindings(current, root.id, revisionKey({ base, head }), context);
			// The migration strips the run's level, so its findings name the version alone, as its own review expects.
			expect(findings.map((finding) => finding.properties.source)).toEqual([
				{ check: "lens.correctness", version: lens.version },
			]);
		} finally {
			await current.close(context);
		}
	});
});
