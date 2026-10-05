import { rmSync } from "node:fs";
import { Changeset, defaultConfig, Lens, type Verification, VerificationState } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	type Review,
	readFindings,
	reviewChangeset,
	revisionKey,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
	scriptVerifier,
	systemPromptOf,
	textOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSightings } from "../src/findings.ts";
import { reviewFiles } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { type VerificationInput, VerificationTask } from "../src/verification.ts";
import { verifierMarker, verifierVersion } from "../src/verification-instructions.ts";
import { gitIn } from "./fixtures/repo.ts";
import { crashFinding, crashRepository } from "./fixtures/review-scenario.ts";

let repo: string;
let harness: Harness;
let fake: FakeModels;
let lenses: Lens[];
let changeset: Changeset;

beforeEach(async () => {
	repo = crashRepository();
	fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }, { id: "backup" }] });
	harness = await openHarness(createMemoryStorage(), {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false }, toolExecution: "parallel" },
	});
	await harness.root(context, { agent: { model: fake.ref("finder") } });
	changeset = await Changeset.resolve(repo, "main...feature");
	lenses = (
		await Lens.load(repo, { kind: "revision", commit: gitIn(repo, "rev-parse", "main") }, ["src/user.ts"])
	).filter((lens) => lens.name === "correctness");
});
afterEach(async () => {
	await harness.close(context);
	rmSync(repo, { recursive: true, force: true });
});

async function review(rerun = false): Promise<Review> {
	const finder = fake.ref("finder");
	const judge = fake.ref("judge");
	return reviewChangeset({
		harness,
		changeset,
		lenses,
		standards: [],
		models: fake.review,
		rerun,
		config: {
			...defaultConfig,
			tiers: { full: lenses.map((lens) => `lens.${lens.name}`) },
			stages: { "pull-request": "full" },
			models: {
				heavy: { model: `${finder.provider}/${finder.modelId}` },
				verifier: { model: `${judge.provider}/${judge.modelId}`, fallbacks: [`${judge.provider}/backup`] },
			},
		},
	});
}

function scripts(verdict: Verification["verdict"] = "confirmed") {
	return scriptConversations(fake, [
		...lenses.map((lens) => ({
			match: lens.instructions,
			replies: [
				fauxAssistantMessage(fauxToolCall("report_finding", { ...crashFinding, rule: lens.rules[0]!.id }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Done."),
			],
		})),
		{
			match: verifierMarker,
			replies: [
				(messages) => {
					const ids = [...systemPromptOf(messages).matchAll(/finding ([0-9a-f]+)/g)].map((match) => match[1]!);
					return scriptVerifier(
						messages,
						Object.fromEntries(
							ids.map((id) => [
								id,
								{
									verdict,
									reason: "Traced the code.",
									correction: "Use the guarded value.",
									...(verdict === "refuted"
										? { evidence: [{ file: "src/user.ts", line: 7, role: "context" as const }] }
										: {}),
								},
							]),
						),
					);
				},
				(messages) => scriptVerifier(messages),
			],
		},
	]);
}

describe("the verifier", () => {
	it("merges two rules before asking one conversation to judge both claims inside boundaries", async () => {
		const first = lenses[0]!;
		lenses.push(
			Lens.from({
				...first.toJSON(),
				name: "second",
				version: "second",
				instructions: "Second finder",
				rules: [{ id: "second-rule", description: "Same failure." }],
			}),
		);
		const requests = scripts();
		const result = await review();
		expect(result.verdict.attention()).toHaveLength(1);
		expect(requests[verifierMarker]).toHaveLength(2);
		const messages = requests[verifierMarker]![0]!;
		const prompt = messages
			.filter((message) => message.role === "user")
			.map(textOf)
			.join("\n");
		expect(prompt.match(/label="findings"/g)).toHaveLength(2);
		expect(prompt).toContain(JSON.stringify(crashFinding.failureScenario));
		expect(prompt.replace(/<untrusted-[\s\S]*?<\/untrusted-[^>]*>/g, "")).not.toContain("src/user.ts");
		expect(result.findings.every((finding) => finding.properties.verification?.verdict === "confirmed")).toBe(true);
		expect(result.verdict.ran?.find((check) => check.name === "verifier")?.status).toBe("ran");
	});
	it.each(["confirmed", "plausible", "refuted"] as const)(
		"stores %s beside the sighting without writing confidence",
		async (verdict) => {
			scripts(verdict);
			const result = await review();
			expect(result.findings[0]!.properties.verification).toMatchObject({
				verdict,
				executor: "llm",
				model: `${fake.ref("judge").provider}/judge`,
				correction: "Use the guarded value.",
			});
			expect(result.findings[0]!.properties.confidence).toBeUndefined();
			expect(result.verdict.refuted?.length ?? 0).toBe(verdict === "refuted" ? 1 : 0);
			expect(result.verdict.attention()).toHaveLength(verdict === "refuted" ? 0 : 1);
		},
	);
	it.each([
		["confirmed", "plausible", "refuted"],
		["confirmed", "refuted", "plausible"],
		["plausible", "confirmed", "refuted"],
		["plausible", "refuted", "confirmed"],
		["refuted", "confirmed", "plausible"],
		["refuted", "plausible", "confirmed"],
	])("keeps confirmed for conflicting same-label calls in order %s, %s, %s", async (...verdicts) => {
		scriptConversations(fake, [
			{
				match: lenses[0]!.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{
				match: verifierMarker,
				replies: [
					fauxAssistantMessage(
						verdicts.map((verdict) =>
							fauxToolCall("report_verdict", {
								claim: "c1",
								answers: { code: "yes", guard: "no", base: "no" },
								verdict,
								reason: `Reported ${verdict}.`,
								evidence: [{ file: "src/user.ts", line: 7, role: "context" }],
							}),
						),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("Done."),
				],
			},
		]);
		const result = await review();
		expect(result.findings[0]!.properties.verification?.verdict).toBe("confirmed");
		expect(result.verdict.attention()).toHaveLength(1);
		expect(result.verdict.refuted).toBeUndefined();
	});
	it("attaches a repeat review without asking another model", async () => {
		const requests = scripts();
		await review();
		await review();
		expect(requests[verifierMarker]).toHaveLength(2);
		const root = await harness.root(context);
		const index = await harness.snapshot(ReviewIndex, root.id, context);
		expect(index?.reviews[revisionKey(changeset.revision)]?.verification).toBeDefined();
	});
	it("lets a replacement task refute a claim the failed task confirmed", async () => {
		const requests = scriptConversations(fake, [
			{
				match: lenses[0]!.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{
				match: verifierMarker,
				replies: [
					(messages) => scriptVerifier(messages),
					...Array.from({ length: 2 }, () =>
						fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 service unavailable" }),
					),
				],
			},
		]);
		await expect(review()).rejects.toMatchObject({ code: "verifierFailed" });
		const root = await harness.root(context);
		const revision = revisionKey(changeset.revision);
		const previous = (await harness.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!.verification!;
		expect((await readFindings(harness, root.id, revision, context))[0]!.properties.verification?.verdict).toBe(
			"confirmed",
		);
		expect(requests[verifierMarker]).toHaveLength(3);
		const rerunRequests = scripts("refuted");
		const result = await review(true);
		expect((await harness.snapshot(ReviewIndex, root.id, context))!.reviews[revision]!.verification!.task).not.toBe(
			previous.task,
		);
		expect(rerunRequests[verifierMarker]).toHaveLength(2);
		expect(result.findings[0]!.properties.verification?.verdict).toBe("refuted");
		expect(result.verdict.refuted).toHaveLength(1);
		expect(result.verdict.attention()).toEqual([]);
	});
	it("passes a rerun after the lens withdraws the only claim from a failed verification", async () => {
		const requests = scriptConversations(fake, [
			{
				match: lenses[0]!.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{
				match: verifierMarker,
				replies: Array.from({ length: 2 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 service unavailable" }),
				),
			},
		]);
		await expect(review()).rejects.toMatchObject({ code: "verifierFailed" });
		const root = await harness.root(context);
		const revision = revisionKey(changeset.revision);
		const findings = await readFindings(harness, root.id, revision, context);
		await root.commit(
			(tx) =>
				clearSightings(
					tx,
					root.id,
					revision,
					findings.map((finding) => finding.properties.source),
				),
			context,
		);
		expect((await harness.snapshot(ReviewIndex, root.id, context))?.reviews[revision]?.verification).toBeDefined();
		const result = await review(true);
		expect(result.verdict.status).toBe("passed");
		expect(result.findings).toEqual([]);
		expect(
			[...(result.verdict.ran ?? []), ...(result.verdict.notRun ?? [])].some((check) => check.name === "verifier"),
		).toBe(false);
		expect((await harness.snapshot(ReviewIndex, root.id, context))?.reviews[revision]?.verification).toBeUndefined();
		expect((await review(true)).verdict.status).toBe("passed");
		expect(requests[verifierMarker]).toHaveLength(2);
	});
	it("fails over to the next verifier model", async () => {
		const requests = scriptConversations(fake, [
			{
				match: lenses[0]!.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{
				match: verifierMarker,
				replies: [
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 service unavailable" }),
					(messages) => scriptVerifier(messages),
					(messages) => scriptVerifier(messages),
				],
			},
		]);
		const result = await review();
		expect(requests[verifierMarker]).toHaveLength(3);
		expect(result.findings[0]!.properties.verification?.model).toBe(`${fake.ref("backup").provider}/backup`);
	});
	it("fails closed when every verifier model fails and does not retry without rerun", async () => {
		const requests = scriptConversations(fake, [
			{
				match: lenses[0]!.instructions,
				replies: [
					fauxAssistantMessage(fauxToolCall("report_finding", crashFinding), { stopReason: "toolUse" }),
					fauxAssistantMessage("Done."),
				],
			},
			{
				match: verifierMarker,
				replies: Array.from({ length: 2 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "HTTP 503 service unavailable" }),
				),
			},
		]);
		await expect(review()).rejects.toMatchObject({
			code: "verifierFailed",
			verdict: {
				status: "not-reviewed",
				blocking: false,
				findings: { advisory: [expect.anything()] },
				notRun: [expect.objectContaining({ name: "verifier", status: "failed" })],
			},
		});
		await expect(review()).rejects.toMatchObject({ code: "verifierFailed" });
		expect(requests[verifierMarker]).toHaveLength(2);
		const root = await harness.root(context);
		expect(
			(await readFindings(harness, root.id, revisionKey(changeset.revision), context))[0]!.properties.verification,
		).toBeUndefined();
	});
});

describe("verification ownership and budgets", () => {
	async function input(): Promise<VerificationInput> {
		scripts();
		const result = await review();
		const root = await harness.root(context);
		return {
			root: root.id,
			version: verifierVersion,
			revision: {
				repoRoot: repo,
				nonce: "a".repeat(24),
				base: changeset.revision.base,
				head: changeset.revision.head,
				files: reviewFiles(changeset.revision.files),
			},
			candidates: [
				{
					key: result.findings[0]!.id,
					state: VerificationState.from(result.findings[0]!).toJSON(),
					finder: "faux/finder",
					route: [fake.ref("judge")],
					budget: { tokens: 100000, tools: 1 },
				},
			],
		};
	}
	it("a task the index does not name asks no model and writes nothing", async () => {
		const stored = await input();
		const calls = fake.provider.state.callCount;
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(VerificationTask, stored, { ownership: { kind: "conversation" } }),
			context,
		);
		expect((await harness.waitForTask(id, context)).state.outcome).toMatchObject({ status: "completed", result: {} });
		expect(fake.provider.state.callCount).toBe(calls);
	});
	it("ends a candidate when its read budget ends", async () => {
		const stored = await input();
		scriptConversations(fake, [
			{
				match: verifierMarker,
				replies: Array.from({ length: 2 }, () =>
					fauxAssistantMessage(fauxToolCall("read_file", { path: "src/user.ts" }), { stopReason: "toolUse" }),
				),
			},
		]);
		const root = await harness.root(context);
		const id = await root.commit(async (tx) => {
			const created = await tx.createTask(VerificationTask, stored, { ownership: { kind: "conversation" } });
			const entry = (await tx.doc(ReviewIndex, root.id)).reviews[revisionKey(changeset.revision)]!;
			entry.verification = { task: created, input: "budget" };
			return created;
		}, context);
		const outcome = (await harness.waitForTask(id, context)).state.outcome;
		expect(outcome).toMatchObject({
			status: "completed",
			result: { [stored.candidates[0]!.key]: { status: "ended", budgetEnded: { budget: "tools", limit: 1 } } },
		});
	});
});
