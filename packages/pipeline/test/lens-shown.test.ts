import { rmSync } from "node:fs";
import { Changeset, defaultConfig, Lens, Revision } from "@melian-agent/core";
import {
	ChangePrompt,
	backgroundContext as context,
	createMemoryStorage,
	createReviewRegistry,
	type Harness,
	openHarness,
	reviewChangeset,
	type Stage,
	TelemetryReader,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	fauxToolCall,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseAndHead, gitIn, isolatedGitEnv, lines } from "./fixtures/repo.ts";
import { twoLensTiers } from "./fixtures/review-scenario.ts";

const correctness = "You are the correctness reviewer";
const contracts = "You are the contracts reviewer";
const promptLimit = 200 * 1024;
// One line of about 30 bytes per value, so 8000 of them pass the prompt's limit alone.
const big = (count: number) =>
	lines(...Array.from({ length: count }, (_, index) => `export const value${index} = ${index};`));

let repo: string | undefined;
let fake: FakeModels;
let harness: Harness;
let storage: ReturnType<typeof createMemoryStorage>;

beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "heavy" }] });
	storage = createMemoryStorage();
	harness = await openHarness(storage, {
		models: fake.models,
		registry: createReviewRegistry(),
		settings: { retry: { enabled: false } },
	});
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
});

afterEach(async () => {
	await harness.close(context);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
});

async function lensStage(name: string): Promise<Stage> {
	const root = repo!;
	const changeset = await Changeset.resolve(root, "main...feature");
	const heavy = fake.ref("heavy");
	await reviewChangeset({
		harness,
		changeset,
		config: {
			...defaultConfig,
			tiers: twoLensTiers,
			models: { heavy: { model: `${heavy.provider}/${heavy.modelId}` } },
		},
		lenses: await Lens.load(
			root,
			{ kind: "revision", commit: gitIn(root, "rev-parse", "main") },
			changeset.revision.paths(),
		),
		standards: [],
		models: fake.review,
		checks: [
			{ name: "guardrails", status: "ran" },
			{ name: "static.biome", status: "ran" },
			{ name: "static.tsc", status: "ran" },
		],
	});
	const telemetry = await TelemetryReader.open(storage).read(Revision.key(changeset.revision));
	return telemetry.stages.find((stage) => stage.name === "melian.lens" && stage.subject.startsWith(`${name}@`))!;
}

describe("what each lens was shown and read", { timeout: 60_000 }, () => {
	it("leaves a file the cut prompt omits out of shown, and puts it in read only when the lens reads it", async () => {
		repo = baseAndHead(
			{ "src/seed.ts": lines("export {};") },
			{ "src/a.ts": big(8000), "src/b.ts": lines("export const b = 1;", "export const c = 2;") },
		);
		scriptConversations(fake, [
			{
				match: correctness,
				replies: [
					fauxAssistantMessage(fauxToolCall("read_file", { path: "src/b.ts", startLine: 2, maxLines: 1 }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("Done."),
				],
			},
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);

		const read = await lensStage("correctness");
		const unread = await lensStage("contracts");

		expect(read).toMatchObject({ outcome: "completed", shown: [], read: [{ path: "src/b.ts", ranges: [[2, 2]] }] });
		expect(unread).toMatchObject({ outcome: "completed", shown: [] });
		expect(unread).not.toHaveProperty("read");
	});

	it("names every file whose diff block the prompt carried whole", async () => {
		repo = baseAndHead(
			{ "src/seed.ts": lines("export {};") },
			{ "src/a.ts": lines("export const a = 1;"), "src/b.ts": lines("export const b = 1;") },
		);
		scriptConversations(fake, [
			{ match: correctness, replies: [fauxAssistantMessage("Done.")] },
			{ match: contracts, replies: [fauxAssistantMessage("Done.")] },
		]);

		expect((await lensStage("correctness")).shown).toEqual(["src/a.ts", "src/b.ts"]);
	});

	it("shows a file whose block ends the prompt at its byte limit, and cuts it one byte past", async () => {
		// The prompt counts its header and each block, not the blank lines that join them.
		const sized = async (line: string) => {
			repo = baseAndHead({ "src/seed.ts": lines("export {};") }, { "src/a.ts": lines(line) });
			const rendered = new ChangePrompt(await Changeset.resolve(repo, "main...feature"), "nonce").renderInput();
			rmSync(repo, { recursive: true, force: true });
			return { size: Buffer.byteLength(rendered.text) - 2, rendered };
		};
		const { size } = await sized("x");
		const at = await sized("x".repeat(1 + promptLimit - size));
		const past = await sized("x".repeat(2 + promptLimit - size));
		repo = undefined;

		expect(at.size).toBe(promptLimit);
		expect(at.rendered).toMatchObject({ cut: false, shown: ["src/a.ts"] });
		expect(past.rendered).toMatchObject({ cut: true, shown: [] });
	});
});
