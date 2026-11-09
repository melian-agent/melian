import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, defaultConfig, Lens, ReviewPlan, Revision, type Verification } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	planInputs,
	type Review,
	readFindings,
	reviewChangeset,
	TelemetryReader,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	type ScriptedReply,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTask, openSqliteStorage, type TaskId } from "../src/harness.ts";
import { reviewFiles } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { startVerification, startWave, type VerificationInput } from "../src/verification.ts";
import { verifierMarker, verifierVersion } from "../src/verification-instructions.ts";
import { VerificationWavesDocument } from "../src/verification-waves.ts";
import { gitIn } from "./fixtures/repo.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

let repo: string;
let harness: Harness;
let storage: ReturnType<typeof createMemoryStorage>;
let fake: FakeModels;
let lenses: Lens[];
let changeset: Changeset;
let registry: ReturnType<typeof createReviewRegistry>;

beforeEach(async () => {
	repo = crashRepository();
	fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }, { id: "backup" }] });
	storage = createMemoryStorage();
	registry = createReviewRegistry();
	harness = await openHarness(storage, {
		models: fake.models,
		registry,
		settings: { retry: { enabled: false }, toolExecution: "parallel" },
	});
	await harness.root(context, { agent: { model: fake.ref("finder") } });
	changeset = await Changeset.resolve(repo, "main...feature");
	lenses = (
		await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])
	).filter((lens) => lens.name === "correctness" || lens.name === "contracts");
});
afterEach(async () => {
	await harness.close(context);
	rmSync(repo, { recursive: true, force: true });
});

function review(): Promise<Review> {
	return reviewChangeset(reviewOptions());
}

function reviewOptions(): Parameters<typeof reviewChangeset>[0] {
	const finder = fake.ref("finder");
	const judge = fake.ref("judge");
	return {
		harness,
		checks: [],
		changeset,
		lenses,
		standards: [],
		models: fake.review,
		config: {
			...defaultConfig,
			tiers: { full: lenses.map((lens) => `lens.${lens.name}`) },
			stages: { "pull-request": "full" },
			models: {
				heavy: { model: `${finder.provider}/${finder.modelId}` },
				verifier: { model: `${judge.provider}/${judge.modelId}` },
			},
		},
	};
}

const lens = (name: string) => lenses.find((each) => each.name === name)!;
// A defect of contracts' own on another line, so it never merges with correctness's report.
const caller = {
	...crashFinding,
	line: 3,
	rule: "broken-caller",
	explanation: {
		what: "User.manager is optional, and managerName now reads it unguarded.",
		why: "Every caller passing a user without a manager now throws.",
		fix: "Guard the manager in managerName.",
	},
};
const report = (rule: string) =>
	fauxAssistantMessage(fauxToolCall("report_finding", { ...crashFinding, rule }), { stopReason: "toolUse" });
const claimsIn = (messages: Parameters<typeof systemPromptOf>[0]) =>
	[...systemPromptOf(messages).matchAll(/Claim c[0-9]+ finding ([0-9a-f]+)/g)].map((match) => match[1]!);

// A verifier that judges every claim it is shown with `verdict(claims)`, recording the claims of each conversation's
// first request in `asked`, and resolving `judged` once a conversation's report has committed.
function verifier(
	asked: string[][],
	judged: () => void,
	verdict: (claims: readonly string[]) => Verification["verdict"],
) {
	const reply: ScriptedReply = (messages) => {
		const claims = claimsIn(messages);
		const reported = messages.some((message) => message.role === "toolResult");
		if (reported) judged();
		else asked.push(claims);
		return scriptVerifier(
			messages,
			Object.fromEntries(claims.map((id) => [id, { verdict: verdict(claims), reason: "Traced the code." }])),
		);
	};
	return { match: verifierMarker, replies: Array.from({ length: 20 }, () => reply) };
}

describe("verification as each lens ends", () => {
	it("verifies a fast lens's claim before a slow lens finishes, and only once while its defect is unchanged", async () => {
		const events: string[] = [];
		let judged!: () => void;
		const firstJudged = new Promise<void>((resolve) => {
			judged = resolve;
		});
		const asked: string[][] = [];
		// Contracts holds its answer until the verifier has judged correctness's claim, or two seconds pass, so a
		// verification that waits for every lens finds contracts still running and the test sees the order.
		const slow: ScriptedReply = async () => {
			await Promise.race([firstJudged, new Promise((resolve) => setTimeout(resolve, 2_000))]);
			events.push("contracts ended");
			return fauxAssistantMessage("Done.");
		};
		scriptConversations(fake, [
			{
				match: lens("correctness").instructions,
				replies: [report("null-dereference"), fauxAssistantMessage("Done.")],
			},
			{ match: lens("contracts").instructions, replies: [slow] },
			verifier(
				asked,
				() => {
					events.push("verified");
					judged();
				},
				() => "confirmed",
			),
		]);
		const result = await review();
		expect(events).toEqual(["verified", "contracts ended"]);
		expect(asked).toHaveLength(1);
		expect(result.verdict.status).toBe("findings");
		expect((result.verdict.ran ?? []).map((check) => check.name)).toContain("verifier");
		// The round's telemetry shows the verifier at work before the last lens ended.
		const { stages } = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
		const judging = stages.find((stage) => stage.name === "melian.verification.candidate")!;
		const contracts = stages.find((stage) => stage.name === "melian.lens" && stage.subject.startsWith("contracts@"))!;
		expect(judging.startedAt).toBeLessThan(contracts.endedAt!);
	});

	it("verifies a defect again with every sighting when a later lens joins it, and the last verification decides", async () => {
		let judged!: () => void;
		const firstJudged = new Promise<void>((resolve) => {
			judged = resolve;
		});
		const asked: string[][] = [];
		const slow: ScriptedReply = async () => {
			await Promise.race([firstJudged, new Promise((resolve) => setTimeout(resolve, 2_000))]);
			return report("broken-caller");
		};
		scriptConversations(fake, [
			{
				match: lens("correctness").instructions,
				replies: [report("null-dereference"), fauxAssistantMessage("Done.")],
			},
			{ match: lens("contracts").instructions, replies: [slow, fauxAssistantMessage("Done.")] },
			// Confirmed alone, plausible with both sightings: a stored confirmation that outlived the second verification
			// would outrank its plausible verdict.
			verifier(
				asked,
				() => judged(),
				(claims) => (claims.length === 1 ? "confirmed" : "plausible"),
			),
		]);
		await review();
		expect(asked.map((claims) => claims.length)).toEqual([1, 2]);
		const findings = await readFindings(
			harness,
			(await harness.root(context)).id,
			Revision.key(changeset.revision),
			context,
		);
		expect(findings.map((finding) => finding.properties.verification?.verdict)).toEqual(["plausible", "plausible"]);
	});
	it("records no lens's end once the index names another lens task", async () => {
		const correctness = lens("correctness");
		lenses = [correctness];
		const key = Revision.key(changeset.revision);
		scriptConversations(fake, [
			{
				match: correctness.instructions,
				replies: [
					async () => {
						const root = await harness.root(context);
						await root.commit(async (tx) => {
							(await tx.doc(ReviewIndex, root.id)).reviews[key]!.task = 999_999;
						}, context);
						return fauxAssistantMessage("Done.");
					},
				],
			},
		]);
		await review();
		const root = await harness.root(context);
		const entry = (await harness.snapshot(VerificationWavesDocument, root.id, context))?.reviews[key];
		expect(entry?.ended).toEqual({});
	});

	it("starts no wave for a lens task the index does not name", async () => {
		const root = await harness.root(context);
		const created = await startWave(
			harness,
			{
				root: root.id,
				version: verifierVersion,
				revision: {
					repoRoot: repo,
					nonce: "a".repeat(24),
					base: changeset.revision.base,
					head: changeset.revision.head,
					files: reviewFiles(changeset.revision.files),
				},
				candidates: [],
			},
			424_242,
			context,
		);
		expect(created).toBeUndefined();
		expect(
			(await harness.snapshot(VerificationWavesDocument, root.id, context))?.reviews[
				Revision.key(changeset.revision)
			],
		).toBeUndefined();
	});

	// Correctness reports and ends at once; contracts waits for the first verification, so a wave verifies
	// correctness's claim, and the final step finds it standing.
	function fastThenSlow(asked: string[][]) {
		let judged!: () => void;
		const firstJudged = new Promise<void>((resolve) => {
			judged = resolve;
		});
		const slow: ScriptedReply = async () => {
			await Promise.race([firstJudged, new Promise((resolve) => setTimeout(resolve, 2_000))]);
			return fauxAssistantMessage("Done.");
		};
		return scriptConversations(fake, [
			{
				match: lens("correctness").instructions,
				replies: [report("null-dereference"), fauxAssistantMessage("Done.")],
			},
			{ match: lens("contracts").instructions, replies: [slow] },
			verifier(
				asked,
				() => judged(),
				() => "confirmed",
			),
		]);
	}
	// A revision whose entry a verifier refusal deleted has no waves.
	const waveTasks = async () =>
		(
			(await harness.snapshot(VerificationWavesDocument, (await harness.root(context)).id, context))?.reviews[
				Revision.key(changeset.revision)
			]?.waves ?? []
		).map((wave) => wave.task);

	it("verifies again under a route it ran before, once another route's verification has replaced that wave's", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		expect(asked).toHaveLength(1);
		const routed = (id: string) => {
			const options = reviewOptions();
			const model = fake.ref(id);
			return {
				...options,
				config: {
					...options.config,
					models: { ...options.config.models, verifier: { model: `${model.provider}/${model.modelId}` } },
				},
			};
		};
		scriptConversations(fake, [
			verifier(
				asked,
				() => undefined,
				() => "plausible",
			),
		]);
		await reviewChangeset(routed("backup"));
		expect(asked).toHaveLength(2);
		scriptConversations(fake, [
			verifier(
				asked,
				() => undefined,
				() => "confirmed",
			),
		]);
		const result = await reviewChangeset(routed("judge"));
		expect(asked).toHaveLength(3);
		const judge = fake.ref("judge");
		expect(result.findings[0]!.properties.verification).toMatchObject({
			verdict: "confirmed",
			model: `${judge.provider}/${judge.modelId}`,
		});
	});

	it("starts no wave over a lens task that had already finished when the review began", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		const root = await harness.root(context);
		const revision = Revision.key(changeset.revision);
		// The lenses' ends stay recorded, but no wave stands for their claims and no final verification owns them.
		await root.commit(async (tx) => {
			delete (await tx.doc(ReviewIndex, root.id)).reviews[revision]!.verification;
			for (const wave of (await tx.doc(VerificationWavesDocument, root.id)).reviews[revision]!.waves)
				wave.candidates = [];
		}, context);
		const waves = await waveTasks();
		await review();
		expect(await waveTasks()).toEqual(waves);
		expect(asked).toHaveLength(2);
	});

	it("reuses a wave's outcome on rerun once the index has lost the final verification", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		expect(await waveTasks()).toHaveLength(1);
		const root = await harness.root(context);
		await root.commit(async (tx) => {
			delete (await tx.doc(ReviewIndex, root.id)).reviews[Revision.key(changeset.revision)]!.verification;
		}, context);
		const result = await reviewChangeset({ ...reviewOptions(), rerun: true });
		expect(asked).toHaveLength(1);
		expect(result.verdict.ran?.find((check) => check.name === "verifier")?.status).toBe("ran");
	});

	it("passes over a standing wave whose task ended without completing", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		const failed = defineTask<Record<string, never>, { phase: "end" }, unknown>({
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
			name: "test.failed-wave",
			version: 1,
			initial: () => ({ phase: "end" }),
			phases: {
				end: async (_task, runtime, context) => {
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "failed", error: { message: "wave failed" } } }),
						context,
					);
				},
			},
		});
		registry.install({ name: "failed-wave", tasks: [failed] });
		const root = await harness.root(context);
		const parked = await root.commit(async (tx) => {
			const id = await tx.createTask(failed, {}, { ownership: { kind: "conversation" } });
			const entry = (await tx.doc(VerificationWavesDocument, root.id)).reviews[Revision.key(changeset.revision)]!;
			entry.waves = entry.waves.map((wave) => ({ ...wave, task: id }));
			// Without the final verification, only the failed wave could supply the outcome, so the review must ask again.
			delete (await tx.doc(ReviewIndex, root.id)).reviews[Revision.key(changeset.revision)]!.verification;
			return id;
		}, context);
		expect((await harness.waitForTask(parked as TaskId, context)).state.outcome.status).toBe("failed");
		const result = await review();
		expect(asked).toHaveLength(2);
		expect(result.verdict.ran?.find((check) => check.name === "verifier")?.status).toBe("ran");
	});

	it("reads no wave for a candidate no wave verified, in SQLite storage", async () => {
		const directory = mkdtempSync(join(tmpdir(), "melian-waves-"));
		try {
			await harness.close(context);
			harness = await openHarness(await openSqliteStorage(join(directory, "state.sqlite")), {
				models: fake.models,
				registry: createReviewRegistry(),
				settings: { retry: { enabled: false }, toolExecution: "parallel" },
			});
			await harness.root(context, { agent: { model: fake.ref("finder") } });
			const asked: string[][] = [];
			fastThenSlow(asked);
			await review();
			const root = await harness.root(context);
			// With neither a wave nor the final verification left, only a fresh verification can judge the claim.
			await root.commit(async (tx) => {
				delete (await tx.doc(VerificationWavesDocument, root.id)).reviews[Revision.key(changeset.revision)];
				delete (await tx.doc(ReviewIndex, root.id)).reviews[Revision.key(changeset.revision)]!.verification;
			}, context);
			const result = await review();
			expect(asked).toHaveLength(2);
			expect(result.findings.map((finding) => finding.properties.verification?.verdict)).toEqual(["confirmed"]);
			expect(result.verdict.ran?.find((check) => check.name === "verifier")?.status).toBe("ran");
		} finally {
			await harness.close(context);
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("starts no wave while the plan refuses the verifier", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		const options = reviewOptions();
		const judge = `${fake.ref("judge").provider}/judge`;
		const config = {
			...options.config,
			models: { ...options.config.models, verifier: { model: `${fake.ref("backup").provider}/backup` } },
		};
		const { catalog, credentials } = await planInputs(fake.review);
		const plan = ReviewPlan.resolve({
			config,
			catalog,
			credentials,
			lenses,
			checks: lenses.map((each) => `lens.${each.name}`),
			routes: {
				committed: { heavy: config.models.heavy, verifier: { model: judge, acceptOverridden: false } },
				overridden: { verifier: "melian.local.yaml" },
				lensTiers: {},
				retiered: {},
			},
		});
		expect(plan.refusal("verifier")).toBeDefined();
		await expect(
			reviewChangeset({ ...options, plan, config: { ...config, models: plan.routes() } }),
		).rejects.toMatchObject({ code: "verifierFailed" });
		expect(asked).toEqual([]);
		expect(await waveTasks()).toEqual([]);
	});

	it("starts no wave while a candidate has no verifier model with credentials", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		const options = reviewOptions();
		const locked = fake.withoutCredentials("judge");
		await expect(
			reviewChangeset({
				...options,
				config: {
					...options.config,
					models: { ...options.config.models, verifier: { model: `${locked.provider}/${locked.modelId}` } },
				},
			}),
		).rejects.toMatchObject({ code: "verifierFailed" });
		expect(asked).toEqual([]);
		expect(await waveTasks()).toEqual([]);
	});

	it("leaves a lens that has reported but not ended out of a wave", async () => {
		let judged!: () => void;
		const firstJudged = new Promise<void>((resolve) => {
			judged = resolve;
		});
		const asked: string[][] = [];
		// Contracts reports at once, then holds its end until correctness's claim is judged alone.
		const hold: ScriptedReply = async () => {
			await Promise.race([firstJudged, new Promise((resolve) => setTimeout(resolve, 2_000))]);
			return fauxAssistantMessage("Done.");
		};
		scriptConversations(fake, [
			{
				match: lens("correctness").instructions,
				replies: [report("null-dereference"), fauxAssistantMessage("Done.")],
			},
			{ match: lens("contracts").instructions, replies: [report("broken-caller"), hold] },
			verifier(
				asked,
				() => judged(),
				() => "confirmed",
			),
		]);
		await review();
		expect(asked.map((claims) => claims.length)).toEqual([1, 2]);
	});

	it("gives each candidate the verifier's fixed budget", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		const root = await harness.root(context);
		const entry = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[Revision.key(changeset.revision)]!;
		const tasks = [...(await waveTasks()), entry.verification!.task];
		for (const task of tasks) {
			const input = (await harness.getTask(task as TaskId, context))!.input as unknown as VerificationInput;
			expect(input.candidates.map((candidate) => candidate.budget)).toEqual(
				input.candidates.map(() => ({ tokens: 300_000, tools: 60 })),
			);
			expect(input.candidates.length).toBeGreaterThan(0);
		}
	});

	it("starts no wave while an earlier wave still runs", async () => {
		let firstAsked!: () => void;
		const waveAsked = new Promise<void>((resolve) => {
			firstAsked = resolve;
		});
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let contractsDone!: () => void;
		const contractsEnded = new Promise<void>((resolve) => {
			contractsDone = resolve;
		});
		const asked: string[][] = [];
		// Wave 1 verifies correctness's claim and holds its answer; contracts reports a defect of its own on another line
		// and ends meanwhile, so a second wave started now would run beside the first.
		const judge: ScriptedReply = async (messages) => {
			const claims = claimsIn(messages);
			if (!messages.some((message) => message.role === "toolResult")) {
				asked.push(claims);
				if (asked.length === 1) {
					firstAsked();
					await held;
				}
			}
			return scriptVerifier(
				messages,
				Object.fromEntries(claims.map((id) => [id, { verdict: "confirmed" as const, reason: "Traced the code." }])),
			);
		};
		scriptConversations(fake, [
			{
				match: lens("correctness").instructions,
				replies: [report("null-dereference"), fauxAssistantMessage("Done.")],
			},
			{
				match: lens("contracts").instructions,
				replies: [
					async () => {
						await Promise.race([waveAsked, new Promise((resolve) => setTimeout(resolve, 2_000))]);
						return fauxAssistantMessage(fauxToolCall("report_finding", caller), { stopReason: "toolUse" });
					},
					async () => {
						contractsDone();
						return fauxAssistantMessage("Done.");
					},
				],
			},
			{ match: verifierMarker, replies: Array.from({ length: 20 }, () => judge) },
		]);
		const running = review();
		let during: number | undefined;
		try {
			await contractsEnded;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
			during = asked.length;
		} finally {
			release();
			await running;
		}
		expect(during).toBe(1);
		expect(asked.map((claims) => claims.length)).toEqual([1, 1]);
	});

	it("starts the next wave once the running one settles, while a slower lens still runs", async () => {
		lenses = [
			...lenses,
			(await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])).find(
				(each) => each.name === "tests",
			)!,
		];
		const settled = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
		const events: string[] = [];
		let judged = 0;
		const judge: ScriptedReply = (messages) => {
			const claims = claimsIn(messages);
			if (messages.some((message) => message.role === "toolResult")) {
				if (judged === 1) events.push("contracts verified");
				settled[judged++]?.resolve();
			}
			return scriptVerifier(
				messages,
				Object.fromEntries(claims.map((id) => [id, { verdict: "confirmed" as const, reason: "Traced the code." }])),
			);
		};
		const within = (promise: Promise<void>, ms: number) =>
			Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
		scriptConversations(fake, [
			{
				match: lens("correctness").instructions,
				replies: [report("null-dereference"), fauxAssistantMessage("Done.")],
			},
			{
				match: lens("contracts").instructions,
				replies: [
					async () => {
						await within(settled[0]!.promise, 2_000);
						return fauxAssistantMessage(fauxToolCall("report_finding", caller), { stopReason: "toolUse" });
					},
					fauxAssistantMessage("Done."),
				],
			},
			{
				match: lens("tests").instructions,
				replies: [
					async () => {
						await within(settled[1]!.promise, 3_000);
						events.push("tests ended");
						return fauxAssistantMessage("Done.");
					},
				],
			},
			{ match: verifierMarker, replies: Array.from({ length: 20 }, () => judge) },
		]);
		await review();
		expect(events).toEqual(["contracts verified", "tests ended"]);
	});

	it("waits on a wave still running when the next lens ends, then starts the next wave before a slower lens ends", async () => {
		lenses = [
			...lenses,
			(await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])).find(
				(each) => each.name === "tests",
			)!,
		];
		const contractsEnded = Promise.withResolvers<void>();
		const second = Promise.withResolvers<void>();
		const events: string[] = [];
		let asked = 0;
		const within = (promise: Promise<void>, ms: number) =>
			Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))]);
		const judge: ScriptedReply = async (messages) => {
			const claims = claimsIn(messages);
			if (messages.some((message) => message.role === "toolResult")) {
				if (asked === 2) {
					events.push("contracts verified");
					second.resolve();
				}
			} else if (++asked === 1) {
				// The first wave is still judging when contracts ends.
				await within(contractsEnded.promise, 2_000);
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			return scriptVerifier(
				messages,
				Object.fromEntries(claims.map((id) => [id, { verdict: "confirmed" as const, reason: "Traced the code." }])),
			);
		};
		scriptConversations(fake, [
			{
				match: lens("correctness").instructions,
				replies: [report("null-dereference"), fauxAssistantMessage("Done.")],
			},
			{
				match: lens("contracts").instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", caller), { stopReason: "toolUse" }),
					() => {
						contractsEnded.resolve();
						return fauxAssistantMessage("Done.");
					},
				],
			},
			{
				match: lens("tests").instructions,
				replies: [
					async () => {
						await within(second.promise, 4_000);
						events.push("tests ended");
						return fauxAssistantMessage("Done.");
					},
				],
			},
			{ match: verifierMarker, replies: Array.from({ length: 20 }, () => judge) },
		]);
		await review();
		expect(events).toEqual(["contracts verified", "tests ended"]);
	});

	it("verifies again a claim whose wave outcome a verifier refusal cleared", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		expect(await waveTasks()).toHaveLength(1);
		const options = reviewOptions();
		const locked = fake.withoutCredentials("judge");
		await expect(
			reviewChangeset({
				...options,
				config: {
					...options.config,
					models: { ...options.config.models, verifier: { model: `${locked.provider}/${locked.modelId}` } },
				},
			}),
		).rejects.toMatchObject({ code: "verifierFailed" });
		const before = asked.length;
		const result = await review();
		expect(asked.length).toBeGreaterThan(before);
		// The lens task had finished, so the final step verifies again and no wave starts.
		expect(await waveTasks()).toEqual([]);
		expect(result.findings.map((finding) => finding.properties.verification?.verdict)).toEqual(["confirmed"]);
	});

	it("starts one wave for a lens's claim when two reviews watch the same lens task", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await Promise.all([review(), review()]);
		expect(await waveTasks()).toHaveLength(1);
		expect(asked).toHaveLength(1);
	});

	it("starts no final verification that reuses a wave another review's final verification retired", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		const root = await harness.root(context);
		const revision = Revision.key(changeset.revision);
		const entry = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!;
		const final = (await harness.getTask(entry.verification!.task as TaskId, context))!
			.input as unknown as VerificationInput;
		expect(Object.keys(final.reused ?? {})).toHaveLength(1);
		await root.commit(async (tx) => {
			delete (await tx.doc(ReviewIndex, root.id)).reviews[revision]!.verification;
		}, context);
		// Another review formed the same claim's candidate differently, so its final task clears the claim and retires the wave.
		const other = {
			...final,
			reused: undefined,
			candidates: final.candidates.map((candidate) => ({
				...candidate,
				budget: { ...candidate.budget, tools: candidate.budget.tools + 1 },
			})),
		};
		expect(await startVerification(harness, other, entry.lenses, false, context)).toBeDefined();
		expect(await startVerification(harness, final, entry.lenses, false, context)).toBeUndefined();
	});

	it("leaves a wave still pending when the final verification starts no authority to verify", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		const root = await harness.root(context);
		const revision = Revision.key(changeset.revision);
		const entry = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!;
		const final = (await harness.getTask(entry.verification!.task as TaskId, context))!
			.input as unknown as VerificationInput;
		await root.commit(async (tx) => {
			delete (await tx.doc(ReviewIndex, root.id)).reviews[revision]!.verification;
		}, context);
		// Another review's watcher started this wave just before the final verification; it has not run yet.
		const late = await startWave(harness, { ...final, version: "late" }, entry.task!, context);
		expect(late).toBeDefined();
		await startVerification(harness, { ...final, reused: undefined }, entry.lenses, false, context);
		expect((await harness.waitForTask(late!, context)).state.outcome).toEqual({ status: "completed", result: {} });
	});

	it("starts no wave beside a running one, even for a candidate no wave holds", async () => {
		const asked: string[][] = [];
		fastThenSlow(asked);
		await review();
		const root = await harness.root(context);
		const entry = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[Revision.key(changeset.revision)]!;
		const final = (await harness.getTask(entry.verification!.task as TaskId, context))!
			.input as unknown as VerificationInput;
		const candidate = final.candidates[0]!;
		// No wave starts once a final verification owns the revision.
		expect(
			await startWave(harness, { ...final, version: "late", candidates: [candidate] }, entry.task!, context),
		).toBeUndefined();
		await root.commit(async (tx) => {
			delete (await tx.doc(ReviewIndex, root.id)).reviews[Revision.key(changeset.revision)]!.verification;
		}, context);
		// A finished wave before the unfinished one, so only the latest wave decides.
		const earlier = await startWave(
			harness,
			{ ...final, version: "earlier", candidates: [candidate] },
			entry.task!,
			context,
		);
		await harness.waitForTask(earlier!, context);
		// A task created in a commit stays pending until the scheduler resumes, so the first wave is still unfinished.
		const first = await startWave(
			harness,
			{ ...final, version: "held", candidates: [candidate] },
			entry.task!,
			context,
		);
		expect(first).toBeDefined();
		// Another claim, so no wave holds the candidate, and only the unfinished wave can refuse it.
		const other = {
			...candidate,
			key: "other",
			state: {
				...candidate.state,
				claims: candidate.state.claims.map((claim) => ({ ...claim, id: "f".repeat(16) })),
			},
		};
		expect(
			await startWave(harness, { ...final, version: "held", candidates: [other] }, entry.task!, context),
		).toBeUndefined();
		await harness.waitForTask(first!, context);
		expect(
			await startWave(harness, { ...final, version: "held", candidates: [other] }, entry.task!, context),
		).toBeDefined();
	});
});
