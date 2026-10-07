import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Changeset, type Decider, defaultConfig, Lens, type ReviewProvider } from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import {
	type ConversationId,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	type Message,
	openHarness,
	openPublishHarness,
	openSqliteStorage,
	publishReview,
	ReviewHarness,
	readFindings,
	readVerdict,
	reviewChangeset,
	revisionKey,
	type TaskId,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallerContext } from "../src/callers.ts";
import { DecisionDocument, decisionExtension } from "../src/decisions.ts";
import { findingsVersion } from "../src/findings.ts";
import { LensDocument } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { SummaryTask } from "../src/summarize.ts";
import { gitIn } from "./fixtures/repo.ts";
import {
	budgetLenses,
	count,
	crashFinding,
	crashLenses,
	crashRepository,
	endingBudgets,
	readEvents,
	twoLensTiers,
} from "./fixtures/review-scenario.ts";

const crashScript = fileURLToPath(new URL("./fixtures/review-crash.ts", import.meta.url));

let dir: string;
let repo: string;
let harness: Harness | undefined;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "melian-review-crash-"));
	repo = crashRepository();
});

afterEach(async () => {
	await harness?.close(context);
	harness = undefined;
	rmSync(dir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

async function killWhen(
	scenario:
		| "finding"
		| "legacy"
		| "request"
		| "callers"
		| "adjudication"
		| "read"
		| "spent"
		| "tokens"
		| "escalation"
		| "verifier"
		| "verdict"
		| "conflicting-verdict"
		| "decision"
		| "replacement",
	reached: (events: ReturnType<typeof readEvents>) => boolean,
	database: string,
	log: string,
): Promise<void> {
	// The condition resolves workspace packages to their sources, as Vitest does, rather than to a stale or absent build.
	const child = spawn(
		process.execPath,
		["--conditions=@melian-agent/source", crashScript, scenario, repo, database, log],
		{
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<string | number | null>((resolve) =>
		child.on("exit", (code, signal) => resolve(signal ?? code)),
	);
	const deadline = Date.now() + 15_000;
	try {
		while (!reached(readEvents(log))) {
			if (child.exitCode !== null || child.signalCode !== null)
				throw new Error(`crash script exited before the kill point:\n${stderr}`);
			if (Date.now() > deadline) throw new Error(`crash script never reached the kill point:\n${stderr}`);
			await sleep(20);
		}
	} finally {
		child.kill("SIGKILL");
	}
	expect(await exited).toBe("SIGKILL");
}

// The revision `main...feature` reviews, as the findings and verdict documents key it.
function reviewedRevision(): string {
	return revisionKey({
		base: gitIn(repo, "merge-base", "main", "feature"),
		head: gitIn(repo, "rev-parse", "feature"),
	});
}

function toolResults(messages: readonly Message[]): string[] {
	return messages.filter((message) => message.role === "toolResult").map(textOf);
}

describe("report_finding across a crash", { timeout: 30_000 }, () => {
	it("replays and accepts a correction at exactly the lens's full budget", async () => {
		const database = join(dir, "review.sqlite");
		const log = join(dir, "review.jsonl");
		await killWhen("finding", (events) => count(events, "finding-committed") === 1, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const corrected = { ...crashFinding, explanation: { ...crashFinding.explanation, what: "Corrected." } };
		const requests = scriptConversations(fake, [
			{
				match: "You are the correctness reviewer",
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", corrected), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		harness.resume();
		const lensTask = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses");
		expect(lensTask).toBeDefined();
		const settled = await harness.waitForTask(lensTask!.record.id, context);

		expect(settled.state.outcome.status).toBe("completed");
		const [replayed, correction] = requests["You are the correctness reviewer"]!;
		const [first] = toolResults(replayed!);
		expect(first).toMatch(/^recorded finding [0-9a-f]{16} as introduced\n/);
		expect(toolResults(correction!).at(-1)).toBe(first);
		const root = await harness.root(context);
		const findings = await readFindings(harness, root.id, reviewedRevision(), context);
		expect(findings.map((finding) => finding.message.text)).toEqual(["Corrected."]);
	});

	it("refuses an older Melian's call replayed after a crash, saying what evidence must be, and takes the lens's retry", async () => {
		const database = join(dir, "legacy.sqlite");
		const log = join(dir, "legacy.jsonl");
		await killWhen("legacy", (events) => count(events, "legacy-call-accepted") === 1, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{
				match: "You are the correctness reviewer",
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		harness.resume();
		const lensTask = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses");
		expect(lensTask).toBeDefined();
		const settled = await harness.waitForTask(lensTask!.record.id, context);

		expect(settled.state.outcome.status).toBe("completed");
		const [replayed, retried] = requests["You are the correctness reviewer"]!;
		expect(toolResults(replayed!)).toEqual([
			expect.stringContaining(
				"evidence must be a list of one or more locations, each { file, line, endLine, role }",
			),
		]);
		expect(toolResults(retried!).at(-1)).toMatch(/^recorded finding [0-9a-f]{16} as introduced\n/);
		const root = await harness.root(context);
		const findings = await readFindings(harness, root.id, reviewedRevision(), context);
		expect(findings.map((finding) => finding.properties.failureScenario)).toEqual([crashFinding.failureScenario]);
	});

	it("attaches a repeat call to the crashed review, so each lens asks its model once", async () => {
		const database = join(dir, "repeat.sqlite");
		const log = join(dir, "repeat.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const heavy = fake.ref("heavy");
		await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: twoLensTiers,
				models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
			},
			lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
		});

		expect(requests["You are the correctness reviewer"]).toHaveLength(1);
		expect(requests["You are the contracts reviewer"]).toHaveLength(1);
		expect(fake.provider.state.callCount).toBe(2);
		const lensTasks = (await harness.inspect(context)).tasks.filter((task) => task.record.kind === "melian.lenses");
		expect(lensTasks).toEqual([]);
	});

	it("says a crashed lens task resumes a model, before anything resumes it, and a finished review none", async () => {
		const database = join(dir, "resumes.sqlite");
		const log = join(dir, "resumes.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, { retry: false });
		harness = reopened.harness;

		expect(await reopened.resumesModels(context)).toBe(true);
		expect(fake.provider.state.callCount).toBe(0);

		const heavy = fake.ref("heavy");
		await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: twoLensTiers,
				models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
			},
			lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
		});

		expect(await reopened.resumesModels(context)).toBe(false);
	});

	it.each([
		[
			"a triage decision",
			"decision",
			(events: ReturnType<typeof readEvents>) => count(events, "decision-asked") === 1,
		],
		[
			"a verification",
			"verifier",
			(events: ReturnType<typeof readEvents>) =>
				events.some((event) => event.event === "model-request" && event.lens === "verifier"),
		],
	] as const)("says a crashed %s resumes a model", async (_, scenario, reached) => {
		const database = join(dir, `${scenario}-resumes.sqlite`);
		await killWhen(scenario, reached, database, join(dir, `${scenario}-resumes.jsonl`));

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const decider: Decider = { name: "parked", calibrated: false, decide: async () => ({ answers: [] }) };
		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, {
			retry: false,
			...(scenario === "decision" ? { decider } : {}),
		});
		harness = reopened.harness;
		const kinds = (await harness.inspect(context)).tasks.map((task) => task.record.kind);

		expect(kinds).toContain(scenario === "decision" ? "melian.decision" : "melian.verification");
		expect(await reopened.resumesModels(context)).toBe(true);
	});

	it("says a walkthrough task that has not finished resumes a model, and no task none", async () => {
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "light" }] });
		const reopened = await ReviewHarness.open(createMemoryStorage(), fake.review, { retry: false });
		harness = reopened.harness;
		const root = await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
		expect(await reopened.resumesModels(context)).toBe(false);

		await root.commit(async (tx) => {
			await tx.createTask(
				SummaryTask,
				{ root: root.id, revision: "r", prompt: "p", model: fake.ref("light"), paths: [] },
				{ ownership: { kind: "conversation" } },
			);
		}, context);

		expect(await reopened.resumesModels(context)).toBe(true);
		expect(fake.provider.state.callCount).toBe(0);
	});

	it("attaches a repeat call whose caller context is unavailable, and keeps the first call's caller section", async () => {
		const database = join(dir, "callers.sqlite");
		const log = join(dir, "callers.jsonl");
		await killWhen("callers", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const heavy = fake.ref("heavy");
		await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: twoLensTiers,
				models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
			},
			lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
			callers: CallerContext.unavailable("graph missing on the rerun"),
		});

		expect(requests["You are the correctness reviewer"]).toHaveLength(1);
		expect(requests["You are the contracts reviewer"]).toHaveLength(1);
		expect(fake.provider.state.callCount).toBe(2);
		for (const [match, [request]] of Object.entries(requests)) {
			expect(systemPromptOf(request!), match).toContain("First");
		}
	});

	it("records the caller notes and coverage of the call that rendered the section a repeat call finished", async () => {
		const database = join(dir, "callers-record.sqlite");
		const log = join(dir, "callers-record.jsonl");
		await killWhen("callers", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const heavy = fake.ref("heavy");
		vi.spyOn(CallerContext.prototype, "recordCoverage").mockImplementation(async function (this: CallerContext) {
			return { review: `paths:${this.coverageSource()?.paths.join(",") ?? "none"}` };
		});
		const repeat = async (callers: CallerContext) =>
			reviewChangeset({
				harness: harness!,
				changeset: await Changeset.resolve(repo, "main...feature"),
				config: {
					...defaultConfig,
					static: { ...defaultConfig.static, enola: { ...defaultConfig.static.enola, enabled: true } },
					tiers: twoLensTiers,
					models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
				},
				lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
				standards: [],
				checks: [],
				models: fake.review,
				callers,
			});
		const lensRecords = (result: Awaited<ReturnType<typeof repeat>>) =>
			result.verdict.ran!.filter((record) => record.name.startsWith("lens."));

		const second = await repeat(CallerContext.unavailable("graph missing on the rerun"));
		const third = await repeat(CallerContext.unavailable("graph missing on the third call"));

		for (const result of [second, third])
			for (const record of lensRecords(result)) {
				expect(record.coverage).toEqual({ review: "paths:caller.ts" });
				expect(record.reason ?? "").toContain("Call one's note");
				expect(record.reason ?? "").not.toContain("Callers unavailable");
			}
		expect(third.verdict.fingerprint()).toBe(second.verdict.fingerprint());
	});

	it("falls back to the finishing call's notes for a lens task that stored no caller context", async () => {
		const database = join(dir, "callers-old.sqlite");
		const log = join(dir, "callers-old.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const heavy = fake.ref("heavy");
		const result = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				static: { ...defaultConfig.static, enola: { ...defaultConfig.static.enola, enabled: true } },
				tiers: twoLensTiers,
				models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
			},
			lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
			callers: CallerContext.unavailable("graph missing on the rerun"),
		});

		for (const record of result.verdict.ran!.filter((each) => each.name.startsWith("lens.")))
			expect(record.reason).toContain("Callers unavailable: graph missing on the rerun");
	});

	it("does not resume a crashed run on one route once a review on another starts, and reads only the new run", async () => {
		const database = join(dir, "rerouted.sqlite");
		const log = join(dir, "rerouted.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "backup" }] });
		const askedBy: string[] = [];
		const answer = (_: readonly Message[], model: string) => {
			askedBy.push(model);
			return fauxAssistantMessage("Done.");
		};
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [answer, answer] },
			{ match: "You are the contracts reviewer", replies: [answer, answer] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const crashed = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses");
		expect(crashed).toBeDefined();
		const backup = fake.ref("backup");
		const { verdict } = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: twoLensTiers,
				models: { heavy: { model: `${backup.provider}/${backup.modelId}` } },
			},
			lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
		});

		// The crashed run on heavy is aborted before anything resumes it, so only the new run's model is asked.
		expect(askedBy).toEqual(["backup", "backup"]);
		const old = await harness.getTask(crashed!.record.id, context);
		expect(old?.state).toMatchObject({ status: "terminal", outcome: { status: "aborted" } });
		expect(verdict.ran?.filter((check) => check.name.startsWith("lens."))).toHaveLength(2);
	});

	it.each([
		["replaced", 999_999],
		["rewrote without a lens task, as one that selected no lens does", undefined],
	])("aborts, on opening, a crashed lens run a later review %s, so it asks no model", async (_, named) => {
		const database = join(dir, "replaced.sqlite");
		const log = join(dir, "replaced.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		// What a later review's commit leaves when the process dies before it aborts the run it replaced.
		const replace = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const crashed = (await replace.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses");
		expect(crashed).toBeDefined();
		const root = await replace.root(context);
		await root.commit(async (tx) => {
			const index = await tx.doc(ReviewIndex, root.id);
			const entry = index.reviews[reviewedRevision()]!;
			index.reviews[reviewedRevision()] = named === undefined ? { lenses: [] } : { ...entry, task: named };
		}, context);
		await replace.close(context);

		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, { retry: false });
		harness = reopened.harness;
		const settled = await harness.waitForTask(crashed!.record.id, context);

		expect(settled.state.outcome.status).toBe("aborted");
		expect(requests["You are the correctness reviewer"]).toEqual([]);
		expect(requests["You are the contracts reviewer"]).toEqual([]);
	});

	it("aborts, on opening, a crashed lens run an older Melian indexed, which no review can attach to", async () => {
		const database = join(dir, "v2.sqlite");
		const log = join(dir, "v2.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		// The entry as version 2 of the review index stored it: each lens by name and version, with no route.
		const older = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const crashed = (await older.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses");
		expect(crashed).toBeDefined();
		const root = await older.root(context);
		await root.commit(async (tx) => {
			const index = await tx.doc(ReviewIndex, root.id);
			const entry = index.reviews[reviewedRevision()]!;
			index.reviews[reviewedRevision()] = { ...entry, lenses: entry.lenses.map((lens) => lens.split(" on ")[0]!) };
		}, context);
		await older.close(context);

		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, { retry: false });
		harness = reopened.harness;
		const settled = await harness.waitForTask(crashed!.record.id, context);

		expect(settled.state.outcome.status).toBe("aborted");
		expect(requests["You are the correctness reviewer"]).toEqual([]);
		expect(requests["You are the contracts reviewer"]).toEqual([]);
	});

	it("aborts, on opening, a crashed lens run a Melian before the level key indexed, which no review can attach to", async () => {
		const database = join(dir, "v3.sqlite");
		const log = join(dir, "v3.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		// The entry as before the level key: each lens by name and version, with its route and no level.
		const older = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const crashed = (await older.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses");
		expect(crashed).toBeDefined();
		const root = await older.root(context);
		await root.commit(async (tx) => {
			const index = await tx.doc(ReviewIndex, root.id);
			const entry = index.reviews[reviewedRevision()]!;
			index.reviews[reviewedRevision()] = {
				...entry,
				lenses: entry.lenses.map((lens) => lens.replace(/^([^@\s]+@[^@\s]+)@\S+/, "$1")),
			};
		}, context);
		await older.close(context);

		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, { retry: false });
		harness = reopened.harness;
		const settled = await harness.waitForTask(crashed!.record.id, context);

		expect(settled.state.outcome.status).toBe("aborted");
		expect(requests["You are the correctness reviewer"]).toEqual([]);
		expect(requests["You are the contracts reviewer"]).toEqual([]);
	});

	it("records no verdict from a crashed adjudication once a new lens selection reviews the head", async () => {
		const database = join(dir, "superseded.sqlite");
		const log = join(dir, "superseded.jsonl");
		await killWhen("adjudication", (events) => count(events, "adjudication-started") === 1, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		scriptConversations(fake, [
			{
				match: "You are the correctness reviewer",
				replies: [async () => held.then(() => fauxAssistantMessage("Done."))],
			},
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const tasks = async (kind: string) =>
			(await harness!.inspect(context)).tasks.filter((task) => task.record.kind === kind);
		const [stale] = await tasks("melian.adjudication");
		expect(stale).toBeDefined();
		const heavy = fake.ref("heavy");
		const reviewing = reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: twoLensTiers,
				models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
				lenses: { contracts: { enabled: false } },
			},
			lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
		});
		const root = (await harness.root(context)).id;
		const head = reviewedRevision();
		try {
			// Waiting starts the scheduler, so wait only once the new selection has replaced the head's index entry.
			while ((await tasks("melian.lenses")).length === 0) await sleep(10);
			const settled = await harness.waitForTask(stale!.record.id, context);

			expect(settled.state.outcome).toEqual({ status: "completed", result: "superseded" });
			expect(await readVerdict(harness, root, head, context)).toBeUndefined();
		} finally {
			release();
		}
		const { verdict } = await reviewing;
		expect(await readVerdict(harness, root, head, context)).toEqual(verdict);
	});

	it("counts a read-only tool call replayed after a crash once against the tools budget", async () => {
		const database = join(dir, "read.sqlite");
		const log = join(dir, "read.jsonl");
		await killWhen("read", (events) => count(events, "read-counted") === 1, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{
				match: "You are the correctness reviewer",
				replies: [
					fauxAssistantMessage(fauxToolCall("read_file", { path: "src/user.ts", startLine: 7, maxLines: 1 }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const heavy = fake.ref("heavy");
		const { verdict } = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: twoLensTiers,
				models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
			},
			lenses: budgetLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
		});

		// The replayed call is the lens's first and its next is its second, so the budget of two lets both run and the
		// lens finishes on its own. Counted twice, the second would have been refused and ended the lens.
		expect(requests["You are the correctness reviewer"]).toHaveLength(2);
		const [replayed, next] = requests["You are the correctness reviewer"]!;
		expect(toolResults(replayed!)).toEqual([expect.stringContaining("export interface User")]);
		expect(toolResults(next!).at(-1)).toContain("return user.manager.name;");
		expect(toolResults(next!).at(-1)).not.toContain("not run");
		expect(verdict.ran?.find((check) => check.name === "lens.correctness")).toEqual({
			name: "lens.correctness",
			status: "ran",
			level: "careful",
		});
	});

	// The killed process committed the spent budget in the call that ends the lens, then died before Pi stored its
	// result. The replay decides from durable state alone, so it ends the lens too, and the model is never asked again.
	for (const scenario of ["spent", "tokens"] as const) {
		it(`ends a lens on replay when the call that ended it at its ${scenario === "spent" ? "tools" : "token"} budget crashed`, async () => {
			const database = join(dir, `${scenario}.sqlite`);
			const log = join(dir, `${scenario}.jsonl`);
			await killWhen(scenario, (events) => count(events, "read-counted") === 1, database, log);

			const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
			const requests = scriptConversations(fake, [
				{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Never asked.")] },
				{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
			]);
			harness = await openHarness(await openSqliteStorage(database), {
				models: fake.models,
				registry: createReviewRegistry(),
				settings: { retry: { enabled: false } },
			});
			const heavy = fake.ref("heavy");
			const { verdict } = await reviewChangeset({
				harness,
				changeset: await Changeset.resolve(repo, "main...feature"),
				config: {
					...defaultConfig,
					tiers: twoLensTiers,
					models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
				},
				lenses: budgetLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"]), endingBudgets[scenario]),
				standards: [],
				checks: [],
				models: fake.review,
			});

			expect(requests["You are the correctness reviewer"]).toHaveLength(0);
			const ended = verdict.notRun.find((check) => check.name === "lens.correctness");
			expect(ended).toMatchObject(
				scenario === "spent"
					? { status: "ended", budgetEnded: { budget: "tools", limit: 1, tools: 1 } }
					: { status: "ended", budgetEnded: { budget: "tokens", limit: 1, tools: 0 } },
			);
			// The tokens are the killed process's: its one response, recorded before the crash, spent the budget.
			expect(ended?.budgetEnded?.tokens).toBeGreaterThan(1);
		});
	}
});

describe("an escalation across a crash", { timeout: 30_000 }, () => {
	it("continues the escalated run on its own conversation, without asking triage again or escalating twice", async () => {
		const database = join(dir, "review.sqlite");
		const log = join(dir, "review.jsonl");
		await killWhen("escalation", (events) => count(events, "model-request") === 1, database, log);

		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		const decider = new RecordedDecider({
			triage: { version: "1", answers: { correctness: { distribution: { quick: 1 } } } },
		});
		const registry = createReviewRegistry();
		registry.install(decisionExtension(decider));
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry,
			settings: { retry: { enabled: false } },
		});
		const medium = fake.ref("medium");
		const heavy = fake.ref("heavy");
		const { verdict } = await reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: { ...defaultConfig.tiers, full: ["standard"] },
				models: {
					medium: { model: `${medium.provider}/${medium.modelId}` },
					heavy: { model: `${heavy.provider}/${heavy.modelId}` },
				},
			},
			lenses: await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"]),
			standards: [],
			models: fake.review,
			decider,
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.biome", status: "ran" },
				{ name: "static.tsc", status: "ran" },
			],
		});

		// The stored decision answered; the decider was never asked again.
		expect(decider.requests).toEqual([]);
		// Only the careful run's interrupted request was answered: the quick run did not run again.
		expect(requests["You are the correctness reviewer"]).toHaveLength(1);
		// The record follows the escalation the stored task made before the crash.
		expect(verdict.ran?.find((check) => check.name === "lens.correctness")).toMatchObject({
			level: "careful",
			reason: expect.stringMatching(/^escalated from quick to careful: at quick it reported a P1 finding/),
		});
		const levels: string[] = [];
		for (let id = 1; id < 60; id++) {
			const lens = (await harness.snapshot(LensDocument, id as ConversationId, context))?.lens;
			if (lens !== undefined && lens.role !== "verifier") levels.push(lens.level ?? "none");
		}
		// One conversation per level: the escalation's was created once, before the crash.
		expect(levels.sort()).toEqual(["careful", "quick"]);
		expect(verdict.ran?.find((check) => check.name === "verifier")?.status).toBe("ran");
		expect(verdict.attention()[0]!.properties.verification?.verdict).toBe("confirmed");
		expect(verdict.attention()[0]!.properties.source.version).toMatch(/@quick$/);
	});
});

describe("verification across a crash", { timeout: 30_000 }, () => {
	it("does not downgrade a confirmed claim when the second conflicting call replays after a real kill", async () => {
		const database = join(dir, "conflicting-verdict.sqlite");
		const log = join(dir, "conflicting-verdict.jsonl");
		await killWhen("conflicting-verdict", (events) => count(events, "verdict-committed") === 1, database, log);
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "medium" }] });
		const requests = scriptConversations(fake, [
			{
				match: "Melian adversarial verifier",
				replies: [fauxAssistantMessage("Done.")],
			},
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false }, toolExecution: "parallel" },
		});
		const root = await harness.root(context);
		const before = await readFindings(harness, root.id, reviewedRevision(), context);
		expect(before[0]!.properties.verification?.verdict).toBe("confirmed");
		const version = await findingsVersion(harness, root.id, reviewedRevision(), context);
		harness.resume();
		const task = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "melian.verification")!;
		expect((await harness.waitForTask(task.record.id, context)).state.outcome.status).toBe("completed");
		const after = await readFindings(harness, root.id, reviewedRevision(), context);
		expect(after[0]!.properties.verification).toEqual(before[0]!.properties.verification);
		expect(await findingsVersion(harness, root.id, reviewedRevision(), context)).toBe(version);
		expect(requests["Melian adversarial verifier"]).toHaveLength(1);
	});
	it.each(["verifier", "verdict"] as const)("resumes %s after a real kill", async (scenario) => {
		const database = join(dir, "verifier.sqlite");
		const log = join(dir, "verifier.jsonl");
		await killWhen(
			scenario,
			(events) =>
				scenario === "verifier"
					? events.some((event) => event.event === "model-request" && event.lens === "verifier")
					: count(events, "verdict-committed") === 1,
			database,
			log,
		);
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }, { id: "medium" }] });
		const requests = scriptConversations(fake, [
			{
				match: "Melian adversarial verifier",
				replies: [(messages) => scriptVerifier(messages), (messages) => scriptVerifier(messages)],
			},
		]);
		harness = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry: createReviewRegistry(),
			settings: { retry: { enabled: false } },
		});
		const root = await harness.root(context);
		const before = await readFindings(harness, root.id, reviewedRevision(), context);
		expect(before[0]?.properties.verification !== undefined).toBe(scenario === "verdict");
		harness.resume();
		const task = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "melian.verification")!;
		expect((await harness.waitForTask(task.record.id, context)).state.outcome.status).toBe("completed");
		const after = await readFindings(harness, root.id, reviewedRevision(), context);
		expect(after[0]!.properties.verification?.verdict).toBe("confirmed");
		expect(requests["Melian adversarial verifier"]).toHaveLength(scenario === "verdict" ? 1 : 2);
	});
});

describe("a lens task from an earlier selection during triage", { timeout: 60_000 }, () => {
	it("clears the old verdict when a replacement decision commits, even across a crash", async () => {
		const changeset = await Changeset.resolve(repo, "main...feature");
		const directory = join(repo, ".git", "melian");
		mkdirSync(directory, { recursive: true });
		const database = join(directory, `${changeset.id}.sqlite`);
		const log = join(dir, "replacement.jsonl");
		await killWhen("replacement", (events) => count(events, "decision-asked") === 1, database, log);
		expect(count(readEvents(log), "verdict-recorded")).toBe(1);
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
		const pullRequest = {
			repository: { owner: "test", name: "repo" },
			number: 62,
			title: "Test",
			url: "https://example.invalid/pull/62",
			state: "open" as const,
			base: { ref: "main", sha: changeset.revision.base },
			head: { ref: "feature", sha: changeset.revision.head },
			fetch: { url: repo, headRef: "feature" },
		};
		const provider: ReviewProvider = {
			login: async () => undefined,
			permission: async () => undefined,
			name: "fake",
			resolveThread: vi.fn(async () => false),
			findLedger: vi.fn(async () => undefined),
			writeLedger: vi.fn(async () => ({
				id: "ledger",
				url: "https://example.invalid/ledger",
				stamp: {
					version: 1 as const,
					base: changeset.revision.base,
					head: changeset.revision.head,
					round: 1,
					verdict: "0".repeat(16),
					counts: { open: 0, blocking: 0, dismissed: 0 },
					lenses: [],
					plan: null,
					projection: "0".repeat(16),
				},
			})),
			getStatus: vi.fn(async () => undefined),
			pullRequest: vi.fn(async () => pullRequest),
			postReview: vi.fn(async () => ({ id: "review", threads: {} })),
			replyResolved: vi.fn(async () => undefined),
			setStatus: vi.fn(async () => {}),
			findPublished: vi.fn(async () => ({ threads: {}, replies: {} })),
		};
		const publisher = await openPublishHarness(await openSqliteStorage(database), fake.review, provider);
		harness = publisher.harness;
		const root = (await harness.root(context)).id;
		const revision = revisionKey(changeset.revision);
		expect((await harness.snapshot(ReviewIndex, root, context))!.reviews[revision]!.adjudication).toBeUndefined();
		expect(await readVerdict(harness, root, revision, context)).toBeUndefined();
		await expect(
			publishReview({
				trustedWriters: true,
				harness,
				changeset,
				provider,
				pullRequest,
				base: changeset.revision.base,
			}),
		).rejects.toMatchObject({ code: "notReviewed" });
		expect(provider.postReview).not.toHaveBeenCalled();
		expect(provider.writeLedger).not.toHaveBeenCalled();
		expect(provider.setStatus).not.toHaveBeenCalled();
		await publisher.close(context);
		harness = undefined;
		const findings = () =>
			spawnSync(
				process.execPath,
				[
					fileURLToPath(new URL("../../cli/bin/melian.js", import.meta.url)),
					"findings",
					"main...feature",
					"--json",
				],
				{
					cwd: repo,
					encoding: "utf8",
					timeout: 60_000,
					env: {
						...process.env,
						MELIAN_STATE_DIR: "",
						MELIAN_TEST_SCRIPT: "",
						PI_CODING_AGENT_DIR: dir,
						XDG_CONFIG_HOME: dir,
					},
				},
			);
		const absent = findings();
		expect(absent).toMatchObject({ status: 1, stderr: expect.stringContaining("Melian has no review"), stdout: "" });
		const decider = new RecordedDecider({
			triage: {
				version: "1",
				answers: { correctness: { distribution: { careful: 1 } }, contracts: { distribution: { careful: 1 } } },
			},
		});
		const resumedDecider: Decider = {
			name: "parked",
			calibrated: false,
			decide: (request) => decider.decide(request),
		};
		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, {
			retry: false,
			decider: resumedDecider,
		});
		harness = reopened.harness;
		const medium = fake.ref("medium");
		const heavy = fake.ref("heavy");
		const { verdict } = await reviewChangeset({
			harness,
			changeset,
			config: {
				...defaultConfig,
				tiers: twoLensTiers,
				models: {
					medium: { model: `${medium.provider}/${medium.modelId}` },
					heavy: { model: `${heavy.provider}/${heavy.modelId}` },
				},
			},
			lenses: crashLenses(await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"])),
			standards: [],
			checks: [],
			models: fake.review,
			decider: resumedDecider,
			policy: { kind: "revision", commit: changeset.revision.base },
			origin: {
				kind: "pull-request",
				repository: { owner: "test", name: "repo" },
				pullRequest: 62,
				base: changeset.revision.base,
				head: changeset.revision.head,
			},
		});
		expect(await readVerdict(harness, root, revision, context)).toEqual(verdict);
		expect(fake.provider.state.callCount).toBe(0);
		await reopened.close(context);
		harness = undefined;
		expect(findings().status).toBe(0);
		const completed = await openPublishHarness(await openSqliteStorage(database), fake.review, provider);
		harness = completed.harness;
		await expect(
			publishReview({
				trustedWriters: true,
				harness,
				changeset,
				provider,
				pullRequest,
				base: changeset.revision.base,
			}),
		).resolves.toBeDefined();
		expect(provider.postReview).toHaveBeenCalledOnce();
	});

	it("aborts its pending adjudication while a fresh decision chooses another selection", async () => {
		const database = join(dir, "triage-adjudication.sqlite");
		const log = join(dir, "triage-adjudication.jsonl");
		await killWhen("adjudication", (events) => count(events, "adjudication-started") === 1, database, log);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const decide = vi.fn(async (request: Parameters<Decider["decide"]>[0]) => {
			await gate;
			return {
				answers: request.questions.map((question) => ({ question: question.id, distribution: { quick: 1 } })),
			};
		});
		const decider: Decider = { name: "holding", calibrated: false, decide };
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, {
			retry: false,
			decider,
		});
		harness = reopened.harness;
		const { tasks } = await harness.inspect(context);
		const previous = tasks.find((task) => task.record.kind === "melian.adjudication")!;
		expect(previous.record.state.status).not.toBe("terminal");
		const conversation = await harness.root(context);
		const root = conversation.id;
		const revision = reviewedRevision();
		const entry = (await harness.snapshot(ReviewIndex, root, context))!.reviews[revision]!;
		const lenses = await conversation.commit((tx) => tx.task(entry.task as TaskId), context);
		expect(lenses!.state).toMatchObject({ status: "terminal", outcome: { status: "completed" } });
		expect(entry.adjudication!.task).toBe(previous.record.id);
		const medium = fake.ref("medium");
		const heavy = fake.ref("heavy");
		const pending = reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: { ...defaultConfig.tiers, full: ["standard"] },
				models: {
					medium: { model: `${medium.provider}/${medium.modelId}` },
					heavy: { model: `${heavy.provider}/${heavy.modelId}` },
				},
			},
			lenses: await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"]),
			standards: [],
			models: fake.review,
			decider,
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.biome", status: "ran" },
				{ name: "static.tsc", status: "ran" },
			],
		});
		try {
			await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
			const old = await harness.waitForTask(previous.record.id, context);
			expect(old.state.outcome.status).toBe("aborted");
			expect(await readVerdict(harness, root, revision, context)).toBeUndefined();
			expect(fake.provider.state.callCount).toBe(0);
		} finally {
			release();
			await pending.catch(() => undefined);
		}
		const { verdict } = await pending;
		expect(verdict).toMatchObject({
			status: "passed",
			ran: expect.arrayContaining([
				{ name: "lens.correctness", status: "ran", level: "quick", reason: expect.any(String) },
			]),
		});
		expect(await readVerdict(harness, root, revision, context)).toEqual(verdict);
		harness.resume();
		expect(await readVerdict(harness, root, revision, context)).toEqual(verdict);
		expect(requests["You are the correctness reviewer"]).toHaveLength(1);
	});

	it("cannot resume while a fresh decision is pending", async () => {
		const database = join(dir, "triage.sqlite");
		const log = join(dir, "triage.jsonl");
		await killWhen("request", (events) => count(events, "model-request") === 2, database, log);
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const decide = vi.fn(async (request: Parameters<Decider["decide"]>[0]) => {
			await gate;
			return {
				answers: request.questions.map((question) => ({ question: question.id, distribution: { quick: 1 } })),
			};
		});
		const decider: Decider = { name: "holding", calibrated: false, decide };
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "medium" }, { id: "heavy" }] });
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
			{ match: "You are the contracts reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, {
			retry: false,
			decider,
		});
		harness = reopened.harness;
		const previous = (await harness.inspect(context)).tasks.find((task) => task.record.kind === "melian.lenses")!;
		const medium = fake.ref("medium");
		const heavy = fake.ref("heavy");
		const pending = reviewChangeset({
			harness,
			changeset: await Changeset.resolve(repo, "main...feature"),
			config: {
				...defaultConfig,
				tiers: { ...defaultConfig.tiers, full: ["standard"] },
				models: {
					medium: { model: `${medium.provider}/${medium.modelId}` },
					heavy: { model: `${heavy.provider}/${heavy.modelId}` },
				},
			},
			lenses: await Lens.load(repo, { kind: "worktree" }, ["src/user.ts"]),
			standards: [],
			models: fake.review,
			decider,
			checks: [
				{ name: "guardrails", status: "ran" },
				{ name: "static.biome", status: "ran" },
				{ name: "static.tsc", status: "ran" },
			],
		});
		try {
			await vi.waitFor(() => expect(decide).toHaveBeenCalledOnce());
			expect(fake.provider.state.callCount).toBe(0);
			const old = await harness.waitForTask(previous.record.id, context);
			expect(old.state.outcome.status).toBe("aborted");
		} finally {
			release();
			await pending.catch(() => undefined);
		}
		const reviewed = await pending;
		expect(reviewed.verdict.ran?.find((check) => check.name === "lens.correctness")).toMatchObject({
			status: "ran",
			level: "quick",
		});
		expect(requests["You are the correctness reviewer"]).toHaveLength(1);
		expect(requests["You are the contracts reviewer"]).toHaveLength(0);
	});
});

describe("a decision task a later review replaced", { timeout: 30_000 }, () => {
	it("is aborted on opening, after a crash between the repoint and the abort, so it asks no decider", async () => {
		const database = join(dir, "decision.sqlite");
		const log = join(dir, "decision.jsonl");
		await killWhen("decision", (events) => count(events, "decision-asked") === 1, database, log);

		const asked: string[] = [];
		const decider: Decider = {
			name: "parked",
			calibrated: false,
			decide: async () => {
				asked.push("asked");
				return { answers: [] };
			},
		};
		const fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
		// What a later review's commit leaves when the process dies before it aborts the task it replaced.
		const registry = createReviewRegistry();
		registry.install(decisionExtension(decider));
		const replace = await openHarness(await openSqliteStorage(database), {
			models: fake.models,
			registry,
			settings: { retry: { enabled: false } },
		});
		const crashed = (await replace.inspect(context)).tasks.find((task) => task.record.kind === "melian.decision");
		expect(crashed).toBeDefined();
		const input = crashed!.record.input as unknown as { key: string };
		expect(JSON.parse(input.key).decider).toBe(decider.name);
		const root = await replace.root(context);
		await root.commit(async (tx) => {
			const document = await tx.doc(DecisionDocument, root.id);
			const revision = reviewedRevision();
			const entry = document.decisions[revision]!.triage!;
			document.decisions = { ...document.decisions, [revision]: { triage: { ...entry, task: 999_999 } } };
		}, context);
		await replace.close(context);

		const reopened = await ReviewHarness.open(await openSqliteStorage(database), fake.review, {
			retry: false,
			decider,
		});
		harness = reopened.harness;
		const settled = await harness.waitForTask(crashed!.record.id, context);

		expect(settled.state.outcome.status).toBe("aborted");
		expect(asked).toEqual([]);
		const recorded = await harness.snapshot(DecisionDocument, root.id, context);
		expect(recorded!.decisions[reviewedRevision()]!.triage).toMatchObject({ task: 999_999 });
		expect(recorded!.decisions[reviewedRevision()]!.triage!.decision).toBeUndefined();
		expect(recorded!.decisions[reviewedRevision()]!.triage!.failure).toBeUndefined();
	});
});
