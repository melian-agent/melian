import { rmSync } from "node:fs";
import { Changeset, defaultConfig, Lens, Revision, type Verification } from "@melian-agent/core";
import {
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
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
import { reviewFiles } from "../src/lens-tools.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { startWave } from "../src/verification.ts";
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

beforeEach(async () => {
	repo = crashRepository();
	fake = createFakeModels({ models: [{ id: "finder" }, { id: "judge" }] });
	storage = createMemoryStorage();
	harness = await openHarness(storage, {
		models: fake.models,
		registry: createReviewRegistry(),
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
	const finder = fake.ref("finder");
	const judge = fake.ref("judge");
	return reviewChangeset({
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
	});
}

const lens = (name: string) => lenses.find((each) => each.name === name)!;
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
});
